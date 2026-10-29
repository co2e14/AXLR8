#!/usr/bin/env bash
# Start the simulation API (port 8000) and the web app (port 5173) together.
set -euo pipefail
cd "$(dirname "$0")"
(cd backend && uv sync --quiet --extra db && uv run --extra db uvicorn axlr8.api:app --port 8000) &
API=$!
trap 'kill $API 2>/dev/null' EXIT
cd frontend
[ -d node_modules ] || npm install
npm run dev -- --open
