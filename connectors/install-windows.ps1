[CmdletBinding()]
param(
  [ValidateSet("Install", "Upgrade", "Uninstall")]
  [string]$Action = "Install",
  [string]$ApiUrl,
  [switch]$CredentialFromStdin,
  [switch]$NoSchedule
)

$ErrorActionPreference = "Stop"
$TaskName = "SuperBrain WorkBuddy Sync"
$InstallRoot = Join-Path $env:LOCALAPPDATA "SuperBrainCopilot\app"
$StateRoot = Join-Path $env:LOCALAPPDATA "SuperBrainCopilot"
$Connector = Join-Path $InstallRoot "workbuddy-sync.mjs"
$SkillTemplate = Join-Path $InstallRoot "SKILL.template.md"
$Wrapper = Join-Path $InstallRoot "workbuddy-sync.ps1"
$Runner = Join-Path $InstallRoot "scheduled-sync.ps1"
$LogRoot = Join-Path $StateRoot "logs"
$RunnerLog = Join-Path $LogRoot "scheduled-sync.log"
$WorkBuddySkillRoot = Join-Path $env:USERPROFILE ".workbuddy\skills\superbrain-sync"
$InstalledSkill = Join-Path $WorkBuddySkillRoot "SKILL.md"

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
  Remove-Item `
    -LiteralPath $Connector, $SkillTemplate, $Wrapper, $Runner, $InstalledSkill `
    -Force `
    -ErrorAction SilentlyContinue
  Write-Host "Connector program removed. Private queue and configuration were preserved at $StateRoot."
  exit 0
}

if ([string]::IsNullOrWhiteSpace($ApiUrl)) {
  throw "-ApiUrl is required for install or upgrade."
}

$node = (Get-Command node -ErrorAction Stop).Source
$nodeMajor = [int](& $node -p 'Number(process.versions.node.split(".")[0])')
if ($nodeMajor -lt 22) {
  throw "Node.js 22 or newer is required."
}

$sourceConnector = Join-Path $PSScriptRoot "workbuddy-sync.mjs"
$sourceSkill = Join-Path $PSScriptRoot "SKILL.md"
if (-not (Test-Path -LiteralPath $sourceConnector) -or -not (Test-Path -LiteralPath $sourceSkill)) {
  throw "workbuddy-sync.mjs and SKILL.md must be downloaded beside this installer."
}

New-Item `
  -ItemType Directory `
  -Path $InstallRoot, $StateRoot, $LogRoot, $WorkBuddySkillRoot `
  -Force | Out-Null
Copy-Item -LiteralPath $sourceConnector -Destination $Connector -Force
Copy-Item -LiteralPath $sourceSkill -Destination $SkillTemplate -Force

$currentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$identity = $currentIdentity.Name
$currentSid = $currentIdentity.User
Set-PrivateDirectoryAcl -Path $StateRoot
Set-PrivateDirectoryAcl -Path $InstallRoot
Set-PrivateDirectoryAcl -Path (Join-Path $env:USERPROFILE ".workbuddy")

$nodeLiteral = "'" + $node.Replace("'", "''") + "'"
$connectorLiteral = "'" + $Connector.Replace("'", "''") + "'"
@"
`$ErrorActionPreference = "Stop"
& $nodeLiteral $connectorLiteral @args
exit `$LASTEXITCODE
"@ | Set-Content -LiteralPath $Wrapper -Encoding UTF8

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
    $plainCredential | & $node $Connector configure --api-url $ApiUrl --token-stdin
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
`$logFile = $logLiteral
`$status = 0
"`$([DateTime]::UtcNow.ToString("o")) scheduled sync start" | Add-Content -LiteralPath `$logFile
& $nodeLiteral $connectorLiteral flush 1>`$null 2>>`$logFile
if (`$LASTEXITCODE -eq 0) {
  "`$([DateTime]::UtcNow.ToString("o")) flush ok" | Add-Content -LiteralPath `$logFile
} else {
  "`$([DateTime]::UtcNow.ToString("o")) flush failed" | Add-Content -LiteralPath `$logFile
  `$status = 1
}
& $nodeLiteral $connectorLiteral fetch 1>`$null 2>>`$logFile
if (`$LASTEXITCODE -eq 0) {
  "`$([DateTime]::UtcNow.ToString("o")) fetch ok" | Add-Content -LiteralPath `$logFile
} else {
  "`$([DateTime]::UtcNow.ToString("o")) fetch failed" | Add-Content -LiteralPath `$logFile
  `$status = 1
}
exit `$status
"@ | Set-Content -LiteralPath $Runner -Encoding UTF8

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

Write-Host "SuperBrain WorkBuddy connector installed for the current user."
Write-Host "Skill installed at: $InstalledSkill"
Write-Host "Connector command: $Wrapper"
Write-Host "Run in PowerShell: & `"$Wrapper`" status"
Write-Host "Restart WorkBuddy to load the new skill."
