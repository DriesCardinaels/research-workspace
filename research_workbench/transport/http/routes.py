"""Exact-route contributions; authorization remains in the request handler."""
import json
from dataclasses import dataclass
from types import MappingProxyType

from research_workbench.domain.schemas import CREATE_SCHEMA
from research_workbench.extensions.filetypes import handlers
from research_workbench.infrastructure.filesystem.storage import json_bytes
from research_workbench.infrastructure.metadata.openalex import entries


@dataclass(frozen=True)
class RouteRequest:
    """Bounded request data for a registered URL family; transport objects never escape."""
    method: str
    path: str
    body: bytes
    query: object


class RouteRegistry:
    """Own a private, deterministic set of method/path handlers."""

    def __init__(self):
        """@param None: No inputs. @pre None. @post Empty registry.
        @return None. @throws None.
        """
        self.__routes = {}
        self.__prefixes = {}

    def register(self, method, path, operation):
        """Register a route without modifying the transport dispatcher.

        @param method,path,operation: HTTP verb, exact absolute path and (app,raw) callable.
        @pre Operation returns a status/body tuple, with optional MIME type.
        @post One unique contribution is installed. @return RouteRegistry: This registry.
        @throws ValueError: Invalid or duplicate registration.
        """
        if (method not in ('GET', 'POST', 'PUT', 'PATCH', 'DELETE') or not isinstance(path, str)
                or not path.startswith('/api/') or '?' in path or '#' in path or not callable(operation)):
            raise ValueError('A route requires an HTTP method, exact API path and callable.')
        key = (method, path)
        if key in self.__routes:
            raise ValueError('Route already registered: ' + method + ' ' + path)
        self.__routes[key] = operation
        return self

    def register_prefix(self, method, prefix, operation):
        """Register a URL family without adding switches to the HTTP host.

        @param method,prefix,operation: HTTP verb, exact path root and (app,RouteRequest) callable.
        @pre Operation owns route-family parsing and short application locks.
        @post Duplicate prefixes are rejected; longest matching prefix wins after exact routes.
        @return RouteRegistry: This registry. @throws ValueError: Invalid or duplicate registration.
        """
        if (method not in ('GET', 'POST', 'PUT', 'PATCH', 'DELETE') or not isinstance(prefix, str)
                or not prefix.startswith('/api/') or prefix.endswith('/')
                or '?' in prefix or '#' in prefix or not callable(operation)):
            raise ValueError('A URL family requires an HTTP method, API prefix and callable.')
        key = (method, prefix)
        if key in self.__prefixes:
            raise ValueError('Route family already registered: ' + method + ' ' + prefix)
        self.__prefixes[key] = operation
        return self

    def dispatch(self, method, path, app, raw=b'', *, query=None):
        """Dispatch authenticated exact routes first, then the longest URL family.

        @param method,path,app,raw,query: Parsed bounded request data and application dependencies.
        @pre Handler checked host/origin/token before invocation; operations retain lock ownership.
        @post At most one operation runs; query values are immutable detached tuples.
        @return tuple|None: Operation response, or None for an unknown route.
        @throws Exception: Operations propagate errors to the shared HTTP boundary.
        """
        operation = self.__routes.get((method, path))
        if operation is not None:
            return operation(app, raw)
        matches = [(prefix, operation) for (verb, prefix), operation in self.__prefixes.items()
                   if verb == method and (path == prefix or path.startswith(prefix + '/'))]
        if not matches:
            return None
        prefix, operation = max(matches, key=lambda item: len(item[0]))
        request = RouteRequest(method, path, raw, MappingProxyType({key: tuple(values) for key, values in (query or {}).items()}))
        return operation(app, request)


def configuration(app, raw):
    """Read consistent session configuration.

    @param app,raw: Application and unused request bytes. @pre Authorized read.
    @post No changes. @return tuple: Status and configuration snapshot. @throws OSError: Root inspection failed.
    """
    with app.lock:
        return 200, {'token': app.token, 'last_folder': app.last_folder, 'projects': app.project_list()}


def health(app, raw):
    """Identify this ready local application without exposing session data.

    @param app,raw: Unused initialized application and request bytes. @pre Authorized local GET.
    @post No locks, files, settings or projects are read or changed.
    @return tuple: Stable application identity, health protocol and ready status. @throws None.
    """
    return 200, {'application': 'research-workbench', 'protocol': 1, 'status': 'ready'}


def server_status(app, raw):
    """Read bounded native lifecycle/token metadata behind the common local-origin guard.

    @param app,raw: Initialized application and unused bytes. @pre Authorized local read.
    @post No project/settings read, process action or application lock.
    @return tuple: Current server identity/token/state. @throws ValueError: Shutdown unsupported.
    """
    return 200, app.server_status()


def shutdown_server(app, raw):
    """Accept an authenticated empty shutdown request without blocking its response thread.

    @param app,raw: Application and JSON body. @pre Shared host/origin/session-token checks passed.
    @post One graceful separate-thread shutdown is requested; existing data is retained.
    @return tuple: 202 and stopping acknowledgement. @throws ValueError: Invalid body/unsupported host.
    @throws RuntimeError,OSError: Shutdown worker could not start.
    """
    if json.loads(raw) != {}:
        raise ValueError('Server shutdown accepts an empty JSON object only.')
    return 202, app.request_shutdown()


def projects(app, raw):
    """Read registered project roots without opening them.

    @param app,raw: Application and unused request bytes. @pre Authorized read.
    @post No folders created. @return tuple: Project list. @throws OSError: Root inspection failed.
    """
    with app.lock:
        return 200, app.project_list()


