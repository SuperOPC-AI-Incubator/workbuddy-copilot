import { auth, defineMcp } from "@lovable.dev/mcp-js";
import callMentorTool from "./tools/call-mentor";
import getMySessionsTool from "./tools/get-my-sessions";
import logTurnTool from "./tools/log-turn";
import listStudentsTool from "./tools/list-students";
import listStudentSessionsTool from "./tools/list-student-sessions";
import getSessionTimelineTool from "./tools/get-session-timeline";
import replyAsMentorTool from "./tools/reply-as-mentor";

// The OAuth issuer MUST be the direct Supabase host, not the .lovable.cloud proxy.
// Only the project ref survives publish unchanged. Read via Vite's inlined literal.
const projectRef = import.meta.env.VITE_SUPABASE_PROJECT_ID ?? "project-ref-unset";

export default defineMcp({
  name: "workbuddy-copilot-mcp",
  title: "WorkBuddy Copilot",
  version: "0.2.0",
  instructions: [
    "本 MCP 用于把学员在 WorkBuddy 中的对话实时同步到导师观察台。",
    "",
    "【硬性规则 — 必须严格执行】",
    "1. 每收到学员的一条消息,你在生成最终回复之后,必须立即调用 `log_turn`,把本轮的 prompt 和 reply 一次性写入云端。这是本会话的强制职责,不是可选项。",
    "2. 为每一轮生成 event_id UUID；网络重试时必须复用该 event_id。为当前 WorkBuddy 对话生成一次 source_session_key，后续每轮持续复用。无需传数据库 session_id。",
    "3. 若你判定学员出现了知识误解、卡壳、或错误操作,请在 `log_turn` 中附上 `diagnosis`:{ text, severity: ok|warn|error }。error 会立刻触发导师端红色告警。",
    "4. 若学员明确请求人工帮助、或问题超出你的能力,调用 `call_mentor` 呼叫导师。",
    "5. 不要因为担心打扰用户而跳过 `log_turn` — 学员和导师都已知情并同意同步。",
    "",
    "所有工具通过 Supabase RLS 严格限制:每个学员账号只能读写自己的会话和 timeline;导师账号可读全部。",
  ].join("\n"),
  auth: auth.oauth.issuer({
    issuer: `https://${projectRef}.supabase.co/auth/v1`,
    acceptedAudiences: "authenticated",
  }),
  tools: [
    logTurnTool,
    getMySessionsTool,
    callMentorTool,
    listStudentsTool,
    listStudentSessionsTool,
    getSessionTimelineTool,
    replyAsMentorTool,
  ],
});
