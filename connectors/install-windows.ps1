[CmdletBinding()]
param(
  [ValidateSet("Install", "Upgrade", "Uninstall")]
  [string]$Action = "Install",
  [string]$ApiUrl,
  [switch]$CredentialFromStdin,
  [switch]$NoSchedule,
  # 跳过 WorkBuddy Stop hook 注册（排障/CI 用；正常安装不要加）
  [switch]$NoHook,
  # 跳过装机时的历史补传
  [switch]$NoImport,
  # 下行（导师回信 Skill）本期默认不安装，需要时显式打开
  [switch]$WithDownstream
)

$ErrorActionPreference = "Stop"
$TaskName = "SuperBrain WorkBuddy Sync"
$InstallRoot = Join-Path $env:LOCALAPPDATA "SuperBrainCopilot\app"
$StateRoot = Join-Path $env:LOCALAPPDATA "SuperBrainCopilot"
$Connector = Join-Path $InstallRoot "workbuddy-sync.mjs"
$HookEntry = Join-Path $InstallRoot "workbuddy-hook.mjs"
$HookWrapper = Join-Path $InstallRoot "workbuddy-hook.sh"
$SettingsHelper = Join-Path $InstallRoot "register-workbuddy-hook.mjs"
$SkillTemplate = Join-Path $InstallRoot "SKILL.template.md"
$Wrapper = Join-Path $InstallRoot "workbuddy-sync.ps1"
$Runner = Join-Path $InstallRoot "scheduled-sync.ps1"
$LogRoot = Join-Path $StateRoot "logs"
$RunnerLog = Join-Path $LogRoot "scheduled-sync.log"
$HookLog = Join-Path $LogRoot "hook.log"
$ImportLog = Join-Path $LogRoot "import.log"
$DefaultWorkBuddyRoot = Join-Path $env:USERPROFILE ".workbuddy"
function Get-WorkBuddyHome {
  $configured = if (-not [string]::IsNullOrWhiteSpace($env:WORKBUDDY_HOME)) {
    $env:WORKBUDDY_HOME
  }
  else {
    $DefaultWorkBuddyRoot
  }
  return [IO.Path]::GetFullPath($configured)
}
$WorkBuddyRoot = Get-WorkBuddyHome
$WorkBuddySettings = Join-Path $WorkBuddyRoot "settings.json"
$WorkBuddySkillRoot = Join-Path $WorkBuddyRoot "skills\superbrain-sync"
$InstalledSkill = Join-Path $WorkBuddySkillRoot "SKILL.md"
# hook 事件与识别标记：升级时靠标记就地替换旧命令，绝不重复追加。
$HookEvent = "Stop"
$HookMarker = "workbuddy-hook.sh"
# hook 的本地总预算最多 4 秒；15 秒的 WorkBuddy timeout 留出明显余量。
$HookTimeoutSeconds = 15
$MinimumNodeMajor = 22
$ConnectorModules = @("workbuddy-sync.mjs")
$HookModules = @("workbuddy-hook.mjs", "workbuddy-transcript.mjs", "workbuddy-event-id.mjs")

# ---------------------------------------------------------------------------
# 运行时探测
#
# 已实测（macOS）：WorkBuddy 是腾讯 CodeBuddy 的 Electron 应用，
# 其二进制加 ELECTRON_RUN_AS_NODE=1 即为 node 22.x；学员机通常没有单独装 Node。
#
# ⚠️ 未经真机验证（Windows）：下面的 Electron 可执行文件名与安装路径、
# 以及 ~/.workbuddy/binaries/node 在 Windows 上的目录层级，都还没有在
# Windows 真机上核对过。因此全部做成"候选列表 + 环境变量可覆盖"：
#   $env:WORKBUDDY_NODE                 显式指定运行时（最高优先级）
#   $env:WORKBUDDY_NODE_MODE            配合上一项声明 electron|plain
#   $env:WORKBUDDY_ELECTRON_CANDIDATES  ";" 分隔的候选路径，覆盖内置默认列表
#   $env:WORKBUDDY_HOME                 WorkBuddy 数据目录，默认 $env:USERPROFILE\.workbuddy
# 真机核对后请把确认到的路径补进 $defaults 并删掉这段告警注释。
# ---------------------------------------------------------------------------
function Get-WorkBuddyElectronCandidate {
  if (-not [string]::IsNullOrWhiteSpace($env:WORKBUDDY_ELECTRON_CANDIDATES)) {
    return @(
      $env:WORKBUDDY_ELECTRON_CANDIDATES.Split(";") |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
        ForEach-Object { $_.Trim() }
    )
  }

  # ⚠️ 全部未经真机验证：electron-builder 通常把可执行文件改名成产品名（WorkBuddy.exe），
  # Squirrel 打包则是 <Name>\app-<版本>\<Name>.exe。两种布局都试，再兜底 Electron.exe。
  # Windows 文件系统大小写不敏感，所以不需要再列小写变体。
  $roots = @()
  foreach ($base in @($env:LOCALAPPDATA, $env:PROGRAMFILES, ${env:ProgramFiles(x86)})) {
    if ([string]::IsNullOrWhiteSpace($base)) { continue }
    $roots += (Join-Path $base "Programs")
    $roots += $base
  }
  $names = @("WorkBuddy", "CodeBuddy")
  $executables = @("WorkBuddy.exe", "CodeBuddy.exe", "Electron.exe")
  $literal = @()
  $patterns = @()
  foreach ($root in $roots) {
    foreach ($name in $names) {
      foreach ($executable in $executables) {
        $literal += (Join-Path $root (Join-Path $name $executable))
        $patterns += (Join-Path $root (Join-Path $name (Join-Path "app-*" $executable)))
      }
    }
  }
  $expanded = @()
  foreach ($pattern in $patterns) {
    $expanded += (
      Get-ChildItem -Path $pattern -ErrorAction SilentlyContinue |
        ForEach-Object { $_.FullName }
    )
  }
  return @(@($literal + $expanded) | Select-Object -Unique)
}

