# PDF Tool contributions

`tools.js` supplies navigation, annotation modes, undo/redo, notes, copying and
export. It uses public annotator operations: `getToolbarState`,
`runToolbarCommand`, `getToolbarControl`, `setTool`, `undo`, `redo`, `toggleNotes`,
`copyToolbarComments` and `exportPdf`.

Add an action in `pdf.actions` or a mode in `pdf.marks` through the public registry.
Define availability for archived versions, bare previews and source-only views;
read-only presentation must never imply editable annotations. Reuse an existing
public operation or add an intentional one on the annotator. Do not access page,
worker, history or annotation storage directly from a Tool. Export and copy errors
reach the owner's shared recovery operation.

Mounts refresh current state without replacing controls and must be disposed with
the PDF view. Verify `test_toolbars.mjs`, `test_tool_contract.mjs`,
`test_annotator_lifecycle.mjs`, `test_strikethrough.mjs` and relevant copy/export
checks. PDF rendering itself still lives in `static/annotator.js`.
