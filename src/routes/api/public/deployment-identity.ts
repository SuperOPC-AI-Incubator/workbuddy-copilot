import { createFileRoute } from "@tanstack/react-router";

import { PUBLIC_SUPABASE_URL } from "@/integrations/supabase/public-config";
import { createDeploymentIdentityResponse } from "@/lib/deployment-identity";

export const Route = createFileRoute("/api/public/deployment-identity")({
  server: {
    handlers: {
      GET: async () =>
        createDeploymentIdentityResponse({
          serverUrl: process.env.SUPABASE_URL,
          browserUrl: PUBLIC_SUPABASE_URL,
        }),
    },
  },
});
