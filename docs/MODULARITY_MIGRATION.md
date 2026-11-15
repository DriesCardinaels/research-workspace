# Modular architecture migration plan

Historical plan: the MCP adapter described below has since been removed. External
clients now use the HTTP API documented in [llms.txt](../llms.txt).

Initial analysis date: 2026-11-14. Scope: the working tree, including uncommitted
feature modules. This is the original roadmap. Several foundational migrations
are now implemented; see [MIGRATION_STATUS.md](MIGRATION_STATUS.md) for actual
ownership, extension acceptance and work that remains. Counts and baseline failures
below describe the original analysis snapshot, not the latest test result.

## 1. Objective and completion criteria

Build deep modules: substantial behavior behind a small public interface. Optimize
for locality of change, substitutable adapters, discoverable contribution workflows
and tests through the same seam that callers use. More files or classes alone do
not demonstrate modularity. Retain the standard-library Python server and plain
JavaScript unless a measured requirement justifies another dependency.

The migration is complete when:

- A new toolbar action requires only a feature contribution, tests and registration;
  existing renderers, actions and the application shell do not change.
- A file type using an existing text/image adapter requires a descriptor plus its
  feature behavior and tests; it does not require server-route or explorer edits.
  A genuinely new editing model requires one adapter implementing the editor seam.
- A diagnostic provider or build variant can be added without editing a central
  feature switch. The registration/composition point may change intentionally.
- HTTP and MCP call the same application operations without importing one another.
- Feature modules cannot mutate another module's storage or access its private
  editor fields. Public contracts include lifecycle, revision and error semantics.
- Each implementation directory has a working extension README and targeted tests.
- Existing data, links, annotation coordinates, Unicode ranges, autosave behavior,
  read-only history and explicit commit/push behavior pass compatibility checks.
- A clean checkout runs and tests without the original author's home directory.

Scope excludes arbitrary third-party code loading, a plugin marketplace runtime,
a framework rewrite, microservices, and automatic changes to user research data.
Bundled extensions are trusted application code; registration is not a sandbox.

## 2. Observed architecture

Counts below are a snapshot, useful for locating responsibility concentration rather
than setting artificial file-size limits.

| Current implementation | Observed responsibility | Migration pressure |
| --- | --- | --- |
| `research_workbench.py` (1,304 lines) | CLI, Project, App, settings, files, library/version persistence, HTTP dispatch | Transport and storage policy change together |
| `drafts.py` (1,277 lines) | BibTeX parsing, citations, source IO, diff/anchor relocation, Git, builds, review state | Unrelated features import a draft implementation |
| `static/workspace.js` (3,189 lines) | CodeMirror buffers, tabs, source/PDF layout, review, diagnostics, citations, build state | Broad owner interface and shared mutable state |
| `static/app.js` (1,182 lines) | Shell, navigation, project registry UI, explorer, dialogs and session switching | Feature routing still depends on shell knowledge |
| `static/annotator.js` (1,332 lines) | PDF render, interaction, annotations, export and lifecycle | Preserve established lifecycle tests while extracting |
| `static/toolbar.js` (732 lines) | Tool runtime, registries, icons and concrete tools | Good seam; infrastructure still bundles feature definitions |
| `file_handlers.py` + `static/file-types.js` and contributions | Backend permissions versus frontend file identity/capabilities | Same extensions maintained in two runtimes |
| `standalone_latex.py`, `source_archive.py`, `openalex.py` | Feature modules depending on `drafts` helpers/errors | Shared parsing and IO owned by the wrong module |
| `project_entries.py` | Confined explorer operations and index changes | Writes `project.index` and coordinates through Project internals |
| MCP `server.py` | Schemas, dispatch, HTTP client and process startup | Defaults and launcher contain historical machine paths |
| `tests/` | unittest, VM/DOM JavaScript fixtures, browser smoke page | Good coverage; some tests inspect source text/layout |

### Existing seams to preserve

`ToolRegistry.register/contribute/mount/execute`, `Tool`, `ToolInfo`, shared icons,
`SourceCommandRegistry`, `FileTypeRegistry`, `TextSession`, `LatexSourceSession`,
and the image preview host already provide useful extension points. Tool mounts
support refresh and disposal. File handlers explicitly distinguish editing,
review, prose and image preview permissions. Importing does not imply editing.
Keep these behaviors; adapt their implementations incrementally.

### Concrete coupling evidence

