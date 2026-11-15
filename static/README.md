# Browser implementation and extension guide

This directory contains the active browser application. `index.html` loads classic
scripts in a deliberate order; there is no npm build step. Bundled dependencies
are described in [vendor/README.md](vendor/README.md). Concrete built-in Tool contributions now live in [features/](features/README.md).
See [implementation status](../docs/MIGRATION_STATUS.md) for remaining extractions.

## Ownership map

| Files | Responsibility and public entry points |
| --- | --- |
| `toolbar.js`, `features/*/tools.js`, `tool-ui.js`, `toolbar.css` | `EditorTools.Tool`, `ToolInfo`, icons, tool/source-command registries, help and presentation |
| `file-types.js`, `text-file-types.js`, `json-filetype.js`, `image-filetypes.js` | `FileTypes.registry`, concrete provider registrations and image adapter |
| `app.js`, `explorer.js`, desk/explorer styles | Shell, project/file routing, dialogs, `ProjectExplorer` hooks |
| `text-editor.js` | `TextSession`, `TextWorkspace`: independent text buffers and SHA saves |
| `workspace.js`, `latex-source-session.js`, `editors/source/projection.js`, `core/source-text.js` | `Workspace` and source-only transport; LaTeX/source/PDF editing |
| `editors/source/buffers.js`, `features/review/*` | Private source/review ownership; [registered review tabs](features/review/README.md) |
| `annotator.js`, `draft.js` | PDF annotation host and `DraftMatch` source/PDF matching |
| `latex-table.js`, `source-formatting.js`, `source-export.js` | LaTeX insertion, formatting and archive actions |
| `bibliography*.js`, `features/bibliography/citations.js`, `features/bibliography/popup.js`, `bibtex-sorting.js` | Metadata dialog, inline diagnostics, links, toolbar and sorting |
| `writing.js` | Writing rules and readability analysis |
| `theme.css`, shared styles | Theme tokens, syntax colors and shared layouts |

## Add a Tool

Use `EditorTools.registry.contribute(area, definition)` for a normal action.
An independently loaded script can contribute this action with existing public
interfaces:

```js
'use strict';
(() => {
  window.EditorTools.registry.contribute('markdown.tools', {
    id: 'markdown.inline-code',
    label: 'Inline code',
    info: 'Wrap the selection in backticks',
    icon: 'code',
    available: ({ session }) => typeof session?.replaceSelection === 'function',
    enabled: ({ session }) => !!session,
    /** Wrap the current selection as one native edit.
     * @param {object} context Public text session capability.
     * @pre An editable text session is active.
     * @post Selection is wrapped; the buffer becomes dirty and can be undone.
     * @return {void} Nothing.
     * @throws {Error} Session edit failure; Tool invocation reports it.
     */
    execute: ({ session }) => session.replaceSelection('`' + session.getSelection() + '`'),
  });
})();
```

Load the script after `toolbar.js` and before `app.js` starts mounting hosts.
Use the existing `markdown.tools` area to avoid changing a renderer. Current areas
include `workspace.actions`, `workspace.build`, `workspace.source`, `workspace.tabs`,
`latex.tools`, `bibtex.tools`, `pdf.marks`, `pdf.actions`, `text.actions`,
`markdown.tools` and `image.view`. Check the host before assuming an area is mounted.

Every definition needs an ID, nonblank label and `execute(context)`. Use a registered
icon, or `showText: true` for a text control. `info` defaults to the label. Define
`available`, `enabled`, `state` and portable `Ctrl/Cmd+…` shortcuts as needed. State
comes from the current context; do not capture a previous session in a closure.
Register custom icons with `EditorTools.icons.register(name, path)`.

For custom controls, extend `EditorTools.Tool`, supply static label/ID metadata,
and implement `create(context)`, relevant `update(control, context)` and cleanup.
Register the class with `registry.register(area, Type, { views })`. Read the public
contracts in `toolbar.js`; do not access registry maps or another tool's internals.
For an existing button use `Tool.bind` with a concrete action. Avoid an independent
button click handler that bypasses availability, enabled state and error handling.

The host owns `registry.mount(area, context, label)`, calls `refresh(nextContext)`
after capability/state changes, and calls `dispose()` before removing a view.
Registrations affect future mounts; existing mounts are snapshots. Keep tool
registration before startup. No hot-loading guarantee exists.

Use [source-export.js](source-export.js) as a real action example and
[bibliography-tools.js](bibliography-tools.js) for custom controls. Source formatting
commands can use `EditorTools.sourceCommands.register`; inspect `latex-table.js`
and the existing commands in `workspace.js` for their owner capability contract.
Do not read private editor state or bypass the host's save operation.

## Add a file type

The authoritative source is [extensions/filetypes.json](../extensions/filetypes.json).
Follow its [catalog guide](../extensions/README.md). Backend and browser definitions
are no longer maintained separately.

1. Add a versioned catalog entry with unique ID/extensions, label, adapter,
   capabilities and explicit backend permissions. For notes use the existing
   `text` adapter, `text` capability and `editable` permission.
2. Reuse `text.actions` or declare a feature toolbar area. Existing text/source/PDF/
   image adapters are composed in `filetype-adapters.js`. A metadata-only type
   requires no explorer or route changes. Restart the server to reload metadata.
3. A genuinely new editing model needs one authored adapter and explicit composition.
   Provider registration remains available through `FileTypes.registry.register`;
   trusted application catalogs use `registry.install(catalog, adapters)` atomically.
