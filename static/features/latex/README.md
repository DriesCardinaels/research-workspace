# Source and LaTeX Tool contributions

`tools.js` supplies workspace comment/change controls, compile placement, formatting,
source commenting and bibliography reference visibility. Core owns placement and
lifecycle; these contributions use public `getToolbarControl(id)`,
`isLatexSource()` and `isBibliographySource()` owner operations.

To add a source action, use `EditorTools.registry.contribute` in the relevant
`workspace.source`, `workspace.build`, `latex.tools` or `bibtex.tools` area.
Use the narrow editor/session capability when available; add a public semantic
owner operation rather than exposing a CodeMirror buffer or DOM internals. Custom
controls extend `Tool`/`ControlTool`, declare labels and supply refresh/disposal
where needed. Register before mounting.

`source-formatting.js`, `latex-table.js` and source build/session code remain at
existing paths during migration. A directory move is not a prerequisite to an
independent contribution. Run `test_toolbars.mjs`, `test_toolbar_icons.mjs`,
`test_latex_table.mjs`, `test_compile_menu.mjs` and the relevant source tests.
