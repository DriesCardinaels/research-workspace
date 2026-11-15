# Contributing to Research Workbench

The active application is a local Python HTTP server with plain browser JavaScript
and bundled rendering/editor libraries. The launcher uses the Research Workbench name. Historical storage
identifiers remain compatible with existing projects and browser preferences. [README.md](README.md) documents user behavior;
[API.md](API.md) documents HTTP behavior.

## Development setup

1. Use Python 3.10 or newer for the application. Use Node.js 26 or newer for browser
   regression scripts. This analysis was run with Python 3.14.6 and Node.js 26.10.0;
   the minimum versions still need a CI compatibility run.
2. Run `python3 research_workbench.py --no-browser --settings /tmp/research-workbench-dev-settings.json`
   from the repository root. Open `http://127.0.0.1:8766` and use a disposable project.
   The normal application requires no pip or npm install.
3. Optional LaTeX features use Git, `latexmk`, `pdflatex`, and `synctex` on PATH.
   Full API validation also needs `pdftotext`. Do not use confidential manuscripts
   as fixtures. Some validation contacts OpenAlex; see [tools](tools/README.md).


## Choose the extension seam

| Change | Start here | Required checks |
| --- | --- | --- |
| Toolbar action, keyboard action, hover label | [Browser guide](static/README.md#add-a-tool) | Tool contract, toolbar, icon and relevant feature scripts |
| File extension, editor or preview | [File-type guide](static/README.md#add-a-file-type) and `extensions/filetypes.json` | Backend permissions and frontend routing/lifecycle |
| Backend behavior or HTTP route | `research_workbench/application/`, HTTP routes, [API.md](API.md) | HTTP fixture, authorization, stale writes, failure preservation |
| Citation check or metadata integration | `openalex.py`, bibliography modules | Mock network, stale-result handling and suppression |
| Maintenance command | [tools/README.md](tools/README.md) | Isolated input/output and explicit side effects |

The [ownership map](docs/ARCHITECTURE.md) describes implemented seams.
The [implementation status](docs/MIGRATION_STATUS.md) lists completed extractions
and remaining work. Use the public interfaces described by the owning README;
the [migration plan](docs/MODULARITY_MIGRATION.md) also contains future interfaces.
For a catalog-only type using an existing editor, no backend/frontend code changes
are necessary. A new editing model still needs an authored adapter.

## Contracts and encapsulation

Document each added or changed method with a short purpose and `@param`, `@pre`,
`@post`, `@return`, and `@throws` entries. Describe mutation, persistence,
concurrency, cleanup and relevant callers. Mark no-result/no-exception cases
explicitly. Keep mutable state private; return snapshots and expose operations.
Do not make private helpers public simply to support a test or another module.

Pass narrow public capabilities to tools. A text action needs selection operations,
not a workspace's buffers, DOM nodes or revision storage. Route all button and
keyboard activation through the Tool runtime. Supply a nonblank label and useful
hover information; an icon never replaces its accessible name.

Lower-level operations raise meaningful errors. Catch where recovery, rollback,
cleanup, or translation is possible: HTTP requests, Tool invocation, process
transport and background tasks. Preserve causes, retain unsaved buffers and the
last good preview, and report failures once. Avoid catch-and-ignore handlers.

## Validation

From the repository root:

```sh
python3 tools/check.py
python3 -m unittest discover -s tests -v
for test_file in tests/test_*.mjs; do
  node --experimental-vm-modules "$test_file" || exit 1
done
```

The standard runner checks documentation, architecture, Python and all JavaScript
scripts with nonzero failure exits. The normal unittest suite needs loopback sockets. The
in-process runner exercises production HTTP handling without a listening socket;
it does not prove socket transport. The shell loop exits nonzero at the first failed
JavaScript script. See [tests/README.md](tests/README.md) for focused checks and
validation limitations. Do not represent skipped optional checks as passes.

## Pull requests

Explain observable behavior, the public interface affected, validation and
compatibility impact. Keep mechanical moves separate from behavior changes.
Update the owning directory README, API documentation and relevant tests together.
Use temporary directories and synthetic data; never commit local settings, tokens,
research projects, review content or logs. Inspect new files before staging.

## Contribution license and release status

Original contributions submitted for inclusion must be offered under the
[PolyForm Noncommercial License 1.0.0](LICENSE). Submit only material you have the
right to license on those terms. Identify third-party material and preserve its
upstream license and notices. Contributors retain copyright; no copyright
assignment or additional relicensing permission is implied by a submission.

Forks and adaptations for permitted purposes are welcome. Include the license or
its URL, the [required notice](NOTICE) and applicable third-party notices when
redistributing. The [licensing guide](LICENSING.md) explains the noncommercial
restriction and explicit institutional permissions. This is a source-available
release, not an OSI open-source release.

Publication preparation, portable launch configuration, CI and dependency provenance are tracked in
[phase 0](docs/MODULARITY_MIGRATION.md#phase-0--establish-a-reproducible-public-baseline).
