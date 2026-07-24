import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";
import { resolveDomainPack } from "@/lib/domain-packs";

const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";
const DEEPSEEK_MODEL = "deepseek-chat";
export const AI_PROVIDER_TIMEOUT_MS = 20_000;

type ChatMsg = { role: "system" | "user" | "assistant"; content: string };
type SB = SupabaseClient<Database>;

type HistoryRow = {
  kind: "prompt" | "reply" | "diagnosis" | "mentor";
  text: string;
  tag: string | null;
  severity: "ok" | "warn" | "error" | null;
  created_at: string;
};

type StudentAnswer = {
  reply: string;
  diagnosis: string;
  severity: "ok" | "warn" | "error";
  tag: string;
};

const STUDENT_RESPONSE_CONTRACT = `请用简洁准确的中文回答（150 字以内）。
严格输出 JSON，字段：
{"reply": "给学员的答复", "diagnosis": "对学员掌握程度的简短诊断（30 字内）", "severity": "ok" | "warn" | "error", "tag": "可选的知识点标签，5 字内或空字符串"}
severity 规则：概念清晰=ok；有小误解=warn；涉及安全隐患或严重错误=error。`;

const MENTOR_RESPONSE_CONTRACT = "基于下方对话时间线，只输出提示正文，不要引号、不要前缀。";

export function aiUnavailableResult(mode: "draft"): {
  available: false;
  code: "AI_UNAVAILABLE";
  message: string;
  draft: "";
};
export function aiUnavailableResult(mode: "student"): {
  available: false;
  ok: false;
  code: "AI_UNAVAILABLE";
  message: string;
};
export function aiUnavailableResult(mode: "draft" | "student") {
  return mode === "draft"
    ? {
        available: false as const,
        code: "AI_UNAVAILABLE" as const,
        message: "AI草稿暂不可用，人工导师功能不受影响",
        draft: "" as const,
      }
    : {
        available: false as const,
        ok: false as const,
        code: "AI_UNAVAILABLE" as const,
        message: "AI 回答暂不可用，请稍后重试。",
      };
}

export function isAIAvailableFromEnvironment(): boolean {
  return providerConfigFromEnvironment() !== null;
}

export class AIProviderError extends Error {
  readonly code = "AI_PROVIDER_UNAVAILABLE";

  constructor() {
    super("AI_PROVIDER_UNAVAILABLE");
    this.name = "AIProviderError";
  }
}

export type AIProviderRuntime = {
  fetch?: typeof fetch;
  schedule?: (callback: () => void, delay: number) => unknown;
  clear?: (timer: unknown) => void;
};

type AIProviderConfig = {
  apiKey: string;
  url: string;
  model: string;
  enableThinking?: boolean;
};

function providerConfigFromEnvironment(): AIProviderConfig | null {
  const rawGenericApiKey = process.env.AI_PROVIDER_API_KEY;
  const rawGenericUrl = process.env.AI_PROVIDER_URL;
  const rawGenericModel = process.env.AI_PROVIDER_MODEL;
  const genericApiKey = rawGenericApiKey?.trim() || "";
  const genericUrl = rawGenericUrl?.trim() || "";
  const genericModel = rawGenericModel?.trim() || "";
  const thinking = process.env.AI_PROVIDER_ENABLE_THINKING;
  const genericConfigured = Boolean(
    (rawGenericApiKey !== undefined && rawGenericApiKey !== "") ||
    (rawGenericUrl !== undefined && rawGenericUrl !== "") ||
    (rawGenericModel !== undefined && rawGenericModel !== "") ||
    (thinking !== undefined && thinking !== ""),
  );
  if (!genericConfigured) {
    const legacyApiKey = process.env.DEEPSEEK_API_KEY?.trim() || "";
    return legacyApiKey
      ? {
          apiKey: legacyApiKey,
          url: DEEPSEEK_URL,
          model: DEEPSEEK_MODEL,
        }
      : null;
  }
  if (!genericApiKey || !genericUrl || !genericModel) {
    throw new AIProviderError();
  }

  let url: URL;
  try {
    url = new URL(genericUrl);
  } catch {
    throw new AIProviderError();
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new AIProviderError();
  }

  if (thinking !== undefined && thinking !== "" && thinking !== "true" && thinking !== "false") {
    throw new AIProviderError();
  }

  return {
    apiKey: genericApiKey,
    url: url.toString(),
    model: genericModel,
    ...(thinking === "true"
      ? { enableThinking: true }
      : thinking === "false"
        ? { enableThinking: false }
        : {}),
  };
}

