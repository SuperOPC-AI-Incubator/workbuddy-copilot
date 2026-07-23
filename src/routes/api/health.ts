import { createFileRoute } from "@tanstack/react-router";

const RELEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    },
  });
}

export function createHealthResponse(releaseId: string | undefined): Response {
  if (!releaseId || !RELEASE_ID_PATTERN.test(releaseId)) {
    return json({ status: "unhealthy" }, 503);
  }

  return json({ status: "ok", release_id: releaseId }, 200);
}

export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: async () => createHealthResponse(process.env.SUPERBRAIN_RELEASE_ID),
    },
  },
});
