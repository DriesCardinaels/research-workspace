# Source editing modules

## Multi-file projection

`projection.js` exposes `SourceProjection.combinedSource`, `projectionRange`,
`projectionSpans` and `applyProjectionEdit`. It accepts an authorized path set and
async exact-text reader; it owns no editor, DOM, storage, global project or network.
`Workspace` consumes these operations and retains its static compatibility exports.

## Extend source composition

Implement literal source expansion/range behavior here. Preserve `includeonly`,
cycle/missing-input warnings, repeated-file occurrences, generated separators and
native CRLF. Coordinates inside the projection use normalized UTF-16 units;
`SourceText` converts to native offsets. A source edit must resolve to one uniquely
included source span; reject cross-file/separator/repeated projections before any
buffer mutation. Return a new model instead of modifying the caller's maps.

The reader remains responsible for authorization and revision ownership. Do not
make this model open arbitrary file paths or mutate CodeMirror documents. Add
synthetic projection cases to `tests/test_combined_source.mjs`, which uses real
CodeMirror documents for edits/history and verifies source range mapping.


## Build execution state

`build-controller.js` exposes `SourceBuildController.run(target, operation)`,
`pending`, a detached immutable `target`, `queue()` and `dispose()`. The controller
owns serial execution and coalesced replay state without DOM/editor/transport
access. Inject presentation/completion hooks. Replays retain the original build
identity even if a different file becomes active. Disposal suppresses completion
hooks and prevents unstarted tasks; it does not pretend to cancel already running
server work. `test_build_controller.mjs` covers these guarantees.

## Revision-aware persistence

`save-queue.js` exposes `SourceSaveQueue.save(snapshot, persist, accept)`, `pending`
and `dispose()`. Both Workspace source saves and independent `TextSession` use it.
An idle save captures text/revision immediately; a waiting save captures only after
its predecessor succeeds. A failed predecessor rejects dependent work, preserving
unsaved text and revision for an explicit retry. Edits during IO remain dirty.

Callbacks expose only text/revision values and accepted responses, never native
CodeMirror documents or workspace state. Disposal blocks unstarted/new writes while
allowing an active response to settle. Run `test_source_save_queue.mjs`,
`test_text_session.mjs`, `test_combined_source.mjs` and `test_hide_images.mjs`.

## Native buffer ownership

`buffers.js` exposes `SourceBuffers.SourceBuffers` and `SourceBuffer`. The collection
owns native CodeMirror documents, accepted SHA/text baselines, external conflicts,
anchors, read deduplication and lifetime. Supply authorized `read(file)` and
`write(file, {text, sha})` operations; optional `createDocument(snapshot, mode)` and
`modeFor(file)` supply the native adapter. The default uses bundled CodeMirror
**5.65.16**, preserving CRLF. No dependency was added.

Use `open`, `get`, `save`, `refresh`, `close` and `dispose`; `pending` and `unsaved`
are observations. `snapshotMap()` returns detached membership containing public
buffer handles. `SourceBuffer.snapshot()` returns immutable text/revision metadata.
`doc` is a frozen method adapter for editing/history/positions, with wrapped anchor
handles; it does not expose native document internals. `attach(editor)` and
`isAttached(editor)` keep native attachment behind the trusted editor adapter.

A normal refresh reloads clean text with cursor preservation, flags dirty external
changes as stale, and ignores obsolete results. Refresh waits for pending saves;
responses spanning a save or replacement/closure cannot restore older revisions.
`refresh(file, {force:true})` discards the text present when the read began, but
rejects its result if the user types during that read. The caller owns discard
confirmation. Closing/reopening invalidates previous reads; disposal clears owned
anchors and blocks late registration. Already running IO settles through its
transport; disposal does not claim to cancel server-side work.

Workspace `files` is a compatibility membership snapshot. Use its public buffer
handles or `getSourceBuffers()` operations instead of map mutation or metadata
assignment. Tests can inject a native document factory at `adopt` (see
`tests/support/source-buffers.mjs`); they must not inject the private native map.
Save or explicitly discard work before `close`; await `pending` before closing a
buffer with queued writes. Validate with `test_source_buffers.mjs` and the existing
real CodeMirror projection, formatting, tab and save regressions.
