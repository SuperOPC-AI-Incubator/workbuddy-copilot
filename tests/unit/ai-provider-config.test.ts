import { afterEach, describe, expect, test, vi } from "vitest";

import {
  AIProviderError,
  createMentorDraftFromEnvironment,
  isAIAvailableFromEnvironment,
} from "@/lib/ai.server";

const SESSION_ID = "30000000-0000-4000-8000-000000000001";
const GENERIC_KEY = "generic-provider-key-for-tests";
const TOKENHUB_URL = "https://tokenhub.tencentmaas.com/v1/chat/completions";

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

function successfulProvider() {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    Response.json({
      choices: [{ message: { content: "保持节奏，继续验证。" } }],
    }),
  );
}

function stubAIEnvironment(values: {
  genericKey?: string;
  legacyKey?: string;
  url?: string;
  model?: string;
  enableThinking?: string;
}) {
  vi.stubEnv("AI_PROVIDER_API_KEY", values.genericKey ?? "");
  vi.stubEnv("DEEPSEEK_API_KEY", values.legacyKey ?? "");
  vi.stubEnv("AI_PROVIDER_URL", values.url ?? "");
  vi.stubEnv("AI_PROVIDER_MODEL", values.model ?? "");
  vi.stubEnv("AI_PROVIDER_ENABLE_THINKING", values.enableThinking ?? "");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AI provider environment configuration", () => {
  test("a complete generic provider config is available without a DeepSeek credential", async () => {
    stubAIEnvironment({
      genericKey: GENERIC_KEY,
      url: TOKENHUB_URL,
      model: "qwen3.5-flash",
    });
    const fetchProvider = successfulProvider();
    vi.stubGlobal("fetch", fetchProvider);

    expect(isAIAvailableFromEnvironment()).toBe(true);
    await expect(
      createMentorDraftFromEnvironment(timelineClient() as never, SESSION_ID),
    ).resolves.toMatchObject({
      available: true,
      draft: "保持节奏，继续验证。",
    });

    expect(fetchProvider).toHaveBeenCalledOnce();
    expect(fetchProvider.mock.calls[0]?.[0]).toBe(TOKENHUB_URL);
    const init = fetchProvider.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "qwen3.5-flash",
    });
    expect(body).not.toHaveProperty("enable_thinking");
  });

  test("uses the configured HTTPS endpoint, model, and explicit thinking flag", async () => {
    stubAIEnvironment({
      genericKey: GENERIC_KEY,
      legacyKey: "legacy-deepseek-key-for-tests",
      url: TOKENHUB_URL,
      model: "qwen3.5-flash",
      enableThinking: "false",
    });
    const fetchProvider = successfulProvider();
    vi.stubGlobal("fetch", fetchProvider);

    await createMentorDraftFromEnvironment(timelineClient() as never, SESSION_ID);

    expect(fetchProvider).toHaveBeenCalledOnce();
    expect(fetchProvider.mock.calls[0]?.[0]).toBe(TOKENHUB_URL);
    const init = fetchProvider.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toMatchObject({
      authorization: `Bearer ${GENERIC_KEY}`,
    });
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "qwen3.5-flash",
      enable_thinking: false,
    });
  });

  test("keeps the legacy DeepSeek credential, endpoint, model, and request shape", async () => {
    stubAIEnvironment({ legacyKey: "legacy-deepseek-key-for-tests" });
    const fetchProvider = successfulProvider();
    vi.stubGlobal("fetch", fetchProvider);

    expect(isAIAvailableFromEnvironment()).toBe(true);
    await createMentorDraftFromEnvironment(timelineClient() as never, SESSION_ID);

    expect(fetchProvider.mock.calls[0]?.[0]).toBe("https://api.deepseek.com/v1/chat/completions");
    const init = fetchProvider.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.model).toBe("deepseek-chat");
    expect(body).not.toHaveProperty("enable_thinking");
  });

  test("returns unavailable when neither generic nor legacy credential exists", async () => {
    stubAIEnvironment({});
    const fetchProvider = successfulProvider();
    vi.stubGlobal("fetch", fetchProvider);

    expect(isAIAvailableFromEnvironment()).toBe(false);
    await expect(
      createMentorDraftFromEnvironment(timelineClient() as never, SESSION_ID),
    ).resolves.toEqual({
      available: false,
      code: "AI_UNAVAILABLE",
      message: "AI草稿暂不可用，人工导师功能不受影响",
      draft: "",
    });
    expect(fetchProvider).not.toHaveBeenCalled();
  });

  test.each([
    { label: "key only", values: { genericKey: GENERIC_KEY } },
    { label: "URL only", values: { url: TOKENHUB_URL } },
    { label: "model only", values: { model: "qwen3.5-flash" } },
    { label: "thinking only", values: { enableThinking: "false" } },
    {
      label: "partial generic plus legacy credential",
      values: {
        legacyKey: "legacy-deepseek-key-for-tests",
        genericKey: GENERIC_KEY,
        url: TOKENHUB_URL,
      },
    },
    {
      label: "whitespace generic credential plus legacy credential",
      values: {
        legacyKey: "legacy-deepseek-key-for-tests",
        genericKey: "   ",
      },
    },
  ])("rejects partial generic config before fetch: $label", async ({ values }) => {
    stubAIEnvironment(values);
    const fetchProvider = successfulProvider();
    vi.stubGlobal("fetch", fetchProvider);

    expect(() => isAIAvailableFromEnvironment()).toThrow(AIProviderError);
    await expect(
      createMentorDraftFromEnvironment(timelineClient() as never, SESSION_ID),
    ).rejects.toBeInstanceOf(AIProviderError);
    expect(fetchProvider).not.toHaveBeenCalled();
  });

  test.each([
    "http://tokenhub.tencentmaas.com/v1/chat/completions",
    "https://user:password@tokenhub.tencentmaas.com/v1/chat/completions",
  ])("rejects an unsafe provider URL before fetch: %s", async (url) => {
    stubAIEnvironment({
      genericKey: GENERIC_KEY,
      url,
      model: "qwen3.5-flash",
    });
    const fetchProvider = successfulProvider();
    vi.stubGlobal("fetch", fetchProvider);

    await expect(
      createMentorDraftFromEnvironment(timelineClient() as never, SESSION_ID),
    ).rejects.toBeInstanceOf(AIProviderError);
    expect(fetchProvider).not.toHaveBeenCalled();
  });

  test("accepts only literal true or false for the thinking flag", async () => {
    stubAIEnvironment({
      genericKey: GENERIC_KEY,
      url: TOKENHUB_URL,
      model: "qwen3.5-flash",
      enableThinking: "0",
    });
    const fetchProvider = successfulProvider();
    vi.stubGlobal("fetch", fetchProvider);

    await expect(
      createMentorDraftFromEnvironment(timelineClient() as never, SESSION_ID),
    ).rejects.toBeInstanceOf(AIProviderError);
    expect(fetchProvider).not.toHaveBeenCalled();
  });
});
