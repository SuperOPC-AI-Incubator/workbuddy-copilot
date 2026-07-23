import { pathToFileURL } from "node:url";

import {
  createProductionMentorAdminService,
  type CreatedMentorAccount,
  type MentorAccountDto,
} from "../src/lib/auth/admin.server";
import { normalizeMentorUsername } from "../src/lib/auth/identifiers";

export type BootstrapConfig = {
  usernames: string[];
  adminUsername: string;
};

export interface PasswordReader {
  readPassword(prompt: string): Promise<string>;
}

export interface BootstrapMentorService {
  listMentors(): Promise<MentorAccountDto[]>;
  createMentor(input: {
    username: string;
    temporaryPassword: string;
    isTeamAdmin: boolean;
  }): Promise<CreatedMentorAccount>;
}

export interface BootstrapLogger {
  info(message: string): void;
}

type TtyInput = {
  isTTY?: boolean;
  setRawMode(enabled: boolean): void;
  resume(): void;
  pause(): void;
  on(event: string, listener: (chunk: Buffer | string) => void): unknown;
  off(event: string, listener: (chunk: Buffer | string) => void): unknown;
};

type TtyOutput = {
  write(chunk: string): unknown;
};

export function createMaskedTtyPasswordReader({
  stdin = process.stdin,
  output = process.stderr,
}: {
  stdin?: TtyInput;
  output?: TtyOutput;
} = {}): PasswordReader {
  return {
    async readPassword(prompt) {
      if (!stdin.isTTY) {
        throw new Error("密码必须通过交互式 TTY 安全输入");
      }

      output.write(prompt);
      stdin.setRawMode(true);
      stdin.resume();

      return new Promise<string>((resolve, reject) => {
        let password = "";

        const finish = (error?: Error) => {
          stdin.off("data", onData);
          stdin.setRawMode(false);
          stdin.pause();
          output.write("\n");
          if (error) reject(error);
          else resolve(password);
        };

        const onData = (chunk: Buffer | string) => {
          const value = chunk.toString();
          if (value === "\u0003") {
            finish(new Error("导师账号初始化已取消"));
            return;
          }
          if (value === "\r" || value === "\n") {
            finish();
            return;
          }
          if (value === "\u007f" || value === "\b") {
            if (password.length > 0) {
              password = password.slice(0, -1);
              output.write("\b \b");
            }
            return;
          }

          const printable = [...value].filter((character) => character >= " ").join("");
          if (printable) {
            password += printable;
            output.write("*".repeat([...printable].length));
          }
        };

        stdin.on("data", onData);
      });
    },
  };
}

export function parseBootstrapArguments(argv: string[]): BootstrapConfig {
  if (argv.some((argument) => argument.toLowerCase().includes("password"))) {
    throw new Error("不允许通过命令行传入密码");
  }

  let usernamesJson: string | undefined;
  let adminUsername: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--usernames-json") {
      usernamesJson = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument === "--admin-username") {
      adminUsername = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error("初始化参数无效");
  }

  if (!usernamesJson || !adminUsername) {
    throw new Error("必须提供导师用户名列表和管理员用户名");
  }

  let usernames: unknown;
  try {
    usernames = JSON.parse(usernamesJson);
  } catch {
    throw new Error("导师用户名 JSON 格式无效");
  }
  if (
    !Array.isArray(usernames) ||
    usernames.length === 0 ||
    usernames.some((username) => typeof username !== "string")
  ) {
    throw new Error("导师用户名列表无效");
  }

  return {
    usernames,
    adminUsername,
  };
}

function normalizedConfig(config: BootstrapConfig): BootstrapConfig {
  const usernames = [...new Set(config.usernames.map(normalizeMentorUsername))];
  const adminUsername = normalizeMentorUsername(config.adminUsername);
  if (!usernames.includes(adminUsername)) {
    throw new Error("管理员用户名必须包含在导师用户名列表中");
  }
  return { usernames, adminUsername };
}

export async function runMentorBootstrap({
  config,
  passwordReader,
  service,
  logger,
}: {
  config: BootstrapConfig;
  passwordReader: PasswordReader;
  service: BootstrapMentorService;
  logger: BootstrapLogger;
}): Promise<{ created: string[]; skipped: string[] }> {
  const normalized = normalizedConfig(config);
  let existing: MentorAccountDto[];
  try {
    existing = await service.listMentors();
  } catch {
    throw new Error("导师账号初始化失败");
  }

  const existingUsernames = new Set(existing.map(({ username }) => username));
  const created: string[] = [];
  const skipped: string[] = [];

  for (const username of normalized.usernames) {
    if (existingUsernames.has(username)) {
      skipped.push(username);
      logger.info("已跳过一个现有导师账号");
      continue;
    }

    let temporaryPassword: string;
    try {
      temporaryPassword = await passwordReader.readPassword(`请输入 ${username} 的临时密码：`);
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === "密码必须通过交互式 TTY 安全输入" ||
          error.message === "导师账号初始化已取消")
      ) {
        throw error;
      }
      throw new Error("导师账号初始化失败");
    }
    if (temporaryPassword.length < 6 || temporaryPassword.length > 256) {
      throw new Error("临时密码长度必须为 6–256 个字符");
    }

    try {
      await service.createMentor({
        username,
        temporaryPassword,
        isTeamAdmin: username === normalized.adminUsername,
      });
    } catch {
      throw new Error("导师账号初始化失败");
    } finally {
      temporaryPassword = "";
    }

    created.push(username);
    existingUsernames.add(username);
    logger.info("已创建一个导师账号");
  }

  return { created, skipped };
}

async function productionService(): Promise<BootstrapMentorService> {
  const service = await createProductionMentorAdminService({
    allowTrustedBootstrap: true,
  });
  return {
    listMentors() {
      return service.listMentors({ actor: { kind: "trusted_bootstrap" } });
    },
    createMentor(input) {
      return service.createMentor({
        actor: { kind: "trusted_bootstrap" },
        ...input,
      });
    },
  };
}

async function main(): Promise<void> {
  const config = parseBootstrapArguments(process.argv.slice(2));
  const result = await runMentorBootstrap({
    config,
    passwordReader: createMaskedTtyPasswordReader(),
    service: await productionService(),
    logger: console,
  });
  console.info(
    `导师账号初始化完成：创建 ${result.created.length} 个，跳过 ${result.skipped.length} 个。`,
  );
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  main().catch((error) => {
    const message =
      error instanceof Error &&
      [
        "不允许通过命令行传入密码",
        "初始化参数无效",
        "必须提供导师用户名列表和管理员用户名",
        "导师用户名 JSON 格式无效",
        "导师用户名列表无效",
        "管理员用户名必须包含在导师用户名列表中",
        "密码必须通过交互式 TTY 安全输入",
        "导师账号初始化已取消",
        "临时密码长度必须为 6–256 个字符",
      ].includes(error.message)
        ? error.message
        : "导师账号初始化失败";
    console.error(message);
    process.exitCode = 1;
  });
}
