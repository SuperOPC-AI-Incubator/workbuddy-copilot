import { createFileRoute } from "@tanstack/react-router";
import {
  InvalidWorkbuddyCredentialError,
  ReliableWorkbuddyTurnSchema,
  RevokedWorkbuddyCredentialError,
  WorkbuddyEventConflictError,
  type ReliableWorkbuddyTurn,
} from "@/lib/workbuddy/contracts";
import type { WorkbuddyIngestResult } from "@/lib/workbuddy/events.server";

export const MAX_WORKBUDDY_INGEST_BODY_BYTES = 200_000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
} as const;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

class PayloadTooLargeError extends Error {}
class InvalidPayloadEncodingError extends Error {}

async function readBodyWithLimit(request: Request, maximumBytes: number): Promise<string> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (Number.isFinite(parsedLength) && parsedLength > maximumBytes) {
      throw new PayloadTooLargeError();
    }
  }

  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > maximumBytes) {
      await reader.cancel();
      throw new PayloadTooLargeError();
    }
    chunks.push(value);
  }

  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new InvalidPayloadEncodingError();
  }
}

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer[ \t]+(.+)$/i);
  const token = match?.[1]?.trim();
  return token ? token : null;
}

type IngestRouteDependencies = {
  resolveCredential(presentedToken: string): Promise<{ studentId: string }>;
  ingestTurn(input: {
    studentId: string;
    turn: ReliableWorkbuddyTurn;
  }): Promise<WorkbuddyIngestResult>;
  maximumBodyBytes?: number;
};

function unauthorized() {
  return json(
    {
      error: {
        code: "UNAUTHORIZED",
        message: "Invalid WorkBuddy credential",
      },
    },
    401,
  );
}

function invalidPayload() {
  return json(
    {
      error: {
        code: "INVALID_PAYLOAD",
        message: "Invalid WorkBuddy payload",
      },
    },
    400,
  );
}

export function createWorkbuddyIngestPostHandler(dependencies: IngestRouteDependencies) {
  return async (request: Request): Promise<Response> => {
    let rawBody: string;
    try {
      rawBody = await readBodyWithLimit(
        request,
        dependencies.maximumBodyBytes ?? MAX_WORKBUDDY_INGEST_BODY_BYTES,
      );
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        return json(
          {
            error: {
              code: "PAYLOAD_TOO_LARGE",
              message: "Payload too large",
            },
          },
          413,
        );
      }
      if (error instanceof InvalidPayloadEncodingError) {
        return invalidPayload();
      }
      console.error("[WorkBuddy ingest] request body read failed");
      return json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } }, 500);
    }

    const token = bearerToken(request);
    if (!token) return unauthorized();

    let studentId: string;
    try {
      ({ studentId } = await dependencies.resolveCredential(token));
    } catch (error) {
      if (
        error instanceof InvalidWorkbuddyCredentialError ||
        error instanceof RevokedWorkbuddyCredentialError
      ) {
        return unauthorized();
      }
      console.error("[WorkBuddy ingest] credential lookup failed");
      return json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } }, 500);
    }

    let turn: ReliableWorkbuddyTurn;
    try {
      turn = ReliableWorkbuddyTurnSchema.parse(JSON.parse(rawBody));
    } catch {
      return invalidPayload();
    }

    try {
      const result = await dependencies.ingestTurn({ studentId, turn });
      return json({
        ok: true,
        event_id: result.event_id,
        session_id: result.session_id,
        item_ids: {
          prompt: result.prompt_item_id,
          reply: result.reply_item_id,
          diagnosis: result.diagnosis_item_id,
        },
        duplicate: result.duplicate,
      });
    } catch (error) {
      if (error instanceof WorkbuddyEventConflictError) {
        return json(
          {
            error: {
              code: "EVENT_ID_CONFLICT",
              message: "Event ID conflicts with stored payload",
            },
          },
          409,
        );
      }

      console.error("[WorkBuddy ingest] atomic ingest failed");
      return json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } }, 500);
    }
  };
}

async function post(request: Request): Promise<Response> {
  try {
    const [
      { supabaseAdmin },
      { createSupabaseWorkbuddyCredentialGateway, resolveWorkbuddyCredential },
      { createSupabaseWorkbuddyIngestGateway, ingestWorkbuddyTurn },
    ] = await Promise.all([
      import("@/integrations/supabase/client.server"),
      import("@/lib/workbuddy/credentials.server"),
      import("@/lib/workbuddy/events.server"),
    ]);

    const credentialGateway = createSupabaseWorkbuddyCredentialGateway(supabaseAdmin);
    const ingestGateway = createSupabaseWorkbuddyIngestGateway(supabaseAdmin);
    return createWorkbuddyIngestPostHandler({
      resolveCredential: (presentedToken) =>
        resolveWorkbuddyCredential(presentedToken, { gateway: credentialGateway }),
      ingestTurn: (input) => ingestWorkbuddyTurn(input, { gateway: ingestGateway }),
    })(request);
  } catch {
    console.error("[WorkBuddy ingest] server dependency initialization failed");
    return json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } }, 500);
  }
}

export const Route = createFileRoute("/api/public/workbuddy/ingest")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS }),
      POST: async ({ request }) => post(request),
    },
  },
});
