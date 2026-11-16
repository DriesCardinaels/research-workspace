# Native server recovery

This package owns startup for the optional [macOS host](../../native/macos/README.md).
It is not imported by a browser script or HTTP route. The ordinary
`research_workbench.py` CLI and server composition remain unchanged.

`recovery.probe(port, timeout=0.5)` returns immutable `Health`: `ready`, `offline`
or `occupied`. It contacts only numeric loopback, refuses redirects, caps headers
and body and uses a total socket deadline. Only the exact `GET /api/health`
identity counts as ready. An older server without this contract must be stopped
by its owner before recovery. Health returns no token, settings or project data.

`recovery.ensure_server(root, port=8766, settings=None, timeout=15)` accepts a
trusted checkout, optional settings path and readiness bound. It acquires
`.plugin-start.lock` under the same deadline, rechecks health, then starts the
normal Python entry point with literal arguments and no browser. Concurrent
native/plugin attempts share that lock. Direct CLI races remain safe because
the OS allows one listener and the losing child exits.

It returns `{url, reused}` after verified readiness. Output goes to ignored
`.native-server.log`. Failure stops/reaps only this attempt's unready child,
then releases the lock without deleting its file. It never signals a PID loaded
from a file or a process found by port. Ready/reused servers survive helper and
app exit because browser/plugin clients may share them. An app closed during
startup lets the bounded helper finish; SIGTERM cancellation unwinds cleanup.

The native-only CLI emits one JSON result and a nonzero failure exit:

```sh
python3 -m research_workbench.native_host.recovery --root /absolute/checkout --port 8766
```

There is no HTTP launch route or JS bridge. Dependencies are Python's standard
library and Unix `flock`; the browser/CLI do not depend on macOS. To extend this
module, preserve process ownership/deadlines and inject narrow IO seams. Cover
failure/cleanup before changing host callbacks. Pure/HTTP regressions are in
`tests/test_native_recovery.py`; explicit loopback/process tests are in
`tests/native_recovery_integration.py`. See [test commands](../../tests/README.md).
