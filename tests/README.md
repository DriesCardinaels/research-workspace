# Regression tests and extension contracts

Tests exercise public behavior with synthetic PDFs, sources and temporary projects.
Do not add real manuscripts, personal settings, credentials or research-project paths.
Application runtime dependencies remain separate from optional test tools.

## Run the suites

From the repository root, Python 3.10+ and Node.js 26+:

```sh
RESEARCH_WORKBENCH_ROOT="$PWD" python3 tests/run_inprocess.py
python3 -m unittest discover -s tests -v
for test_file in tests/test_*.mjs; do
  node --experimental-vm-modules "$test_file" || exit 1
done
```

`run_inprocess.py` replaces the socket fixture while using production Handler,
authorization and serialization. Normal unittest discovery includes socket tests;
it is a separate transport check. Node VM module tests need `--experimental-vm-modules`.
No npm install is required. Node.js 26 is the validated JavaScript test baseline.
The bundled PDF.js 6.1.200 uses modern JavaScript built-ins, including `Promise.try`;
Node.js 22 does not provide the required runtime. This affects development checks,
not the Python requirement for running the application.

Some Python and JavaScript tests use installed Git/TeX tools. Real build validation
needs `git`, `latexmk`, `pdflatex` and `synctex`; `tools/validate_api.py` also uses
`pdftotext` and attempts a live OpenAlex lookup. Inspect skip output and distinguish
optional omissions from successful tests. Do not run external-network validation
as part of a deterministic unit test.

## Add a Python feature test

1. Name the module `test_<feature>.py` and use `unittest.TestCase`.
2. For route tests reuse `http_fixture.setup`, `http_fixture.teardown` and
   `http_fixture.request`; see `test_file_handlers.py`. Use temporary storage and
   production route handling. For pure parsing/rules call the public function directly.
3. Test observable success plus meaningful invariants: forbidden path, missing token,
   malformed payload, stale revision, read-only version, failure preserving old data.
4. Inject or patch the external seam (process, provider or storage publication),
   not private algorithm details. New code should accept dependencies explicitly.
5. Include method contracts on added test helpers. Always clean up servers,
   subprocesses and temporary directories, including failure paths.

## Add a JavaScript contribution test

1. Name the script `test_<feature>.mjs` and use `node:assert/strict`.
2. Load the real implementation in a minimal VM/DOM fixture, or import the public
   module when native modules are introduced. [support/README.md](support/README.md)
   explains the current Tool runtime helper. Avoid testing a rewritten copy.
3. Contribute a fixture action/provider through its public registry. Verify mounting,
   current context, state/shortcuts, action output and disposal through public methods.
4. Cover save-before-navigation, failed save, edits while saving or stale asynchronous
   results when the feature crosses those seams. Keep ordinary reversible UI changes
   free of brittle implementation-mirroring tests.
5. Print a concise success result and exit nonzero on assertion failure. Use
   `--experimental-vm-modules` if SourceTextModule is involved.

## Coverage map

| Seam | Representative tests |
| --- | --- |
| Tool contract and concrete controls | `test_tool_contract.mjs`, `test_toolbars.mjs`, `test_toolbar_icons.mjs` |
| File permissions and identity | `test_file_handlers.py`, `test_image_json_files.py`, `test_filetype_navigation.mjs` |
| Explorer create/move/rename/trash/reveal | `test_project_entries.py`, `test_entry_manipulation.py`, `test_explorer.mjs` |
| Private buffer/review ownership and tabs | `test_source_buffers.mjs`, `test_review_modules.mjs`, `test_comment_copy.mjs` |
| Source sessions and navigation | `test_text_session.mjs`, `test_workspace_tabs.mjs`, `test_project_navigation.mjs` |
| PDF lifecycle and concurrent review | `test_annotator_lifecycle.mjs`, `test_markup_sync.mjs`, `test_markup.py` |
| Builds and exports | `test_drafts.py`, `test_standalone_latex.py`, `test_source_archive.py` |
| Citation completion lifecycle | `test_citation_search.mjs`: independent controller, linked buffers, navigation, positioning, dismissal and disposal |
| Bibliography | `test_openalex.py`, `test_bibliography_diagnostics.mjs`, `test_bibliography_links.mjs` |

## Real-browser smoke page

`markdown-browser.html` checks the README toolbar, GFM rendering, unsafe HTML,
relative images/links, native undo, shortcuts, view switching, saves and disposal.
Serve the checkout root and open `/tests/markdown-browser.html`. It also runs under
optional jsdom **26.1.0** with `node tests/run_markdown_dom.mjs /path/to/jsdom/lib/api.js`.
The DOM runner supplies CodeMirror measurement stubs and cannot validate viewport
layout or visual fidelity. `test_markdown.mjs` needs only the usual Node runtime.

`modularity-browser.html` exercises real DOM/editor behavior and cleanup. The server
serves assets under `static/`; temporarily copy the fixture there, open
`http://127.0.0.1:8766/static/modularity-browser.html`, verify `ALL CHECKS PASSED`,
and remove the temporary copy afterward. Use disposable development settings/project
storage. This smoke page is not a replacement for focus/keyboard, theme and PDF
interaction checks in the actual application.

## Migration checks

`test_modular_contracts.py` tests catalog-only file support, HTTP registration,
index snapshot isolation and redacted unexpected failures.
`test_api_source_editing.py` verifies client guides, source creation/editing, stale-write
preservation, authentication and the renamed launcher.
`test_filetype_catalog.mjs` tests independently declared types, aliases, adapter
resolution and atomic frontend registration. `tools/check.py` runs all scripts and
checks documentation/dependency direction; `--integration` exercises real sockets.

See [implementation status](../docs/MIGRATION_STATUS.md) for platform and packaging limits.
