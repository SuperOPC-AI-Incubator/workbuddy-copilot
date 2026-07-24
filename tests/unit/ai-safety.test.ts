import { afterEach, describe, expect, test, vi } from "vitest";

import {
  AI_PROVIDER_TIMEOUT_MS,
  AIProviderError,
  createMentorDraft,
  createMentorDraftFromEnvironment,
} from "@/lib/ai.server";

const MALICIOUS_PROVIDER_BODY =
  "PRIVATE_PROVIDER_BODY url=https://api.deepseek.com key=sk-never-return-this";

function timelineClient() {
  const query = {
    select: () => query,
    eq: () => query,
    order: () => query,
    limit: async () => ({
      data: [
        {
          kind: "prompt",
          text: "怎样继续？",
          tag: null,
          severity: null,
          created_at: "2026-07-24T00:00:00.000Z",
        },
      ],
      error: null,
    }),
  };
  return { from: () => query };
}

describe("AI provider safety", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("normalizes a malicious provider response without logging or returning its body, URL, or key", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(MALICIOUS_PROVIDER_BODY, { status: 502 })),
    );

    const failure = await createMentorDraft(
      timelineClient() as never,
      "30000000-0000-4000-8000-000000000001",
      "sk-local-secret",
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AIProviderError);
    expect(failure).toMatchObject({
      code: "AI_PROVIDER_UNAVAILABLE",
      message: "AI_PROVIDER_UNAVAILABLE",
    });
    expect(JSON.stringify(failure)).not.toContain(MALICIOUS_PROVIDER_BODY);
    expect(JSON.stringify(failure)).not.toContain("api.deepseek.com");
    expect(JSON.stringify(failure)).not.toContain("sk-local-secret");
    expect(JSON.stringify(warn.mock.calls)).not.toContain(MALICIOUS_PROVIDER_BODY);
    warn.mockRestore();
  });

  test("sanitizes a configured provider URL, credential, and response body", async () => {
    const providerUrl = "https://private-provider.example.test/v1/chat/completions";
    const providerKey = "private-generic-provider-key";
    const providerBody = "PRIVATE_GENERIC_PROVIDER_BODY";
    vi.stubEnv("AI_PROVIDER_API_KEY", providerKey);
    vi.stubEnv("AI_PROVIDER_URL", providerUrl);
    vi.stubEnv("AI_PROVIDER_MODEL", "private-model");
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(providerBody, { status: 502 })),
    );

    const failure = await createMentorDraftFromEnvironment(
      timelineClient() as never,
      "30000000-0000-4000-8000-000000000001",
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "AI_PROVIDER_UNAVAILABLE",
      message: "AI_PROVIDER_UNAVAILABLE",
    });
    const observable = JSON.stringify({ failure, logs: warn.mock.calls });
    expect(observable).not.toContain(providerUrl);
    expect(observable).not.toContain(providerKey);
    expect(observable).not.toContain(providerBody);
  });

  test("refuses redirects before an HTTPS provider can reach a second address", async () => {
    vi.stubEnv("AI_PROVIDER_API_KEY", "redirect-test-provider-key");
    vi.stubEnv("AI_PROVIDER_URL", "https://provider.example.test/v1/chat/completions");
    vi.stubEnv("AI_PROVIDER_MODEL", "redirect-test-model");
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    let reachedRedirectTarget = false;
    const fetchProvider = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.redirect !== "error") {
        reachedRedirectTarget = true;
        return Response.json({
          choices: [{ message: { content: "internal redirect target" } }],
        });
      }
      throw new TypeError("redirect blocked");
    });
    vi.stubGlobal("fetch", fetchProvider);

    await expect(
      createMentorDraftFromEnvironment(
        timelineClient() as never,
        "30000000-0000-4000-8000-000000000001",
      ),
    ).rejects.toBeInstanceOf(AIProviderError);
    expect(fetchProvider).toHaveBeenCalledOnce();
    expect(fetchProvider.mock.calls[0]?.[1]?.redirect).toBe("error");
    expect(reachedRedirectTarget).toBe(false);
  });

  test("aborts a never-resolving provider at the stable timeout and clears its timer", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("PRIVATE_ABORT_DETAIL", "AbortError"));
            });
          }),
      ),
    );

    const draft = createMentorDraft(
      timelineClient() as never,
      "30000000-0000-4000-8000-000000000001",
      "sk-timeout-secret",
    );
    const rejection = expect(draft).rejects.toMatchObject({
      code: "AI_PROVIDER_UNAVAILABLE",
      message: "AI_PROVIDER_UNAVAILABLE",
    });
    await vi.advanceTimersByTimeAsync(AI_PROVIDER_TIMEOUT_MS);

    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });
});
