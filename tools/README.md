# Maintenance and validation commands

These are developer commands, not toolbar tools. Browser actions use
[the Tool registry](../static/README.md#add-a-tool). Python application code must
not import a maintenance command to perform runtime work.

| Command | Purpose | Dependencies and effects |
| --- | --- | --- |
| `python3 tools/check.py` | Run docs, architecture, Python and all JS checks | Standard library, Node.js 26+; `--integration` adds loopback tests |
| `uv run --no-project python tools/build_macos_app.py` | Build optional native macOS app with offline Launch Server controls | Swift/AppKit/WebKit, Python 3.10+, codesign; creates an absent output bundle, never installs/overwrites an app; [options and lifecycle](../native/macos/README.md) |
| `python3 tools/validate_api.py` | Full HTTP workflow validation | Git, TeX, SyncTeX, `pdftotext`, loopback sockets; creates isolated output, local commits and local bare-repository pushes; attempts live OpenAlex metadata |
| `uv run --with pillow python tools/make_icons.py` | Generate historical application icons | Optional Pillow, currently unpinned; writes `static/icons/`; not needed to run the app |
| `python3 tools/split_hallmark_repositories.py` | Historical research repository split | Project/account-specific paths; default inspection, `--apply` creates checkouts, `--push` publishes via GitHub CLI; not a general setup command |

The app currently has no manifest icons. Do not regenerate icons as part of normal
feature work. The historical repository splitter must be parameterized or moved
out of the public tool set before being advertised to external contributors.

## Run API validation

```sh
python3 tools/validate_api.py --output /tmp/research-workbench-api-validation
```

Choose an absent output path. The default is a timestamped directory under
`work/api-validation/`. The validator uses synthetic projects and retains evidence;
request bodies and credentials are not logged. It deliberately performs expensive
builds and a live provider attempt; it is separate from offline unit tests. See
[tests/README.md](../tests/README.md) for deterministic checks.

## Add a maintenance command

1. Add a descriptive Python script with a `main` entry point and `argparse` options.
   Take input/output/account paths as arguments; do not embed personal paths.
2. Put reusable runtime behavior in its owning application module. Keep the command
   focused on orchestration through public interfaces.
3. Document dependencies, supported versions, defaults, outputs and side effects
   here and in `--help`. Pin optional packages before making them required tooling.
4. For destructive/publication behavior, expose an inspection/default dry run and
   an explicit apply/publish action. Avoid mutating user repositories during tests.
5. Give every method a purpose, parameter, pre/postcondition, result and exception
   contract. Use literal subprocess arguments, bounded execution and cleanup.
6. Test real input/output in temporary directories and failure preservation at the
   relevant seam. Never include real credentials or live publication in a test.

Use `python3 tools/check.py --help` for focused check selection.
