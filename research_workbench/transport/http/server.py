"""Local HTTP request/authentication boundary; feature policy stays with its owner."""
from http.server import BaseHTTPRequestHandler
import json
import mimetypes
import os
import subprocess
import sys
import traceback
from urllib.parse import parse_qs, unquote, urlparse

from research_workbench.domain.errors import ConflictError, SourceError, MarkupConflict, RepositoryConflict
from research_workbench.infrastructure.filesystem.storage import json_bytes
from research_workbench.resources import ROOT as HERE
from research_workbench.transport.http.routes import builtin_routes

MAX_BODY = 280 * 1024 * 1024
mimetypes.add_type('text/javascript', '.mjs')
mimetypes.add_type('application/wasm', '.wasm')

class Handler(BaseHTTPRequestHandler):
    server_version = 'ResearchWorkbench/1.0'
    routes = builtin_routes()
    def log_message(self, *args):
        """Emit HTTP access logs only when local debug logging is enabled.

        @param args: Native HTTP access-log formatting values.
        @pre Inputs satisfy the operation description; dependencies are initialized.
        @post Only enabled diagnostic output is written.
        @return None
        @throws OSError: Diagnostic stream failure.
        """
        if os.environ.get('RESEARCH_WORKBENCH_DEBUG'):
            super().log_message(*args)

    def send(self, code, body, ctype='application/json; charset=utf-8'):
        """Serialize and send one complete local HTTP response.

        @param code: HTTP status code.
        @param body: JSON-compatible response value, string or exact bytes.
        @param ctype: Explicit response content type.
        @pre Inputs satisfy the operation description; dependencies are initialized.
        @post Headers and body are written with defensive response headers.
        @return None
        @throws OSError: Response transport failure; ValueError,TypeError: Invalid payload.
        """
        if isinstance(body, (dict, list)):
            body = json_bytes(body)
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'DENY')
        self.end_headers()
        self.wfile.write(body)

    def check_request(self, mutation=False):
        """Authorize the local host/origin and mutation token.

        @param mutation: Whether a current session write token is required.
        @pre Inputs satisfy the operation description; dependencies are initialized.
        @post Rejected requests cannot reach registered operations.
        @return None
        @throws PermissionError: Foreign host/origin or missing/stale token.
        """
        port = self.server.server_port
        allowed = {f'127.0.0.1:{port}', f'localhost:{port}'}
        if self.headers.get('Host') not in allowed:
            raise PermissionError('Invalid local host.')
        origin = self.headers.get('Origin')
        if origin and origin not in {'http://' + a for a in allowed}:
            raise PermissionError('Foreign origins are not allowed.')
        if mutation and self.headers.get('X-PDF-Token') != self.server.app.token:
            raise PermissionError('Reload the editor to refresh its session.')

    def body(self):
        """Read the complete bounded request body.

        @param None: No explicit inputs.
        @pre Inputs satisfy the operation description; dependencies are initialized.
        @post Body bytes are consumed once; incomplete/oversized requests are rejected.
        @return bytes: Exact request body
        @throws ValueError: Invalid size or incomplete upload; OSError: Read failure.
        """
        n = int(self.headers.get('Content-Length', '0'))
        if n < 0 or n > MAX_BODY:
            raise ValueError('Request too large (maximum PDF size: 200 MB).')
        data = self.rfile.read(n)
        if len(data) != n:
            raise ValueError('Incomplete upload.')
        return data

    def handle_error(self, fn):
        """Translate one request failure at the top-level HTTP recovery interface.

        @param fn: Request operation whose errors are translated once.
        @pre Inputs satisfy the operation description; dependencies are initialized.
        @post Expected errors keep their public status; unexpected details stay out of replies.
        @return None
        @throws OSError: Response transport itself failed.
        """
        try:
            fn()
        except RepositoryConflict as e:
            self.send(409, {'error': str(e)})
        except ConflictError as e:
            self.send(409, {'error': str(e), 'matches': e.matches})
        except MarkupConflict as e:
            self.send(409, {'error': str(e)})
        except SourceError as e:
            self.send(422, {'error': str(e)})
        except subprocess.TimeoutExpired:
            self.send(504, {'error': 'A git or LaTeX command took too long and was stopped.'})
        except PermissionError as e:
            self.send(403, {'error': str(e)})
        except FileNotFoundError as e:
            self.send(404, {'error': str(e)})
        except (ValueError, TypeError, KeyError) as e:
            self.send(400, {'error': str(e)})
        except OSError as e:
            self.send(500, {'error': 'Could not access project files: ' + str(e)})
        except Exception as error:
            # Report stack locations locally without rendering provider/credential values.
            traceback.print_tb(error.__traceback__, file=sys.stderr)
            self.send(500, {'error': 'An unexpected error occurred. Reload before retrying.'})


    def do_GET(self):
        """Dispatch the HTTP GET request through the shared error interface.

        @param None: No explicit inputs.
        @pre Inputs satisfy the operation description; dependencies are initialized.
        @post Authorization, dispatch and error translation run exactly once.
        @return None
        @throws OSError: Response transport failed.
        """
        self.handle_error(self.get)

    def get(self):
        """Dispatch an authorized read without holding locks during response writes.

        @param None: No explicit inputs.
        @pre Inputs satisfy the operation description; dependencies are initialized.
        @post Matching read result is sent; application reads use the relevant locks.
        @return None
        @throws PermissionError,ValueError,FileNotFoundError,OSError: Request/read failure.
        """
        self.check_request()
        path = unquote(urlparse(self.path).path)
        app = self.server.app
        registered = self.routes.dispatch('GET', path, app, query=parse_qs(urlparse(self.path).query))
        if registered is not None:
            return self.send(*registered)
        if path in ('/llms.txt', '/API.md'):
            # Fixed allowlist: clients can inspect contracts without exposing project files.
            return self.send(200, (HERE / path[1:]).read_bytes(), 'text/plain; charset=utf-8')
        if path == '/' or path.startswith('/static/'):
            rel = 'index.html' if path == '/' else path[8:]
            root = HERE / 'static'
            file = (root / rel).resolve()
            if not file.is_relative_to(root) or not file.is_file():
                raise FileNotFoundError('File not found.')
            return self.send(200, file.read_bytes(), mimetypes.guess_type(file)[0] or 'application/octet-stream')
        raise FileNotFoundError('Route not found.')
    def do_POST(self):
        """Dispatch the HTTP POST request through the shared error interface.

        @param None: No explicit inputs.
        @pre Inputs satisfy the operation description; dependencies are initialized.
        @post Authorization, dispatch and error translation run exactly once.
        @return None
        @throws OSError: Response transport failed.
        """
        self.handle_error(self.mutate)

    def do_PATCH(self):
        """Dispatch explorer mutations through the normal HTTP boundary.

        @param self: Request handler. @pre HTTP request parsed.
        @post Authorization, locking and error serialization run through mutate().
        @return None. @throws OSError: Unrecoverable response transport failure.
        """
        self.do_POST()

    def do_PUT(self):
        """Dispatch the HTTP PUT request through the shared error interface.

        @param None: No explicit inputs.
        @pre Inputs satisfy the operation description; dependencies are initialized.
        @post Authorization, dispatch and error translation run exactly once.
        @return None
        @throws OSError: Response transport failed.
        """
        self.handle_error(self.mutate)

    def do_DELETE(self):
        """Dispatch the HTTP DELETE request through the shared error interface.

        @param None: No explicit inputs.
        @pre Inputs satisfy the operation description; dependencies are initialized.
        @post Authorization, dispatch and error translation run exactly once.
        @return None
        @throws OSError: Response transport failed.
        """
        self.handle_error(self.mutate)





    def mutate(self):
        """Authorize a mutation before handing it to registered exact/prefix operations.

        @param None: Uses parsed native HTTP request.
        @pre Request headers available. @post One authorized operation runs, then a response is sent.
        @return None. @throws Exception: Translated by handle_error; transport errors propagate.
        """
        self.check_request(True)
        path = urlparse(self.path).path
        result = self.routes.dispatch(self.command, path, self.server.app, self.body(),
                                      query=parse_qs(urlparse(self.path).query))
        if result is None:
            raise FileNotFoundError('Route not found.')
        return self.send(*result)