- `OpenAlex` imports `parse_bib` from `drafts`; standalone compilation imports
  `SourceError`, Git and source helpers there; archives import its error type.
- `Project` constructs `Drafts(self)` and owns the mutable index. `ProjectEntries`
  edits that index directly, while `Drafts` calls back into Project operations.
- `toolbar.js` defines PDF actions, source controls and tab actions in the same
  closure as registry infrastructure. Some tools receive the entire owner.
- `index.html` explicitly orders classic scripts. `workspace.js` reads `DraftMatch`
  at load time; contributions depend on globally installed registries. Adding a
  script still requires an intentional loader change.
- Browser registration in `FileTypes` does not register backend permission in
  `file_handlers`. Unknown import support does not imply an editor exists.
- The MCP bridge shares schemas with backend modules but advertises tools and
  implements dispatch separately. Its `.mcp.json` names a developer-specific
  Python executable, checkout and historical `research-workbench` directory.
- `tools/split_hallmark_repositories.py` is a research-specific migration utility
  with embedded source paths and account details; it is not a generic extension.

### Baseline validation and blockers

Analysis environment: Python 3.14.6, Node.js 26.10.0. The declared application
minimum is Python 3.10; PDF lifecycle tests now require Node.js 26+ (the original Node 22 CI baseline failed). Minimum-version
compatibility has not been established by this local run.

- JavaScript: 34 of 35 `tests/test_*.mjs` scripts passed with
  `--experimental-vm-modules`. `test_tool_architecture.mjs` rejects the
  `wrapper.addEventListener('click', ...)` binding in `bibliography-links.js`.
  This is a baseline failure, not introduced by these docs. It requires deciding
  how link navigation and Tool activation differ, then testing the behavior.
- The initial Python in-process run executed 171 tests with one error in real MCP
  stdio discovery. The bridge defaults to the old checkout path. Use
  `RESEARCH_WORKBENCH_ROOT="$PWD"` for reproducible bridge imports; phase 0 must remove the
  machine-specific assumption. The environment-qualified rerun passed all 171 tests
  in 12.205 seconds.
- Full API validator, normal socket suite, plugin socket suite and interactive
  browser smoke checks are separate checks; this analysis does not claim them.

Do not begin mechanical extraction by weakening these tests. Resolve or explicitly
track baseline defects first, and record actual commands and skip reasons in each PR.

## 3. Target ownership and dependency direction

The following layout is proposed. Create a directory only when moving real behavior
into it. Every listed implementation directory receives its README in that PR.

```text
research_workbench/
  __init__.py
  bootstrap.py               # composition and resource paths
  domain/                    # values, invariants, review/diff rules, typed errors
  application/               # project, document, source, review use cases
  ports/                     # narrow contracts for actual IO variation
  infrastructure/
    filesystem/              # atomic persistence, confined paths, storage adapters
    processes/               # Git, LaTeX, SyncTeX execution
    metadata/                # OpenAlex adapter and credential settings
  transport/
    http/                    # request parsing, authorization, routes, error mapping
  extensions/
    filetypes/               # trusted backend registrations and descriptor catalog
static/
  bootstrap.js               # explicit built-in composition
  core/                      # tools, file types, public contracts, transport helpers
  shell/                     # projects, explorer, routing and top-level layout
  editors/                   # text, source and PDF adapters; buffer lifecycle
  features/
    pdf/                     # PDF tools and export
    latex/                   # commands, tables, compilation UI, source mapping
    bibliography/            # parsing presentation, tools, diagnostics and links
    review/                  # comments, changes, panel and annotation presentation
    media/                   # image preview and JSON contributions
  ui/                        # shared controls, dialogs, help and theme tokens
extensions/
  builtin-filetypes.json     # inert cross-runtime identity/capability descriptors
```

The existing MCP packaging directory can remain a distribution adapter. It consumes
HTTP plus transport-independent schemas, never Project or Drafts implementations.
Keep `research_workbench.py` as a compatibility launcher during and after package extraction.
Use `.research-workbench/` for metadata. Migrate previous storage intact; preserve historic IDs.

