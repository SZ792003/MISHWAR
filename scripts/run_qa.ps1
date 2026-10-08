param(
  [switch]$SkipFlutter,
  [switch]$BackendOnly
)

$ErrorActionPreference = "Stop"
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$results = New-Object System.Collections.Generic.List[object]

function Invoke-QAStep {
  param(
    [string]$Name,
    [string]$WorkingDirectory,
    [string]$Command
  )

  Write-Host ""
  Write-Host "==> $Name"
  $started = Get-Date
  Push-Location $WorkingDirectory
  try {
    powershell -NoProfile -ExecutionPolicy Bypass -Command $Command
    $elapsed = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)
    $results.Add([pscustomobject]@{ Name = $Name; Status = "PASS"; Seconds = $elapsed }) | Out-Null
    Write-Host "PASS $Name ($elapsed s)"
  } catch {
    $elapsed = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)
    $results.Add([pscustomobject]@{ Name = $Name; Status = "FAIL"; Seconds = $elapsed }) | Out-Null
    Write-Host "FAIL $Name ($elapsed s)"
    throw
  } finally {
    Pop-Location
  }
}

try {
  Invoke-QAStep "Backend critical gate" (Join-Path $repoRoot "backend") "npm.cmd run qa:critical"

  if (-not $BackendOnly -and -not $SkipFlutter) {
    Invoke-QAStep "Flutter shared checks" (Join-Path $repoRoot "apps\mishwar_shared") "flutter pub get; flutter analyze --no-fatal-infos --no-fatal-warnings; flutter test"
    Invoke-QAStep "Flutter customer checks" (Join-Path $repoRoot "apps\customer_app") "flutter pub get; flutter analyze --no-fatal-infos --no-fatal-warnings; flutter test"
    Invoke-QAStep "Flutter driver checks" (Join-Path $repoRoot "apps\driver_app") "flutter pub get; flutter analyze --no-fatal-infos --no-fatal-warnings; flutter test"
  }
} finally {
  Write-Host ""
  Write-Host "QA summary"
  $results | Format-Table -AutoSize
}
