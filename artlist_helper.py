#!/usr/bin/env python3
"""
Artlist DL Helper v2
- Auto-started at Windows login (setup_autostart.bat) and, as a fallback, via
  Tampermonkey through the artlist:// custom protocol
- Opens Windows Explorer / Finder at the exact download folder
- Stays running in the background for the whole login session — it used to
  shut itself down 5 s after the last Artlist tab closed, but that meant every
  fresh tab had to survive Chrome's "Allow artlist.io to open..." handshake
  again to restart it, which is the main reason auto-open was flaky. A stdlib
  HTTP server sitting idle costs nothing worth reclaiming.

Run silently (no window):  pythonw artlist_helper.py
Run with console:           python  artlist_helper.py
"""
import sys, os, subprocess, threading, time
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, unquote

PORT = 7842

# The userscript sends this header on /open. A web page cannot put a custom
# header on a request to another origin without a CORS preflight, and this
# server never grants one, so no website can open folders through the helper.
OPEN_HEADER = 'X-Artlist-DL'

_tab_count = 0
_tab_lock  = threading.Lock()

# ---- opening a folder --------------------------------------------------------

ASFW_ANY = -1


EXPLORER_CLASSES = ('CabinetWClass', 'ExploreWClass')
SW_RESTORE = 9
SPAWN_WAIT_S = 3.0

_user32 = None


def _win32():
    """user32 with argtypes declared, or None off Windows.

    The argtypes matter: left undeclared, ctypes marshals window handles as
    32-bit ints and every one of these calls silently gets a truncated HWND on
    64-bit Python.
    """
    global _user32
    if _user32 is not None:
        return _user32
    if sys.platform != 'win32':
        return None
    import ctypes
    from ctypes import wintypes
    u = ctypes.windll.user32
    u.IsWindowVisible.argtypes = [wintypes.HWND]
    u.IsWindowVisible.restype = wintypes.BOOL
    u.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    u.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    u.GetForegroundWindow.restype = wintypes.HWND
    u.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.c_void_p]
    u.GetWindowThreadProcessId.restype = wintypes.DWORD
    u.SetForegroundWindow.argtypes = [wintypes.HWND]
    u.BringWindowToTop.argtypes = [wintypes.HWND]
    u.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
    _user32 = u
    return u


def _windows_showing(leaf):
    """Handles of visible Explorer windows displaying the folder named `leaf`.

    Explorer titles a folder window "<leaf> - File Explorer" (just "<leaf>" on
    some versions), which is all there is to match on short of dragging COM in.
    Splitting on the last " - " keeps a folder actually named "Music - Old" from
    being mistaken for "Music".
    """
    import ctypes
    from ctypes import wintypes

    u = _win32()
    if u is None or not leaf:
        return []

    leaf = leaf.lower()
    found = []
    buf = ctypes.create_unicode_buffer(512)

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def collect(hwnd, _lparam):
        if not u.IsWindowVisible(hwnd):
            return True
        u.GetClassNameW(hwnd, buf, 512)
        if buf.value not in EXPLORER_CLASSES:
            return True
        u.GetWindowTextW(hwnd, buf, 512)
        title = buf.value.lower()
        if title == leaf or title.rsplit(' - ', 1)[0] == leaf:
            found.append(hwnd)
        return True

    u.EnumWindows(collect, 0)
    return found


def _force_foreground(hwnd):
    """Raise `hwnd` over everything else, foreground lock included.

    A background service calling SetForegroundWindow is ignored outright.
    Attaching to the input state of the thread that currently owns the
    foreground is what makes the call legal.
    """
    u = _win32()
    if u is None or not hwnd:
        return False
    import ctypes
    kernel32 = ctypes.windll.kernel32
    this_thread = kernel32.GetCurrentThreadId()
    fg_thread = u.GetWindowThreadProcessId(u.GetForegroundWindow(), None)
    attached = bool(fg_thread) and fg_thread != this_thread and bool(
        u.AttachThreadInput(this_thread, fg_thread, True))
    try:
        u.ShowWindow(hwnd, SW_RESTORE)
        u.BringWindowToTop(hwnd)
        return bool(u.SetForegroundWindow(hwnd))
    finally:
        if attached:
            u.AttachThreadInput(this_thread, fg_thread, False)