# 版本一律**实际询问二进制**，绝不从路径里的数字字符串推断。
function Get-NodeVersionFromBinary {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][ValidateSet("electron", "plain")][string]$Mode
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  $previous = $env:ELECTRON_RUN_AS_NODE
  try {
    # electron 模式必须带 ELECTRON_RUN_AS_NODE=1，否则会当 GUI 启动。
    if ($Mode -eq "electron") { $env:ELECTRON_RUN_AS_NODE = "1" }
    else { Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue }
    $output = & $Path -p "process.versions.node" 2>$null
    if ($LASTEXITCODE -ne 0) { return $null }
  }
  catch {
    return $null
  }
  finally {
    if ($null -eq $previous) {
      Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    }
    else {
      $env:ELECTRON_RUN_AS_NODE = $previous
    }
  }

  $text = (@($output) -join "`n").Trim()
  $match = [regex]::Match($text, '(?m)^(\d+)\.(\d+)\.(\d+)')
  if (-not $match.Success) { return $null }
  return [pscustomobject]@{
    Text  = $match.Value
    Major = [int]$match.Groups[1].Value
    # 22.9 与 22.10 必须按数值比较，不能按字典序。
    Key   = ([int]$match.Groups[1].Value * 1000000) +
            ([int]$match.Groups[2].Value * 1000) +
            [int]$match.Groups[3].Value
  }
}

