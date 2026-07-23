import { createFileRoute } from "@tanstack/react-router";

import { applySupabaseApiKeyHeaders } from "@/integrations/supabase/api-key-headers";

const DEFAULT_READY_TIMEOUT_MS = 2_500;

type ReadyProbeConfig = {
  supabaseUrl: string | undefined;
  serviceRoleKey: string | undefined;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    },
  });
}

function dependencyUnavailable() {
  return json({ status: "not_ready" }, 503);
}

function supabaseReadUrl(rawUrl: string | undefined): URL | null {
  if (!rawUrl) return null;

  try {
    const url = new URL(rawUrl);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return new URL("/rest/v1/students?select=id&limit=1", url);
  } catch {
    return null;
  }
}

async function consumeResponseBody(
  response: Response,
  setActiveReader: (reader: ReadableStreamDefaultReader<Uint8Array> | undefined) => void,
): Promise<void> {
  if (!response.body) return;

  const reader = response.body.getReader();
  setActiveReader(reader);
  try {
    while (!(await reader.read()).done) {
      // Consume the one-row readiness response without retaining its contents.
    }
  } finally {
    setActiveReader(undefined);
    reader.releaseLock();
  }
}

export async function createReadyResponse(config: ReadyProbeConfig): Promise<Response> {
  const readUrl = supabaseReadUrl(config.supabaseUrl);
  const serviceRoleKey = config.serviceRoleKey?.trim();
  const timeoutMs = config.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  if (
    !readUrl ||
    !serviceRoleKey ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 10_000
  ) {
    return dependencyUnavailable();
  }

  const abortController = new AbortController();
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      abortController.abort();
      void activeReader?.cancel("readiness dependency timeout").catch(() => undefined);
      reject(new Error("readiness dependency timeout"));
    }, timeoutMs);
  });

  try {
    const headers = applySupabaseApiKeyHeaders(
      new Headers({ Accept: "application/json" }),
      serviceRoleKey,
    );
    const response = await Promise.race([
      (config.fetchImpl ?? fetch)(readUrl, {
        method: "GET",
        cache: "no-store",
        headers,
        signal: abortController.signal,
      }),
      timeoutPromise,
    ]);
    if (!response.ok) {
      await Promise.race([response.body?.cancel() ?? Promise.resolve(), timeoutPromise]);
      return dependencyUnavailable();
    }

    await Promise.race([
      consumeResponseBody(response, (reader) => {
        activeReader = reader;
      }),
      timeoutPromise,
    ]);
    return json({ status: "ready" }, 200);
  } catch {
    return dependencyUnavailable();
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export const Route = createFileRoute("/api/ready")({
  server: {
    handlers: {
      GET: async () => {
        const response = await createReadyResponse({
          supabaseUrl: process.env.SUPABASE_URL,
          serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        });
        if (!response.ok) {
          console.error("[readiness] Supabase dependency unavailable");
        }
        return response;
      },
    },
  },
});
