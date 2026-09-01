#!/usr/bin/env bash
# Serve the course browser locally.
#
# Sends no-store on every response: the app is a set of ES modules, and browsers
# cache those aggressively enough that edits to js/*.js would otherwise not show
# up on a normal reload.
cd "$(dirname "$0")" || exit 1
PORT="${1:-8000}"
echo "Serving Course Browser at http://localhost:$PORT  (Ctrl+C to stop)"
python - "$PORT" <<'PY'
import sys, functools, http.server, socketserver

class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Expires", "0")
        super().end_headers()

class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

port = int(sys.argv[1])
with Server(("", port), Handler) as httpd:
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print()
PY
