# Current implementation ownership

Use this map for implemented interfaces. The [migration plan](MODULARITY_MIGRATION.md)
contains the original target; [status](MIGRATION_STATUS.md) distinguishes remaining work.

| Change | Owner | Public contribution seam |
| --- | --- | --- |
| Application startup | `research_workbench/bootstrap.py` | `run` with application/server factories; `main` for built-ins |
| Native macOS recovery | [native/macos](../native/macos/README.md), [native_host](../research_workbench/native_host/README.md) | Native-only bounded startup/reuse and health; loaded editor retained during outages |
| Graceful shared-server stop | `application/lifecycle.py`, `transport/http/lifecycle.py` | Authenticated separate-thread stop; drain/application cleanup before port release; native action keeps loaded editor |
| Projects/settings | `application/projects.py`, `application/sessions.py` | Semantic operations, detached snapshots, explicit transactions and factories |
| Build execution | [application/builds](../research_workbench/application/builds/README.md) | `BuildVariantRegistry.register`, `BuildService.run` |
| Version publication | `application/draft_operations.py` | Validated application workflow outside the HTTP host |
| Source/PDF mapping | `application/source_mapping.py` | Injected authorized source resolver and bounded query operation |
| Native HTTP | [transport/http](../research_workbench/transport/http/README.md) | Exact routes and longest-prefix families, behind common auth/error handling |
| File-type identity | [extensions/filetypes.json](../extensions/README.md) | Trusted descriptor plus an existing or authored adapter |
| Browser actions | [static/features](../static/features/README.md) | Tool/source-command registries and current capabilities |
| Build state | [source/build-controller.js](../static/editors/source/build-controller.js) | Private execution/replay state with presentation/completion hooks |
| Source buffers | [source buffers](../static/editors/source/README.md#native-buffer-ownership) | Private native documents/revisions; immutable adapters, semantic save/reload/attachment |
| Review presentation | [review](../static/features/review/README.md) | Private composition state, replaceable cards, registered tabs with immutable display values |
| Persistence ordering | [source/save-queue.js](../static/editors/source/save-queue.js) | Snapshot/persist/accept operations without native editor exposure |
| Citation completion | [bibliography popup](../static/features/bibliography/README.md#citation-popup-public-interface) | Private controller with injected editor, DOM factory, linked entries and synchronous error boundary; `update`, `move`, `accept`, `close`, `dispose` |
| Diagnostics | [bibliography providers](../static/features/bibliography/README.md) | Local file rules and remote entry comparisons |
| Metadata IO | [infrastructure/metadata](../research_workbench/infrastructure/metadata/README.md) | Explicit bounded adapter operations and private settings |

Application implementations must not import the historical root compatibility
modules. Domain code performs no filesystem/network/process IO. The native HTTP
host imports no application feature implementation. Browser build/save controllers
perform no DOM, CodeMirror or fetch operations. Registered strategies/contributions
own behavior; shared executors own lifecycle and recovery.

`python3 tools/check.py` enforces those dependency directions and runs documented
extension regressions. A new directory needs its own README with real entry points,
allowed dependencies, implementation steps, lifecycle/errors and validation.

The bundled browser dependencies are unchanged: CodeMirror 5.65.16, PDF.js 6.1.200
and the existing pdf-lib artifact whose upstream version remains unverified. Exact
local bytes/licenses are recorded in `static/vendor/manifest.json`. This migration
adds no runtime dependency.