def is_local_abs_path(p):
    """True for an absolute path on a local drive (C:\\..., or /... off Windows).

    UNC and device paths (\\\\host\\share, //host/share, \\\\?\\...) are refused:
    merely checking whether one exists makes Windows connect to that host and
    offer it the user's login hash.
    """
    if not isinstance(p, str) or not p or '\0' in p:
        return False
    if p.startswith(('\\\\', '//', '/\\', '\\/')):
        return False
    if sys.platform == 'win32':
        return len(p) >= 3 and p[0].isalpha() and p[1] == ':' and p[2] in '\\/'
    return p.startswith('/')


def open_folder(folder):
    """Show `folder` in the OS file manager, in front of whatever is on screen.

    Windows deliberately avoids os.startfile here. os.startfile is
    ShellExecute, which opens the window *behind* the browser, and when a window
    for that folder is already open it does nothing visible at all -- the
    request returns 200, the userscript reports success, and the user sees
    nothing happen. So: reuse an existing window if there is exactly one (more
    than one and there is no way to tell which is the right folder, so don't
    guess), otherwise spawn explorer.exe and pull the new window forward.
    """
    folder = os.path.normpath(folder)

    if sys.platform != 'win32':
        subprocess.Popen(['open' if sys.platform == 'darwin' else 'xdg-open', folder])
        return

    import ctypes
    leaf = os.path.basename(folder.rstrip('\\/'))

    try:
        existing = _windows_showing(leaf)
        if len(existing) == 1 and _force_foreground(existing[0]):
            return
    except Exception:
        existing = []   # never let the reuse path stop the folder from opening

    try:
        ctypes.windll.user32.AllowSetForegroundWindow(ASFW_ANY)
    except Exception:
        pass

    # explorer.exe exits 1 even on success, so its return code says nothing
    # worth checking -- launch, then hunt down the window it made.
    before = set(existing)
    subprocess.Popen(['explorer.exe', folder], close_fds=True)

    deadline = time.monotonic() + SPAWN_WAIT_S
    while time.monotonic() < deadline:
        time.sleep(0.2)
        try:
            fresh = [h for h in _windows_showing(leaf) if h not in before]
        except Exception:
            return
        if fresh:
            _force_foreground(fresh[-1])
            return

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
            # Informational tab ref-count only; no longer drives a shutdown.
            with _tab_lock:
                _tab_count += 1
            self._respond(200, b'OK')

        elif path == '/disconnect':
            with _tab_lock:
                _tab_count = max(0, _tab_count - 1)
            self._respond(200, b'OK')

        elif path == '/open':
            if not self._from_userscript():
                self._respond(403, b'Forbidden'); return
            folder = unquote(qs.get('path', [''])[0])
            if not folder:
                self._respond(400, b'No path'); return
            # Local drives only, and the path is not echoed back.
            if not is_local_abs_path(folder) or not os.path.isdir(folder):
                self._respond(404, b'Folder not found')
                return
            try:
                open_folder(folder)
                self._respond(200, b'OK')
            except Exception as e:
                self._respond(500, str(e).encode())

        else:
            self._respond(404, b'Not found')

    def _from_userscript(self):
        """True only for the userscript's own request.

        The Host check stops DNS rebinding (a hostile site re-pointing its own
        name at 127.0.0.1); the custom header stops every other web page.
        """
        host = (self.headers.get('Host') or '').lower()
        if host not in ('127.0.0.1:%d' % PORT, 'localhost:%d' % PORT):
            return False
        return self.headers.get(OPEN_HEADER) == '1'

    def _respond(self, code, body):
        self.send_response(code)
        # No CORS headers: the script reaches the helper through Tampermonkey's
        # own request channel, not the page, so nothing legitimate needs them.
        # Without them a web page cannot read what the helper answers.
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass   # stay silent

# ---- entry point -------------------------------------------------------------

if __name__ == '__main__':
    try:
        # Threaded: a shell call that takes a second must not hold up the next
        # /ping, which the userscript times out after 1 s.
        _httpd = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
        _httpd.serve_forever()
    except OSError as e:
        # Port already in use → another instance is running, that's fine
        if getattr(e, 'winerror', None) == 10048 or 'Address already in use' in str(e):
            pass
        else:
            raise
    except KeyboardInterrupt:
        pass