| Module owner | May depend on | Must not depend on |
| --- | --- | --- |
| Domain | Standard-library pure values/functions | HTTP, files, subprocesses, DOM or providers |
| Application | Domain and narrow ports | Concrete HTTP/MCP handlers or browser state |
| IO adapters | Port contracts, domain errors, relevant system library | Application shell or unrelated feature implementation |
| HTTP transport | Application operations, request schemas, error mapping | Direct project-file mutation |
| Bootstrap | All concrete implementations needed for composition | Business decisions implemented in wiring |
| Browser core | Browser primitives and explicit small interfaces | Feature implementations or shell globals |
| Feature | Core plus injected editor/application capabilities | Another feature's private state or shell internals |
| Shell/editor host | Public registries, adapter contracts | Extension IDs in routing conditionals |
| MCP | HTTP client plus inert public schemas | Backend persistence classes |

Prefer explicit calls and dependency injection. Introduce an event subscription only
when multiple owners need notifications; name the event, payload, ordering,
unsubscription and error owner. Avoid a global service locator or untyped event bus.
Only introduce ports where behavior actually varies or IO needs controlled tests;
do not wrap every standard-library function in a forwarding class.

## 4. Public contracts to establish

These are proposed semantics to refine against existing callers in the owning PR.
They are not names contributors can import today.

### Editor session

A host owns one document identity, revision and buffer lifecycle. Expose reading
text/selection, applying an edit, history operations, saving, dirty-state snapshots,
change subscription and disposal. Read-only adapters declare this explicitly;
source-only sessions do not fake a review baseline. Inject transport and the error
reporter. Do not expose CodeMirror documents, mutable maps or the workspace object.

A save captures a revision; edits made while it runs remain dirty. Stale writes
surface a conflict and retain the buffer. Selection/ranges crossing Python and JS
use the API's Unicode code-point convention, with conversion inside the editor
adapter. Disposal cancels timers, requests, subscriptions, tool mounts and object
URLs; late results cannot publish into a different document.

### Tools and contributions

Retain the working Tool contract: stable namespaced ID, label, optional info,
registered icon or text presentation, shortcut, available/enabled/state and execute.
Use explicit capability subsets such as selection edits, build operations or tab
operations rather than `owner` or `publicContext` as a catch-all. Hosts own placement;
features own actions. Register before mounting, since current mounts are snapshots.
No runtime hot registration requirement is introduced by this plan.

One invocation path serves pointer, menu and keyboard activation. Each invocation
has one error owner. Custom controls define refresh and dispose. A capability
absence hides an inapplicable action; temporary unavailability disables it.

### File-type descriptor and adapter

Share inert metadata: schema version, ID, label, extensions, declared capabilities
and adapter key. Backend code remains authoritative for permissions, byte signature,
MIME, size limits and path confinement. Do not ship executable code, credentials or
security decisions in a browser-controlled descriptor.

Backend trusted registration supplies implementation functions; bootstrap maps
adapter keys to browser implementations. Serialize the normalized public catalog
through a read route, and validate frontend mappings against it before navigation.
Keep the old registrations as compatibility adapters until parity tests cover
TeX, BibTeX, text, Markdown, JSON, PNG and JPEG. Unknown importable files can remain
noneditable. New executable behavior still requires authored code and registration.

### Application operations and errors

Use operations such as open project, read/save source, manipulate entry, compile
and publish version; accept explicit IDs/revisions and return immutable snapshots.
Move schema definitions needed by both transports into a transport-independent
module. Keep validation at trusted entry points and domain invariants in their owner.

Name expected categories: invalid input, missing resource, conflict, unsupported
capability, authorization, build/provider failure and timeout. Initially map these
to the current HTTP statuses and payloads in `Handler.handle_error` (including
400/403/404/409/422/500/504); changing error taxonomy must not silently change clients.
Catch unknown failures at the transport boundary with a generic reply and local
traceback that omits secrets. Cleanup/rollback catches may rethrow with context.

### Build and diagnostic providers

A build request identifies source root, main file, variant and expected revision;
its result identifies success, artifact, log and source mapping. Paper, active-file
and no-figures builds share execution/publishing policy, with distinct strategies.
Publication is atomic and failure retains the last good artifact. Preserve current
lock semantics first; narrow lock granularity only after concurrency tests exist.

A diagnostic consumes a source snapshot and returns stable IDs, ranges, severity,
rule, provenance and suppression identity. Async results carry the snapshot revision;
obsolete results are ignored. Local duplicate/citation checks work without network.
External metadata checks preserve explicit settings and query disclosure; provider
outages must not become false bibliographic mismatch warnings.

## 5. Ordered migration phases

