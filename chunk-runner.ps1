# chunk-runner.ps1
# Run this ONCE on your dev machine to split the runner zip into chunks
# Place this script in your project root and run from PowerShell

$ErrorActionPreference = "Stop"

$RUNNER_VERSION = "2.332.0"
$RUNNER_URL     = "https://github.com/actions/runner/releases/download/v$RUNNER_VERSION/actions-runner-win-x64-$RUNNER_VERSION.zip"
$SCRIPT_DIR     = Split-Path -Parent $MyInvocation.MyCommand.Path
$RUNNER_ZIP     = Join-Path $SCRIPT_DIR "actions-runner.zip"
$CHUNKS_DIR     = Join-Path $SCRIPT_DIR "bin\runner"
$CHUNK_SIZE     = 50MB

Write-Host "DSA Payroll - Runner Chunker" -ForegroundColor Cyan
Write-Host "=============================" -ForegroundColor Cyan

# Download runner zip if not already present
if (-not (Test-Path $RUNNER_ZIP)) {
    Write-Host "`n[1/3] Downloading runner v$RUNNER_VERSION..." -ForegroundColor Yellow
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $RUNNER_URL -OutFile $RUNNER_ZIP -UseBasicParsing
    Write-Host "[1/3] Downloaded ✔" -ForegroundColor Green
} else {
    Write-Host "`n[1/3] Runner zip already exists — skipping download." -ForegroundColor Green
}

# Create chunks directory
Write-Host "`n[2/3] Splitting into ~50MB chunks..." -ForegroundColor Yellow
if (-not (Test-Path $CHUNKS_DIR)) {
    New-Item -ItemType Directory -Force -Path $CHUNKS_DIR | Out-Null
}

# Remove existing chunks
Get-ChildItem "$CHUNKS_DIR\runner.part*" -ErrorAction SilentlyContinue | Remove-Item -Force

# Read and split
$bytes      = [System.IO.File]::ReadAllBytes((Resolve-Path $RUNNER_ZIP))
$totalSize  = $bytes.Length
$chunkBytes = [int]$CHUNK_SIZE
$chunks     = [Math]::Ceiling($totalSize / $chunkBytes)

for ($i = 0; $i -lt $chunks; $i++) {
    $start  = $i * $chunkBytes
    $length = [Math]::Min($chunkBytes, $totalSize - $start)
    $chunk  = $bytes[$start..($start + $length - 1)]
    $file   = Join-Path $CHUNKS_DIR "runner.part$i"
    [System.IO.File]::WriteAllBytes($file, $chunk)
    $sizeMB = [Math]::Round($length / 1MB, 1)
    Write-Host "  + runner.part$i ($sizeMB MB)" -ForegroundColor Gray
}

Write-Host "[2/3] Split into $chunks chunks ✔" -ForegroundColor Green

# Cleanup zip
Write-Host "`n[3/3] Cleaning up zip..." -ForegroundColor Yellow
if (Test-Path $RUNNER_ZIP) { Remove-Item $RUNNER_ZIP -Force }
Write-Host "[3/3] Done ✔" -ForegroundColor Green

Write-Host "`n=============================" -ForegroundColor Cyan
Write-Host "Chunks saved to: $CHUNKS_DIR" -ForegroundColor Cyan
Write-Host "Now commit and push:" -ForegroundColor Cyan
Write-Host "  git add bin/runner/" -ForegroundColor White
Write-Host "  git commit -m `"add runner chunks`"" -ForegroundColor White
Write-Host "  git push" -ForegroundColor White
Write-Host "=============================" -ForegroundColor Cyan
