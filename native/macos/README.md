# macOS source-checkout host

The AppKit/WKWebView host requires macOS 12+. It shows native **Launch Server**
controls when offline and opens the existing editor after verified readiness.
A healthy server opens directly. The title bar also has **Stop Server**, with the
same action in the app menu. It confirms that other Workbench windows/browser tabs
will disconnect and adds a pending-work warning when needed. The loaded editor is
kept. After stopping, Launch Server restarts it; Reload Editor remains explicit.
The web UI, CLI and project/settings formats are unchanged.

## Build and install

Swift command-line tools (`swiftc`, `codesign`) and persistent Python 3.10+ are
required. No package download or dependency installation is needed.

```sh
uv run --no-project python tools/build_macos_app.py
```

Output defaults to `native/macos/build/Research Workbench.app`. The builder refuses
to overwrite an existing output/app. Options: `--output` chooses an absent path,
`--python` selects a persistent interpreter, `--port`/`--settings` configure the
server and `--icon /absolute/icon.icns` copies an existing icon. It stages and
ad-hoc signs the complete bundle before publishing it. Absolute checkout/Python
paths and the build environment's PATH are embedded so Git/TeX tools work from
Finder. Rebuild if those dependencies move. This is a local source-checkout
launcher, not a self-contained or notarized distribution.

Move the finished app to Applications to install it, retaining the old wrapper
as a backup. The builder itself never changes an installed app. WKWebView has its
own persistent browser storage: Safari Add-to-Dock author, theme, open tabs and
preferences do not transfer automatically. Select them again in the new host.
Files, projects and backend settings remain in their existing locations.

## Ownership and extension points

| File | Interface and responsibility |
| --- | --- |
| `HostConfiguration.swift` | Trusted bundle settings and exact local-origin validation |
| `ServerConnection.swift` | Bounded async health and one native startup/shutdown action at a time |
| `WorkbenchWindow.swift` | Offline UI, recovery banner, guarded navigation/close, dialogs, uploads and staged downloads |
| `main.swift` | App lifecycle and standard text editing/window menus |
| `../../tools/build_macos_app.py` | Compile, configure, sign and publish a local bundle |

The host launches only the fixed recovery module from trusted build-time paths.
No HTTP launch route or script-message handler exists. Native health checks refuse
redirects, cap bodies at 4096 bytes and use a 2-second total resource timeout.
The helper has a 15-second readiness deadline plus bounded child cleanup; the
native watchdog allows 25 seconds, then signals cancellation and waits for cleanup.
See [Python recovery](../../research_workbench/native_host/README.md) for ownership.

Stop uses bounded identity/status/token reads and authenticated
`POST /api/server/shutdown`. It never discovers or signals a PID. The backend stops
accepting work, drains requests, releases application resources and then closes
the listener. Native verification allows 15 seconds after acknowledgement and
requires definite loopback connection refusal; a health timeout or a port owned
by draining work remains occupied. Long builds may report that shutdown is still
finishing, with safe retry. Cancellation sends no stop request. Lifecycle actions
and delayed reload callbacks are coordinated so stale results cannot replace the
editor during shutdown. Old running backends need a restart after updating before
they support the new stop routes.

The monitor never replaces a loaded editor during an outage. It shows a compact
Launch Server banner. After recovery, the page stays intact until **Reload Editor**
is chosen. Copy unsaved text before reloading after a restart: the new server has
a new write token, so the old page may be unable to save. Initial offline startup
loads automatically after recovery. Native close, Cmd-Q and reload consult the
page's existing `beforeunload` event and require confirmation when dirty, saving
or unreadable. New-window/external links open in the default browser and preserve
the active editor.

WebKit delegates retain JS alert/confirm/prompt, file inputs and downloads. Exports
use an absent adjacent staging path and atomically replace the selected file after
completion; failed repeated exports retain the previous file. Menus preserve
copy/paste/select-all/undo/redo. To extend native behavior, keep UI on the main
thread, use `ServerConnection` for transport/startup, document method contracts
and add real WebKit checks for lifecycle/download/navigation changes.
`WorkbenchWindow(config:downloadDestination:)` accepts an optional narrow
destination-picker capability for alternate native hosts and controlled smoke
tests; its default remains the normal NSSavePanel. This does not expose download
or process control to a webpage.

## Validation

The builder compiles and signs the host. Python unit tests cover health auth,
occupied ports, lock contention, startup failure and cleanup. Explicit integration
tests cover real concurrent startup/reuse, SIGTERM cleanup and a dripping foreign
service. Commands are in [tests](../../tests/README.md).

A temporary native harness used the real window/connection code with disposable
settings and a nondefault port. It verified offline controls, real startup, the
online editor, server loss, preserved in-page state during recovery, explicit
reload and dirty-unload modal cancellation. Actual WebKit blob export and repeated
export to the same filename passed with an injected temporary destination and the
real staging/publication path. Offline/online snapshots were inspected. This was
AI-only verification. A follow-up native smoke used the actual title-bar action:
Stop was disabled offline and enabled online; dirty-work warning/cancel kept the
server running; confirmed repeated clicks stopped it while keeping page state;
Launch restarted it without replacing the page; explicit Reload reconnected.
The title-bar layout was inspected. The default save dialog, native accessibility, remaining
dialogs, file inputs and keyboard shortcuts still need a human pass.