Each phase should land as small reviewable PRs. Estimates are relative size
(S/M/L), not calendar promises. Functional changes need their own acceptance tests.
For every phase: update the owning READMEs, preserve contracts, run focused checks,
then the broader suites once before merging. Do not combine storage migrations
with extraction PRs.

### Phase 0 — Establish a reproducible public baseline

**Dependency:** none. **Size:** M. **Output:** reliable checkout and release backlog.

1. Capture current working-tree changes in reviewed commits before extraction;
   preserve all research files and existing edits. Record baseline test results.
2. Resolve the link/Tool architecture assertion with behavioral tests for normal
   link activation, hover and keyboard behavior; do not simply exempt the file.
3. Derive plugin checkout/resource paths from installation or explicit configuration;
   replace machine-specific launcher configuration with a documented portable setup.
   Process tests must run from an unrelated working directory and a temporary checkout.
4. Add CI for pure Python and Node checks, then a separate TeX-enabled integration
   job and plugin loopback transport job. Establish actual supported versions and
   OS coverage; Finder and `fcntl` behavior require platform-specific treatment.
5. Root license selected: [PolyForm Noncommercial 1.0.0](../LICENSE), a
   source-available noncommercial license; preserve all third-party notices. Add a
   private security-reporting policy and release instructions appropriate to the repo.
6. Review tracked and proposed files for local credentials, logs, absolute paths,
   manuscripts and old research utilities. Move/archive or parameterize the
   Hallmark-specific command before presenting it as general tooling. Inspect Git
   history as a separate publication task; do not rewrite it as part of extraction.
7. Inventory vendored versions, provenance, hashes, licenses and update procedure.
   Do not infer a dependency version when the artifact does not identify it.

**Gate:** documented clean-checkout commands pass, private data is excluded, no
required command depends on the author's home directory. The noncommercial license
has been selected; release approval remains a maintainer decision.

### Phase 1 — Extract the Python package and composition root

**Dependency:** 0. **Size:** M.

Move startup, settings loading and dependency construction into
`research_workbench/bootstrap.py`. Add explicit package exports and a thin
`research_workbench.py` launcher with temporary re-exports for existing imports. Derive
static asset paths from the installed checkout/package rather than current working
directory. Keep the current CLI, default port, settings location and HTTP identity.
Add packaging metadata only with a verified resource inclusion/install story;
do not require installing a package to run the checkout.

**Gate:** launch from repository root and another directory; old imports, CLI flags,
MCP startup, deep links and asset URLs work. **Rollback:** keep the old launcher
entry point; revert moves without touching any project files.

### Phase 2 — Separate domain rules and shared contracts

**Dependency:** 1. **Size:** M.

Extract BibTeX parsing/citation analysis, review values, diff/relocation algorithms
and error definitions from `drafts.py`; establish public contracts with synthetic
fixtures. Move shared markup/directory-import schemas out of concrete feature IO.
Update OpenAlex, standalone compilation and archives to import their proper owner.
Keep forwarding imports temporarily so existing callers can migrate independently.

**Gate:** pure-domain tests use no IO, subprocess or HTTP setup; Unicode, CRLF,
duplicate keys, braces and anchor relocation match baseline fixtures.
**Rollback:** compatibility exports continue to resolve old names.

### Phase 3 — Encapsulate storage and project state

**Dependency:** 2. **Size:** L.

Give library/version state, draft review state and source bytes separate storage
owners. Extract one confined path policy and atomic publication implementation,
with explicit managed-directory and linked-source-root rules. Replace
`ProjectEntries` writes to `project.index` with public operations for coordinated
entry changes. Introduce application operations that coordinate storage adapters;
Project can temporarily delegate behind its existing public interface. Preserve
index schema versions, backups, permissions, SHA checks and lock ordering.

**Gate:** failed write/rename/import leaves prior bytes and index intact; traversal,
symlink escape, archived-version mutation and stale revisions are rejected. Project
registration survives restarts; removal only forgets registration.
**Rollback:** storage format unchanged; revert delegation rather than rewriting data.

### Phase 4 — Separate HTTP routing and platform operations

**Dependency:** 3. **Size:** M.

Move route families (projects, files, review, source/build and settings) into explicit
route modules using common request/response contracts. Authorization, body limits,
error translation and response headers stay centralized. Routes call application
operations rather than opening files. Keep the full URL/status/payload contract.
Extract native chooser/reveal behavior into a platform adapter with clear supported
and unsupported outcomes. Keep API and plugin schemas aligned through contract tests.