function Resolve-WorkBuddyNode {
  $checked = New-Object System.Collections.Generic.List[string]

  # 1) 显式覆盖
  if (-not [string]::IsNullOrWhiteSpace($env:WORKBUDDY_NODE)) {
    # 安装后的 wrapper/计划任务会在不同 cwd 运行；相对路径必须在此刻固化为绝对路径。
    $overridePath = [IO.Path]::GetFullPath($env:WORKBUDDY_NODE)
    $modes = @("electron", "plain")
    if ($env:WORKBUDDY_NODE_MODE -in @("electron", "plain")) {
      $modes = @($env:WORKBUDDY_NODE_MODE)
    }
    elseif ([IO.Path]::GetFileName($overridePath) -imatch '^node(\.exe)?$') {
      # 名字就是 node 的先按普通 node 试，避免多余的 GUI 启动尝试。
      $modes = @("plain", "electron")
    }
    foreach ($mode in $modes) {
      $version = Get-NodeVersionFromBinary -Path $overridePath -Mode $mode
      if ($null -eq $version) { continue }
      if ($version.Major -lt $MinimumNodeMajor) {
        throw "WORKBUDDY_NODE=$overridePath 自报版本 $($version.Text)，低于要求的 $MinimumNodeMajor。"
      }
      return [pscustomobject]@{ Path = $overridePath; Mode = $mode; Version = $version.Text }
    }
    throw "WORKBUDDY_NODE=$overridePath 不可用（不存在、无法执行，或不是 Node/Electron 运行时）。"
  }

  # 2) WorkBuddy 自带的 Electron（唯一"装了 WorkBuddy 就必然存在"的运行时）
  foreach ($candidate in Get-WorkBuddyElectronCandidate) {
    $checked.Add($candidate)
    $version = Get-NodeVersionFromBinary -Path $candidate -Mode "electron"
    if ($null -eq $version -or $version.Major -lt $MinimumNodeMajor) { continue }
    return [pscustomobject]@{ Path = $candidate; Mode = "electron"; Version = $version.Text }
  }

  # 3) WorkBuddy 按需下载的 node（可能根本没下载过）：取 major >= 22 的最高版本
  #    ⚠️ 未经真机验证：Windows 上的层级可能是 versions\<v>\node.exe 而非 versions\<v>\bin\node.exe，
  #    所以两种都找。
  $versionsRoot = Join-Path (Get-WorkBuddyHome) "binaries\node\versions"
  $checked.Add((Join-Path $versionsRoot "*\node.exe"))
  $best = $null
  if (Test-Path -LiteralPath $versionsRoot) {
    $downloaded = @()
    foreach ($relative in @("node.exe", "bin\node.exe", "node", "bin\node")) {
      $downloaded += Get-ChildItem -Path (Join-Path $versionsRoot (Join-Path "*" $relative)) `
        -ErrorAction SilentlyContinue
    }
    foreach ($item in $downloaded) {
      $version = Get-NodeVersionFromBinary -Path $item.FullName -Mode "plain"
      if ($null -eq $version -or $version.Major -lt $MinimumNodeMajor) { continue }
      if ($null -eq $best -or $version.Key -gt $best.Key) {
        $best = [pscustomobject]@{
          Path = $item.FullName; Mode = "plain"; Version = $version.Text; Key = $version.Key
        }
      }
    }
  }
  if ($null -ne $best) {
    return [pscustomobject]@{ Path = $best.Path; Mode = $best.Mode; Version = $best.Version }
  }

  # 4) PATH 里的 node
  $pathNode = Get-Command node -ErrorAction SilentlyContinue
  if ($null -ne $pathNode) {
    $checked.Add($pathNode.Source)
    $version = Get-NodeVersionFromBinary -Path $pathNode.Source -Mode "plain"
    if ($null -ne $version -and $version.Major -ge $MinimumNodeMajor) {
      return [pscustomobject]@{ Path = $pathNode.Source; Mode = "plain"; Version = $version.Text }
    }
  }

  $checkedText = (
    @($checked) | Select-Object -First 12 | ForEach-Object { "     $_" }
  ) -join "`n"
  if ($checked.Count -gt 12) {
    $checkedText = "$checkedText`n     …（共 $($checked.Count) 个候选）"
  }
  throw @"
未找到可用的 Node 运行时（需要 $MinimumNodeMajor 或更高版本）。
已按顺序检查：
  1) `$env:WORKBUDDY_NODE（未设置或不可用）
  2) WorkBuddy 自带的 Electron 运行时
  3) $versionsRoot\*\node.exe（WorkBuddy 按需下载，可能尚未下载）
  4) PATH 中的 node（缺失或低于 $MinimumNodeMajor）
检查过的路径：
$checkedText
请确认：
  - WorkBuddy 是否已安装，并且至少完整启动过一次（首次启动才会创建 $(Get-WorkBuddyHome)）
  - **本连接器在 Windows 上需要 Git Bash**（Git for Windows）：WorkBuddy/CodeBuddy 的 hook
    命令只能用 Git Bash 执行，cmd 与 PowerShell 都不支持。请先安装 Git for Windows。
  - 若 WorkBuddy 装在非默认位置，可显式指定后重跑：
      `$env:WORKBUDDY_NODE = "C:\路径\到\WorkBuddy.exe"
      `$env:WORKBUDDY_NODE_MODE = "electron"
（未探测到运行时时不会继续安装，以免装出一个永远不同步的 hook。）
"@
}

# 探测成功后调用：$env:ELECTRON_RUN_AS_NODE 已按模式设置好（见 Enable-WorkBuddyRuntime）。
# 只返回退出码，命令自身的输出直接打到宿主，避免混进函数返回值。
function Invoke-WorkBuddyNode {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)

  $output = & $runtimePath @Arguments 2>&1
  $code = $LASTEXITCODE
  foreach ($line in @($output)) {
    if ($null -ne $line) { Write-Host $line }
  }
  return $code
}

# electron 模式下 WorkBuddy 的二进制只有带 ELECTRON_RUN_AS_NODE=1 才当 node 用。
# 安装脚本本身是短命进程，直接设进进程环境，后续所有 node 调用都生效。
function Enable-WorkBuddyRuntime {
  param([Parameter(Mandatory = $true)][string]$Mode)
  if ($Mode -eq "electron") { $env:ELECTRON_RUN_AS_NODE = "1" }
}

# LF + 无 BOM：Git Bash 执行的脚本不能带 BOM，也不该是 CRLF。
function Write-TextFileLf {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Content
  )
  $normalized = $Content.Replace("`r`n", "`n")
  [IO.File]::WriteAllText($Path, $normalized, (New-Object Text.UTF8Encoding($false)))
}

# POSIX shell 的单引号只能以 '\'' 形式嵌入；所有 Windows 路径在写入 .sh 前
# 都经此函数处理，避免 O'Neil 这类目录既破坏语法又造成命令注入。
function ConvertTo-BashSingleQuoted {
  param([Parameter(Mandatory = $true)][string]$Value)
  return "'" + $Value.Replace("'", "'\''") + "'"
}

function Get-GitBash {
  $bashCommand = Get-Command bash -ErrorAction SilentlyContinue
  if ($null -eq $bashCommand) {
    throw @"
找不到 Git Bash：WorkBuddy/CodeBuddy 在 Windows 上**只能用 Git for Windows 的 Git Bash 执行 hook 命令**。
请先安装 Git for Windows（https://git-scm.com/download/win），确保 bash 在 PATH 中后重跑本脚本。
（也可以加 -NoHook 只安装连接器，但那样不会自动同步对话。）
"@
  }
  $flavor = (& $bashCommand.Source -lc "uname -s" 2>$null | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $flavor -notmatch '(?i)(MINGW|MSYS)') {
    $reported = if ([string]::IsNullOrWhiteSpace($flavor)) { "无可用 uname 输出" } else { $flavor }
    throw @"
检测到的 bash 不是 Git Bash/MSYS（路径：$($bashCommand.Source)，uname -s：$reported）。
WSL bash 不能执行此 Windows hook；请安装 Git for Windows，或使用 -NoHook 明确跳过自动同步。
"@
  }
  return $bashCommand
}

function Write-SettingsHelper {
  param([Parameter(Mandatory = $true)][string]$Path)

  # 与 install-macos.sh 中的同名辅助脚本保持一致：
  #  - 保留学员自己已有的 hook
  #  - 已存在本项目的 hook 条目则就地替换（升级不会留下旧命令）
  #  - 改动前做原子备份（写临时文件 + rename）
  $helper = @'
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";

const [settingsPath, event, marker, mode, command, timeoutRaw] = process.argv.slice(2);
if (!settingsPath || !event || !marker || (mode !== "register" && mode !== "remove")) {
  process.stderr.write("register-workbuddy-hook: invalid arguments\n");
  process.exit(2);
}

const isPlainObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sleep = (milliseconds) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
const lockPath = `${settingsPath}.superbrain.lock`;
const staleLockAgeMs = 5 * 60 * 1000;
const isStaleLock = () => {
  try {
    const metadata = JSON.parse(readFileSync(lockPath, "utf8"));
    if (Number.isInteger(metadata?.pid) && metadata.pid > 0) {
      try {
        process.kill(metadata.pid, 0);
        return false;
      } catch (error) {
        if (error?.code === "ESRCH") return true;
        if (error?.code === "EPERM") return false;
      }
    }
  } catch {
    // 新建 lock 与写入 metadata 之间可能极短暂为空；只按年龄回收这种 lock。
  }
  try {
    return Date.now() - statSync(lockPath).mtimeMs > staleLockAgeMs;
  } catch (error) {
    return error?.code === "ENOENT";
  }
};
let lockFd;
for (let attempt = 0; attempt < 80; attempt += 1) {
  try {
    lockFd = openSync(lockPath, "wx", 0o600);
    writeFileSync(lockFd, `${JSON.stringify({ pid: process.pid, createdAt: Date.now() })}\n`);
    break;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    if (isStaleLock()) {
      try {
        unlinkSync(lockPath);
      } catch (unlinkError) {
        if (unlinkError?.code !== "ENOENT") throw unlinkError;
      }
      continue;
    }
    sleep(25);
  }
}
if (lockFd === undefined) {
  process.stderr.write(`${settingsPath} 正在被另一个安装或卸载操作修改，请稍后重试。\n`);
  process.exit(4);
}

const fail = (message, code) => {
  const error = new Error(message);
  error.exitCode = code;
  throw error;
};
const readSnapshot = () => {
  const exists = existsSync(settingsPath);
  return { exists, raw: exists ? readFileSync(settingsPath, "utf8") : null };
};

try {
  const snapshot = readSnapshot();
  let raw = snapshot.raw;
  let settings = {};
  let originalMode = 0o600;
  if (snapshot.exists) {
    try {
      originalMode = statSync(settingsPath).mode & 0o777;
    } catch {
      originalMode = 0o600;
    }
    if (raw.trim().length > 0) {
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        fail(
          `${settingsPath} 不是合法 JSON，已中止且未做任何修改。\n` +
            "请先修好该文件（或改名备份后让 WorkBuddy 重新生成）再重跑安装脚本。",
          3,
        );
      }
      if (!isPlainObject(parsed)) {
        fail(`${settingsPath} 顶层不是 JSON 对象，已中止且未做任何修改。`, 3);
      }
      settings = parsed;
    }
  }
  const absentRemove = !snapshot.exists && mode === "remove";
  if (absentRemove) {
    process.stdout.write("absent\n");
  } else {
    // 原子备份：临时文件和备份名都唯一，避免并发 helper 相互覆盖。
    if (raw !== null) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const unique = `${process.pid}-${randomUUID()}`;
      const backupPath = `${settingsPath}.superbrain-${stamp}-${unique}.bak`;
      const backupTemp = `${backupPath}.tmp`;
      writeFileSync(backupTemp, raw, { encoding: "utf8", mode: originalMode });
      renameSync(backupTemp, backupPath);
      process.stdout.write(`backup=${backupPath}\n`);
    }

    const hooks = isPlainObject(settings.hooks) ? settings.hooks : {};
    const blocks = Array.isArray(hooks[event]) ? hooks[event] : [];
    const matchesMarker = (hook) =>
      isPlainObject(hook) && typeof hook.command === "string" && hook.command.includes(marker);

    let outcome;
    if (mode === "remove") {
      const kept = [];
      for (const block of blocks) {
        if (!isPlainObject(block) || !Array.isArray(block.hooks)) {
          kept.push(block);
          continue;
        }
        const remaining = block.hooks.filter((hook) => !matchesMarker(hook));
        if (remaining.length > 0) kept.push({ ...block, hooks: remaining });
      }
      if (kept.length > 0) hooks[event] = kept;
      else delete hooks[event];
      outcome = "removed";
    } else {
      const timeout = Number.parseInt(timeoutRaw ?? "", 10);
      const entry = { type: "command", command };
      if (Number.isFinite(timeout) && timeout > 0) entry.timeout = timeout;
      if (!command) fail("register-workbuddy-hook: command is required", 2);
      let replaced = false;
      for (const block of blocks) {
        if (!isPlainObject(block) || !Array.isArray(block.hooks)) continue;
        for (let index = 0; index < block.hooks.length; index += 1) {
          if (!matchesMarker(block.hooks[index])) continue;
          block.hooks[index] = { ...block.hooks[index], ...entry };
          replaced = true;
        }
      }
      if (!replaced) blocks.push({ hooks: [entry] });
      hooks[event] = blocks;
      outcome = replaced ? "replaced" : "added";
    }

    if (Object.keys(hooks).length > 0) settings.hooks = hooks;
    else delete settings.hooks;

    const temporaryPath = `${settingsPath}.superbrain-${process.pid}-${randomUUID()}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, {
      encoding: "utf8",
      mode: originalMode,
    });
    const current = readSnapshot();
    if (current.exists !== snapshot.exists || current.raw !== snapshot.raw) {
      unlinkSync(temporaryPath);
      fail(`${settingsPath} settings changed concurrently; 已中止，未覆盖其他更新，请重试。`, 4);
    }
    renameSync(temporaryPath, settingsPath);
    process.stdout.write(`${outcome}\n`);
  }
} catch (error) {
  if (Number.isInteger(error?.exitCode)) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.exitCode;
  } else {
    throw error;
  }
} finally {
  closeSync(lockFd);
  try {
    unlinkSync(lockPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
'@
  Write-TextFileLf -Path $Path -Content $helper
}

function Remove-SuperBrainSchedule {
  $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($null -ne $existing) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  }
}

function Set-PrivateDirectoryAcl {
  param([Parameter(Mandatory = $true)][string]$Path)
  Set-CurrentUserOnlyAcl `
    -Path $Path `
    -InheritanceFlags (
      [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
      [Security.AccessControl.InheritanceFlags]::ObjectInherit
    )
}

function Set-PrivateFileAcl {
  param([Parameter(Mandatory = $true)][string]$Path)
  Set-CurrentUserOnlyAcl `
    -Path $Path `
    -InheritanceFlags ([Security.AccessControl.InheritanceFlags]::None)
}

function Set-CurrentUserOnlyAcl {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)]
    [Security.AccessControl.InheritanceFlags]$InheritanceFlags
  )

  $acl = Get-Acl -LiteralPath $Path
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.Access)) {
    [void]$acl.RemoveAccessRuleSpecific($rule)
  }
  $currentUserRule = [Security.AccessControl.FileSystemAccessRule]::new(
    $currentSid,
    [Security.AccessControl.FileSystemRights]::FullControl,
    $InheritanceFlags,
    [Security.AccessControl.PropagationFlags]::None,
    [Security.AccessControl.AccessControlType]::Allow
  )
  [void]$acl.AddAccessRule($currentUserRule)
  Set-Acl -LiteralPath $Path -AclObject $acl
}

if ($Action -eq "Uninstall") {
  Remove-SuperBrainSchedule
  # 先摘 hook 再删文件：否则 WorkBuddy 每次 Stop 都会去执行一个不存在的脚本。
  if (Test-Path -LiteralPath $WorkBuddySettings) {
    try {
      $runtime = Resolve-WorkBuddyNode
      $runtimePath = $runtime.Path
      $runtimeMode = $runtime.Mode
      Enable-WorkBuddyRuntime -Mode $runtimeMode
      New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
      Write-SettingsHelper -Path $SettingsHelper
      $exitCode = Invoke-WorkBuddyNode -Arguments @(
        $SettingsHelper, $WorkBuddySettings, $HookEvent, $HookMarker, "remove"
      )
      if ($exitCode -eq 0) {
        Write-Host "Removed the WorkBuddy $HookEvent hook entry."
      }
      else {
        Write-Warning "无法自动摘除 hook，请手动编辑 $WorkBuddySettings 删除包含 $HookMarker 的条目。"
      }
      Remove-Item -LiteralPath $SettingsHelper -Force -ErrorAction SilentlyContinue
    }
    catch {
      Write-Warning "未找到可用的 Node 运行时，无法自动摘除 hook。"
      Write-Warning "请手动编辑 $WorkBuddySettings 删除包含 $HookMarker 的条目。"
    }
  }
  $removable = @($Connector, $HookEntry, $HookWrapper, $SettingsHelper, $SkillTemplate, $Wrapper,
    $Runner, $InstalledSkill)
  foreach ($module in $HookModules) {
    $removable += (Join-Path $InstallRoot $module)
  }
  Remove-Item -LiteralPath $removable -Force -ErrorAction SilentlyContinue
  Write-Host "Connector program removed. Private queue and configuration were preserved at $StateRoot."
  exit 0
}

if ([string]::IsNullOrWhiteSpace($ApiUrl)) {
  throw "-ApiUrl is required for install or upgrade."
}

$requiredModules = @($ConnectorModules)
if (-not $NoHook) { $requiredModules += $HookModules }
$missingModules = @()
foreach ($module in $requiredModules) {
  if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot $module))) {
    $missingModules += $module
  }
}
if ($missingModules.Count -gt 0) {
  throw "以下文件必须与安装脚本一起下载到同一目录：$($missingModules -join ' ')"
}
$sourceSkill = Join-Path $PSScriptRoot "SKILL.md"
if ($WithDownstream -and -not (Test-Path -LiteralPath $sourceSkill)) {
  throw "SKILL.md must be downloaded beside this installer when -WithDownstream is used."
}

# hook 命令只能由 Git Bash/MSYS 执行；WSL 的 bash 即使同名也不能运行 Windows 路径。
if (-not $NoHook) {
  $bashCommand = Get-GitBash
}

$runtime = Resolve-WorkBuddyNode
$runtimePath = $runtime.Path
$runtimeMode = $runtime.Mode
Enable-WorkBuddyRuntime -Mode $runtimeMode
Write-Host "Runtime: $runtimePath ($runtimeMode, node $($runtime.Version))"

New-Item `
  -ItemType Directory `
  -Path $InstallRoot, $StateRoot, $LogRoot, $WorkBuddyRoot `
  -Force | Out-Null
foreach ($module in $requiredModules) {
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot $module) `
    -Destination (Join-Path $InstallRoot $module) -Force
}

$currentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$identity = $currentIdentity.Name
$currentSid = $currentIdentity.User
Set-PrivateDirectoryAcl -Path $StateRoot
Set-PrivateDirectoryAcl -Path $InstallRoot
Set-PrivateDirectoryAcl -Path $WorkBuddyRoot

$nodeLiteral = "'" + $runtimePath.Replace("'", "''") + "'"
$connectorLiteral = "'" + $Connector.Replace("'", "''") + "'"
# electron 模式下 WorkBuddy 的二进制只有带 ELECTRON_RUN_AS_NODE=1 才当 node 用。
$electronPreamble = ""
if ($runtimeMode -eq "electron") {
  $electronPreamble = "`$env:ELECTRON_RUN_AS_NODE = `"1`"`n"
}
# WorkBuddy 升级可能换掉可执行文件路径：每次运行都校验，宁可报错也不静默不同步。
@"
`$ErrorActionPreference = "Stop"
$electronPreamble`$nodeBinary = $nodeLiteral
if (-not (Test-Path -LiteralPath `$nodeBinary)) {
  [Console]::Error.WriteLine("找不到 WorkBuddy 的 Node 运行时：`$nodeBinary")
  [Console]::Error.WriteLine("WorkBuddy 可能已升级、移动或被卸载。请重新运行安装脚本以重新探测运行时。")
  exit 1
}
& `$nodeBinary $connectorLiteral @args
exit `$LASTEXITCODE
"@ | Set-Content -LiteralPath $Wrapper -Encoding UTF8

if ($WithDownstream) {
  New-Item -ItemType Directory -Path $WorkBuddySkillRoot -Force | Out-Null
  Copy-Item -LiteralPath $sourceSkill -Destination $SkillTemplate -Force
  $entrypoint = "& '" + $Wrapper.Replace("'", "''") + "'"
  $skillContent = (Get-Content -LiteralPath $SkillTemplate -Raw).Replace(
    "__WORKBUDDY_CONNECTOR_ENTRYPOINT__",
    $entrypoint
  )
  if ($skillContent.Contains("__WORKBUDDY_CONNECTOR_ENTRYPOINT__")) {
    throw "Skill entrypoint generation failed."
  }
  $skillContent | Set-Content -LiteralPath $InstalledSkill -Encoding UTF8
  Set-PrivateFileAcl -Path $InstalledSkill
}

$configPath = Join-Path $StateRoot "config.json"
if (-not (Test-Path -LiteralPath $configPath)) {
  $bstr = [IntPtr]::Zero
  try {
    if ($CredentialFromStdin) {
      if (-not [Console]::IsInputRedirected) {
        throw "-CredentialFromStdin requires redirected standard input."
      }
      $plainCredential = [Console]::In.ReadLine()
    }
    else {
      $secureCredential = Read-Host "Paste the one-time WorkBuddy credential" -AsSecureString
      $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureCredential)
      $plainCredential = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    }
    if ([string]::IsNullOrWhiteSpace($plainCredential)) {
      throw "Credential input is required."
    }
    $plainCredential | & $runtimePath $Connector configure --api-url $ApiUrl --token-stdin
    if ($LASTEXITCODE -ne 0) {
      throw "Connector configuration failed."
    }
  }
  finally {
    if ($null -ne $plainCredential) {
      $plainCredential = $null
    }
    if ($null -ne $secureCredential) {
      $secureCredential.Dispose()
      $secureCredential = $null
    }
    if ($bstr -ne [IntPtr]::Zero) {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
  }
}
Set-PrivateFileAcl -Path $configPath

$logLiteral = "'" + $RunnerLog.Replace("'", "''") + "'"
@"
`$ErrorActionPreference = "Continue"
$electronPreamble`$logFile = $logLiteral
`$nodeBinary = $nodeLiteral
`$status = 0
"`$([DateTime]::UtcNow.ToString("o")) scheduled sync start" | Add-Content -LiteralPath `$logFile
if (-not (Test-Path -LiteralPath `$nodeBinary)) {
  "`$([DateTime]::UtcNow.ToString("o")) runtime missing: `$nodeBinary" | Add-Content -LiteralPath `$logFile
  exit 1
}
& `$nodeBinary $connectorLiteral flush 1>`$null 2>>`$logFile
if (`$LASTEXITCODE -eq 0) {
  "`$([DateTime]::UtcNow.ToString("o")) flush ok" | Add-Content -LiteralPath `$logFile
} else {
  "`$([DateTime]::UtcNow.ToString("o")) flush failed" | Add-Content -LiteralPath `$logFile
  `$status = 1
}
& `$nodeBinary $connectorLiteral fetch 1>`$null 2>>`$logFile
if (`$LASTEXITCODE -eq 0) {
  "`$([DateTime]::UtcNow.ToString("o")) fetch ok" | Add-Content -LiteralPath `$logFile
} else {
  "`$([DateTime]::UtcNow.ToString("o")) fetch failed" | Add-Content -LiteralPath `$logFile
  `$status = 1
}
exit `$status
"@ | Set-Content -LiteralPath $Runner -Encoding UTF8

if (-not $NoHook) {
  # hook 包装脚本必须是 bash 脚本：Windows 上 CodeBuddy 强制用 Git Bash 执行 hook 命令。
  $hookNodePath = ConvertTo-BashSingleQuoted ($runtimePath.Replace("\", "/"))
  $hookEntryPath = ConvertTo-BashSingleQuoted ($HookEntry.Replace("\", "/"))
  $hookLogPath = ConvertTo-BashSingleQuoted ($HookLog.Replace("\", "/"))
  $localAppData = ""
  if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    $localAppData = ConvertTo-BashSingleQuoted ($env:LOCALAPPDATA.Replace("\", "/"))
  }
  else {
    $localAppData = ConvertTo-BashSingleQuoted ""
  }
  $hookScript = @"
#!/bin/sh
NODE_PATH=$hookNodePath
HOOK_ENTRY=$hookEntryPath
HOOK_LOG=$hookLogPath
if [ -z "`${LOCALAPPDATA:-}" ]; then
  LOCALAPPDATA=$localAppData
  export LOCALAPPDATA
fi
$(if ($runtimeMode -eq "electron") { "ELECTRON_RUN_AS_NODE=1`nexport ELECTRON_RUN_AS_NODE" } else { "" })
if [ ! -f "`$NODE_PATH" ]; then
  message="找不到 WorkBuddy 的 Node 运行时：`$NODE_PATH（WorkBuddy 可能已升级或移动，请重跑安装脚本）"
  echo "`$message" >&2
  printf '%s %s\n' "`$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "`$message" >>"`$HOOK_LOG" 2>/dev/null || true
  exit 0
fi
if [ ! -f "`$HOOK_ENTRY" ]; then
  message="找不到上行 hook 程序：`$HOOK_ENTRY（请重跑安装脚本）"
  echo "`$message" >&2
  printf '%s %s\n' "`$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "`$message" >>"`$HOOK_LOG" 2>/dev/null || true
  exit 0
fi
exec "`$NODE_PATH" "`$HOOK_ENTRY" "`$@"
"@
  Write-TextFileLf -Path $HookWrapper -Content $hookScript
  Set-PrivateFileAcl -Path $HookWrapper

  # hook 命令保持 bash 语法（与 macOS 端同一种写法），末尾 || true 兜底保证不阻塞 WorkBuddy。
  $hookCommand = "bash $(ConvertTo-BashSingleQuoted ($HookWrapper.Replace("\", "/"))) || true"
  Write-SettingsHelper -Path $SettingsHelper
  $exitCode = Invoke-WorkBuddyNode -Arguments @(
    $SettingsHelper, $WorkBuddySettings, $HookEvent, $HookMarker, "register",
    $hookCommand, "$HookTimeoutSeconds"
  )
  Remove-Item -LiteralPath $SettingsHelper -Force -ErrorAction SilentlyContinue
  if ($exitCode -ne 0) {
    throw "hook 注册失败：$WorkBuddySettings 未被修改。"
  }
}

if (-not $NoSchedule) {
  $taskAction = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$Runner`""
  $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1)
  $trigger.Repetition.Interval = "PT5M"
  $trigger.Repetition.Duration = "P3650D"
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew
  Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $taskAction `
    -Trigger $trigger `
    -Settings $settings `
    -User $identity `
    -RunLevel Limited `
    -Force | Out-Null
}

# 装机时补传近 7 天历史：后台跑，不阻塞安装完成，随时可中断后重跑。
if (-not $NoImport) {
  $importCommand = "& '" + $Wrapper.Replace("'", "''") + "' import --since 7d " +
    "*>> '" + $ImportLog.Replace("'", "''") + "'"
  Start-Process `
    -FilePath "powershell.exe" `
    -ArgumentList @(
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-Command", $importCommand
    ) `
    -WindowStyle Hidden | Out-Null
}

Write-Host "SuperBrain WorkBuddy connector installed for the current user."
Write-Host "Connector command: $Wrapper"
if (-not $NoHook) {
  Write-Host "Upstream hook registered in: $WorkBuddySettings ($HookEvent)"
  Write-Host "Hook log: $HookLog"
}
if ($WithDownstream) {
  Write-Host "Skill installed at: $InstalledSkill"
}
else {
  Write-Host "Downstream skill not installed (pass -WithDownstream if you need it)."
}
if (-not $NoImport) {
  Write-Host "历史补传（近 7 天）已在后台开始，不影响安装完成。"
  Write-Host "  进度日志：$ImportLog"
  Write-Host "  需要重跑：& `"$Wrapper`" import --since 7d"
}
Write-Host "Run in PowerShell: & `"$Wrapper`" status"
Write-Host "Restart WorkBuddy so it reloads settings.json."
