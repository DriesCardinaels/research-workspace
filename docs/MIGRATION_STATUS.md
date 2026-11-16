# Implemented migration and remaining work

Updated 2026-11-15. The initial [migration plan](MODULARITY_MIGRATION.md) remains the
roadmap. This document records working implementation and remaining scope.

## Implemented

| Seam | Actual implementation and compatibility |
| --- | --- |
| Package and startup | Package-owned composition, working-directory-independent assets, compatibility CLI and package entry point |
| macOS offline recovery | Optional AppKit/WKWebView host, native Launch Server action, bounded serialized startup/reuse and health identity; loaded editor survives outages until explicit reload |
| Graceful shared-server stop | Native Stop Server button/menu, shared-impact/dirty confirmation, authenticated lifecycle operation and request/application cleanup before port release |
| Shared rules/contracts | Bibliography, citations, diff/relocation, comments, PDF/LaTeX transformations, errors and HTTP schemas |
| Build variants | `BuildVariantRegistry`, immutable requests/plans and one shared executor; paper, standalone preview and figure-free strategies |
| Artifact publication | Stage all outputs/backups; restore prior artifacts on failed replacement; reject missing required files/symlinks; remove stale optional maps |
| Source mapping | Bounded SyncTeX process adapter and injected source/PDF mapping owner with source-root confinement |
| Project workflows | Private library state/snapshots; source build/version/history transactions in application operations |
| HTTP routing | Exact and prefix contribution registry; project/document/draft family outside the native HTTP host; authorization remains centralized |
| Source persistence | Shared revision-aware save queue for Workspace and TextSession; idle snapshots immediate, waiting snapshots fresh, failed predecessors stop dependent writes |
| Native source ownership | Private document/revision/anchor collection; immutable editing adapters; race-safe reload, deduplicated reads and closure guards |
| Citation completion | Private popup controller owns autocomplete, keyboard/pointer selection, positioning, dismissal, async generations and disposal; Workspace supplies editor/linked metadata capabilities |
| Review state and presentation | Private composition/selection model; replaceable cards; registered tabs with immutable display snapshots; newer typing survives older submissions |
| Browser build state | Private controller owns serial execution, immutable target identity, coalesced replay and disposal; host owns UI/save/IO behavior |
| Diagnostics | Independently registered file/entry providers; isolated inputs, cache namespaces, failure cooldowns and suppression with stale-result protection |
| File types and Tools | One frontend/backend catalog; shared Tool runtime; concrete feature contributions; pure citation/projection models |
| Module consolidation | Flat source files are compatibility imports; package implementation imports only its owning modules |
| Construction seams | App accepts project/provider factories; Project accepts a draft factory; Drafts accepts a build registry/compiler |
| Lifecycle | Server joins request threads before project preview cleanup; disposed browser hosts stop queued saves/replays and ignore completion hooks |
| Contributor checks | Directory READMEs, extension examples, dependency-direction checks, docs/vendor validation and Linux/macOS/TeX CI configuration |

The launcher is now `research_workbench.py`; external automation uses HTTP.
The former MCP adapter and plugin have been removed. Existing storage formats
and URLs are preserved. Metadata now uses `.research-workbench/`; previous storage
is renamed intact on project open. Document IDs, version history and source links
are preserved. No research project
was moved/deleted, and no Git commit/push or public release was performed.

## Extension acceptance

- `test_native_recovery.py` covers health authorization, lock contention, occupied
  ports, startup failure, deadline rejection and owned-child cleanup. The explicit
  `native_recovery_integration.py` checks concurrent real startup/reuse, SIGTERM
  cleanup and a total health deadline. The native host remains a source-checkout
  launcher; Safari browser preferences are separate from its WKWebView storage.

- `test_build_strategies.py` supplies a new plan and compiler through real project
  construction without editing the executor, exercises partial publication rollback,
  safe mapping, required/optional artifacts and server/application shutdown order.
- `test_modular_contracts.py` adds file types and exact/prefix HTTP contributions,
  checks authorization and detached state, verifies every startup asset resolves,
  and verifies public extension behavior.
- `test_build_controller.mjs` proves serial execution, original-target replay,
  synchronous busy state, cleanup and disposal through public operations.
- `test_source_save_queue.mjs` proves fresh queued snapshots/revisions, preservation
  of edits during writes, conflict propagation, retry and disposal.
- `test_source_buffers.mjs` exercises the real CodeMirror adapter, native history,
  wrapped anchors, immutable membership/metadata, save/reload races and disposal.
- `test_review_modules.mjs` adds an independent review tab, checks detached inputs,
  availability fallback, composition/reply races and disposal without a Workspace.
