import { auth, defineMcp } from "@lovable.dev/mcp-js";
import logPromptTool from "./tools/log-prompt";
import logReplyTool from "./tools/log-reply";
import logDiagnosisTool from "./tools/log-diagnosis";
import callMentorTool from "./tools/call-mentor";
import getMySessionsTool from "./tools/get-my-sessions";
import createSessionTool from "./tools/create-session";

// The OAuth issuer MUST be the direct Supabase host, not the .lovable.cloud proxy.
// Only the project ref survives publish unchanged. Read via Vite's inlined literal.
const projectRef = import.meta.env.VITE_SUPABASE_PROJECT_ID ?? "project-ref-unset";

export default defineMcp({
  name: "workbuddy-copilot-mcp",
  title: "WorkBuddy Copilot",
  version: "0.1.0",
  instructions:
    "工具用于将学员在 WorkBuddy 中的提问、AI 回复、诊断和呼叫导师事件同步到导师观察台。每个学员登录自己的 Supabase 账号后,所有工具仅在其自己的会话和 timeline 上操作。",
  auth: auth.oauth.issuer({
    issuer: `https://${projectRef}.supabase.co/auth/v1`,
    acceptedAudiences: "authenticated",
  }),
  tools: [
    createSessionTool,
    getMySessionsTool,
    logPromptTool,
    logReplyTool,
    logDiagnosisTool,
    callMentorTool,
  ],
});