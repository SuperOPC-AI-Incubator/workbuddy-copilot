import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { WorkbuddyEventConflictError } from "@/lib/workbuddy/contracts";
import { getMyStudent, unauth } from "./_supabase";

export default defineTool({
  name: "log_turn",
  title: "记录一轮对话 / Log a full turn",
  description:
    "**每一轮学员对话都必须调用此工具**。使用稳定的 event_id 去重，并以 source_session_key 将同一 WorkBuddy 对话持续映射到同一个云端会话。",
  inputSchema: {
    event_id: z.string().uuid().describe("本轮稳定 UUID；重试必须复用同一个值"),
    source_session_key: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .describe("当前 WorkBuddy 对话的稳定标识；同一对话的每轮必须复用"),
    session_title: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .optional()
      .describe("首次创建云端会话时显示的标题；不会参与会话复用判断"),
    prompt: z.string().trim().min(1).max(4000).describe("学员本轮的原始提问"),
    reply: z.string().trim().min(1).max(8000).describe("AI 本轮给学员的完整回复"),
    diagnosis: z
      .object({
        text: z.string().trim().min(1).max(2000),
        severity: z.enum(["ok", "warn", "error"]),
      })
      .optional()
      .describe("可选：AI 对学员当前状态的诊断"),
    client_created_at: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe("本轮发生时间；ISO 8601 格式"),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: async (
    { event_id, source_session_key, session_title, prompt, reply, diagnosis, client_created_at },
    ctx,
  ) => {
    if (!ctx.isAuthenticated()) return unauth();

    const { student } = await getMyStudent(ctx);
    if (!student) {
      return {
        content: [{ type: "text", text: "未找到当前登录账号对应的学员档案" }],
        isError: true,
      };
    }

    try {
      const [{ supabaseAdmin }, { createSupabaseWorkbuddyIngestGateway, ingestWorkbuddyTurn }] =
        await Promise.all([
          import("@/integrations/supabase/client.server"),
          import("@/lib/workbuddy/events.server"),
        ]);
      const gateway = createSupabaseWorkbuddyIngestGateway(supabaseAdmin);
      const result = await ingestWorkbuddyTurn(
        {
          // student.id came from the authenticated user's RLS-scoped lookup.
          // The MCP input never accepts a student or session database id.
          studentId: student.id,
          turn: {
            event_id,
            source: "mcp",
            source_session_key,
            session_title: session_title ?? "WorkBuddy 对话",
            prompt,
            reply,
            diagnosis,
            client_created_at,
          },
        },
        { gateway },
      );

      return {
        content: [
          {
            type: "text",
            text: result.duplicate
              ? `本轮已同步，无需重复写入（session=${result.session_id}）`
              : `已同步本轮对话（session=${result.session_id}）`,
          },
        ],
        structuredContent: {
          event_id: result.event_id,
          session_id: result.session_id,
          prompt_item_id: result.prompt_item_id,
          reply_item_id: result.reply_item_id,
          diagnosis_item_id: result.diagnosis_item_id,
          duplicate: result.duplicate,
        },
      };
    } catch (error) {
      if (error instanceof WorkbuddyEventConflictError) {
        return {
          content: [
            {
              type: "text",
              text: "event_id 已用于另一份内容，请为新的一轮生成新的 UUID",
            },
          ],
          isError: true,
        };
      }
      console.error("[WorkBuddy MCP] atomic log_turn failed");
      return {
        content: [{ type: "text", text: "同步失败，请使用相同 event_id 重试" }],
        isError: true,
      };
    }
  },
});
