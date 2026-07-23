import { describe, expect, test } from "vitest";

import {
  createMaskedTtyPasswordReader,
  parseBootstrapArguments,
  runMentorBootstrap,
  type BootstrapMentorService,
  type PasswordReader,
} from "../../scripts/bootstrap-mentors";

const fixturePassword = ["fixture", "bootstrap", "8!"].join("-");

function createService(existing: string[] = []) {
  const calls: Array<{
    username: string;
    temporaryPassword: string;
    isTeamAdmin: boolean;
  }> = [];
  const service: BootstrapMentorService = {
    async listMentors() {
      return existing.map((username, index) => ({
        userId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        username,
        active: true,
        mustChangePassword: false,
        lastLoginAt: null,
        roles: ["mentor"],
        createdAt: "2026-07-20T08:00:00.000Z",
        disabledAt: null,
      }));
    },
    async createMentor(input) {
      calls.push(input);
      return {
        userId: `aaaaaaaa-aaaa-4aaa-8aaa-${String(calls.length).padStart(12, "0")}`,
        username: input.username,
        isActive: true,
        mustChangePassword: true,
        roles: input.isTeamAdmin ? ["mentor", "team_admin"] : ["mentor"],
        createdAt: "2026-07-23T08:00:00.000Z",
        disabledAt: null,
      };
    },
  };
  return { calls, service };
}

describe("mentor bootstrap", () => {
  test("uses the injected masked password reader only for missing usernames", async () => {
    const { calls, service } = createService(["existing.fixture"]);
    const prompts: string[] = [];
    const passwordReader: PasswordReader = {
      async readPassword(prompt) {
        prompts.push(prompt);
        return fixturePassword;
      },
    };

    const result = await runMentorBootstrap({
      config: {
        usernames: ["existing.fixture", "new.fixture"],
        adminUsername: "new.fixture",
      },
      passwordReader,
      service,
      logger: { info() {} },
    });

    expect(prompts).toEqual(["请输入 new.fixture 的临时密码："]);
    expect(calls).toEqual([
      {
        username: "new.fixture",
        temporaryPassword: fixturePassword,
        isTeamAdmin: true,
      },
    ]);
    expect(result).toEqual({
      created: ["new.fixture"],
      skipped: ["existing.fixture"],
    });
  });

  test("normalizes and de-duplicates input while assigning only the explicit admin", async () => {
    const { calls, service } = createService();
    const passwordReader: PasswordReader = {
      async readPassword() {
        return fixturePassword;
      },
    };

    await runMentorBootstrap({
      config: {
        usernames: [" MENTOR.ONE ", "mentor.one", "ADMIN.ONE"],
        adminUsername: " admin.one ",
      },
      passwordReader,
      service,
      logger: { info() {} },
    });

    expect(calls.map(({ username, isTeamAdmin }) => ({ username, isTeamAdmin }))).toEqual([
      { username: "mentor.one", isTeamAdmin: false },
      { username: "admin.one", isTeamAdmin: true },
    ]);
  });

  test("never resets or requests a password for an existing account on rerun", async () => {
    const { calls, service } = createService(["mentor.one", "admin.one"]);
    let reads = 0;

    const result = await runMentorBootstrap({
      config: {
        usernames: ["mentor.one", "admin.one"],
        adminUsername: "admin.one",
      },
      passwordReader: {
        async readPassword() {
          reads += 1;
          return fixturePassword;
        },
      },
      service,
      logger: { info() {} },
    });

    expect(reads).toBe(0);
    expect(calls).toEqual([]);
    expect(result.created).toEqual([]);
    expect(result.skipped).toEqual(["mentor.one", "admin.one"]);
  });

  test("keeps passwords out of accepted CLI arguments, logs, and results", async () => {
    expect(
      parseBootstrapArguments([
        "--usernames-json",
        '["mentor.fixture"]',
        "--admin-username",
        "mentor.fixture",
      ]),
    ).toEqual({
      usernames: ["mentor.fixture"],
      adminUsername: "mentor.fixture",
    });
    expect(() =>
      parseBootstrapArguments([
        "--usernames-json",
        '["mentor.fixture"]',
        "--admin-username",
        "mentor.fixture",
        "--password",
        fixturePassword,
      ]),
    ).toThrow("不允许通过命令行传入密码");

    const { service } = createService();
    const logs: string[] = [];
    const result = await runMentorBootstrap({
      config: {
        usernames: ["mentor.fixture"],
        adminUsername: "mentor.fixture",
      },
      passwordReader: {
        async readPassword() {
          return fixturePassword;
        },
      },
      service,
      logger: {
        info(message) {
          logs.push(message);
        },
      },
    });

    expect(JSON.stringify(result)).not.toContain(fixturePassword);
    expect(logs.join("\n")).not.toContain(fixturePassword);
  });

  test("fails closed when the password input is not a TTY", async () => {
    const reader = createMaskedTtyPasswordReader({
      stdin: {
        isTTY: false,
        setRawMode() {},
        resume() {},
        pause() {},
        on() {
          return this;
        },
        off() {
          return this;
        },
      },
      output: {
        write() {
          return true;
        },
      },
    });

    await expect(reader.readPassword("临时密码：")).rejects.toThrow(
      "密码必须通过交互式 TTY 安全输入",
    );
  });

  test("scrubs service failures and never logs an upstream secret-bearing error", async () => {
    const logs: string[] = [];
    const service: BootstrapMentorService = {
      async listMentors() {
        return [];
      },
      async createMentor() {
        throw new Error(`unsafe upstream ${fixturePassword} internal@example.invalid`);
      },
    };

    const operation = runMentorBootstrap({
      config: {
        usernames: ["mentor.fixture"],
        adminUsername: "mentor.fixture",
      },
      passwordReader: {
        async readPassword() {
          return fixturePassword;
        },
      },
      service,
      logger: {
        info(message) {
          logs.push(message);
        },
      },
    });

    await expect(operation).rejects.toThrow("导师账号初始化失败");
    await expect(operation).rejects.not.toThrow(fixturePassword);
    await expect(operation).rejects.not.toThrow("internal@example.invalid");
    expect(logs.join("\n")).not.toContain(fixturePassword);
    expect(logs.join("\n")).not.toContain("internal@example.invalid");
  });
});
