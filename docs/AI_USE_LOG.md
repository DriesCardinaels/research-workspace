# AI use log

## 2026-11-15 — Native macOS startup and recovery

Codex using GPT-6.1 Sol implemented an optional Swift AppKit/WKWebView host,
native-only Python startup/readiness coordination, a read-only HTTP health identity,
local bundle tooling, method contracts, documentation and regression tests.
The task was requested by the author to recover from an unavailable local backend
without leaving the app or changing the online editor and CLI.

Implementation choices included shared startup locking, bounded health/startup,
reuse of healthy servers, cleanup restricted to owned unready children and retention
of loaded browser state during outages. The host preserves the page's unload guard,
dialogs, file inputs and staged download replacement. It does not expose process
launch through HTTP or JavaScript. Browser preferences remain in separate WebKit
storage rather than transferring from Safari's Add-to-Dock wrapper.

Validation used synthetic temporary settings/projects and local child processes.
Seven focused socket-free HTTP/recovery tests and three explicit loopback/process
tests passed (concurrent startup/reuse, total health deadline and SIGTERM child
cleanup). The complete runner passed 197 Python tests, 44 JavaScript scripts,
39 documentation checks and architecture/vendor checks. The Swift app compiled
and an ad-hoc signed source-checkout bundle was built.

A separate AI agent ran a temporary harness against the actual native host code
on a disposable port. Eight stages passed: offline button, real startup/online
editor, server loss preserving the page, recovery preserving the page, explicit
reload, dirty-unload modal cancellation, actual WebKit blob export and atomic
replacement on repeat export to the same filename. The export test injected only
a temporary destination through the constructor's narrow picker capability; it
used the actual WebKit download and publication path. The default save dialog
was not validated through reliable native UI automation. Offline/online snapshots
were inspected. A fresh AI review checked compatibility and failure behavior.
This review and native harness are AI-only, not independent human validation.
The coordinating Codex session installed the verified bundle at
`~/Applications/Research Workbench.app`, preserving the previous wrapper as
`Research Workbench (Safari backup 2026-11-15).app`. The installed bundle matched
the signed build byte-for-byte and retained the original icon. No research files
or backend settings were migrated. Local smoke artifacts and the complete check
log are retained under ignored `work/verification/native-recovery-2026-11-15/`.

## 2026-11-15 — Explicit shared-server shutdown

At the author's request, Codex using GPT-6.1 Sol added the native Stop Server
button/menu, one shared-impact confirmation with an unsaved-work warning, bounded
authenticated shutdown/status transport and application-owned lifecycle coordination.
The counted HTTP host retains its listener while accepted saves/builds and application
cleanup finish, then releases the port. Idle request IO has a 10-second bound;
computation is allowed to finish. Native success requires definite connection
refusal, and loaded page state is retained through stop/restart. No PID killing,
HTTP startup route or JS launch bridge was added.

Six focused socket-free shutdown tests passed. The final runner passed 203 Python
tests, 44 JavaScript scripts and 39 documentation checks, plus architecture/vendor
checks. Five dedicated loopback/process tests passed, including blocked mutation
and cleanup gates retaining the port, and idle-client drain. The updated Swift
host compiled and a signed bundle with the existing icon was built.

A separate AI agent exercised the actual title-bar action through six successful
checks: disabled offline, enabled online, dirty warning/cancel retaining the running
server, confirmed repeated-click stop preserving page state, Launch restart keeping
the page and explicit Reload reconnecting. The online title-bar snapshot was
inspected. Artifacts are retained under `work/verification/native-shutdown-2026-11-15/`.
A fresh AI review checked authorization, draining, idle clients, failure reporting
and delayed native callback races; no remaining findings were reported after fixes.
These reviews and smoke checks are AI-only, not human validation.

The updated native app was installed with the previous bundle retained as
`Research Workbench (before Stop Server).app`. The installed bundle was checked
byte-for-byte against the signed build. A read-only live check found that the
already-running backend predates the shutdown routes. Its one-time activation
restart was deferred until the author confirmed that editing/build work was saved.
No live process was signaled during installation.

## 2026-11-16 — Approved activation restart

After the author confirmed that work was saved and requested the restart, Codex
rechecked the listener's exact launcher command and process start time. The old
server received SIGINT, exited normally and released port 8766. The installed
app's configured Python and normal recovery launcher started the current backend.
Both `/api/health` and `/api/server/status` returned HTTP 200 with Workbench identity
and ready state. Session credentials were not printed. No source or research data
was changed by the restart. This verifies live shutdown capability discovery;
the new shutdown endpoint was not invoked against the restarted production server.
