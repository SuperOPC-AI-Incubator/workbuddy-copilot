import { createFileRoute } from "@tanstack/react-router";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Workbuddy-Signature, Authorization",
  "Access-Control-Max-Age": "86400",
} as const;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

const ItemSchema = z.object({
  kind: z.enum(["prompt", "reply", "diagnosis", "mentor"]),
  text: z.string().min(1).max(8000),
  tag: z.string().max(40).optional().nullable(),
  severity: z.enum(["ok", "warn", "error"]).optional().nullable(),
});

const PayloadSchema = z.object({
  student: z
    .object({
      user_id: z.string().uuid().optional(),
      email: z.string().email().optional(),
      display_name: z.string().min(1).max(80).optional(),
    })
    .optional(),
  session: z
    .object({
      id: z.string().uuid().optional(),
      title: z.string().min(1).max(120).optional(),
      group: z.enum(["space", "task"]).optional(),
    })
    .optional(),
  items: z.array(ItemSchema).min(1).max(50),
});

function verifySignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!header) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const given = header.startsWith("sha256=") ? header.slice(7) : header;
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(given, "hex");
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

export const Route = createFileRoute("/api/public/workbuddy/ingest")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS }),
      POST: async ({ request }) => {
        const secret = process.env.WORKBUDDY_INGEST_SECRET;
        if (!secret) return json({ error: "Server not configured" }, 500);

        const raw = await request.text();
        if (raw.length > 200_000) return json({ error: "Payload too large" }, 413);

        // Two auth modes:
        // 1) Per-student bearer token (SKILL.md flow, simple for the AI)
        // 2) HMAC signature over raw body (server-to-server flow)
        const authHeader = request.headers.get("authorization") ?? "";
        const bearer = authHeader.toLowerCase().startsWith("bearer ")
          ? authHeader.slice(7).trim()
          : "";
        const hasSig = !!request.headers.get("x-workbuddy-signature");
        if (!bearer && !hasSig) {
          return json({ error: "Missing Authorization bearer or X-Workbuddy-Signature" }, 401);
        }
        if (
          !bearer &&
          !verifySignature(raw, request.headers.get("x-workbuddy-signature"), secret)
        ) {
          return json({ error: "Invalid signature" }, 401);
        }

        let parsed;
        try {
          parsed = PayloadSchema.parse(JSON.parse(raw));
        } catch (e) {
          return json({ error: "Invalid payload", detail: (e as Error).message }, 400);
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        // Resolve student
        let studentId: string | null = null;
        let authorId: string | null = null;
        if (bearer) {
          const { data } = await supabaseAdmin
            .from("students")
            .select("id, user_id")
            .eq("workbuddy_token", bearer)
            .maybeSingle();
          if (!data) return json({ error: "Invalid student token" }, 401);
          studentId = data.id;
          authorId = data.user_id;
        }
        const s = parsed.student ?? {};
        if (!studentId && s.user_id) {
          const { data } = await supabaseAdmin
            .from("students")
            .select("id")
            .eq("user_id", s.user_id)
            .maybeSingle();
          studentId = data?.id ?? null;
        }
        if (!studentId && s.email) {
          // Find auth user by email
          const { data: list } = await supabaseAdmin.auth.admin.listUsers();
          const authUser = list?.users.find(
            (u) => u.email?.toLowerCase() === s.email!.toLowerCase(),
          );
          if (authUser) {
            const { data } = await supabaseAdmin
              .from("students")
              .select("id")
              .eq("user_id", authUser.id)
              .maybeSingle();
            studentId = data?.id ?? null;
          }
        }
        if (!studentId && s.display_name) {
          const { data } = await supabaseAdmin
            .from("students")
            .select("id")
            .eq("display_name", s.display_name)
            .limit(1)
            .maybeSingle();
          studentId = data?.id ?? null;
        }
        if (!studentId) {
          return json({ error: "Student not found", student: s }, 404);
        }

        // Resolve or create session
        const sess = parsed.session ?? {};
        let sessionId = sess.id ?? null;
        if (!sessionId) {
          const title = sess.title ?? "WorkBuddy 会话";
          const group = sess.group ?? "task";
          const { data: existing } = await supabaseAdmin
            .from("sessions")
            .select("id")
            .eq("student_id", studentId)
            .eq("session_title", title)
            .maybeSingle();
          if (existing) {
            sessionId = existing.id;
          } else {
            const { data: created, error: csErr } = await supabaseAdmin
              .from("sessions")
              .insert({ student_id: studentId, session_title: title, session_group: group })
              .select("id")
              .single();
            if (csErr || !created)
              return json({ error: "Failed to create session", detail: csErr?.message }, 500);
            sessionId = created.id;
          }
        }

        const rows = parsed.items.map((it) => ({
          session_id: sessionId!,
          kind: it.kind,
          text: it.text,
          tag: it.tag ?? "WorkBuddy",
          severity: it.severity ?? null,
          author_id: authorId,
        }));

        const { error: insErr } = await supabaseAdmin.from("timeline_items").insert(rows);
        if (insErr) return json({ error: "Insert failed", detail: insErr.message }, 500);

        return json({
          ok: true,
          student_id: studentId,
          session_id: sessionId,
          inserted: rows.length,
        });
      },
    },
  },
});