**Gate:** in-process and real-socket suites cover the same operations; invalid host,
foreign origin and missing token checks execute before writes. MCP exercises the
unchanged routes. **Rollback:** route family can delegate to the former handler.

### Phase 5 — Separate Tool infrastructure and browser composition

**Dependency:** 0; coordinate path changes with 1. **Size:** M.

Move Tool/registry/icons contracts into `static/core`, shared help/controls into
`static/ui`, and concrete tools into feature directories. Introduce an explicit
bootstrap with imports or a validated ordered manifest; prefer native ES modules
when the existing VM tests and PDF.js import path are migrated deliberately.
Move feature registration side effects into explicit registration functions.
Keep a short-lived global facade for unmigrated scripts, with a named removal phase.
Do not mix framework adoption, transpilation or a bundler into this extraction.

**Gate:** startup validates unique registrations and required adapters; adding a
fixture Tool edits no host implementation. Mount/refresh/dispose, shortcuts,
focus preservation and tooltips pass. **Rollback:** old facade delegates to new core.

### Phase 6 — Extract editor sessions and workspace ownership

**Dependency:** 3, 5. **Size:** L; split by buffer, build and review ownership.

Extract revision-aware source sessions, tab navigation, build controller, PDF pane,
review panel, citation completion and diagnostics presentation from `Workspace`.
Reuse `TextSession` and `LatexSourceSession` semantics rather than building a
second source editor. Give the shell one editor adapter interface for open,
unsaved state, save-before-navigation, reconnect and dispose. Migrate one owner
at a time; replace broad workspace/owner arguments with capability subsets.
Make app routing resolve providers rather than switching over known extension IDs.

**Gate:** editor instances and undo histories survive supported switches; failed
save blocks navigation; pending edits and last good PDFs survive failures; obsolete
async results do not affect a new project/tab. Repeated open/close frees listeners,
timers, workers and object URLs. **Rollback:** old Workspace can compose extracted
owners until every caller migrates.

### Phase 7 — Unify file-type metadata and registration

**Dependency:** 4, 5, 6. **Size:** M.

Introduce the versioned inert catalog and trusted backend/frontend adapter mapping
described above. Migrate one existing type at a time. Validate catalog uniqueness,
capability agreement and required adapters; treat backend capability checks as
mandatory even if the UI disables an action. Separate supported imports, text edits,
review eligibility, preview and compilation in descriptors and docs.

**Gate:** a fixture `.notes` type using the text adapter needs no route, explorer
or host changes. An extra image type uses the existing preview adapter plus
explicit MIME/signature policy. Catalog parity covers every current extension.
Unknown extensions cannot acquire permissions by client metadata.
**Rollback:** regenerate legacy registration inputs from the catalog temporarily.

### Phase 8 — Extract build and diagnostic strategies

**Dependency:** 2, 3, 6; registration follows 5. **Size:** L.

Move Git/process invocation, LaTeX variants and SyncTeX into dedicated adapters.
Application operations own orchestration, save/build ordering and atomic artifact
publication. Introduce build strategies for the three existing variants; keep
archive export consuming the public build result. Extract bibliography diagnostic
providers from workspace rendering. Keep OpenAlex settings/network handling in
its adapter and stable suppression/cache behavior in the diagnostic owner.

**Gate:** all build variants share failure-preservation and cleanup tests; failed
version publication rolls back the relevant commit/import state as before; a build
never implies a push. Local diagnostics run offline; cancellation, stale results,
provider timeout, suppression and restored warnings work through public contracts.
**Rollback:** preserve old Drafts entry points as delegating compatibility methods.

### Phase 9 — Make MCP a portable transport adapter

**Dependency:** 2, 4; can proceed alongside 6–8. **Size:** M.

Separate HTTP client/startup, tool schemas, handlers and stdio JSON-RPC loop.
Register each advertised schema with its actual handler to prevent discovery/dispatch
drift. Preserve existing tool names and arguments; annotate side effects truthfully.
Inject process startup and HTTP transport. Consume shared schema definitions only
through a public contract; prohibit imports of storage/domain implementation state.
Keep human-facing plugin instructions aligned with the actual launcher.

**Gate:** every advertised tool is invoked through production dispatch; stdio and
loopback tests pass in a relocated checkout. Read-only lookup never changes state;
write tokens, explicit pushes and version creation preserve their existing behavior.
**Rollback:** retain the existing `server.py` entry point as a thin adapter.

