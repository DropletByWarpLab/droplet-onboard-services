"""Standard-library HTTP app: no dependencies or install step."""
import os
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlsplit

BASE = os.environ["DROPLET_EXT_BASE_PATH"]

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = urlsplit(self.path).path
        if path == BASE + "healthz":
            status, content, mime = 200, b"ok", "text/plain"
        elif path == BASE:
            status, content, mime = 200, b"<!doctype html><title>My Droplet app</title><h1>My Droplet app</h1>", "text/html; charset=utf-8"
        else:
            status, content, mime = 404, b"Not found", "text/plain"
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.end_headers()
        self.wfile.write(content)

HTTPServer(("127.0.0.1", int(os.environ["PORT"])), Handler).serve_forever()
