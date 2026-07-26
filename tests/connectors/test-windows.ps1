[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($env:CONNECTOR_TEST_TOKEN)) {
  throw "CONNECTOR_TEST_TOKEN is required."
}

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path

# 仓库根一旦算错，后面会以一个含义不明的退出码失败（CI 上实测过 pwsh 的 64），
# 而本机没有 pwsh 无法复现。所以在这里就自证路径，并把判定依据全部带进错误信息。
$ExpectedInstaller = Join-Path $Root "connectors\install-windows.ps1"
if (-not (Test-Path -LiteralPath $ExpectedInstaller -PathType Leaf)) {
  throw (@(
    "Repository root resolution failed; the Windows installer is not where the test expects it.",
    "  PSScriptRoot      = $PSScriptRoot",
    "  Root              = $Root",
    "  ExpectedInstaller = $ExpectedInstaller",
    "  PWD               = $((Get-Location).Path)",
    "  PSCommandPath     = $PSCommandPath"
  ) -join [Environment]::NewLine)
}
Write-Host "Repo root: $Root"
$TestRoot = Join-Path ([IO.Path]::GetTempPath()) ("superbrain-connector-" + [guid]::NewGuid())
$OriginalUserProfile = $env:USERPROFILE
$OriginalLocalAppData = $env:LOCALAPPDATA
$OriginalWorkBuddyHome = $env:WORKBUDDY_HOME
$OriginalWorkBuddyNode = $env:WORKBUDDY_NODE
$OriginalElectronCandidates = $env:WORKBUDDY_ELECTRON_CANDIDATES

# The installer itself must write only in the sandbox below. Read the real
# profile's standard candidate locations first so a future runner image with
# WorkBuddy cannot be hidden merely by sandboxing LOCALAPPDATA for installation.
$RealElectronCandidates = @()
foreach ($base in @($OriginalLocalAppData, $env:PROGRAMFILES, ${env:ProgramFiles(x86)})) {
  if ([string]::IsNullOrWhiteSpace($base)) { continue }
  # 变量名不能与脚本级 $Root 只差大小写：PowerShell 变量名大小写不敏感，
  # 用 $root 会静默覆盖仓库根，且只在 Windows（ProgramFiles(x86) 非空）触发。
  foreach ($candidateRoot in @((Join-Path $base "Programs"), $base)) {
    foreach ($name in @("WorkBuddy", "CodeBuddy")) {
      foreach ($executable in @("WorkBuddy.exe", "CodeBuddy.exe", "Electron.exe")) {
        $candidate = Join-Path $candidateRoot (Join-Path $name $executable)
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $RealElectronCandidates += $candidate }
      }
    }
  }
}
$RealElectronCandidates = @($RealElectronCandidates | Select-Object -Unique)
$RealWorkBuddyHome = if ([string]::IsNullOrWhiteSpace($OriginalWorkBuddyHome)) {
  Join-Path $OriginalUserProfile ".workbuddy"
}
else {
  $OriginalWorkBuddyHome
}
$RealDownloadedNode = @(
  foreach ($relativePath in @("node.exe", "bin\node.exe", "node", "bin\node")) {
    Get-ChildItem `
      -Path (Join-Path $RealWorkBuddyHome (Join-Path "binaries\node\versions" (Join-Path "*" $relativePath))) `
      -File -ErrorAction SilentlyContinue
  }
) | Select-Object -First 1

