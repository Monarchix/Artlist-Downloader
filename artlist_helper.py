#!/usr/bin/env python3
"""
Artlist DL Helper v2
- Auto-started by Tampermonkey via artlist:// custom protocol (run setup_autostart.bat once)
- Opens Windows Explorer / Finder at the exact download folder
- Ref-counts open Artlist tabs; shuts itself down 5 s after the last tab closes

Run silently (no window):  pythonw artlist_helper.py
Run with console:           python  artlist_helper.py
"""
import sys, os, subprocess, threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, unquote

PORT = 7842

_tab_count  = 0
_tab_lock   = threading.Lock()
_shutdown_t = None   # pending shutdown timer
_httpd      = None

# ---- lifecycle ---------------------------------------------------------------

def _do_shutdown():
    if _httpd:
        threading.Thread(target=_httpd.shutdown, daemon=True).start()

def _schedule_shutdown():
    global _shutdown_t
    _cancel_shutdown()
    _shutdown_t = threading.Timer(5.0, _do_shutdown)
    _shutdown_t.daemon = True
    _shutdown_t.start()

def _cancel_shutdown():
    global _shutdown_t
    if _shutdown_t:
        _shutdown_t.cancel()
        _shutdown_t = None

# ---- request handler ---------------------------------------------------------

class Handler(BaseHTTPRequestHandler):

    def do_OPTIONS(self):
        self._respond(204, b'')

    def do_GET(self):
        global _tab_count
        path = urlparse(self.path).path
        qs   = parse_qs(urlparse(self.path).query)

        if path == '/ping':
            self._respond(200, b'artlist-dl-helper')

        elif path in ('/start', '/connect'):
            with _tab_lock:
                _tab_count += 1
                _cancel_shutdown()
            self._respond(200, b'OK')

        elif path == '/disconnect':
            with _tab_lock:
                _tab_count = max(0, _tab_count - 1)
                if _tab_count == 0:
                    _schedule_shutdown()
            self._respond(200, b'OK')

        elif path == '/open':
            folder = unquote(qs.get('path', [''])[0])
            if not folder:
                self._respond(400, b'No path'); return
            try:
                if sys.platform == 'win32':
                    os.startfile(folder)            # opens Windows Explorer
                elif sys.platform == 'darwin':
                    subprocess.Popen(['open', folder])
                else:
                    subprocess.Popen(['xdg-open', folder])
                self._respond(200, b'OK')
            except Exception as e:
                self._respond(500, str(e).encode())

        else:
            self._respond(404, b'Not found')

    def _respond(self, code, body):
        self.send_response(code)
        self.send_header('Access-Control-Allow-Origin',  '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.send_header('Access-Control-Allow-Private-Network', 'true')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass   # stay silent

# ---- entry point -------------------------------------------------------------

if __name__ == '__main__':
    try:
        _httpd = HTTPServer(('127.0.0.1', PORT), Handler)
        _httpd.serve_forever()
    except OSError as e:
        # Port already in use → another instance is running, that's fine
        if getattr(e, 'winerror', None) == 10048 or 'Address already in use' in str(e):
            pass
        else:
            raise
    except KeyboardInterrupt:
        pass
