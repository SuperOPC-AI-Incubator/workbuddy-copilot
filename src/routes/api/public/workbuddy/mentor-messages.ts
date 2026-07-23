import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import {
  DeliveryGatewayError,
  DeliverySessionError,
  InvalidDeliveryCursorError,
  decodeDeliveryCursor,
  type WorkbuddyMentorMessagePage,
} from "@/lib/workbuddy/delivery.server";
import {
  InvalidWorkbuddyCredentialError,
  RevokedWorkbuddyCredentialError,
} from "@/lib/workbuddy/contracts";
import {
  publicError,
  publicJson,
  publicOptions,
  workbuddyBearerToken,
  workbuddyRequestId,
} from "@/lib/workbuddy/public-route";

const QuerySchema = z
  .object({
    session_id: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(2_000).optional(),
  })
  .strict();

type MentorMessagesGetDependencies = {
  resolveCredential(presentedToken: string): Promise<{ studentId: string }>;
  fetchMessages(input: {
    studentId: string;
    sessionId?: string;
    limit: number;
    cursor?: string;
  }): Promise<WorkbuddyMentorMessagePage>;
  requestId?: (request: Request) => string;
};

function parseQuery(request: Request) {
  const params = new URL(request.url).searchParams;
  const keys = [...new Set(params.keys())];
  if (
    keys.some((key) => !["session_id", "limit", "cursor"].includes(key)) ||
    keys.some((key) => params.getAll(key).length !== 1)
  ) {
    return null;
  }

  const candidate = Object.fromEntries(params.entries());
  const parsed = QuerySchema.safeParse(candidate);
  if (!parsed.success) return null;
  if (parsed.data.cursor) {
    try {
      decodeDeliveryCursor(parsed.data.cursor);
    } catch {
      return null;
    }
  }
  return parsed.data;
}

function unauthorized(requestId: string): Response {
  return publicError(requestId, 401, "UNAUTHORIZED", "Invalid WorkBuddy credential");
}

export function createMentorMessagesGetHandler(dependencies: MentorMessagesGetDependencies) {
  return async (request: Request): Promise<Response> => {
    const requestId = (dependencies.requestId ?? workbuddyRequestId)(request);
    const token = workbuddyBearerToken(request);
    if (!token) return unauthorized(requestId);

    let studentId: string;
    try {
      ({ studentId } = await dependencies.resolveCredential(token));
    } catch (error) {
      if (
        error instanceof InvalidWorkbuddyCredentialError ||
        error instanceof RevokedWorkbuddyCredentialError
      ) {
        return unauthorized(requestId);
      }
      console.error(`[WorkBuddy delivery] credential lookup failed request_id=${requestId}`);
      return publicError(requestId, 500, "INTERNAL_ERROR", "Internal server error");
    }

    const query = parseQuery(request);
    if (!query) {
      return publicError(requestId, 400, "INVALID_QUERY", "Invalid query parameters");
    }

    try {
      const page = await dependencies.fetchMessages({
        studentId,
        sessionId: query.session_id,
        limit: query.limit,
        cursor: query.cursor,
      });
      return publicJson({ ok: true, request_id: requestId, ...page }, requestId);
    } catch (error) {
      if (error instanceof InvalidDeliveryCursorError) {
        return publicError(requestId, 400, "INVALID_QUERY", "Invalid query parameters");
      }
      if (error instanceof DeliverySessionError) {
        return publicError(requestId, 400, "INVALID_SESSION", "Session is invalid");
      }
      if (error instanceof DeliveryGatewayError) {
        console.error(`[WorkBuddy delivery] fetch failed request_id=${requestId}`);
      } else {
        console.error(`[WorkBuddy delivery] unexpected fetch failure request_id=${requestId}`);
      }
      return publicError(requestId, 500, "INTERNAL_ERROR", "Internal server error");
    }
  };
}

async function get(request: Request): Promise<Response> {
  const requestId = workbuddyRequestId(request);
  try {
    const [
      { supabaseAdmin },
      { createSupabaseWorkbuddyCredentialGateway, resolveWorkbuddyCredential },
      { createSupabaseDeliveryGateway, fetchPendingMentorMessages },
    ] = await Promise.all([
      import("@/integrations/supabase/client.server"),
      import("@/lib/workbuddy/credentials.server"),
      import("@/lib/workbuddy/delivery.server"),
    ]);
    const credentialGateway = createSupabaseWorkbuddyCredentialGateway(supabaseAdmin);
    const deliveryGateway = createSupabaseDeliveryGateway(supabaseAdmin);

    return createMentorMessagesGetHandler({
      resolveCredential: (token) =>
        resolveWorkbuddyCredential(token, { gateway: credentialGateway }),
      fetchMessages: (input) => fetchPendingMentorMessages(input, { gateway: deliveryGateway }),
      requestId: () => requestId,
    })(request);
  } catch {
    console.error(`[WorkBuddy delivery] dependency initialization failed request_id=${requestId}`);
    return publicError(requestId, 500, "INTERNAL_ERROR", "Internal server error");
  }
}

export const mentorMessagesOptions = publicOptions;

export const Route = createFileRoute("/api/public/workbuddy/mentor-messages")({
  server: {
    handlers: {
      OPTIONS: async () => mentorMessagesOptions(),
      GET: async ({ request }) => get(request),
    },
  },
});
