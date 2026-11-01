#!/usr/bin/env bash
# Development mode: backend with auto-reload on :8765 and the Vite dev server (HMR) on :5173.
set -euo pipefail
cd "$(dirname "$0")/.."
. .venv/bin/activate
python -m qestudio.cli --print-token >/dev/null   # make sure the API token exists for the Vite plugin
uvicorn qestudio.main:factory --factory --reload --reload-dir backend/qestudio --port 8765 &
BACK=$!
trap 'kill $BACK 2>/dev/null' EXIT
cd frontend && npm run dev
