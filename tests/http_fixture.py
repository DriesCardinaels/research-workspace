"""Exercise real HTTP handlers without binding a port (also works in sandboxes)."""
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace

from research_workbench.launcher import App, Handler


def setup(test):
    """Create an isolated project. Pre: unittest instance; post: App and temp folder.
    Filesystem errors propagate; teardown releases the temporary data.
    """
    test.temp = tempfile.TemporaryDirectory()
    test.folder = Path(test.temp.name) / 'project'
    test.app = App(Path(test.temp.name) / 'settings.json')
    test.server = SimpleNamespace(app=test.app, server_port=8766)
    test.key, test.project = test.app.choose(str(test.folder))
    test.base = '/api/projects/' + test.key + '/documents'


def teardown(test):
    """Remove isolated files. Pre: setup succeeded; post: no fixture data remains.
    TemporaryDirectory cleanup errors propagate.
    """
    test.temp.cleanup()


def request(test, method, path, data=None, headers=None, token=True):
    """Run a full handler over byte streams. Pre: setup; post: status/body pair.
    Handler auth, serialization, routing and exceptions remain real; no socket is used.
    Unexpected production exceptions propagate so tests cannot hide handler failures.
    """
    raw = json.dumps(data).encode() if isinstance(data, (dict, list)) else data or b''
    if isinstance(raw, str):
        raw = raw.encode()
    handler = Handler.__new__(Handler)
    handler.server = test.server
    handler.command, handler.path = method, path
    handler.request_version, handler.requestline = 'HTTP/1.1', method + ' ' + path + ' HTTP/1.1'
    handler.headers = {'Host': '127.0.0.1:8766', 'Content-Length': str(len(raw))}
    if token:
        handler.headers['X-PDF-Token'] = test.app.token
    handler.headers.update(headers or {})
    handler.rfile, handler.wfile = io.BytesIO(raw), io.BytesIO()
    getattr(handler, 'do_' + method)()
    head, _, body = handler.wfile.getvalue().partition(b'\r\n\r\n')
    return int(head.split(b' ', 2)[1]), body