try {
  if (-not [string]::IsNullOrWhiteSpace($OriginalWorkBuddyNode)) {
    throw "Windows CI plain-runtime assertion requires WORKBUDDY_NODE to be unset."
  }
  if (-not [string]::IsNullOrWhiteSpace($OriginalElectronCandidates)) {
    throw "Windows CI plain-runtime assertion requires WORKBUDDY_ELECTRON_CANDIDATES to be unset."
  }
  $env:USERPROFILE = Join-Path $TestRoot "home"
  $env:LOCALAPPDATA = Join-Path $TestRoot "local"
  $WorkBuddyHome = Join-Path $env:USERPROFILE ".workbuddy"
  Remove-Item Env:\WORKBUDDY_HOME -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Path $env:USERPROFILE, $env:LOCALAPPDATA, $WorkBuddyHome -Force | Out-Null

  # Seed an explicit broad ACE on an existing state directory. /inheritance:r
  # cannot remove explicit entries, so the installer must replace the DACL
  # instead of only adding the current-user grant.
  $SeedStateRoot = Join-Path $env:LOCALAPPDATA "SuperBrainCopilot"
  New-Item -ItemType Directory -Path $SeedStateRoot -Force | Out-Null
  & icacls $SeedStateRoot /grant:r "*S-1-1-0:(OI)(CI)RX" | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to seed the Windows ACL negative control."
  }

  $Installer = Join-Path $Root "connectors\install-windows.ps1"
  $PowerShell = (Get-Process -Id $PID).Path
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $PowerShell
  $start.UseShellExecute = $false
  $start.RedirectStandardInput = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.Environment["USERPROFILE"] = $env:USERPROFILE
  $start.Environment["LOCALAPPDATA"] = $env:LOCALAPPDATA
  $start.Environment.Remove("WORKBUDDY_HOME") | Out-Null
  $start.Environment.Remove("WORKBUDDY_NODE") | Out-Null
  $start.Environment.Remove("WORKBUDDY_NODE_MODE") | Out-Null
  $start.Environment.Remove("WORKBUDDY_ELECTRON_CANDIDATES") | Out-Null
  if ($null -ne $RealDownloadedNode) {
    $start.Environment["WORKBUDDY_NODE"] = $RealDownloadedNode.FullName
    $start.Environment["WORKBUDDY_NODE_MODE"] = "plain"
  }
  elseif ($RealElectronCandidates.Count -gt 0) {
    $start.Environment["WORKBUDDY_ELECTRON_CANDIDATES"] = $RealElectronCandidates -join ";"
  }
  foreach ($argument in @(
      "-NoLogo",
      "-NoProfile",
      "-File",
      $Installer,
      "-ApiUrl",
      "https://copilot.example.test",
      "-CredentialFromStdin",
      "-NoSchedule",
      "-NoImport",
      "-WithDownstream"
    )) {
    $start.ArgumentList.Add($argument)
  }
  $start.Environment.Remove("CONNECTOR_TEST_TOKEN") | Out-Null

  # 不依赖父进程的当前目录（.NET 用的是 Environment.CurrentDirectory，
  # 它与 PowerShell 的 Get-Location 并不同步）。
  $start.WorkingDirectory = $Root

  # CI 上出现过「Root 正确但子进程收到别的路径」，本机无法复现，
  # 因此把真正传出去的内容打出来。
  Write-Host "Installer     = $Installer"
  Write-Host "InstallerType = $($Installer.GetType().FullName)"
  Write-Host "InstallerOnDisk = $(Test-Path -LiteralPath $Installer)"
  Write-Host "ArgumentList  = $($start.ArgumentList -join ' | ')"
  Write-Host "WorkingDir    = $($start.WorkingDirectory)"

  $process = [Diagnostics.Process]::Start($start)
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  try {
    $process.StandardInput.WriteLine($env:CONNECTOR_TEST_TOKEN)
    $process.StandardInput.Close()
    if (-not $process.WaitForExit(60000)) {
      $process.Kill($true)
      $process.WaitForExit()
      throw "Windows connector installer exceeded the 60-second test deadline."
    }
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    $exitCode = $process.ExitCode
  }
  finally {
    if (-not $process.HasExited) {
      $process.Kill($true)
      $process.WaitForExit()
    }
    $process.Dispose()
  }
  if ($exitCode -ne 0) {
    # 失败时必须把安装器的实际输出带出来，否则 CI 上只看得到一个退出码，
    # 本机又没有 pwsh 可复现，等于无法诊断。
    $detail = @(
      "Windows connector installer failed with exit code ${exitCode}.",
      "--- installer stdout ---",
      $stdout,
      "--- installer stderr ---",
      $stderr
    ) -join [Environment]::NewLine
    throw $detail
  }
  $pathNode = (Get-Command node -CommandType Application -ErrorAction Stop).Source
  $runtimeMatch = [regex]::Match(
    $stdout,
    '(?m)^Runtime:\s+(?<path>.+?)\s+\((?<mode>plain|electron), node (?<version>\d+\.\d+\.\d+)\)\s*$'
  )
  if (-not $runtimeMatch.Success) {
    throw "Windows connector installer did not report the detected runtime mode."
  }
  $runtimePath = [IO.Path]::GetFullPath($runtimeMatch.Groups["path"].Value.Trim())
  $pathNode = [IO.Path]::GetFullPath($pathNode)
  if ($runtimeMatch.Groups["mode"].Value -ne "plain") {
    throw "Windows CI must exercise plain PATH node, but installer selected $($runtimeMatch.Groups["mode"].Value)."
  }
  if (-not [string]::Equals($runtimePath, $pathNode, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Windows CI must fall back to PATH node ($pathNode), but installer selected $runtimePath."
  }
  if ($stdout.Contains($env:CONNECTOR_TEST_TOKEN) -or $stderr.Contains($env:CONNECTOR_TEST_TOKEN)) {
    throw "Windows connector installer output leaked credential material."
  }
  if ($stdout.Contains("历史补传") -or $stderr.Contains("历史补传")) {
    throw "Windows connector installer started background import despite -NoImport."
  }

  $InstallRoot = Join-Path $env:LOCALAPPDATA "SuperBrainCopilot\app"
  $StateRoot = Join-Path $env:LOCALAPPDATA "SuperBrainCopilot"
  $Config = Join-Path $StateRoot "config.json"
  $Wrapper = Join-Path $InstallRoot "workbuddy-sync.ps1"
  $Runner = Join-Path $InstallRoot "scheduled-sync.ps1"
  $Skill = Join-Path $WorkBuddyHome "skills\superbrain-sync\SKILL.md"
  $HookWrapper = Join-Path $InstallRoot "workbuddy-hook.sh"
  $WorkBuddySettings = Join-Path $WorkBuddyHome "settings.json"

  foreach ($path in @($Config, $Wrapper, $Runner, $Skill, $HookWrapper, $WorkBuddySettings)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
      throw "Expected installed connector file is missing."
    }
  }

  foreach ($path in @($StateRoot, $Config, $Skill)) {
    $acl = Get-Acl -LiteralPath $path
    if (-not $acl.AreAccessRulesProtected) {
      throw "Installed private connector path still inherits ACL entries."
    }
    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $rules = @($acl.Access)
    $currentUserFullControl = $false
    foreach ($rule in $rules) {
      $ruleSid = $rule.IdentityReference.Translate(
        [Security.Principal.SecurityIdentifier]
      ).Value
      if ($ruleSid -ne $currentSid) {
        throw "ACL grants access to an unexpected principal: path=$path sid=$ruleSid"
      }
      if (
        $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
        (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne
          [Security.AccessControl.FileSystemRights]::FullControl)
      ) {
        throw "Current-user ACL is not an unqualified FullControl grant."
      }
      $currentUserFullControl = $true
    }
    if (-not $currentUserFullControl) {
      throw "Current-user ACL grant is missing."
    }
  }

  $configData = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
  if ($configData.token -ne $env:CONNECTOR_TEST_TOKEN) {
    throw "Protected connector configuration did not receive stdin credential."
  }
  if ($configData.api_url -ne "https://copilot.example.test") {
    throw "Protected connector configuration has the wrong API origin."
  }

  $skillContent = Get-Content -LiteralPath $Skill -Raw
  if (
    $skillContent.Contains($env:CONNECTOR_TEST_TOKEN) -or
    $skillContent.Contains("__WORKBUDDY_CONNECTOR_ENTRYPOINT__") -or
    -not $skillContent.Contains("workbuddy-sync.ps1")
  ) {
    throw "Installed WorkBuddy Skill is unsafe or incomplete."
  }

  $status = & $Wrapper status | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or -not $status.configured -or $status.queue.pending -ne 0) {
    throw "Installed Windows connector status check failed."
  }

  $settings = Get-Content -LiteralPath $WorkBuddySettings -Raw | ConvertFrom-Json
  $registeredHook = @(
    foreach ($block in @($settings.hooks.Stop)) {
      foreach ($candidate in @($block.hooks)) {
        if ($candidate.command -like "*workbuddy-hook.sh*") { $candidate }
      }
    }
  ) | Select-Object -First 1
  if ($null -eq $registeredHook) {
    throw "Windows connector installer did not register a Stop hook command."
  }
  $bashHookPath = $HookWrapper.Replace("\", "/")
  $expectedHookCommand = "bash '$bashHookPath' || true"
  if ($registeredHook.command -ne $expectedHookCommand) {
    throw "Windows connector registered an unexpected Git Bash hook command: $($registeredHook.command)"
  }

  $gitBash = (Get-Command bash -CommandType Application -ErrorAction Stop).Source
  & $gitBash -n $bashHookPath
  if ($LASTEXITCODE -ne 0) {
    throw "Generated Git Bash hook script failed bash -n syntax validation."
  }

  # This covers only the Bash child process spawned below. CodeBuddy's own
  # environment propagation still requires a real logged-in client check.
  $hookSession = [guid]::NewGuid().ToString()
  $hookCwd = "C:/ci/workbuddy"
  $hookTimestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $hookTranscript = Join-Path $TestRoot "stop-hook-transcript.jsonl"
  $hookRows = @(
    (@{ timestamp = 1; type = "ai-title"; aiTitle = "Windows CI hook"; sessionId = $hookSession; cwd = $hookCwd } |
      ConvertTo-Json -Compress -Depth 6),
    (@{
        id = "u1"; timestamp = $hookTimestamp; type = "message"; role = "user"
        content = @(@{ type = "input_text"; text = "<user_query>verify Git Bash hook</user_query>" })
        sessionId = $hookSession; cwd = $hookCwd
      } | ConvertTo-Json -Compress -Depth 6),
    (@{
        id = "a1"; parentId = "p1"; timestamp = ($hookTimestamp + 1000); type = "message"
        role = "assistant"; status = "completed"
        content = @(@{ type = "output_text"; text = "hook reply" })
        sessionId = $hookSession; cwd = $hookCwd
      } | ConvertTo-Json -Compress -Depth 6)
  )
  [IO.File]::WriteAllText(
    $hookTranscript,
    (($hookRows -join "`n") + "`n"),
    (New-Object Text.UTF8Encoding($false))
  )
  $hookPayload = @{
    hook_event_name = "Stop"
    session_id = $hookSession
    transcript_path = $hookTranscript
    cwd = $hookCwd
  } | ConvertTo-Json -Compress -Depth 6
  $outbox = Join-Path $StateRoot "outbox"
  $outboxBefore = @(Get-ChildItem -LiteralPath $outbox -Filter "*.json" -File).Count

  $hookStart = [Diagnostics.ProcessStartInfo]::new()
  $hookStart.FileName = $gitBash
  $hookStart.UseShellExecute = $false
  $hookStart.RedirectStandardInput = $true
  $hookStart.RedirectStandardOutput = $true
  $hookStart.RedirectStandardError = $true
  $hookStart.Environment["LOCALAPPDATA"] = $env:LOCALAPPDATA
  $hookStart.Environment["WORKBUDDY_HOME"] = $WorkBuddyHome
  $hookStart.ArgumentList.Add("-lc")
  $hookStart.ArgumentList.Add("bash '$bashHookPath'")
  $hookProcess = [Diagnostics.Process]::Start($hookStart)
  $hookStdoutTask = $hookProcess.StandardOutput.ReadToEndAsync()
  $hookStderrTask = $hookProcess.StandardError.ReadToEndAsync()
  try {
    $hookProcess.StandardInput.Write($hookPayload)
    $hookProcess.StandardInput.Close()
    if (-not $hookProcess.WaitForExit(30000)) {
      $hookProcess.Kill($true)
      $hookProcess.WaitForExit()
      throw "Git Bash hook invocation exceeded the 30-second test deadline."
    }
    $hookStdout = $hookStdoutTask.GetAwaiter().GetResult()
    $hookStderr = $hookStderrTask.GetAwaiter().GetResult()
    $hookExitCode = $hookProcess.ExitCode
  }
  finally {
    if (-not $hookProcess.HasExited) {
      $hookProcess.Kill($true)
      $hookProcess.WaitForExit()
    }
    $hookProcess.Dispose()
  }
  if ($hookExitCode -ne 0) {
    throw "Git Bash hook invocation failed with exit code ${hookExitCode}: $hookStderr"
  }
  $outboxAfter = @(Get-ChildItem -LiteralPath $outbox -Filter "*.json" -File).Count
  if ($outboxAfter -ne ($outboxBefore + 1)) {
    throw "Hook child did not enqueue exactly one event under LOCALAPPDATA state root $StateRoot."
  }

  # 默认（不传 -WithDownstream）必须一个下行 Skill 都不落地。
  # 用一个全新的 profile，避免受上面 -WithDownstream 安装的残留影响。
  $DefaultUserProfile = Join-Path $TestRoot "home-default"
  $DefaultLocalAppData = Join-Path $TestRoot "local-default"
  New-Item -ItemType Directory -Path $DefaultUserProfile, $DefaultLocalAppData -Force | Out-Null

  $defaultStart = [Diagnostics.ProcessStartInfo]::new()
  $defaultStart.FileName = $PowerShell
  $defaultStart.UseShellExecute = $false
  $defaultStart.RedirectStandardInput = $true
  $defaultStart.RedirectStandardOutput = $true
  $defaultStart.RedirectStandardError = $true
  $defaultStart.Environment["USERPROFILE"] = $DefaultUserProfile
  $defaultStart.Environment["LOCALAPPDATA"] = $DefaultLocalAppData
  $DefaultWorkBuddyHome = Join-Path $DefaultUserProfile ".workbuddy"
  $defaultStart.Environment.Remove("WORKBUDDY_HOME") | Out-Null
  foreach ($argument in @(
      "-NoLogo",
      "-NoProfile",
      "-File",
      $Installer,
      "-ApiUrl",
      "https://copilot.example.test",
      "-CredentialFromStdin",
      "-NoSchedule",
      "-NoImport"
    )) {
    $defaultStart.ArgumentList.Add($argument)
  }
  $defaultStart.Environment.Remove("CONNECTOR_TEST_TOKEN") | Out-Null

  $defaultProcess = [Diagnostics.Process]::Start($defaultStart)
  $defaultStdoutTask = $defaultProcess.StandardOutput.ReadToEndAsync()
  $defaultStderrTask = $defaultProcess.StandardError.ReadToEndAsync()
  try {
    $defaultProcess.StandardInput.WriteLine($env:CONNECTOR_TEST_TOKEN)
    $defaultProcess.StandardInput.Close()
    if (-not $defaultProcess.WaitForExit(60000)) {
      $defaultProcess.Kill($true)
      $defaultProcess.WaitForExit()
      throw "Default Windows connector installer exceeded the 60-second test deadline."
    }
    $defaultStdout = $defaultStdoutTask.GetAwaiter().GetResult()
    $defaultStderr = $defaultStderrTask.GetAwaiter().GetResult()
    $defaultExitCode = $defaultProcess.ExitCode
  }
  finally {
    if (-not $defaultProcess.HasExited) {
      $defaultProcess.Kill($true)
      $defaultProcess.WaitForExit()
    }
    $defaultProcess.Dispose()
  }
  if ($defaultExitCode -ne 0) {
    throw "Default Windows connector installer failed with exit code $defaultExitCode."
  }
  if ($defaultStdout.Contains($env:CONNECTOR_TEST_TOKEN) -or $defaultStderr.Contains($env:CONNECTOR_TEST_TOKEN)) {
    throw "Default Windows connector installer output leaked credential material."
  }

  $DefaultSkillRoot = Join-Path $DefaultWorkBuddyHome "skills"
  $DefaultSkill = Join-Path $DefaultSkillRoot "superbrain-sync\SKILL.md"
  if (Test-Path -LiteralPath $DefaultSkill -PathType Leaf) {
    throw "Default Windows connector installation unexpectedly installed the downstream SKILL.md."
  }
  if (Test-Path -LiteralPath $DefaultSkillRoot) {
    throw "Default Windows connector installation unexpectedly created the downstream skills directory."
  }
  if (-not $defaultStdout.Contains("Downstream skill not installed")) {
    throw "Default Windows connector installation did not report that downstream is disabled."
  }
  if (-not $defaultStdout.Contains("-WithDownstream")) {
    throw "Default Windows connector installation did not explain how to enable downstream."
  }

  # 默认不装下行 ≠ 什么都没装：上行连接器与 Stop hook 所需模块仍必须就位。
  $DefaultInstallRoot = Join-Path $DefaultLocalAppData "SuperBrainCopilot\app"
  $DefaultWrapper = Join-Path $DefaultInstallRoot "workbuddy-sync.ps1"
  if (-not (Test-Path -LiteralPath $DefaultWrapper -PathType Leaf)) {
    throw "Default Windows connector installation did not install the upstream wrapper."
  }
  foreach ($module in @(
      "workbuddy-sync.mjs",
      "workbuddy-hook.mjs",
      "workbuddy-transcript.mjs",
      "workbuddy-event-id.mjs"
    )) {
    $canonical = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $Root "connectors\$module")).Hash
    $installed = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $DefaultInstallRoot $module)).Hash
    if ($canonical -ne $installed) {
      throw "Default Windows connector installation differs from the canonical upstream module."
    }
  }

  # Keep the import workload in a separate temporary profile so its asynchronous
  # queue cannot race the Git Bash hook assertion above.
  $ImportUserProfile = Join-Path $TestRoot "home-import"
  $ImportLocalAppData = Join-Path $TestRoot "local-import"
  $ImportWorkBuddyHome = Join-Path $TestRoot "workbuddy-import"
  $ImportProjects = Join-Path $ImportWorkBuddyHome "projects"
  New-Item -ItemType Directory -Path $ImportUserProfile, $ImportLocalAppData, $ImportProjects -Force | Out-Null
  $importTimestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  foreach ($index in 1..6) {
    $importSession = [guid]::NewGuid().ToString()
    $importProject = Join-Path $ImportProjects "project-$index"
    New-Item -ItemType Directory -Path $importProject -Force | Out-Null
    $importRows = @(
      (@{ timestamp = 1; type = "ai-title"; aiTitle = "Background import $index"; sessionId = $importSession; cwd = "C:/ci/import" } |
        ConvertTo-Json -Compress -Depth 6),
      (@{
          id = "u$index"; timestamp = ($importTimestamp + $index); type = "message"; role = "user"
          content = @(@{ type = "input_text"; text = "<user_query>background import $index</user_query>" })
          sessionId = $importSession; cwd = "C:/ci/import"
        } | ConvertTo-Json -Compress -Depth 6),
      (@{
          id = "a$index"; timestamp = ($importTimestamp + 1000 + $index); type = "message"
          role = "assistant"; status = "completed"
          content = @(@{ type = "output_text"; text = "background reply $index" })
          sessionId = $importSession; cwd = "C:/ci/import"
        } | ConvertTo-Json -Compress -Depth 6)
    )
    [IO.File]::WriteAllText(
      (Join-Path $importProject "$importSession.jsonl"),
      (($importRows -join "`n") + "`n"),
      (New-Object Text.UTF8Encoding($false))
    )
  }

  $importStart = [Diagnostics.ProcessStartInfo]::new()
  $importStart.FileName = $PowerShell
  $importStart.UseShellExecute = $false
  $importStart.RedirectStandardInput = $true
  $importStart.RedirectStandardOutput = $true
  $importStart.RedirectStandardError = $true
  $importStart.Environment["USERPROFILE"] = $ImportUserProfile
  $importStart.Environment["LOCALAPPDATA"] = $ImportLocalAppData
  $importStart.Environment["WORKBUDDY_HOME"] = $ImportWorkBuddyHome
  foreach ($argument in @(
      "-NoLogo",
      "-NoProfile",
      "-File",
      $Installer,
      "-ApiUrl",
      "https://127.0.0.1:9",
      "-CredentialFromStdin",
      "-NoSchedule",
      "-NoHook"
    )) {
    $importStart.ArgumentList.Add($argument)
  }
  $importStart.Environment.Remove("CONNECTOR_TEST_TOKEN") | Out-Null

  $backgroundImportStopwatch = [Diagnostics.Stopwatch]::StartNew()
  $importProcess = [Diagnostics.Process]::Start($importStart)
  $importStdoutTask = $importProcess.StandardOutput.ReadToEndAsync()
  $importStderrTask = $importProcess.StandardError.ReadToEndAsync()
  try {
    $importProcess.StandardInput.WriteLine($env:CONNECTOR_TEST_TOKEN)
    $importProcess.StandardInput.Close()
    if (-not $importProcess.WaitForExit(8000)) {
      $importProcess.Kill($true)
      $importProcess.WaitForExit()
      throw "Background import blocked the Windows installer for more than eight seconds."
    }
    $importStdout = $importStdoutTask.GetAwaiter().GetResult()
    $importStderr = $importStderrTask.GetAwaiter().GetResult()
    $importExitCode = $importProcess.ExitCode
  }
  finally {
    if (-not $importProcess.HasExited) {
      $importProcess.Kill($true)
      $importProcess.WaitForExit()
    }
    $importProcess.Dispose()
  }
  $backgroundImportStopwatch.Stop()
  if ($importExitCode -ne 0) {
    throw "Background import installer failed with exit code $importExitCode."
  }
  if ($backgroundImportStopwatch.Elapsed.TotalSeconds -gt 8) {
    throw "Background import installer exceeded the eight-second non-blocking budget."
  }
  if (-not $importStdout.Contains("历史补传（近 7 天）已在后台开始")) {
    throw "Background import installer did not report that import started asynchronously."
  }
  $ImportLog = Join-Path $ImportLocalAppData "SuperBrainCopilot\logs\import.log"
  $importLogDeadline = [DateTime]::UtcNow.AddSeconds(10)
  $importLogReady = $false
  do {
    if (Test-Path -LiteralPath $ImportLog -PathType Leaf) {
      $importLogContent = Get-Content -LiteralPath $ImportLog -Raw
      if ($importLogContent.Contains("workbuddy-import: scanned 6 session file(s)")) {
        $importLogReady = $true
        break
      }
    }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $importLogDeadline)
  if (-not $importLogReady) {
    throw "Background import did not create the expected import log in the sandbox profile."
  }

  # 学员实际下载到的那份必须和仓库里的规范版本逐字节一致。
  foreach ($asset in @(
      "workbuddy-sync.mjs",
      "workbuddy-hook.mjs",
      "workbuddy-transcript.mjs",
      "workbuddy-event-id.mjs",
      "detect-runtime.sh",
      "install-macos.sh",
      "install-windows.ps1",
      "SKILL.md"
    )) {
    $canonical = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $Root "connectors\$asset")).Hash
    $download = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $Root "public\downloads\$asset")).Hash
    if ($canonical -ne $download) {
      throw "Published connector asset differs from canonical source."
    }
  }

  if (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue) {
    if ($null -ne (Get-ScheduledTask -TaskName "SuperBrain WorkBuddy Sync" -ErrorAction SilentlyContinue)) {
      throw "-NoSchedule registered a persistent scheduled task."
    }
  }

  Write-Host "Windows connector install verification passed."
}
finally {
  $env:USERPROFILE = $OriginalUserProfile
  $env:LOCALAPPDATA = $OriginalLocalAppData
  if ($null -eq $OriginalWorkBuddyHome) {
    Remove-Item Env:\WORKBUDDY_HOME -ErrorAction SilentlyContinue
  }
  else {
    $env:WORKBUDDY_HOME = $OriginalWorkBuddyHome
  }
  Remove-Item -LiteralPath $TestRoot -Recurse -Force -ErrorAction SilentlyContinue
}