def openalex_settings(app, raw):
    """Read provider configuration without exposing credentials.

    @param app,raw: Application and unused bytes. @pre Authorized read.
    @post No settings changed. @return tuple: Redacted status. @throws OSError: Settings read failed.
    """
    with app.lock:
        return 200, app.openalex.status()


def save_openalex_settings(app, raw):
    """Validate and save explicitly supplied provider settings.

    @param app,raw: Application and JSON bytes. @pre Authenticated mutation.
    @post Valid settings are published atomically. @return tuple: Redacted status.
    @throws ValueError,OSError: Invalid JSON/settings or publication failure.
    """
    with app.lock:
        return 200, app.openalex.save(json.loads(raw))


def filetype_catalog(app, raw):
    """Read the authoritative inert file-type catalog.

    @param app,raw: Unused application and bytes. @pre Authorized read.
    @post Registry unchanged. @return tuple: Detached catalog. @throws None.
    """
    return 200, handlers.catalog()


def filetype_script(app, raw):
    """Expose catalog metadata to the ordered classic-script bootstrap.

    @param app,raw: Unused application and bytes. @pre Authorized read.
    @post No executable provider logic is generated from input.
    @return tuple: Status, assignment script and JavaScript MIME. @throws None.
    """
    return 200, 'window.WorkbenchFileTypeCatalog = ' + json_bytes(handlers.catalog()).decode('utf-8') + ';', 'text/javascript; charset=utf-8'


def markup_schema(app, raw):
    """Read the transport-independent markup contract.

    @param app,raw: Unused application and bytes. @pre Authorized read.
    @post No changes. @return tuple: Status and schema. @throws None.
    """
    return 200, CREATE_SCHEMA


def bibliography_entries(app, raw):
    """Parse bibliography text without an external request.

    @param app,raw: Unused application and JSON source input. @pre Authenticated mutation.
    @post Input source unchanged. @return tuple: Parsed entries.
    @throws ValueError: Invalid input JSON or fields.
    """
    return 200, {'entries': entries(json.loads(raw))}


def metadata_operation(name):
    """Bind one trusted provider operation during composition.

    @param name: search, check or diagnose. @pre Application supports that provider operation.
    @post No network request runs during registration.
    @return callable: Authenticated request operation. @throws ValueError: Unknown operation.
    """
    if name not in ('search', 'check', 'diagnose'):
        raise ValueError('Unsupported metadata operation.')

    def execute(app, raw):
        """Run a provider lookup outside the application state lock.

        @param app,raw: Provider owner and JSON request. @pre Authenticated mutation.
        @post Source unchanged; only the requested lookup occurs.
        @return tuple: Provider result. @throws ValueError,OSError: Invalid input/provider failure.
        """
        return 200, getattr(app.openalex, name)(json.loads(raw))
    return execute


def builtin_routes():
    """Compose built-in route contributions without starting a server.

    @param None: No inputs. @pre Trusted implementations are imported.
    @post New independent registry contains complete route/operation pairs.
    @return RouteRegistry: Built-in exact routes. @throws ValueError: Conflicting registrations.
    """
    registry = RouteRegistry()
    for method, path, operation in (
        ('GET', '/api/health', health),
        ('GET', '/api/server/status', server_status),
        ('POST', '/api/server/shutdown', shutdown_server),
        ('GET', '/api/config', configuration),
        ('GET', '/api/projects', projects),
        ('GET', '/api/settings/openalex', openalex_settings),
        ('GET', '/api/file-types', filetype_catalog),
        ('GET', '/api/file-types.js', filetype_script),
        ('GET', '/api/note-tools', note_tools),
        ('GET', '/api/markup/schema', markup_schema),
        ('PUT', '/api/settings/openalex', save_openalex_settings),
        ('POST', '/api/bibliography/entries', bibliography_entries),
    ):
        registry.register(method, path, operation)
    for name in ('search', 'check', 'diagnose'):
        registry.register('POST', '/api/openalex/' + name, metadata_operation(name))
    registry.register('POST', '/api/choose-folder', choose_folder)
    for method in ('GET', 'POST', 'PUT', 'PATCH', 'DELETE'):
        registry.register_prefix(method, '/api/projects', project_routes)
    return registry


def note_tools(app, raw):
    """Return machine-readable note toolbar actions. Pre: authorized read.
    Post: no mutations. Returns schema/selection/options metadata. Raises no exceptions.
    Related: NoteFiles and /llms.txt.
    """
    from research_workbench.domain.note_tools import catalog
    return 200, catalog()


def project_routes(app, request):
    """Resolve the project URL family without giving it a native request handler.

    @param app,request: Application owner and immutable RouteRequest.
    @pre Handler authorization completed. @post Only requested family operation executes.
    @return tuple: Existing route response. @throws Exception: Public operation failure.
    """
    from .projects import ProjectRoutes
    return ProjectRoutes(app, request.method).dispatch(request.path, request.body, request.query)


def choose_folder(app, raw):
    """Invoke the supported native folder picker outside project mutation locks.

    @param app,raw: Unused application and request data. @pre Authenticated local mutation.
    @post Native user choice returned; no projects registered automatically.
    @return tuple: Selected path or cancellation. @throws ValueError,OSError: Unsupported platform/picker failure.
    """
    from research_workbench.infrastructure.processes.desktop import choose_folder as choose
    return 200, choose()