async function callAIProvider(
  apiKey: string,
  messages: ChatMsg[],
  opts?: { json?: boolean; temperature?: number },
  runtime: AIProviderRuntime = {},
  provider: Omit<AIProviderConfig, "apiKey"> = {
    url: DEEPSEEK_URL,
    model: DEEPSEEK_MODEL,
  },
) {
  const fetchProvider = runtime.fetch ?? fetch;
  const schedule = runtime.schedule ?? ((callback, delay) => setTimeout(callback, delay));
  const clear = runtime.clear ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const controller = new AbortController();
  const timer = schedule(() => controller.abort(), AI_PROVIDER_TIMEOUT_MS);
  try {
    const res = await fetchProvider(provider.url, {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: provider.model,
        messages,
        temperature: opts?.temperature ?? 0.5,
        ...(provider.enableThinking === undefined
          ? {}
          : { enable_thinking: provider.enableThinking }),
        ...(opts?.json ? { response_format: { type: "json_object" } } : {}),
      }),
      signal: controller.signal,
    });

    if (!res.ok) throw new AIProviderError();

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return data.choices?.[0]?.message?.content?.trim() ?? "";
  } catch (error) {
    if (error instanceof AIProviderError) throw error;
    throw new AIProviderError();
  } finally {
    clear(timer);
  }
}

async function loadRecentTimeline(
  supabase: SB,
  sessionId: string,
  limit = 20,
): Promise<HistoryRow[]> {
  const { data, error } = await supabase
    .from("timeline_items")
    .select("kind, text, tag, severity, created_at")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return ((data ?? []) as HistoryRow[]).reverse();
}

export async function answerStudentPrompt(
  supabase: SB,
  sessionId: string,
  prompt: string,
  apiKey: string,
  providerRuntime?: AIProviderRuntime,
  providerConfig?: Omit<AIProviderConfig, "apiKey">,
): Promise<StudentAnswer> {
  const domainPack = resolveDomainPack(process.env.DOMAIN_PACK);
  const history = await loadRecentTimeline(supabase, sessionId, 12);
  const messages: ChatMsg[] = [
    {
      role: "system",
      content: `${domainPack.studentSystemContext}\n${STUDENT_RESPONSE_CONTRACT}`,
    },
    ...history.slice(0, -1).map<ChatMsg>((item) => ({
      role: item.kind === "prompt" ? "user" : "assistant",
      content: item.text,
    })),
    { role: "user", content: prompt },
  ];

  const raw = await callAIProvider(
    apiKey,
    messages,
    { json: true, temperature: 0.4 },
    providerRuntime,
    providerConfig,
  );
  type Parsed = { reply?: string; diagnosis?: string; severity?: string; tag?: string };
  let parsed: Parsed = {};
  const tryParse = (s: string): Parsed | null => {
    try {
      return JSON.parse(s) as Parsed;
    } catch {
      return null;
    }
  };
  if (raw) {
    parsed = tryParse(raw) ?? {};
    if (!parsed.reply) {
      // Attempt to extract JSON object substring
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) parsed = tryParse(match[0]) ?? parsed;
    }
  }
  if (!parsed.reply) {
    // Fallback: treat entire raw text as reply
    return {
      reply: raw?.trim() || "AI 暂无回复，请稍后重试。",
      diagnosis: "",
      severity: "ok",
      tag: "",
    };
  }

  return {
    reply: parsed.reply.trim(),
    diagnosis: parsed.diagnosis?.trim() ?? "",
    severity: parsed.severity === "warn" || parsed.severity === "error" ? parsed.severity : "ok",
    tag: parsed.tag?.trim() ?? "",
  };
}

export async function createMentorDraft(
  supabase: SB,
  sessionId: string,
  apiKey: string,
  providerRuntime?: AIProviderRuntime,
  providerConfig?: Omit<AIProviderConfig, "apiKey">,
): Promise<string> {
  const domainPack = resolveDomainPack(process.env.DOMAIN_PACK);
  const history = await loadRecentTimeline(supabase, sessionId, 16);
  if (history.length === 0) return "";

  const transcript = history
    .map((item) => {
      const role =
        item.kind === "prompt"
          ? "学员"
          : item.kind === "reply"
            ? "AI"
            : item.kind === "diagnosis"
              ? "诊断"
              : "导师";
      return `[${role}] ${item.text}`;
    })
    .join("\n");

  return callAIProvider(
    apiKey,
    [
      {
        role: "system",
        content: `${domainPack.mentorSystemContext}\n${MENTOR_RESPONSE_CONTRACT}`,
      },
      { role: "user", content: transcript },
    ],
    { temperature: 0.6 },
    providerRuntime,
    providerConfig,
  );
}

export async function answerStudentPromptFromEnvironment(
  supabase: SB,
  sessionId: string,
  prompt: string,
) {
  const provider = providerConfigFromEnvironment();
  if (!provider) return aiUnavailableResult("student");
  const { apiKey, ...providerConfig } = provider;
  return {
    available: true as const,
    answer: await answerStudentPrompt(
      supabase,
      sessionId,
      prompt,
      apiKey,
      undefined,
      providerConfig,
    ),
  };
}

export async function createMentorDraftFromEnvironment(supabase: SB, sessionId: string) {
  const provider = providerConfigFromEnvironment();
  if (!provider) return aiUnavailableResult("draft");
  const { apiKey, ...providerConfig } = provider;
  return {
    available: true as const,
    draft: await createMentorDraft(supabase, sessionId, apiKey, undefined, providerConfig),
  };
}