- `test_citation_search.mjs` exercises autocomplete with linked unsaved buffers, independent
  popup composition, keyboard/pointer selection, UTF-16 insertion, positioning, dismissal,
  stale metadata and disposal through public operations and visible DOM.
- `test_diagnostic_providers.mjs` registers independent rules/comparators, checks
  cache/cooldown/input isolation and ensures a failed provider does not hide others.
- Existing real CodeMirror, source/TeX, review, file navigation and media regressions
  retain the prior Unicode, CRLF, undo, stale-write and preview behavior.

## Contributor compatibility

- `research_workbench.launcher`, `drafts`, `markup`, `openalex`, `imports`, `project_entries`,
  `repository_sync`, `standalone_latex`, `source_archive`, `latex_artifacts` and
  `file_handlers` retain public compatibility imports. New implementation code must
  import package owners; architecture checks reject dependencies on these facades.
- `Project.index`, `doc`, `documents`, `versions` and `folder` return snapshots.
  Use semantic operations or `index_snapshot()`/`commit()` to publish a transaction.
- Workspace `compiling`, `buildTarget` and `saving` are read-only observations.
  Execute through public build/save operations; tests no longer inject build state.
- Workspace `files` and `replyDrafts` return detached membership snapshots. Native
  source documents and review drafts have private owners. Use semantic buffer/model
  operations; polling uses `hasPendingReviewEdits()`. Review tabs register through
  `ReviewTabRegistry`; card/panel adapters can be injected at construction.
- Built-in file metadata belongs in `extensions/filetypes.json`. New executable
  models still require authored adapters and explicit composition.
- Diagnostic providers belong in `static/features/bibliography/providers.js`.
  The controller owns lifecycle, pacing, cache and suppression; providers own rules.
- External clients use HTTP directly; `llms.txt` documents source editing and the API capability map.

## Remaining scope

1. Extract writing-panel presentation and PDF placement
   from the large browser Workspace. Native source-buffer ownership, review state,
   cards and tab presentation now have dedicated owners; navigation and some review
   mutation/clipboard orchestration still live in the host. The generated combined-
   paper document cache also remains host-owned; editable per-file native documents
   are encapsulated by the new collection.
2. Split the project route family's individual feature routes further if needed;
   all existing routes already live behind the registered family and the socket
   host has no application-feature imports. Some source/repository/archive request
   orchestration can still move from that family into narrower application operations.
3. Add a wheel/resource distribution only if package installation is required. The
   current supported workflow is a source checkout with no runtime pip/npm install.
4. Complete platform/transport validation outside this sandbox. Unix LaTeX process
   termination and native Finder selection do not imply Windows feature parity.
   The first remote CI run was inspected: Python passed, then the PDF.js JavaScript lifecycle test failed under Node 22. The workflow now uses the validated Node 26 baseline; the patched remote run remains unverified.
5. The root license is now PolyForm Noncommercial 1.0.0; see [licensing](../LICENSING.md).
   Enable a concrete private security-reporting channel,
   inspect release contents/history, reconcile packaged plugin user instructions
   with the current tool inventory, and resolve unknown vendored provenance. No
   publication or repository-visibility change is established by adding a license.

Established compatibility entry points remain intentional; deleting them merely to
reduce file count would break callers without improving implementation locality.

## Local validation

- Python: **203 tests passed** through `uv run --no-project python tools/check.py`.
- JavaScript: **44 regression scripts passed** through the same complete runner.
- **39 maintained documentation files** passed directory/link checks.
- Dependency-direction, controller/contribution ownership, bundled vendor integrity
  and `git diff --check` passed.
- `python3 -m research_workbench --help` verified the package entry point.

The dedicated native loopback/process suite passed all **five tests** with socket
permission. The complete normal socket suite was not rerun. A temporary native
harness also verified offline launch, online editor, outage recovery with preserved
page state, explicit reload, cancellation of the unsaved-work close/reload guard
and real blob export with atomic replacement at the same destination. Download
verification injected only the destination picker; the default save dialog UI
was not verified. Six follow-up native checks passed: offline disabled Stop state,
online title-bar availability, dirty warning/cancel keeping the server running,
confirmed repeated-click shutdown preserving the page, restart preserving the page
and explicit reload. The title-bar layout was inspected. A fresh AI-only review
found no remaining shutdown issues after the fixes.
This was AI-only validation. The original remote CI run failed at the PDF.js
lifecycle test under Node 22; the patched Node 26 remote CI remains unverified.
The local Python run reported no optional-tool skips; it exercised the installed
TeX toolchain through the existing source/build tests.

Restart a running server before reloading its browser to load backend changes.
This continuation did not stop an existing server or discard open browser buffers.
