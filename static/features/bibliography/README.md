# Bibliography feature rules

`citations.js` exposes `BibliographyCitations.citeUses`, `citeContext` and
`citeMatches`. These are local pure operations for warning ranges, in-progress
citation keys and autocomplete ranking. Metadata comes from the caller's linked
bibliography buffers; this module performs no network lookup or storage access.

To add a citation syntax or matching rule, update this implementation and its
synthetic cases in `tests/test_citation_search.mjs` and `test_format.mjs`. Preserve
literal command behavior, multi-key insertion, key-prefix ranking and native
UTF-16 editor offsets. Shared comment/range helpers belong in `core/source-text.js`.

The completion lifecycle belongs to `popup.js`; backend adapters own code-point ranges. Diagnostics, metadata dialogs and toolbar files remain at their
compatible top-level paths. Use their public operations rather than reaching into
editor fields; their further state-owner extraction remains on the roadmap.


## Register diagnostic providers

`providers.js` exposes `BibliographyDiagnosticProviders.DiagnosticProviders` and the
built-in registry. Register local `scope: 'file'` rules with `diagnose(context)`, or
remote `scope: 'entry'` rules with `compare(context)` and optional `eligible(entry)`.
Every definition requires a unique `id` and label. Register before mounting a
controller, or inject an independent registry via its `providers` option.

Local rules receive detached metadata/counts. Entry comparisons receive exact
entry source, metadata snapshots and `request(path, data)`. Return a response with
`warnings`, whose codes are stable and unique to the provider/rule; use field names
for range mapping. Do not access an editor, buffer map or provider credentials.
Keep synchronous predicates pure and perform remote IO only through the request
capability after the user's automatic-check/recheck preference permits it.

The controller owns pacing, cache expiry, source-generation guards and suppression.
Additional providers have isolated cache keys and failure cooldowns. One unavailable
provider does not prevent other providers/local rules from reporting. Existing
OpenAlex cache/suppression identities stay compatible. `test_diagnostic_providers.mjs`
proves registration, input isolation, failure/cache/cooldown isolation and suppression.

## Citation popup public interface

Load `core/source-text.js`, `citations.js` and `popup.js` before the host. The
controller uses the bundled CodeMirror **5.65.16** adapter; no new dependency is added.

```js
const popup = new window.CitationPopup({
  editor, host, node,
  enabled: () => currentFileIsEditableLatex(),
  entries: () => readLinkedBibliographyEntries(),
  run: operation => reportSynchronousUiErrors(operation),
});
popup.update(true); // Explicit completion command, e.g. Ctrl+Space.
popup.close();      // Host navigation or presentation change.
popup.dispose();    // Host teardown; permanent and idempotent.
```

| Public operation | Contract |
| --- | --- |
| `update(force = false)` | Refresh current citation context and position; `true` permits opening. No source write. |
| `move(delta)` | Clamp the active option by a signed offset. No source write. |
| `accept(index)` | Insert the indexed match (active match by default), retain commas/braces, close a missing brace, and focus the editor. |
| `close()` | Hide popup, invalidate pending metadata and release completion keymap. Reusable. |
| `dispose()` | Close and remove DOM, editor/document/window listeners and blur timer; ignore late results. Permanent. |

`host` is a positioned DOM element with client dimensions. `node(tag, attrs,
...children)` creates text-safe DOM nodes and binds `on*` handlers. `run(operation)`
must execute synchronously so keyboard events can cancel browser defaults; the host
owns unexpected-error reporting. Lower-level public methods throw unexpected DOM or
editor failures. Metadata failures appear as popup status text. `entries()` returns
linked current-buffer metadata (`key`, `title`, `author`, `year`), never a provider
search or save. The controller receives no Workspace, API credentials or buffer map.

The editor adapter supplies `on/off`, cursor/line/selection reads, optional read-only
status, local cursor coordinates, scroll offsets, keymap add/remove, `replaceRange`,
`focus` and `hasFocus`. The controller owns typing/composition/paste/delete,
cursor/scroll/document-swap listeners, resize repositioning, delayed focus dismissal
and outside-pointer dismissal. Arrow/Page keys navigate; Enter/Tab accept; Escape
closes. Pointer options preserve editor selection. Each instance has unique ARIA IDs.

All popup state is private. Tests inspect visible DOM and source edits, never match
arrays or popup fields on Workspace. `tests/test_citation_search.mjs` runs the public
controller without Workspace and also exercises Workspace with real CodeMirror
native documents and linked unsaved bibliography buffers.
