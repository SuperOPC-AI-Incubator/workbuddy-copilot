import { afterEach, describe, expect, test, vi } from "vitest";

import { AI_PROVIDER_TIMEOUT_MS, AIProviderError, createMentorDraft } from "@/lib/ai.server";

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
