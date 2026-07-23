import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const getWorkbuddyCredentialStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { getOwnWorkbuddyCredentialStatusOnServer } = await import("./credentials.server");
    return getOwnWorkbuddyCredentialStatusOnServer(context.userId);
  });

export const createWorkbuddyCredential = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { createFirstWorkbuddyCredentialOnServer } = await import("./credentials.server");
    return createFirstWorkbuddyCredentialOnServer(context.userId);
  });

export const rotateWorkbuddyCredential = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { rotateOwnWorkbuddyCredentialOnServer } = await import("./credentials.server");
    return rotateOwnWorkbuddyCredentialOnServer(context.userId);
  });

export const revokeWorkbuddyCredential = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { revokeOwnWorkbuddyCredentialOnServer } = await import("./credentials.server");
    return revokeOwnWorkbuddyCredentialOnServer(context.userId);
  });
