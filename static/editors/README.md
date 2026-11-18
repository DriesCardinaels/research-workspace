# Editor adapters and models

[source](source/README.md) owns native editable source buffers, multi-file projection,
revision-aware persistence and build execution state.
Text/source/PDF host implementations still have their compatible top-level paths;
this directory is populated only when a real responsibility is extracted.

An editor adapter must preserve document identity, independent history, exact
revision saves, failed-navigation protection and disposal. Put pure calculations
in a model and keep IO/native editor details behind its host interface. A model
must not import the shell or query the active editor from global application state.

Add a directory README with every extracted editor owner. Preserve the established
public session operations until callers migrate; verify native CodeMirror undo,
Unicode/CRLF ranges and stale asynchronous work through existing regression tests.

## Line numbers

Enable CodeMirror's `lineNumbers: true` in any source or output editor to use
the shared [gutter stylesheet](line-numbers.css). Keep `CodeMirror-linenumbers`
in the gutter list when supplying custom gutters. This works for read-only output
editors as well as editing surfaces. The shared stylesheet owns color, alignment,
and spacing. For a line with custom typography, set `--editor-number-line-height`
on its CodeMirror line wrapper to align the number with the first visual row.
Apply horizontal text insets to the measured `pre.CodeMirror-line`. Horizontal
padding on `.CodeMirror-lines` shifts the numbers relative to the gutter divider.
