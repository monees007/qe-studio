# Start QE Studio on Windows (backend + built UI); extra arguments are passed to qe-studio.
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
if (-not (Test-Path .venv)) { throw "Run scripts\setup.ps1 first." }
& .\.venv\Scripts\qe-studio.exe @args
