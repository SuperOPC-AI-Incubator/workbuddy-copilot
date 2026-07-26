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

/**
 * Every .mjs a student machine needs. workbuddy-sync.mjs imports the transcript
 * and event-id modules at load time, and workbuddy-hook.mjs is the Stop hook
 * entrypoint, so all four must be published together.
 */
const CONNECTOR_MODULES = [
  "workbuddy-sync.mjs",
  "workbuddy-transcript.mjs",
  "workbuddy-event-id.mjs",
  "workbuddy-hook.mjs",
] as const;

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

// PowerShell 把双引号字符串里的 `$name:` 解析成作用域限定符（如 $env:PATH），
// 所以 "exit code $code: $msg" 会直接 ParserError。本机没有 pwsh 无法解析校验，
// 这条守卫用静态扫描兜住这一类最常见的语法错误，避免每次都靠 CI 往返发现。
const POWERSHELL_SCOPES = new Set([
  "env",
  "script",
  "global",
  "local",
  "private",
  "using",
  "variable",
  "function",
  "alias",
  "workflow",
]);

function findInvalidScopeQualifiers(source: string): string[] {
  const found: string[] = [];
  source.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(/\$(\w+):/g)) {
      if (!POWERSHELL_SCOPES.has(match[1].toLowerCase())) {
        found.push(`line ${index + 1}: ${match[0]}`);
      }
    }
  });
  return found;
}