### Phase 10 — Enforce seams and complete contributor handoff

**Dependency:** 1–9. **Size:** M.

Add import/dependency checks for forbidden directions, feature-to-private-state
access and executable contribution discovery. Replace source-regex assertions with
behavioral contracts where possible; keep source policies only for actual
architectural invariants. Remove temporary exports/global facades after callers
and tests migrate. Consolidate duplicated root README implementation sections into
feature guides without losing user documentation. Reconcile every directory README
with real paths and tested examples, and add a documentation-link check to CI.

**Gate:** clean checkout, supported-platform CI, all regression suites, browser
smoke checks and extension exercises pass; no compatibility facade or undocumented
extension folder remains. Publish release notes describing extension contracts and
known platform limits. **Rollback:** defer facade removal until the previous gates
are independently reproducible.

## 6. Compatibility and validation matrix

| Concern | Existing evidence to retain | Additional migration acceptance |
| --- | --- | --- |
| Files and permissions | `test_file_handlers.py`, `test_image_json_files.py`, `test_project_entries.py`, `test_entry_manipulation.py` | Same policy for every adapter; catalog cannot grant permissions |
| Projects and versions | `test_projects.py`, `test_editor.py`, project-removal suites | Restart, old settings, unavailable roots and v1 index backup |
| Autosave/conflicts | `test_text_session.mjs`, `test_workspace_tabs.mjs`, `test_markup_sync.mjs` | Edits during saves, concurrent clients, failed switch preserves buffer |
| Review and Unicode | `test_markup.py`, `test_drafts.py`, `test_combined_source.mjs` | Astral characters, CRLF, anchors and stable item IDs across adapters |
| Tools | `test_tool_contract.mjs`, `test_toolbars.mjs`, `test_toolbar_icons.mjs`, `test_tool_architecture.mjs` | Independently contributed action; no host edits or leaked owner state |
| File routing/lifecycle | `test_filetype_navigation.mjs`, `test_media_filetypes.mjs`, `test_annotator_lifecycle.mjs` | Fixture type, stale request, repeated mount/dispose |
| Builds and export | `test_drafts.py`, `test_standalone_latex.py`, `test_source_archive.py`, `test_hide_images.mjs` | Real TeX job; artifact isolation, cancellation and retained preview |
| Metadata | `test_openalex.py`, bibliography/diagnostic/link/sorting scripts | Offline-first behavior, controlled network failures, suppression parity |
| Repository actions | `test_repository_sync.py`, `test_repository_dialog.mjs` | Lock interaction, exact expected HEAD/URL, no unintended commit/push |
| HTTP and MCP | `test_api_validation.py`, `test_mcp_tools.py`, plugin process suite | Real sockets, relocated install, schema/handler parity |
| Browser integration | `tests/modularity-browser.html` and interactive smoke | Focus/keyboard, narrow toolbar overflow, themes and resource cleanup |

Add a test when it protects a seam, data invariant or meaningful behavior; do not
mirror implementation details or add tests solely for moving files. Record optional
TeX/network/platform checks separately from deterministic unit tests.

## 7. Progress and review discipline

Track each phase as a milestone with child PRs for mechanical moves, contract tests,
caller migration and removal of compatibility shims. A PR checklist should name:
source owner → target owner; public contract preserved or intentionally changed;
compatibility adapter and removal phase; focused/full checks; README updated; data
rollback strategy. The reviewer should be able to evaluate one responsibility change.

Measure locality with the extension exercises, forbidden import counts, remaining
private-state callers and cleanup tests. Record file-size trends only as a signal.
Do not optimize for a maximum module count, arbitrary one-class-per-file rules or
100% dependency inversion. Prefer a deep module over several pass-through wrappers.

## 8. Decisions to record before implementation

- Source-available licensing documentation and supported OS/Python/Node/browser matrix (phase 0).
- Packaging/resource discovery and native-module versus ordered-manifest loading
  (phases 1 and 5), grounded in relocated-checkout and startup tests.
- Exact session range/revision contract and lock ordering (phases 3 and 6).
- Descriptor schema ownership and adapter compatibility/version policy (phase 7).
- Build cancellation semantics and shutdown cleanup ownership (phase 8).

Record each decision with context, chosen design, rejected alternatives,
compatibility consequences and proving tests. None requires a runtime change in
this planning/documentation commit.