4. Add custom syntax or actions locally. Syntax mode names must exist in loaded
   CodeMirror. JSON remains source text; validation never rewrites numeric spelling.
5. Test backend permissions and frontend resolution/navigation/lifecycle. Cover stale
   revisions, case-insensitive extensions, invalid bytes, traversal and read-only state.

`GET /api/file-types.js` loads normalized metadata before `file-types.js` and
`filetype-adapters.js`. The backend strips permission implementation fields from
public metadata and rejects capability/permission disagreement. The browser rejects
missing adapters and duplicates before publishing any catalog registrations.

`toolbarAreas` describes workspace placement; `standaloneToolbarAreas` can specialize
independent editor placement. `openPdf`, `openSource`, `openText` and
`openSession(factory)` remain host capabilities. New executable behavior still needs
code; metadata cannot invent a new editing model or grant server permission.

## Extend diagnostics or external metadata

Local parsing belongs in a pure module; rendering belongs in the owning feature.
Use `features/bibliography/providers.js` for rules and comparisons, and
`bibliography-diagnostics.js` for shared scheduling/cache/suppression lifecycle. Diagnostics need stable IDs, exact ranges, severity and suppression data.
Backend offsets use Unicode code points; convert at the editor seam. Test astral
characters, repeated keys and native newlines rather than assuming JS string offsets.

Async checks must identify the source snapshot and ignore superseded results.
Handle provider failure separately from a factual mismatch. Preserve local checks
without network and respect the existing OpenAlex settings. Lower-level provider
errors propagate; background tasks and Tool invocation own visible reporting.
The registered provider interface is implemented in
[features/bibliography/providers.js](features/bibliography/providers.js); its
[directory guide](features/bibliography/README.md#register-diagnostic-providers)
explains local and remote contributions.

## Add a backend-backed feature

Keep persistence and validation in a Python feature module, use the existing HTTP
authorization/error path, and document routes in [API.md](../API.md). Inject the
host's authenticated transport into browser behavior. Do not introduce separate
fetch-based save behavior that loses SHA checks, project identity or save guards.
Give long operations a busy state and preserve the current buffer/preview on failure.

## Styling and lifecycle

Use shared theme tokens and scope selectors to the feature root. Verify light/dark
modes, keyboard focus, hover labels and narrow-toolbar overflow. Avoid global CSS
rules that affect unrelated editors. Use ToolInfo for interactive control metadata.
Dispose tool mounts, subscriptions, request controllers, timers, PDF resources and
object URLs. A late response may never render into a different active file.

## Validation

```sh
node tests/test_tool_contract.mjs
node tests/test_toolbars.mjs
node tests/test_toolbar_icons.mjs
node tests/test_filetype_navigation.mjs
node tests/test_media_filetypes.mjs
node tests/test_text_session.mjs
node --experimental-vm-modules tests/test_annotator_lifecycle.mjs
node tests/test_tool_architecture.mjs
```

Run the owning feature's tests too. The original bibliography-link architecture failure is resolved through shared
Tool dispatch. `test_filetype_catalog.mjs` checks catalog/adapter atomicity.
Real-browser checks and backend permission tests are described in
[tests/README.md](../tests/README.md).

### Appearance schemes

`appearance.js` owns browser-local appearance preferences and data-only dark and
light palette registries. One Dark and Catppuccin Latte remain the defaults.
Settings lists palettes for the **resolved active mode**; switching modes rebuilds
that list and restores its remembered selection. Light selections are stored under
`pdf-editor.light-color-scheme`; the existing `pdf-editor.color-scheme` key retains
its dark selection, preserving previous preferences.

Add a registry entry with the same semantic color keys to expose another scheme
in Settings automatically. `WorkbenchAppearance.apply(mode)` resolves
System/Light/Dark, `select(id)` persists a palette for its registered appearance,
and `mount(container)` renders reusable Settings controls. Invalid IDs reset the
active appearance to its default. System changes and browser storage events
refresh the palette, select options and preview. No server or integration request
is needed. Storage denial retains session changes.

Published upstream palettes (retrieved 2026-11-15):

- [Catppuccin](https://catppuccin.com/palette/): Latte, Mocha, Macchiato and Frappé.
- [Dracula](https://draculatheme.com/contribute): Dracula Classic.
- [Nord](https://www.nordtheme.com/docs/colors-and-palettes/): Nord and Nord Light.
- [Tokyo Night](https://github.com/folke/tokyonight.nvim/tree/main/extras/alacritty): Night and Day.
- [Solarized](https://ethanschoonover.com/solarized/): Dark and Light.

These are local semantic adaptations, not runtime dependencies or complete
upstream editor ports. Nord Light uses the official Snow Storm backgrounds with
darker accent shades for legibility. Muted text and some light-mode semantic
colors are adjusted for readable controls and syntax. Optional `build` and
`syntaxYellow` values customize semantic roles without hardcoding one theme's
colors into every light palette. The preview shows the active palette.

`appearance.css` maps editor syntax and controls onto semantic variables and must
load after component styles. Avoid fixed interface colors in new components;
use `--panel`, `--ink`, `--accent`, and the other shared tokens. Annotation colors
and PDF contents retain their document meaning.

Validate with `node tests/test_appearance.mjs` and the shell/navigation tests.
No additional libraries are used.
