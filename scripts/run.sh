#!/usr/bin/env bash
# Start QE Studio (backend + built UI) and open the browser. Extra arguments go to qe-studio.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -d .venv ] || { echo "Run scripts/setup.sh first." >&2; exit 1; }
. .venv/bin/activate
exec qe-studio "$@"
