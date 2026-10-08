param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("staging", "production")]
  [string]$Environment,

  [Parameter(Mandatory = $true)]
  [string]$ProjectId,

  [switch]$Rules,
  [switch]$Indexes,
  [switch]$Storage,
  [switch]$DryRun,
  [string]$ConfirmProduction
)

$ErrorActionPreference = "Stop"
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")

if ($Environment -eq "production" -and $ConfirmProduction -ne "DEPLOY_PRODUCTION") {
  throw "Production deploy requires -ConfirmProduction DEPLOY_PRODUCTION"
}

if (-not $Rules -and -not $Indexes -and -not $Storage) {
  $Rules = $true
  $Indexes = $true
  $Storage = $true
}

$targets = @()
if ($Rules) { $targets += "firestore:rules" }
if ($Indexes) { $targets += "firestore:indexes" }
if ($Storage) { $targets += "storage" }

$targetArg = ($targets -join ",")
$command = "firebase deploy --project `"$ProjectId`" --only `"$targetArg`""

Write-Host "Environment: $Environment"
Write-Host "Project: $ProjectId"
Write-Host "Targets: $targetArg"

if ($DryRun) {
  Write-Host "DRY RUN: $command"
  exit 0
}

Push-Location $repoRoot
try {
  firebase deploy --project $ProjectId --only $targetArg
} finally {
  Pop-Location
}
