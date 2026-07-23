import { describe, expect, test, vi } from "vitest";

import {
  CredentialManagementError,
  createFirstWorkbuddyCredential,
  getOwnWorkbuddyCredentialStatus,
  revokeOwnWorkbuddyCredential,
  rotateOwnWorkbuddyCredential,
  type CredentialManagementGateway,
} from "@/lib/workbuddy/credentials.server";

const USER_ID = "50000000-0000-4000-8000-000000000001";
const FIXED_RANDOM = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const EXPECTED_TOKEN = "wb_AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA";
const EXPECTED_HASH = "7e582aadb13acef284cda6984479ea58f85472f2b02d489d257c865bf98b1da8";

class RecordingCredentialManagementGateway implements CredentialManagementGateway {
  statusCalls: string[] = [];
  issueCalls: Array<Parameters<CredentialManagementGateway["issue"]>[0]> = [];
  revokeCalls: string[] = [];
  statusResponse: Awaited<ReturnType<CredentialManagementGateway["getStatus"]>> = {
    data: { status: "none", credential: null },
    error: null,
  };
  issueResponse: Awaited<ReturnType<CredentialManagementGateway["issue"]>> = {
    data: {
      status: "active",
      credential: {
        prefix: "wb_AQIDBAUG",
        status: "active",
        created_at: "2026-07-23T10:00:00.000Z",
        last_used_at: null,
        revoked_at: null,
      },
    },
    error: null,
  };
  revokeResponse: Awaited<ReturnType<CredentialManagementGateway["revoke"]>> = {
    data: {
      status: "revoked",
      credential: {
        prefix: "wb_AQIDBAUG",
        status: "revoked",
        created_at: "2026-07-23T10:00:00.000Z",
        last_used_at: null,
        revoked_at: "2026-07-23T10:05:00.000Z",
      },
    },
    error: null,
  };

  async getStatus(userId: string) {
    this.statusCalls.push(userId);
    return this.statusResponse;
  }

  async issue(args: Parameters<CredentialManagementGateway["issue"]>[0]) {
    this.issueCalls.push(args);
    return this.issueResponse;
  }

  async revoke(userId: string) {
    this.revokeCalls.push(userId);
    return this.revokeResponse;
  }
}

describe("student WorkBuddy credential management", () => {
  test("creates a high-entropy token once and persists only its hash and safe prefix", async () => {
    const gateway = new RecordingCredentialManagementGateway();
    const randomBytes = vi.fn(() => FIXED_RANDOM);

    const result = await createFirstWorkbuddyCredential(
      { userId: USER_ID },
      { gateway, randomBytes },
    );

    expect(result.token).toBe(EXPECTED_TOKEN);
    expect(result.credential.prefix).toBe("wb_AQIDBAUG");
    expect(randomBytes).toHaveBeenCalledWith(32);
    expect(gateway.issueCalls).toEqual([
      {
        _user_id: USER_ID,
        _token_hash: EXPECTED_HASH,
        _token_prefix: "wb_AQIDBAUG",
        _rotate: false,
      },
    ]);
    expect(JSON.stringify(gateway.issueCalls)).not.toContain(EXPECTED_TOKEN);
    expect(JSON.stringify(result.credential)).not.toContain(EXPECTED_TOKEN);
  });

  test("never returns a token when the atomic database issue fails", async () => {
    const gateway = new RecordingCredentialManagementGateway();
    gateway.issueResponse = {
      data: null,
      error: { code: "23505", message: "workbuddy_active_credential_exists" },
    };

    await expect(
      createFirstWorkbuddyCredential(
        { userId: USER_ID },
        { gateway, randomBytes: () => FIXED_RANDOM },
      ),
    ).rejects.toBeInstanceOf(CredentialManagementError);
  });

  test("rotates atomically and returns the new plaintext only in that response", async () => {
    const gateway = new RecordingCredentialManagementGateway();
    const result = await rotateOwnWorkbuddyCredential(
      { userId: USER_ID },
      { gateway, randomBytes: () => FIXED_RANDOM },
    );

    expect(result.token).toBe(EXPECTED_TOKEN);
    expect(gateway.issueCalls[0]?._rotate).toBe(true);
    expect(Object.keys(result).sort()).toEqual(["credential", "token"]);
  });

  test("lists safe status and revokes idempotently without accepting student identity input", async () => {
    const gateway = new RecordingCredentialManagementGateway();

    await expect(
      getOwnWorkbuddyCredentialStatus({ userId: USER_ID }, { gateway }),
    ).resolves.toEqual({ status: "none", credential: null });
    const first = await revokeOwnWorkbuddyCredential({ userId: USER_ID }, { gateway });
    const second = await revokeOwnWorkbuddyCredential({ userId: USER_ID }, { gateway });

    expect(first).toEqual(second);
    expect(gateway.statusCalls).toEqual([USER_ID]);
    expect(gateway.revokeCalls).toEqual([USER_ID, USER_ID]);
    expect(JSON.stringify(first)).not.toMatch(/token|hash/i);
  });

  test("fails closed on malformed safe DTOs", async () => {
    const gateway = new RecordingCredentialManagementGateway();
    gateway.statusResponse = {
      data: {
        status: "active",
        credential: {
          prefix: "wb_secret_far_too_long_to_be_safe",
          status: "active",
          created_at: "not-a-date",
          last_used_at: null,
          revoked_at: null,
          token_hash: EXPECTED_HASH,
        },
      },
      error: null,
    };

    await expect(
      getOwnWorkbuddyCredentialStatus({ userId: USER_ID }, { gateway }),
    ).rejects.toBeInstanceOf(CredentialManagementError);
  });

  test("production random seam does not collapse to deterministic or short credentials", async () => {
    const gateway: CredentialManagementGateway = {
      async getStatus() {
        return { data: { status: "none", credential: null }, error: null };
      },
      async issue(args) {
        return {
          data: {
            status: "active",
            credential: {
              prefix: args._token_prefix,
              status: "active",
              created_at: "2026-07-23T10:00:00.000Z",
              last_used_at: null,
              revoked_at: null,
            },
          },
          error: null,
        };
      },
      async revoke() {
        return { data: { status: "none", credential: null }, error: null };
      },
    };
    const issued = new Set<string>();

    for (let index = 0; index < 32; index += 1) {
      const result = await rotateOwnWorkbuddyCredential({ userId: USER_ID }, { gateway });
      expect(result.token).toMatch(/^wb_[A-Za-z0-9_-]{43}$/);
      issued.add(result.token);
    }
    expect(issued.size).toBe(32);
  });
});
