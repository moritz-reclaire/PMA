#!/usr/bin/env bash
# Serve the course browser locally.
cd "$(dirname "$0")" || exit 1
PORT="${1:-8000}"
echo "Serving Course Browser at http://localhost:$PORT  (Ctrl+C to stop)"
python3 -m http.server "$PORT"
