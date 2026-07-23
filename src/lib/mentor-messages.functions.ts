import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  MENTOR_MESSAGE_MAX_CHARACTERS,
  countUnicodeCharacters,
} from "@/lib/workbuddy/mentor-message-contract";

const SendMentorMessageSchema = z
  .object({
    sessionId: z.string().uuid(),
    text: z
      .string()
      .trim()
      .min(1)
      .refine((value) => countUnicodeCharacters(value) <= MENTOR_MESSAGE_MAX_CHARACTERS),
    severity: z.enum(["ok", "warn", "error"]).nullable().optional(),
  })
  .strict();

export const sendMentorMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => SendMentorMessageSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { createMentorMessageOnServer } = await import("./mentor-messages.server");
    return createMentorMessageOnServer(context.userId, data);
  });
