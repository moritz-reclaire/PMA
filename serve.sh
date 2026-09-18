#!/usr/bin/env bash
# Serve the course browser locally.
#
# Two things the stock python -m http.server does not do:
#   * no-store on the app's own files — the app is a set of ES modules, and
#     browsers cache those aggressively enough that edits to js/*.js would
#     otherwise not show up on a normal reload. Media in media/ is left
#     cacheable; re-downloading 40 MB videos on every reload is not helpful.
#   * Range requests — <video> needs them to seek to a spot it has not
#     buffered yet, and the built-in handler answers every GET with 200 and
#     the whole file.
cd "$(dirname "$0")" || exit 1
PORT="${1:-8000}"
echo "Serving Course Browser at http://localhost:$PORT  (Ctrl+C to stop)"
python - "$PORT" <<'PY'
import sys, os, re, http.server, socketserver

RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)$")
CHUNK = 64 * 1024
# Source files get edited between reloads; media does not.
VOLATILE = (".html", ".js", ".css", ".json")


class Handler(http.server.SimpleHTTPRequestHandler):
    range_remaining = None

    def end_headers(self):
        if self.path.split("?")[0].endswith(VOLATILE) or self.path.endswith("/"):
            self.send_header("Cache-Control", "no-store, must-revalidate")
            self.send_header("Expires", "0")
        self.send_header("Accept-Ranges", "bytes")
        super().end_headers()

    def send_head(self):
        self.range_remaining = None
        header = self.headers.get("Range")
        match = RANGE_RE.match(header.strip()) if header else None
        if not match:
            return super().send_head()

        path = self.translate_path(self.path)
        if os.path.isdir(path):
            return super().send_head()
        try:
            f = open(path, "rb")
        except OSError:
            self.send_error(404, "File not found")
            return None

        stat = os.fstat(f.fileno())
        size = stat.st_size
        first, last = match.group(1), match.group(2)
        if first == "":
            # "bytes=-N" — the last N bytes.
            start, end = max(0, size - int(last or 0)), size - 1
        else:
            start = int(first)
            end = min(int(last), size - 1) if last else size - 1

        if start > end or start >= size:
            f.close()
            self.send_response(416)
            self.send_header("Content-Range", "bytes */%d" % size)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return None

        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Last-Modified", self.date_time_string(stat.st_mtime))
        self.end_headers()
        f.seek(start)
        self.range_remaining = end - start + 1
        return f

    def copyfile(self, source, outputfile):
        remaining = self.range_remaining
        if remaining is None:
            return super().copyfile(source, outputfile)
        self.range_remaining = None
        while remaining > 0:
            block = source.read(min(CHUNK, remaining))
            if not block:
                break
            outputfile.write(block)
            remaining -= len(block)


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
