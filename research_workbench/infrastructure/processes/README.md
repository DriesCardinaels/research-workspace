# Bounded process adapters

`git.git(cwd, *args, input=None, check=True)` executes literal arguments with
captured bytes and a 120-second timeout. `git_text` decodes successful output.
`latex.run_latexmk(cwd, main, outdir, jobname)` uses the installed TeX toolchain,
no-shell-escape, a 300-second timeout and a bounded log. `Drafts.latexmk` remains a
compatibility/injection alias for the same implementation.

## Add or replace a process operation

Pass explicit authorized directories and literal argument arrays; do not use a
shell to interpolate document paths. Define the timeout, child-process shutdown,
output limits, cleanup and public error contract. Keep project/index publication
outside the process adapter. Failed compilation must not replace the last good
published PDF, create a version or push a repository.

Use controlled subprocess fixtures for failure/timeout behavior and installed tools
in a separate integration check. `tests/test_drafts.py`, `test_standalone_latex.py`
and `test_source_archive.py` cover current publication callers. The LaTeX timeout
currently uses Unix process-group termination; Windows build support remains a
separate platform task, rather than a claimed guarantee.


`query_synctex(publication, arguments)` in `synctex.py` runs the bounded read-only
mapping process. `application.source_mapping.SourceMapping` validates returned paths
against the authorized source root and uses an injected source-file validator/query.
Alternative mapping implementations can supply that query capability without
modifying the application or editor. `desktop.choose_folder()` owns native picker
execution; unsupported platforms retain typed-path entry.
