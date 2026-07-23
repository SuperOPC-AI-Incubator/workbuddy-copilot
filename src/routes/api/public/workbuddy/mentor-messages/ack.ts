import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import {
  DeliveryGatewayError,
  DeliveryOwnershipError,
  type acknowledgeMentorMessages,
} from "@/lib/workbuddy/delivery.server";
import {
  InvalidWorkbuddyCredentialError,
  RevokedWorkbuddyCredentialError,
} from "@/lib/workbuddy/contracts";
import {
  InvalidPayloadEncodingError,
  PayloadTooLargeError,
  publicError,
  publicJson,
  publicOptions,
  readBodyWithLimit,
  workbuddyBearerToken,
  workbuddyRequestId,
} from "@/lib/workbuddy/public-route";

export const MAX_WORKBUDDY_ACK_BODY_BYTES = 20_000;

const AckBodySchema = z
  .object({
    message_ids: z
      .array(z.string().uuid())
      .min(1)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length),
  })
  .strict();

type AckResult = Awaited<ReturnType<typeof acknowledgeMentorMessages>>;

type MentorMessagesAckDependencies = {
  resolveCredential(presentedToken: string): Promise<{ studentId: string }>;
  acknowledgeMessages(input: { studentId: string; messageIds: string[] }): Promise<AckResult>;
  requestId?: (request: Request) => string;
  maximumBodyBytes?: number;
};

function unauthorized(requestId: string): Response {
  return publicError(requestId, 401, "UNAUTHORIZED", "Invalid WorkBuddy credential");
}

export function createMentorMessagesAckPostHandler(dependencies: MentorMessagesAckDependencies) {
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

    let rawBody: string;
    try {
      rawBody = await readBodyWithLimit(
        request,
        dependencies.maximumBodyBytes ?? MAX_WORKBUDDY_ACK_BODY_BYTES,
      );
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        return publicError(requestId, 413, "PAYLOAD_TOO_LARGE", "Payload too large");
      }
      if (error instanceof InvalidPayloadEncodingError) {
        return publicError(requestId, 400, "INVALID_PAYLOAD", "Invalid payload");
      }
      console.error(`[WorkBuddy delivery] body read failed request_id=${requestId}`);
      return publicError(requestId, 500, "INTERNAL_ERROR", "Internal server error");
    }

    let body: z.infer<typeof AckBodySchema>;
    try {
      body = AckBodySchema.parse(JSON.parse(rawBody));
    } catch {
      return publicError(requestId, 400, "INVALID_PAYLOAD", "Invalid payload");
    }

    try {
      const result = await dependencies.acknowledgeMessages({
        studentId,
        messageIds: body.message_ids,
      });
      return publicJson({ ok: true, request_id: requestId, ...result }, requestId);
    } catch (error) {
      if (error instanceof DeliveryOwnershipError) {
        return publicError(requestId, 400, "INVALID_MESSAGE_IDS", "Message IDs are invalid");
      }
      if (error instanceof DeliveryGatewayError) {
        console.error(`[WorkBuddy delivery] acknowledgement failed request_id=${requestId}`);
      } else {
        console.error(
          `[WorkBuddy delivery] unexpected acknowledgement failure request_id=${requestId}`,
        );
      }
      return publicError(requestId, 500, "INTERNAL_ERROR", "Internal server error");
    }
  };
}

async function post(request: Request): Promise<Response> {
  const requestId = workbuddyRequestId(request);
  try {
    const [
      { supabaseAdmin },
      { createSupabaseWorkbuddyCredentialGateway, resolveWorkbuddyCredential },
      { acknowledgeMentorMessages, createSupabaseDeliveryGateway },
    ] = await Promise.all([
      import("@/integrations/supabase/client.server"),
      import("@/lib/workbuddy/credentials.server"),
      import("@/lib/workbuddy/delivery.server"),
    ]);
    const credentialGateway = createSupabaseWorkbuddyCredentialGateway(supabaseAdmin);
    const deliveryGateway = createSupabaseDeliveryGateway(supabaseAdmin);

    return createMentorMessagesAckPostHandler({
      resolveCredential: (token) =>
        resolveWorkbuddyCredential(token, { gateway: credentialGateway }),
      acknowledgeMessages: (input) =>
        acknowledgeMentorMessages(input, { gateway: deliveryGateway }),
      requestId: () => requestId,
    })(request);
  } catch {
    console.error(`[WorkBuddy delivery] dependency initialization failed request_id=${requestId}`);
    return publicError(requestId, 500, "INTERNAL_ERROR", "Internal server error");
  }
}

export const Route = createFileRoute("/api/public/workbuddy/mentor-messages/ack")({
  server: {
    handlers: {
      OPTIONS: async () => publicOptions(),
      POST: async ({ request }) => post(request),
    },
  },
});
