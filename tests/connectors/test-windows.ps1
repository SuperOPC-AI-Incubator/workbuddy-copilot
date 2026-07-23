[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($env:CONNECTOR_TEST_TOKEN)) {
  throw "CONNECTOR_TEST_TOKEN is required."
}

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$TestRoot = Join-Path ([IO.Path]::GetTempPath()) ("superbrain-connector-" + [guid]::NewGuid())
$OriginalUserProfile = $env:USERPROFILE
$OriginalLocalAppData = $env:LOCALAPPDATA

try {
  $env:USERPROFILE = Join-Path $TestRoot "home"
  $env:LOCALAPPDATA = Join-Path $TestRoot "local"
  New-Item -ItemType Directory -Path $env:USERPROFILE, $env:LOCALAPPDATA -Force | Out-Null

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
  foreach ($argument in @(
      "-NoLogo",
      "-NoProfile",
      "-File",
      $Installer,
      "-ApiUrl",
      "https://copilot.example.test",
      "-CredentialFromStdin",
      "-NoSchedule"
    )) {
    $start.ArgumentList.Add($argument)
  }
  $start.Environment.Remove("CONNECTOR_TEST_TOKEN") | Out-Null

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
    throw "Windows connector installer failed with exit code $exitCode."
  }
  if ($stdout.Contains($env:CONNECTOR_TEST_TOKEN) -or $stderr.Contains($env:CONNECTOR_TEST_TOKEN)) {
    throw "Windows connector installer output leaked credential material."
  }

  $InstallRoot = Join-Path $env:LOCALAPPDATA "SuperBrainCopilot\app"
  $StateRoot = Join-Path $env:LOCALAPPDATA "SuperBrainCopilot"
  $Config = Join-Path $StateRoot "config.json"
  $Wrapper = Join-Path $InstallRoot "workbuddy-sync.ps1"
  $Runner = Join-Path $InstallRoot "scheduled-sync.ps1"
  $Skill = Join-Path $env:USERPROFILE ".workbuddy\skills\superbrain-sync\SKILL.md"

  foreach ($path in @($Config, $Wrapper, $Runner, $Skill)) {
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

  foreach ($asset in @("workbuddy-sync.mjs", "install-macos.sh", "install-windows.ps1", "SKILL.md")) {
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
  Remove-Item -LiteralPath $TestRoot -Recurse -Force -ErrorAction SilentlyContinue
}
