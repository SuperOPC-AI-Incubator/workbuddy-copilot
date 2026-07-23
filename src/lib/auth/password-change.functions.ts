import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const passwordChangeInput = z.object({
  newPassword: z.string().min(8).max(256),
});

export const changeOwnPassword = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => passwordChangeInput.parse(input))
  .handler(async ({ data, context }) => {
    const { changeOwnPasswordOnServer } = await import("./password-change.server");
    return changeOwnPasswordOnServer({
      userId: context.userId,
      newPassword: data.newPassword,
    });
  });
