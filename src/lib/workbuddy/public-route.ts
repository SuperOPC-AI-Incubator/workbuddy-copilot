export const WORKBUDDY_PUBLIC_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Request-Id",
  "Access-Control-Expose-Headers": "X-Request-Id",
  "Access-Control-Max-Age": "86400",
} as const;

export class PayloadTooLargeError extends Error {}
export class InvalidPayloadEncodingError extends Error {}

export function workbuddyRequestId(request: Request): string {
  const supplied = request.headers.get("x-request-id");
  if (supplied && supplied.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(supplied)) {
    return supplied;
  }
  return globalThis.crypto.randomUUID();
}

export function publicJson(body: unknown, requestId: string, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "X-Request-Id": requestId,
      ...WORKBUDDY_PUBLIC_CORS,
    },
  });
}

export function publicError(
  requestId: string,
  status: number,
  code: string,
  message: string,
): Response {
  return publicJson(
    {
      error: {
        code,
        message,
        request_id: requestId,
      },
    },
    requestId,
    status,
  );
}

export function workbuddyBearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer[ \t]+(.+)$/i);
  const token = match?.[1]?.trim();
  return token ? token : null;
}

export async function readBodyWithLimit(request: Request, maximumBytes: number): Promise<string> {
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

export function publicOptions(): Response {
  return new Response(null, { status: 204, headers: WORKBUDDY_PUBLIC_CORS });
}
