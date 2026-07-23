import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";

export default defineTool({
  name: "ensure_active_session",
  title: "已停用 / Deprecated",
  description:
    "已停用：可靠 log_turn 不接受云端 session id。客户端应为本地对话维护稳定的 source_session_key。",
  inputSchema: {
    source_session_key: z.string().trim().min(1).max(255).optional(),
  },
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: async ({ source_session_key }) => {
    const suggestedKey = source_session_key ?? `workbuddy-conversation-${crypto.randomUUID()}`;
    return {
      content: [
        {
          type: "text",
          text: `此工具已停用。请直接调用 log_turn，并在同一段本地对话中复用 source_session_key=${suggestedKey}`,
        },
      ],
      structuredContent: {
        deprecated: true,
        source_session_key: suggestedKey,
      },
    };
  },
});
