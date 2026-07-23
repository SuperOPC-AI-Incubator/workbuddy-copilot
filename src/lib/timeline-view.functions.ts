import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const getTimelineDeliveryView = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => z.object({ sessionId: z.string().uuid() }).strict().parse(input))
  .handler(async ({ data, context }) => {
    const { loadTimelineDeliveryViewOnServer } = await import("./timeline-view.server");
    return loadTimelineDeliveryViewOnServer(context.userId, data.sessionId);
  });
