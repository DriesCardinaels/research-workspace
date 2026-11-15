# Browser feature contributions

Concrete built-in Tool definitions live beside their feature rather than inside
`toolbar.js`. [LaTeX](latex/README.md), [PDF](pdf/README.md) and
[tabs](tabs/README.md) each register through the same public Tool registry.

Add a feature directory with its implementation and README. Load core before
contributions, then load contributions before app startup mounts hosts. Register
in an existing toolbar area to avoid renderer changes. Give actions stable IDs,
labels, current capability inputs and cleanup; use the shared dispatcher for
pointer/menu/keyboard activation. Do not read another feature's private storage.

`index.html` remains an explicit ordered composition point. There is no arbitrary
third-party code discovery or hot registration guarantee. The test helper composes
the same production built-ins; it does not maintain alternative implementations.
Review state/cards and registered tabs live in [review](review/README.md).
See the [browser extension guide](../README.md).
[Markdown](markdown/README.md) owns README authoring Tools and sanitized local previews.
