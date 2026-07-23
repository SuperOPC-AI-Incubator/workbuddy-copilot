import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const root = process.cwd();
const macInstaller = resolve(root, "connectors/install-macos.sh");
const windowsInstaller = resolve(root, "connectors/install-windows.ps1");
const connectorSource = resolve(root, "connectors/workbuddy-sync.mjs");
const gitAttributes = resolve(root, ".gitattributes");
const skillSource = resolve(root, "connectors/SKILL.md");
const setupRoute = resolve(root, "src/routes/_authenticated/workbuddy.tsx");
const mcpReachability = resolve(root, "src/lib/workbuddy/mcp-reachability.ts");

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true })));
});

async function runInstallerWithInput(
  executable: string,
  args: string[],
  input: string,
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", rejectRun);
    child.once("exit", (code) => {
      if (code === 0) resolveRun({ stdout, stderr });
      else rejectRun(new Error(`installer exited ${code}: ${stderr}`));
    });
    child.stdin.end(input);
  });
}

describe("fallback connector installers", () => {
  test("POSIX installer is idempotent, keeps user-only permissions, and installs a token-free SKILL", async () => {
    if (process.platform === "win32") return;
    const home = await mkdtemp(join(tmpdir(), "superbrain-installer-home-"));
    cleanup.push(home);
    await chmod(macInstaller, 0o755);
    let installOutput = "";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await runInstallerWithInput(
        macInstaller,
        ["--api-url", "https://copilot.example.test", "--no-schedule"],
        attempt === 0 ? "wb_installer_secret\n" : "",
        {
          env: {
            ...process.env,
            HOME: home,
            XDG_STATE_HOME: join(home, ".state"),
          },
        }.env,
      );
      installOutput += `${result.stdout}${result.stderr}`;
      if (attempt === 0) {
        await chmod(join(home, ".state", "superbrain-copilot"), 0o755);
        await chmod(join(home, ".state", "superbrain-copilot", "config.json"), 0o644);
      }
    }

    const installRoot = join(home, ".local", "share", "superbrain-copilot");
    const stateRoot = join(home, ".state", "superbrain-copilot");
    const installedSkillPath = join(home, ".workbuddy", "skills", "superbrain-sync", "SKILL.md");
    const wrapper = join(home, ".local", "bin", "workbuddy-sync");
    const installedSkill = await readFile(installedSkillPath, "utf8");
    expect(installedSkill).not.toContain("wb_installer_secret");
    expect(installedSkill).toContain(wrapper);
    expect(installedSkill).not.toContain("__WORKBUDDY_CONNECTOR_ENTRYPOINT__");
    expect(installOutput).toContain(installedSkillPath);
    expect(installOutput).toMatch(/restart WorkBuddy/i);
    expect((await stat(stateRoot)).mode & 0o777).toBe(0o700);
    expect((await stat(join(stateRoot, "config.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(installedSkillPath)).mode & 0o777).toBe(0o600);
    expect((await stat(wrapper)).mode & 0o777).toBe(0o700);
    expect(installedSkill).not.toMatch(/(^|[\s`])workbuddy-sync\.mjs(?:[\s`]|$)/m);
    expect(await readFile(join(installRoot, "workbuddy-sync.mjs"), "utf8")).toBe(
      await readFile(connectorSource, "utf8"),
    );

    const environmentWithoutXdg: NodeJS.ProcessEnv = { ...process.env, HOME: home };
    delete environmentWithoutXdg.XDG_STATE_HOME;
    const status = await runInstallerWithInput(wrapper, ["status"], "", {
      ...environmentWithoutXdg,
    });
    expect(JSON.parse(status.stdout)).toMatchObject({
      configured: true,
      queue: { pending: 0 },
    });

    const runner = join(installRoot, "scheduled-sync.sh");
    await writeFile(
      join(installRoot, "workbuddy-sync.mjs"),
      'process.stderr.write(process.env.XDG_STATE_HOME ?? "missing");\n',
    );
    await runInstallerWithInput(runner, [], "", environmentWithoutXdg);
    expect(await readFile(join(stateRoot, "logs", "scheduled-sync.log"), "utf8")).toContain(
      join(home, ".state"),
    );
  });

  test("Windows installer uses SecureString/stdin, current-user ACL, and an idempotent user task", async () => {
    const source = await readFile(windowsInstaller, "utf8");
    expect(source).toMatch(/Read-Host[\s\S]*-AsSecureString/);
    expect(source).toMatch(/--token-stdin/);
    expect(source).toMatch(/icacls[\s\S]*\/inheritance:r/i);
    expect(source).toMatch(/ScheduledTask[\s\S]*(Register|Set)-ScheduledTask/i);
    expect(source).toMatch(/TaskName/);
    expect(source).toMatch(/if\s*\(\s*-not\s*\(Test-Path\s+-LiteralPath\s+\$configPath\)\s*\)/i);
    expect(source).toMatch(/USERPROFILE[\s\S]*\.workbuddy[\s\S]*superbrain-sync[\s\S]*SKILL\.md/i);
    expect(source).toMatch(/workbuddy-sync\.ps1/);
    expect(source).toMatch(/Get-Command node/i);
    expect(source).toMatch(/\$nodeLiteral[\s\S]*Set-Content -LiteralPath \$Wrapper[\s\S]*UTF8/i);
    expect(source).toMatch(/icacls[\s\S]*LASTEXITCODE[\s\S]*throw/i);
    expect(source).toMatch(
      /\r?\n}\r?\nSet-PrivateFileAcl -Path \$configPath\r?\n\r?\n\$logLiteral/,
    );
    expect(source).toMatch(/Restart WorkBuddy/i);
    expect(source).not.toMatch(/--token(?:\s|=)/);
    expect(source).not.toMatch(/RunAsAdministrator|Start-Process[\s\S]*-Verb\s+RunAs/i);
  });

  test("scheduled runners embed absolute executables, log outcomes, and never auto-ack", async () => {
    const posix = await readFile(macInstaller, "utf8");
    expect(posix).toMatch(/NODE_PATH=%s[\s\S]*\$NODE_QUOTED/);
    expect(posix).toMatch(/scheduled-sync\.log/);
    expect(posix).toMatch(/flush[\s\S]*fetch/);
    expect(posix).not.toMatch(/["']?\$CONNECTOR["']?\s+ack/);

    const windows = await readFile(windowsInstaller, "utf8");
    expect(windows).toMatch(/\$nodeLiteral[\s\S]*\$connectorLiteral[\s\S]*flush/);
    expect(windows).toMatch(/scheduled-sync\.log/);
    expect(windows).toMatch(/flush[\s\S]*fetch/);
    expect(windows).not.toMatch(/\$connectorLiteral\s+ack/);
  });

  test("download assets are real build inputs and byte-identical to canonical connector files", async () => {
    for (const name of [
      "workbuddy-sync.mjs",
      "install-macos.sh",
      "install-windows.ps1",
      "SKILL.md",
    ]) {
      expect(await readFile(resolve(root, "public/downloads", name), "utf8")).toBe(
        await readFile(resolve(root, "connectors", name), "utf8"),
      );
    }
    expect(await readFile(resolve(root, "SKILL.md"), "utf8")).toBe(
      await readFile(resolve(root, "connectors/SKILL.md"), "utf8"),
    );
  });

  test("keeps executable connector modules LF-only across Windows Git checkouts", async () => {
    const attributes = await readFile(gitAttributes, "utf8").catch(() => "");
    expect(attributes).toMatch(/^connectors\/workbuddy-sync\.mjs text eol=lf$/m);
    expect(attributes).toMatch(/^public\/downloads\/workbuddy-sync\.mjs text eol=lf$/m);
  });
});

describe("WorkBuddy setup surface", () => {
  test("stale recovery uses an atomic no-replace file operation", async () => {
    const source = await readFile(connectorSource, "utf8");
    expect(source).toMatch(
      /async function moveWithoutReplacing[\s\S]*await link\(source, target\)[\s\S]*await fsyncDirectoryImpl\(targetDirectory\)[\s\S]*await rm\(source, \{ force: true \}\)[\s\S]*await fsyncDirectoryImpl\(sourceDirectory\)/,
    );
    expect(source).not.toMatch(
      /async function moveWithoutReplacing[\s\S]*await stat\(target\)[\s\S]*rename\(source, target\)/,
    );
  });

  test("recommends MCP and offers macOS/Linux/Windows fallback tabs without embedding a token", async () => {
    const source = await readFile(setupRoute, "utf8");
    const reachabilitySource = await readFile(mcpReachability, "utf8");
    expect(source).toMatch(/MCP[\s\S]*(推荐|首选)/);
    expect(source).toMatch(/macOS/);
    expect(source).toMatch(/Linux/);
    expect(source).toMatch(/Windows/);
    expect(source).toMatch(/\/downloads\/install-macos\.sh/);
    expect(source).toMatch(/\/downloads\/install-windows\.ps1/);
    expect(source).toMatch(/status[\s\S]*flush[\s\S]*test-connection/);
    expect(source).toMatch(/\/mcp/);
    expect(reachabilitySource).toMatch(/oauth-protected-resource/);
    expect(reachabilitySource).toMatch(/metadata[\s\S]*resource[\s\S]*mcpUrl/);
    expect(reachabilitySource).toMatch(/initialize/);
    expect(source).toMatch(/OAuth 尚待授权[\s\S]*不是完整连接测试/);
    expect(source).toMatch(/测试 MCP 地址/);
    expect(source).toMatch(/复制 MCP 地址/);
    expect(source).toMatch(/\.workbuddy[\s\S]*skills[\s\S]*superbrain-sync[\s\S]*SKILL\.md/);
    expect(source).toMatch(/技能栏[\s\S]*导入/);
    expect(source).toMatch(/重启 WorkBuddy/);
    expect(source).toMatch(/粘贴[\s\S]*(凭证|token)|凭证[\s\S]*粘贴/i);
    expect(source).not.toMatch(/buildWorkbuddySkill/);
    expect(source).not.toMatch(/Authorization:\s*Bearer/);
  });

  test("canonical fallback SKILL invokes the connector and contains no credential placeholder", async () => {
    const skill = await readFile(skillSource, "utf8");
    expect(skill).toContain("__WORKBUDDY_CONNECTOR_ENTRYPOINT__");
    expect(skill).toMatch(/__WORKBUDDY_CONNECTOR_ENTRYPOINT__[\s\S]*sync/);
    expect(skill).toMatch(/__WORKBUDDY_CONNECTOR_ENTRYPOINT__[\s\S]*fetch/);
    expect(skill).not.toMatch(/(^|[\s`])workbuddy-sync\.mjs(?:[\s`]|$)/m);
    expect(skill).not.toMatch(/Authorization|Bearer|WORKBUDDY_CREDENTIAL|wb_[A-Za-z0-9_-]+/);
  });
});
