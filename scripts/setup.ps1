# One-time setup on Windows (PowerShell): Python venv + web UI build.
# Local calculations on Windows need Windows QE binaries (upload them in Connections & QE) or WSL;
# SSH and Kaggle connections work without either.
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
if (-not (Test-Path .venv)) { py -3 -m venv .venv }
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\pip.exe install -e "backend[test]"
Push-Location frontend
npm ci --no-audit --no-fund
npm run build
Pop-Location
Write-Host "Setup complete. Start with: scripts\run.ps1"
