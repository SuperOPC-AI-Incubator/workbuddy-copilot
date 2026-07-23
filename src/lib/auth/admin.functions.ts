import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const createMentorInput = z.object({
  username: z.string().min(1).max(128),
  temporaryPassword: z.string().min(8).max(256),
  isTeamAdmin: z.boolean(),
});

const setActiveInput = z.object({
  targetUserId: z.string().uuid(),
  isActive: z.boolean(),
});

const resetPasswordInput = z.object({
  targetUserId: z.string().uuid(),
  temporaryPassword: z.string().min(8).max(256),
});

export const listMentors = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { listMentorsOnServer } = await import("./admin.server");
    return listMentorsOnServer(context.userId);
  });

export const createMentorAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => createMentorInput.parse(input))
  .handler(async ({ data, context }) => {
    const { createMentorOnServer } = await import("./admin.server");
    return createMentorOnServer({
      callerUserId: context.userId,
      username: data.username,
      temporaryPassword: data.temporaryPassword,
      isTeamAdmin: data.isTeamAdmin,
    });
  });

export const setMentorAccountActive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => setActiveInput.parse(input))
  .handler(async ({ data, context }) => {
    const { setMentorActiveOnServer } = await import("./admin.server");
    return setMentorActiveOnServer({
      callerUserId: context.userId,
      targetUserId: data.targetUserId,
      isActive: data.isActive,
    });
  });

export const resetMentorAccountPassword = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => resetPasswordInput.parse(input))
  .handler(async ({ data, context }) => {
    const { resetMentorTemporaryPasswordOnServer } = await import("./admin.server");
    return resetMentorTemporaryPasswordOnServer({
      callerUserId: context.userId,
      targetUserId: data.targetUserId,
      temporaryPassword: data.temporaryPassword,
    });
  });