// PowerShell 变量名大小写不敏感，且 foreach 的循环变量写的是脚本作用域。
// 因此 `foreach ($root ...)` 会静默覆盖脚本级的 $Root —— CI 上这把仓库根改成了
// C:\\Program Files (x86)，而 macOS 因 ProgramFiles(x86) 为空永远复现不了。
// 只检测真正危险的组合：循环变量与脚本级赋值的变量同名（忽略大小写）。
// 不比较函数参数，它们各自独立作用域，跨函数同名不是缺陷。
function findLoopVariablesClobberingScriptScope(source: string): string[] {
  const withoutComments = source
    .split("\n")
    .map((line) => line.replace(/#.*$/, ""))
    .join("\n");

  const scriptScope = new Map<string, string>();
  for (const match of withoutComments.matchAll(/^\$([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)) {
    scriptScope.set(match[1].toLowerCase(), match[1]);
  }

  const clobbered: string[] = [];
  for (const match of withoutComments.matchAll(
    /foreach\s*\(\s*\$([A-Za-z_][A-Za-z0-9_]*)\s+in\b/gi,
  )) {
    const loopVariable = match[1];
    const declared = scriptScope.get(loopVariable.toLowerCase());
    if (declared) clobbered.push(`foreach $${loopVariable} clobbers script-scope $${declared}`);
  }
  return [...new Set(clobbered)].sort();
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
        // --with-downstream 才安装导师回信 Skill；这条用例覆盖"下行开启"时的行为。
        [
          "--api-url",
          "https://copilot.example.test",
          "--no-schedule",
          "--no-import",
          "--with-downstream",
        ],
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
    expect(installOutput).not.toContain("历史补传");
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

  test("POSIX installer leaves the downstream SKILL out unless --with-downstream is passed", async () => {
    // 本期只做上行（hook 上报）。下行导师回信 Skill 默认不装：装了就等于
    // 给学员一个还没有服务端支撑的能力。
    if (process.platform === "win32") return;
    const home = await mkdtemp(join(tmpdir(), "superbrain-installer-default-"));
    cleanup.push(home);
    await chmod(macInstaller, 0o755);
    const result = await runInstallerWithInput(
      macInstaller,
      ["--api-url", "https://copilot.example.test", "--no-schedule", "--no-import"],
      "wb_installer_secret\n",
      { ...process.env, HOME: home, XDG_STATE_HOME: join(home, ".state") },
    );
    const installOutput = `${result.stdout}${result.stderr}`;

    const skillRoot = join(home, ".workbuddy", "skills");
    await expect(stat(join(skillRoot, "superbrain-sync", "SKILL.md"))).rejects.toThrow(/ENOENT/);
    await expect(stat(skillRoot)).rejects.toThrow(/ENOENT/);
    expect(installOutput).toContain("Downstream skill not installed");
    expect(installOutput).toContain("--with-downstream");
    expect(installOutput).not.toContain("历史补传");

    // 上行仍然必须装好：默认不装下行 ≠ 什么都没装。
    expect((await stat(join(home, ".local", "bin", "workbuddy-sync"))).mode & 0o777).toBe(0o700);
    const installRoot = join(home, ".local", "share", "superbrain-copilot");
    for (const name of CONNECTOR_MODULES) {
      expect(await readFile(join(installRoot, name), "utf8")).toBe(
        await readFile(resolve(root, "connectors", name), "utf8"),
      );
    }
  });

  test("Windows installer uses SecureString/stdin, current-user ACL, and an idempotent user task", async () => {
    const source = await readFile(windowsInstaller, "utf8");
    expect(source).toMatch(/Read-Host[\s\S]*-AsSecureString/);
    expect(source).toMatch(/\[switch\]\$CredentialFromStdin/);
    expect(source).toMatch(
      /if\s*\(\$CredentialFromStdin\)[\s\S]*\[Console\]::IsInputRedirected[\s\S]*\[Console\]::In\.ReadLine\(\)[\s\S]*else\s*\{[\s\S]*Read-Host[\s\S]*-AsSecureString/i,
    );
    expect(source).toMatch(/--token-stdin/);
    expect(source).toMatch(
      /SetAccessRuleProtection\(\$true,\s*\$false\)[\s\S]*RemoveAccessRuleSpecific[\s\S]*AddAccessRule/i,
    );
    expect(source).toMatch(/ScheduledTask[\s\S]*(Register|Set)-ScheduledTask/i);
    expect(source).toMatch(/TaskName/);
    expect(source).toMatch(/if\s*\(\s*-not\s*\(Test-Path\s+-LiteralPath\s+\$configPath\)\s*\)/i);
    expect(source).toMatch(/USERPROFILE[\s\S]*\.workbuddy[\s\S]*superbrain-sync[\s\S]*SKILL\.md/i);
    expect(source).toMatch(/workbuddy-sync\.ps1/);
    expect(source).toMatch(/Get-Command node/i);
    expect(source).toMatch(/\$nodeLiteral[\s\S]*Set-Content -LiteralPath \$Wrapper[\s\S]*UTF8/i);
    expect(source).toMatch(/Set-Acl\s+-LiteralPath\s+\$Path\s+-AclObject\s+\$acl/i);
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
      ...CONNECTOR_MODULES,
      "install-macos.sh",
      "install-windows.ps1",
      // install-macos.sh 会 `source` 它，所以它也必须随安装器一起发布且不漂移。
      "detect-runtime.sh",
      "SKILL.md",
    ]) {
      expect(
        await readFile(resolve(root, "public/downloads", name)),
        `public/downloads/${name} drifted from connectors/${name}`,
      ).toEqual(await readFile(resolve(root, "connectors", name)));
    }
    expect(await readFile(resolve(root, "SKILL.md"), "utf8")).toBe(
      await readFile(resolve(root, "connectors/SKILL.md"), "utf8"),
    );
  });

  test("ships every runtime sibling the connector imports", async () => {
    // workbuddy-sync.mjs imports these at load time: shipping only the entrypoint
    // makes a fresh install die with ERR_MODULE_NOT_FOUND.
    const sources = await Promise.all(
      CONNECTOR_MODULES.map((name) => readFile(resolve(root, "connectors", name), "utf8")),
    );
    const imported = new Set<string>();
    for (const source of sources) {
      for (const match of source.matchAll(/from "\.\/([\w.-]+\.mjs)"/g)) imported.add(match[1]);
    }
    expect(imported.size).toBeGreaterThan(0);
    for (const name of imported) {
      expect(CONNECTOR_MODULES, `${name} is imported but never published`).toContain(name);
      await expect(stat(resolve(root, "public/downloads", name))).resolves.toBeDefined();
    }
  });

  test("keeps executable connector modules LF-only across Windows Git checkouts", async () => {
    const attributes = await readFile(gitAttributes, "utf8").catch(() => "");
    // .sh 一旦被 checkout 成 CRLF，`#!/bin/sh` 会带上 \r 变成 "bad interpreter"，
    // 而 install-macos.sh 还会 `source detect-runtime.sh`。PowerShell 容忍 LF，
    // 但两份 .ps1 也必须固定 LF，才能让上面的副本字节一致性在任何 checkout 后稳定。
    for (const name of [
      ...CONNECTOR_MODULES,
      "install-macos.sh",
      "install-windows.ps1",
      "detect-runtime.sh",
    ]) {
      const escaped = name.replace(/\./g, "\\.");
      expect(attributes).toMatch(new RegExp(`^connectors/${escaped} text eol=lf$`, "m"));
      expect(attributes).toMatch(new RegExp(`^public/downloads/${escaped} text eol=lf$`, "m"));
    }
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

  test("copy-paste install commands fetch every file the installer and connector need", async () => {
    // 学员只会复制这两段命令。少下一个兄弟模块，workbuddy-sync.mjs 在加载期就
    // ERR_MODULE_NOT_FOUND；少下 detect-runtime.sh，install-macos.sh 连 source 都做不到。
    const source = await readFile(setupRoute, "utf8");
    const posix = /const posixInstallCommand = `([\s\S]*?)`;/.exec(source)?.[1] ?? "";
    const windows = /const windowsInstallCommand = `([\s\S]*?)`;/.exec(source)?.[1] ?? "";
    expect(posix.length).toBeGreaterThan(0);
    expect(windows.length).toBeGreaterThan(0);
    for (const name of CONNECTOR_MODULES) {
      expect(posix, `${name} is missing from the macOS/Linux install command`).toContain(
        `/downloads/${name}`,
      );
      expect(windows, `${name} is missing from the Windows install command`).toContain(
        `/downloads/${name}`,
      );
    }
    expect(posix).toContain("/downloads/detect-runtime.sh");
    expect(posix).toContain("/downloads/install-macos.sh");
    expect(windows).toContain("/downloads/install-windows.ps1");
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

describe("PowerShell scripts avoid invalid scope-qualifier interpolation", () => {
  const scripts = [
    "connectors/install-windows.ps1",
    "public/downloads/install-windows.ps1",
    "tests/connectors/test-windows.ps1",
  ];

  test.each(scripts)("%s interpolates variables PowerShell can parse", async (relative) => {
    const source = await readFile(resolve(root, relative), "utf8");
    expect(findInvalidScopeQualifiers(source)).toEqual([]);
  });

  test("detects the exact pattern that broke CI", () => {
    // 负控：这正是 test-windows.ps1:312 上让 pwsh ParserError 的原文
    expect(
      findInvalidScopeQualifiers('throw "failed with exit code $hookExitCode: $hookStderr"'),
    ).toEqual(["line 1: $hookExitCode:"]);
    // 合法的作用域限定符不得误报
    expect(findInvalidScopeQualifiers("$env:PATH; $script:x; $using:y")).toEqual([]);
  });
});

describe("PowerShell loop variables do not clobber script scope", () => {
  const scripts = [
    "connectors/install-windows.ps1",
    "public/downloads/install-windows.ps1",
    "tests/connectors/test-windows.ps1",
  ];

  test.each(scripts)("%s keeps foreach variables out of script scope", async (relative) => {
    const source = await readFile(resolve(root, relative), "utf8");
    expect(findLoopVariablesClobberingScriptScope(source)).toEqual([]);
  });

  test("detects the exact collision that broke Windows CI", () => {
    expect(
      findLoopVariablesClobberingScriptScope('$Root = "a"\nforeach ($root in $x) { }'),
    ).toEqual(["foreach $root clobbers script-scope $Root"]);
    // 跨函数的同名参数不是缺陷，不得误报
    expect(
      findLoopVariablesClobberingScriptScope(
        "function A { param($Mode) }\nforeach ($mode in $m) { }",
      ),
    ).toEqual([]);
  });
});
