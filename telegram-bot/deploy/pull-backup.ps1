# Pulls the bot's snapshot from the server to this Windows PC. Run daily by
# Task Scheduler (see DEPLOY.md, "Копія на домашній комп'ютер").
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File pull-backup.ps1 -Server root@<host>
#
# The server cannot reach a home PC, so the PC fetches. It needs SSH key access
# to the server (no password prompts: BatchMode). Each run keeps a dated copy,
# checks that it parses as a snapshot before keeping it, and deletes copies
# older than -KeepDays. The folder is readable by this Windows user only: the
# snapshot holds health data.
param(
  [Parameter(Mandatory = $true)][string]$Server,
  [string]$RemoteFile = "/var/lib/gad7-phq9-bot/results.json",
  [string]$Destination = (Join-Path $env:USERPROFILE "ModdTrackerBackups"),
  [int]$KeepDays = 60
)
$ErrorActionPreference = "Stop"

if (-not (Test-Path $Destination)) {
  New-Item -ItemType Directory -Path $Destination | Out-Null
  # Owner only: no inherited access for other accounts on this PC.
  icacls $Destination /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F" | Out-Null
}
$log = Join-Path $Destination "backup.log"
function Write-Log([string]$message) {
  Add-Content -Path $log -Value ((Get-Date -Format "yyyy-MM-dd HH:mm:ss") + " " + $message) -Encoding utf8
}

$stamp = Get-Date -Format "yyyy-MM-dd"
$target = Join-Path $Destination "results-$stamp.json"
$partial = "$target.part"
try {
  # scp wants an IPv6 host in brackets.
  $remote = $Server -replace '@([0-9a-fA-F:]+:[0-9a-fA-F:]+)$', '@[$1]'
  & scp -q -o BatchMode=yes -o ConnectTimeout=20 "${remote}:$RemoteFile" $partial
  if ($LASTEXITCODE -ne 0) { throw "scp exited with $LASTEXITCODE" }
  $parsed = Get-Content $partial -Raw -Encoding utf8 | ConvertFrom-Json
  if ($null -eq $parsed.users) { throw "the copy has no users object" }
  Move-Item -Force $partial $target
  $count = @($parsed.users.PSObject.Properties).Count
  Write-Log ("ok " + (Split-Path $target -Leaf) + ", users " + $count + ", " + (Get-Item $target).Length + " bytes")
} catch {
  if (Test-Path $partial) { Remove-Item -Force $partial }
  Write-Log ("FAILED: " + $_.Exception.Message)
  exit 1
}

Get-ChildItem $Destination -Filter "results-*.json" |
  Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$KeepDays) } |
  Remove-Item -Force
