const LEGACY_SUPABASE_JWT_PATTERN = /^eyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+$/;

export function applySupabaseApiKeyHeaders(headers: Headers, apiKey: string): Headers {
  const apiKeyAuthorization = `Bearer ${apiKey}`;
  headers.set("apikey", apiKey);

  if (LEGACY_SUPABASE_JWT_PATTERN.test(apiKey)) {
    if (!headers.has("Authorization")) {
      headers.set("Authorization", apiKeyAuthorization);
    }
  } else if (headers.get("Authorization") === apiKeyAuthorization) {
    headers.delete("Authorization");
  }

  return headers;
}
