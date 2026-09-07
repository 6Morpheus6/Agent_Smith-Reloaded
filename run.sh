#!/usr/bin/env bash
# Linux / macOS launcher. Installs deps for THIS machine on first run (or after
# moving the project from another OS), then starts the app.
#   Usage:  bash run.sh
set -e
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required (https://nodejs.org). Install Node 18+ and re-run." >&2
  exit 1
fi
exec node scripts/bootstrap.mjs
