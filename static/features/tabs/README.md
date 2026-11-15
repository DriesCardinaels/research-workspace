# Tab Tool contributions

`tools.js` contributes close/close-others/close-right/close-saved/close-unpinned/
close-all and pin actions to `workspace.tabs`. `TabCloseTool` remains an exported
base in the core for compatibility; concrete tab actions are owned here.

Add a closing policy by extending `EditorTools.TabCloseTool`, setting a label and
`select(owner, file)` operation, then registering the class. Use only public tab
operations: `getOpenTabs`, `isTabPinned`, `isTabSaved`, `closeTabs` and
`setTabPinned`. `closeTabs` owns unsaved-buffer confirmation, save failure and
batch behavior; an action must not remove tabs or buffers itself.

Keep selected-file context separate from active-file identity. Protect pinned tabs
unless an explicit action declares otherwise. Test current context, failed-save
preservation, cancellation, pin state and menu disposal with
`tests/test_workspace_tabs.mjs` and the shared Tool contract suite.
