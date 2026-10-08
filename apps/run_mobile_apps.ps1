param(
  [string]$ApiBaseUrl = "http://localhost:4000",
  [string]$AppMode = "demo",
  [int]$CustomerPort = 5101,
  [int]$DriverPort = 5102,
  [switch]$UseChrome
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command flutter -ErrorAction SilentlyContinue)) {
  Write-Host "Flutter SDK was not found in PATH." -ForegroundColor Yellow
  Write-Host "Install Flutter, then run this script again from the repo root:" -ForegroundColor Yellow
  Write-Host "powershell -ExecutionPolicy Bypass -File apps/run_mobile_apps.ps1" -ForegroundColor Cyan
  exit 1
}

$root = Split-Path -Parent $PSScriptRoot
$customerDir = Join-Path $PSScriptRoot "customer_app"
$driverDir = Join-Path $PSScriptRoot "driver_app"

Write-Host "Starting MISHWAR Flutter apps..." -ForegroundColor Green
Write-Host "Customer app: http://localhost:$CustomerPort" -ForegroundColor Cyan
Write-Host "Driver app:   http://localhost:$DriverPort" -ForegroundColor Cyan
Write-Host "Backend API:  $ApiBaseUrl" -ForegroundColor Cyan

$device = if ($UseChrome) { "chrome" } else { "web-server" }

Start-Process powershell -ArgumentList @(
  "-NoExit",
  "-Command",
  "cd `"$customerDir`"; flutter pub get; flutter run -d $device --web-port=$CustomerPort --dart-define=MISHWAR_API_BASE_URL=$ApiBaseUrl --dart-define=MISHWAR_APP_MODE=$AppMode"
)

Start-Process powershell -ArgumentList @(
  "-NoExit",
  "-Command",
  "cd `"$driverDir`"; flutter pub get; flutter run -d $device --web-port=$DriverPort --dart-define=MISHWAR_API_BASE_URL=$ApiBaseUrl --dart-define=MISHWAR_APP_MODE=$AppMode"
)

