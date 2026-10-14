#!/usr/bin/env python3
"""Tiny static server for development: serves this folder with caching disabled."""
import http.server, sys, os
os.chdir(os.path.dirname(os.path.abspath(__file__)))
class H(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.mjs': 'text/javascript', '.js': 'text/javascript', '.pdf': 'application/pdf', '.bcmap': 'application/octet-stream'}
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store'); super().end_headers()
    def log_message(self, *a): pass
port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
print(f'Master PDF Editor replica: http://127.0.0.1:{port}/', flush=True)
http.server.ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()
