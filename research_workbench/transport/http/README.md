# HTTP transport and route registration

`server.Handler` is the existing `BaseHTTPRequestHandler` interface, re-exported by
`research_workbench.launcher`. It validates local host/origin and mutation tokens before dispatch.
Expected errors retain their established status/payload; unexpected failures return
a generic 500 response while stack locations are reported locally without values.

`routes.RouteRegistry` supports exact method/path and URL-family contributions. `builtin_routes()`
composes health identity, config, project listing, file-type catalog, markup schema, bibliography
parsing, OpenAlex, native folder selection and the project URL family.
`projects.ProjectRoutes` owns project/document/draft path interpretation. The socket
Handler knows no build, review, repository or project operation implementations.
The fixed `/llms.txt` and `/API.md` reads expose client documentation under the
same host/origin authorization. Arbitrary repository paths are not served.
`GET /api/health` returns only application/protocol/readiness and takes no application
lock; startup stays in the native-only host, never an HTTP operation.
`GET /api/server/status` reads bounded identity/token/lifecycle state under the
same local protections as config. `POST /api/server/shutdown` accepts exactly `{}`
and requires the current mutation token. It requests the application-owned
`ServerLifecycle` capability and returns 202, without blocking the request thread.

`lifecycle.GracefulHTTPServer` owns counted non-daemon request handlers.
`close_after(cleanup)` drains accepted work while retaining the listener, calls
application cleanup, then closes the listener. It counts handlers through socket
cleanup and bounds idle reads/writes to 10 seconds without interrupting application
computation. This prevents a replacement server from overlapping old saves/builds.
Alternate hosts must preserve the same ownership contract. Native stop verification
requires connection refusal; a health timeout does not prove completion.
Long build/version transactions belong to `application.draft_operations`.

## Add an exact route

Implement an operation `(app, raw_bytes) -> (status, body[, mime])` in its feature
module and register it in composition:

```python
routes.register('POST', '/api/my-feature', my_operation)
```

Do not change the dispatcher or add a second authorization path. Decode/validate
JSON before side effects. Acquire the application lock only for short state
transactions and release it before external work or response writes. Do not send
credentials in returned metadata. Return snapshots rather than mutable storage.
Add the request/response and permission behavior to [API.md](../../../API.md).

Use a fresh registry on a Handler subclass or injected test handler to avoid
changing global registrations after startup. Duplicate method/path pairs are
rejected; unmatched exact routes use the longest registered prefix on a segment
boundary. Unknown paths remain 404s.
`tests/test_modular_contracts.py` proves an extension remains behind authorization
and the shared error boundary. Run real loopback tests separately with
`python3 tools/check.py --integration`.


## Add a URL family

Use `routes.register_prefix(method, '/api/my-feature', operation)`. The operation
receives `(app, RouteRequest)`; its request contains method, path, bounded body and
an immutable query snapshot. Exact routes win first, then the longest matching
prefix; `/api/my-feature` never matches `/api/my-features`. Validate the remaining
segments and call public application operations. No native request/response objects
or alternate authorization paths enter the family implementation.

Existing project response schemas, mutation status codes and short-lock behavior
are regression-tested through production Handler dispatch. New prefix contributions
are tested for missing tokens and foreign origins in `test_modular_contracts.py`.
