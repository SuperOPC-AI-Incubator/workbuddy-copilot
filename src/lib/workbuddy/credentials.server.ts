import { createHash } from "node:crypto";
import { z } from "zod";
import type { Database, Json } from "@/integrations/supabase/types";
import {
  InvalidWorkbuddyCredentialError,
  MissingWorkbuddyCredentialError,
  RevokedWorkbuddyCredentialError,
} from "./contracts";

export {
  InvalidWorkbuddyCredentialError,
  MissingWorkbuddyCredentialError,
  RevokedWorkbuddyCredentialError,
} from "./contracts";

type CredentialRpcArgs = Database["public"]["Functions"]["resolve_workbuddy_credential"]["Args"];

export interface WorkbuddyCredentialGateway {
  resolveWorkbuddyCredentialHash(tokenHash: string): Promise<{
    data: unknown;
    error: { code?: string; message?: string } | null;
  }>;
}

const CredentialResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("active"), student_id: z.string().uuid() }).strict(),
  z.object({ status: z.literal("revoked") }).strict(),
  z.object({ status: z.literal("invalid") }).strict(),
]);

export class WorkbuddyCredentialGatewayError extends Error {
  readonly code = "WORKBUDDY_CREDENTIAL_LOOKUP_FAILED";

  constructor() {
    super("WORKBUDDY_CREDENTIAL_LOOKUP_FAILED");
    this.name = "WorkbuddyCredentialGatewayError";
  }
}

function hashCredential(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export async function resolveWorkbuddyCredential(
  presentedToken: string,
  dependencies: {
    gateway: WorkbuddyCredentialGateway;
    sha256?: (value: string) => string;
  },
): Promise<{ studentId: string }> {
  if (presentedToken.length === 0) {
    throw new MissingWorkbuddyCredentialError();
  }
  if (presentedToken.length > 4_096) {
    throw new InvalidWorkbuddyCredentialError();
  }

  const tokenHash = (dependencies.sha256 ?? hashCredential)(presentedToken);
  const { data, error } = await dependencies.gateway.resolveWorkbuddyCredentialHash(tokenHash);
  if (error) throw new WorkbuddyCredentialGatewayError();

  const parsed = CredentialResultSchema.safeParse(data);
  if (!parsed.success) {
    throw new WorkbuddyCredentialGatewayError();
  }
  if (parsed.data.status === "invalid") {
    throw new InvalidWorkbuddyCredentialError();
  }
  if (parsed.data.status === "revoked") {
    throw new RevokedWorkbuddyCredentialError();
  }

  return { studentId: parsed.data.student_id };
}

type SupabaseCredentialRpcClient = {
  rpc(
    name: "resolve_workbuddy_credential",
    args: CredentialRpcArgs,
  ): PromiseLike<{
    data: Json | null;
    error: { code?: string; message: string } | null;
  }>;
};

export function createSupabaseWorkbuddyCredentialGateway(
  client: SupabaseCredentialRpcClient,
): WorkbuddyCredentialGateway {
  return {
    async resolveWorkbuddyCredentialHash(tokenHash) {
      const { data, error } = await client.rpc("resolve_workbuddy_credential", {
        _token_hash: tokenHash,
      });
      return {
        data,
        error: error ? { code: error.code, message: error.message } : null,
      };
    },
  };
}
