import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
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

const SafeCredentialSchema = z
  .object({
    prefix: z.string().trim().min(4).max(24),
    status: z.enum(["active", "revoked"]),
    created_at: z.iso.datetime({ offset: true }),
    last_used_at: z.iso.datetime({ offset: true }).nullable(),
    revoked_at: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict()
  .superRefine((credential, context) => {
    if (
      (credential.status === "active" && credential.revoked_at !== null) ||
      (credential.status === "revoked" && credential.revoked_at === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "Invalid credential lifecycle",
      });
    }
  });

const CredentialStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("none"), credential: z.null() }).strict(),
  z
    .object({
      status: z.literal("active"),
      credential: SafeCredentialSchema,
    })
    .strict()
    .refine(({ credential }) => credential.status === "active"),
  z
    .object({
      status: z.literal("revoked"),
      credential: SafeCredentialSchema,
    })
    .strict()
    .refine(({ credential }) => credential.status === "revoked"),
]);

export type SafeWorkbuddyCredential = z.infer<typeof SafeCredentialSchema>;
export type WorkbuddyCredentialStatus = z.infer<typeof CredentialStatusSchema>;

export type CredentialManagementIssueArgs = {
  _user_id: string;
  _token_hash: string;
  _token_prefix: string;
  _rotate: boolean;
};

export interface CredentialManagementGateway {
  getStatus(userId: string): Promise<{
    data: unknown;
    error: { code?: string; message?: string } | null;
  }>;
  issue(args: CredentialManagementIssueArgs): Promise<{
    data: unknown;
    error: { code?: string; message?: string } | null;
  }>;
  revoke(userId: string): Promise<{
    data: unknown;
    error: { code?: string; message?: string } | null;
  }>;
}

export class CredentialManagementError extends Error {
  readonly code = "WORKBUDDY_CREDENTIAL_MANAGEMENT_FAILED";

  constructor() {
    super("WORKBUDDY_CREDENTIAL_MANAGEMENT_FAILED");
    this.name = "CredentialManagementError";
  }
}

function issueMaterial(randomBytes: (size: number) => Uint8Array): {
  token: string;
  tokenHash: string;
  tokenPrefix: string;
} {
  const entropy = randomBytes(32);
  if (entropy.byteLength !== 32) throw new CredentialManagementError();
  const token = `wb_${Buffer.from(entropy).toString("base64url")}`;
  return {
    token,
    tokenHash: hashCredential(token),
    tokenPrefix: token.slice(0, 11),
  };
}

function parseCredentialStatus(data: unknown): WorkbuddyCredentialStatus {
  const parsed = CredentialStatusSchema.safeParse(data);
  if (!parsed.success) throw new CredentialManagementError();
  return parsed.data;
}

export async function getOwnWorkbuddyCredentialStatus(
  input: { userId: string },
  dependencies: { gateway: CredentialManagementGateway },
): Promise<WorkbuddyCredentialStatus> {
  const userId = z.string().uuid().parse(input.userId);
  const { data, error } = await dependencies.gateway.getStatus(userId);
  if (error) throw new CredentialManagementError();
  return parseCredentialStatus(data);
}

async function issueOwnWorkbuddyCredential(
  input: { userId: string; rotate: boolean },
  dependencies: {
    gateway: CredentialManagementGateway;
    randomBytes?: (size: number) => Uint8Array;
  },
): Promise<{ token: string; credential: SafeWorkbuddyCredential }> {
  const userId = z.string().uuid().parse(input.userId);
  const material = issueMaterial(dependencies.randomBytes ?? nodeRandomBytes);
  const { data, error } = await dependencies.gateway.issue({
    _user_id: userId,
    _token_hash: material.tokenHash,
    _token_prefix: material.tokenPrefix,
    _rotate: input.rotate,
  });
  if (error) throw new CredentialManagementError();

  const status = parseCredentialStatus(data);
  if (status.status !== "active" || status.credential.prefix !== material.tokenPrefix) {
    throw new CredentialManagementError();
  }
  return { token: material.token, credential: status.credential };
}

export function createFirstWorkbuddyCredential(
  input: { userId: string },
  dependencies: {
    gateway: CredentialManagementGateway;
    randomBytes?: (size: number) => Uint8Array;
  },
) {
  return issueOwnWorkbuddyCredential({ userId: input.userId, rotate: false }, dependencies);
}

export function rotateOwnWorkbuddyCredential(
  input: { userId: string },
  dependencies: {
    gateway: CredentialManagementGateway;
    randomBytes?: (size: number) => Uint8Array;
  },
) {
  return issueOwnWorkbuddyCredential({ userId: input.userId, rotate: true }, dependencies);
}

export async function revokeOwnWorkbuddyCredential(
  input: { userId: string },
  dependencies: { gateway: CredentialManagementGateway },
): Promise<WorkbuddyCredentialStatus> {
  const userId = z.string().uuid().parse(input.userId);
  const { data, error } = await dependencies.gateway.revoke(userId);
  if (error) throw new CredentialManagementError();
  return parseCredentialStatus(data);
}

type SupabaseCredentialManagementRpcClient = {
  rpc(
    name:
      | "get_workbuddy_credential_status"
      | "issue_workbuddy_credential"
      | "revoke_workbuddy_credential",
    args: { _user_id: string } | CredentialManagementIssueArgs,
  ): PromiseLike<{
    data: Json | null;
    error: { code?: string; message: string } | null;
  }>;
};

export function createSupabaseCredentialManagementGateway(
  client: SupabaseCredentialManagementRpcClient,
): CredentialManagementGateway {
  return {
    async getStatus(userId) {
      const { data, error } = await client.rpc("get_workbuddy_credential_status", {
        _user_id: userId,
      });
      return { data, error };
    },
    async issue(args) {
      const { data, error } = await client.rpc("issue_workbuddy_credential", args);
      return { data, error };
    },
    async revoke(userId) {
      const { data, error } = await client.rpc("revoke_workbuddy_credential", {
        _user_id: userId,
      });
      return { data, error };
    },
  };
}

async function managementGateway() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return createSupabaseCredentialManagementGateway(supabaseAdmin);
}

export async function getOwnWorkbuddyCredentialStatusOnServer(userId: string) {
  return getOwnWorkbuddyCredentialStatus({ userId }, { gateway: await managementGateway() });
}

export async function createFirstWorkbuddyCredentialOnServer(userId: string) {
  return createFirstWorkbuddyCredential({ userId }, { gateway: await managementGateway() });
}

export async function rotateOwnWorkbuddyCredentialOnServer(userId: string) {
  return rotateOwnWorkbuddyCredential({ userId }, { gateway: await managementGateway() });
}

export async function revokeOwnWorkbuddyCredentialOnServer(userId: string) {
  return revokeOwnWorkbuddyCredential({ userId }, { gateway: await managementGateway() });
}
