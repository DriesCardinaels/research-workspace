# Browser core source operations

`source-text.js` exposes immutable `SourceText` operations for comment blanking,
display-newline normalization and native/display offsets. These helpers use UTF-16
editor coordinates; backend API offsets remain Unicode code points and are converted
at their existing editor seam. No DOM, network or persistence is owned here.

Add shared pure source behavior only when multiple real callers need it. Take
explicit strings/positions, return values and document newline/coordinate units.
Keep parser-specific rules in the owning feature. Do not import a feature, shell,
CodeMirror buffer or mutable workspace object into this core.

Load core before citation/projection modules and before Workspace. Existing
`toolbar.js`/`file-types.js` remain at their compatible paths; concrete Tool actions
are already separated into `features/`. Their further physical relocation is not a
reason to introduce a second registry implementation.

Run the source format, citation and combined-source tests. Use the same production
model modules in fixtures through `tests/support/tool-runtime.mjs`.
