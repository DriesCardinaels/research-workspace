# Shared JavaScript test support

`tool-runtime.mjs` exports `withToolRuntime(source)`. It reads production
`static/toolbar.js` plus the same concrete `static/features/*/tools.js` contributions
as index.html, installs them in the test VM only when absent, and aligns
`window`/global Tool bindings with the current classic-script browser startup.
It does not provide a DOM: each test supplies the minimal browser fixture required
by its public behavior.

## Use the helper

```js
import vm from 'node:vm';
import { withToolRuntime } from './support/tool-runtime.mjs';
// fixture must provide the DOM methods exercised by the implementation.
vm.runInNewContext(withToolRuntime(featureSource), fixture);
```

`featureSource` must be the real implementation text; do not substitute a duplicate
implementation. See `../test_tool_contract.mjs` for a public-registry fixture and
related scripts for DOM needs.

## Add support code

Add a helper only when several tests need the same setup. Keep helpers deterministic,
explicitly parameterized and independent of user settings, network and private
module state. Return cleanup operations for listeners, timers and resources. Document
`@param`, `@pre`, `@post`, `@return` and `@throws` for every helper. Keep feature
assertions in the owning test so a fixture cannot manufacture a passing result.

Validate changes by running the consuming scripts and Tool contract tests. When
browser bootstrap migrates to native modules, migrate this helper with callers;
do not keep a second permanent classic-script runtime for tests.


`filetype-runtime.mjs` supplies `withFileTypeCatalog(source)` for tests that load the
core registry. It reads the real `extensions/filetypes.json` and
`static/filetype-adapters.js`, matching HTTP/browser composition. Keep parser or
adapter copies out of test fixtures. `withBuiltInTools(source)` adds production
concrete tools when a fixture explicitly reads core source. Pane fixtures and
`withPaneRuntime` load the actual reusable pane registry.


`browser-runtime.mjs` exports `productionModule(name)` for ordered multi-module
fixtures. It reads real source and applies the same Tool/catalog/model composition
helpers, keeping individual tests free of nested bootstrap conditionals.


`source-buffers.mjs` adopts synthetic source responses through the real collection's
public construction interface. Fixtures supply an authorized native document factory
instead of assigning Workspace map entries or mutating accepted SHA/text metadata.
The resulting adapters exercise production buffer ownership and persistence.
