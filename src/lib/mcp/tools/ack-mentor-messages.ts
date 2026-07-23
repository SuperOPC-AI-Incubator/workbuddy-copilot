import { defineTool, type ToolContext } from "@lovable.dev/mcp-js";
import { z } from "zod";

import {
  DeliveryGatewayError,
  DeliveryOwnershipError,
  acknowledgeMentorMessages,
  createSupabaseDeliveryGateway,
  type DeliveryGateway,
} from "@/lib/workbuddy/delivery.server";
import { getMyStudent } from "./_supabase";

const DisplayedMessageIdsSchema = z
  .array(z.string().uuid())
  .min(1)
  .max(100)
  .refine((ids) => new Set(ids).size === ids.length);

const AckInputShape = {
  displayed_message_ids: DisplayedMessageIdsSchema.describe(
    "已在上一条完成的 WorkBuddy 回复中逐字展示的导师消息 id；本轮新拉取的 id 不得传入",
  ),
  displayed_in_prior_completed_turn: z
    .literal(true)
    .describe("必须为 true，确认这些 id 已存在于上一条成功完成的回复中"),
};
const AckInputSchema = z.object(AckInputShape).strict();

export type McpMentorDeliveryDependencies = {
  resolveStudent(ctx: ToolContext): Promise<{ id: string } | null>;
  createGateway(): Promise<DeliveryGateway>;
};

const productionDependencies: McpMentorDeliveryDependencies = {
  async resolveStudent(ctx) {
    const { student } = await getMyStudent(ctx);
    return student ? { id: student.id } : null;
  },
  async createGateway() {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    return createSupabaseDeliveryGateway(supabaseAdmin);
  },
};

function errorResult(content: string, code: string, message: string, retryable: boolean) {
  return {
    content: [{ type: "text" as const, text: content }],
    structuredContent: { error: { code, message, retryable } },
    isError: true,
  };
}

export function createAckMentorMessagesTool(
  dependencies: McpMentorDeliveryDependencies = productionDependencies,
) {
  return defineTool({
    name: "ack_mentor_messages",
    title: "确认已展示的导师消息 / Acknowledge displayed mentor messages",
    description:
      "仅在新用户轮开始时调用：上一条已完成的 WorkBuddy 回复确实逐字展示过这些消息，才把 id 放入 displayed_message_ids，并传 displayed_in_prior_completed_turn=true。本轮刚拉取、未展示或回复中断的消息不得确认。",
    inputSchema: AckInputShape,
    outputSchema: {
      acknowledged: z
        .array(
          z
            .object({
              id: z.string().uuid(),
              acknowledged_at: z.iso.datetime({ offset: true }),
            })
            .strict(),
        )
        .optional(),
      error: z
        .object({
          code: z.string(),
          message: z.string(),
          retryable: z.boolean(),
        })
        .strict()
        .optional(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: async (input, ctx) => {
      if (!ctx.isAuthenticated()) {
        return errorResult("请先登录后再确认导师消息。", "AUTH_REQUIRED", "需要登录。", false);
      }

      const parsed = AckInputSchema.safeParse(input);
      if (!parsed.success) {
        return errorResult("导师消息确认失败：输入无效。", "INVALID_INPUT", "输入无效。", false);
      }

      try {
        const student = await dependencies.resolveStudent(ctx);
        if (!student) {
          return errorResult(
            "当前账号不能使用学员消息工具。",
            "NOT_AUTHORIZED",
            "当前账号不可用。",
            false,
          );
        }

        const gateway = await dependencies.createGateway();
        const result = await acknowledgeMentorMessages(
          {
            studentId: student.id,
            messageIds: parsed.data.displayed_message_ids,
          },
          { gateway },
        );

        return {
          content: [
            {
              type: "text" as const,
              text: `已确认 ${result.acknowledged.length} 条在上一条已完成回复中展示的导师消息。`,
            },
          ],
          structuredContent: result,
        };
      } catch (error) {
        if (error instanceof DeliveryOwnershipError) {
          return errorResult(
            "导师消息确认失败：消息编号无效。",
            "INVALID_MESSAGE_IDS",
            "消息编号无效。",
            false,
          );
        }
        if (error instanceof DeliveryGatewayError) {
          console.error("[WorkBuddy MCP] mentor delivery acknowledgement failed");
        } else {
          console.error("[WorkBuddy MCP] unexpected mentor delivery acknowledgement failure");
        }
        return errorResult(
          "导师消息确认暂时失败，请稍后重试。",
          "INTERNAL_ERROR",
          "导师消息服务暂时不可用。",
          true,
        );
      }
    },
  });
}

export default createAckMentorMessagesTool();
