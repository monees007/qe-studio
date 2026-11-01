#!/usr/bin/env bash
# One-time setup on Linux/macOS: Python venv for the backend + build of the web UI.
set -euo pipefail
cd "$(dirname "$0")/.."
PY=${PYTHON:-python3}
"$PY" -c 'import sys; assert sys.version_info >= (3, 10), "Python >= 3.10 required"'
[ -d .venv ] || "$PY" -m venv .venv
. .venv/bin/activate
python -m pip install --upgrade pip
pip install -e "backend[test]"
if command -v npm >/dev/null 2>&1; then
  (cd frontend && npm ci --no-audit --no-fund && npm run build)
else
  echo "npm not found: install Node.js >= 20 to build the web UI (or use the Docker image)." >&2
  exit 1
fi
echo "Setup complete. Start with: scripts/run.sh"
