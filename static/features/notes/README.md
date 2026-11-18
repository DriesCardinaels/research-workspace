# Plain-text notes

`.txt` files open as an editable note, using CodeMirror **5.65.16** already bundled
with the app. No additional dependencies. Notes store ordinary UTF-8 Markdown:
headings (`#` through `######`), bold, italic, strikeout, inline code, `==highlight==`,
bulleted/numbered/task lists, and `>` block quotes. Quotation marks are literal text.
The toolbar supplies each operation with an accessible name and hover label.
**Headings** groups Title, Heading, and Subheading. **Lists** groups bullets,
numbered lists, and checklists. Inline quotation uses quotation marks as its
icon. Block quote uses indented lines beside a vertical rule.
Enter continues a list, resets a continued task to unchecked, and increments a
numbered list. Enter on an empty list/quote line exits the block.

Formatting is applied directly to the editable document; markers are hidden on
all lines, including cursor/selected lines. Hidden ranges are atomic so keyboard
navigation skips metadata. Fenced code remains literal.
Raw Markdown toggles typography and marker visibility without changing the text.
Save, undo, redo, conflicts, and CRLF use the existing TextSession implementation.
Saving is explicit through Save or Ctrl/Cmd+S. Both note modes use CodeMirror's
native gutter, with one number per source line, including blank and wrapped lines.

`TextEditorViews.register(id, factory)` attaches a filetype-owned presentation to
the text host. Factories receive `(editor, retainedMode)` and return a controller
with `mode`, `setMode(mode)`, and `dispose()`. This is a trusted editor adapter
boundary: Tools receive only the controller and public session. The host disposes
before swapping buffers and retains the per-file presentation mode. Presentations
must remove their own marks/listeners and restore native editor options.

`NoteEditor.describeLine(text)` is a pure style calculation. Add note syntax here
and corresponding styles in `editor.css`; add formatting contributions to
`notes.tools`. Markdown preview rendering is independent: `==…==` is a notes
extension, not standard GitHub Markdown. Plain-text readers display the markers.
The editor does not convert notes to HTML or a proprietary format.


## Highlights and comments

The marker button toggles a highlight using the selected color. The palette button
opens eight pastel defaults (yellow, peach, pink, lavender, blue, sky, mint, green)
and a native RGB color picker. Applying the picker recolors a selected highlight;
with no selection it sets the current view's next highlight color. Text contrast
is chosen for the selected RGB background. Colored spans persist as
`=={#f9e2af}text==`. Ordinary `==text==` uses the default pastel yellow.

Select text and use Add comment (Ctrl/Cmd+Alt+M). Comments are indicated by a dotted
underline and a text-only hover tooltip. View comments opens a review dialog with
edit/remove actions. Comments accept paragraphs, are escaped as data, and persist
inline as `<!--note-comment:URI_ENCODED_TEXT-->selected text<!--/note-comment-->`.
Multi-line selections store one annotation per selected nonempty line. Comment
changes preserve native undo and verified UTF-16 ranges reject stale edits.
Raw Markdown exposes all metadata for direct editing. No sidecar files are needed.
These annotations and colored highlights are note extensions, not standard Markdown.

Load `annotations.js`, `editor.js`, then `tools.js` after the shared pane and Tool
modules, before app startup. The generic pane form supports `type: 'textarea'` for
multiline comment input. Outstanding note dialogs close on file switch/disposal.
Regression coverage: `node tests/test_notes.mjs` and
`node tests/run_markdown_dom.mjs /path/to/jsdom/lib/api.js`.


## Composed formatting and line measurement

The note view uses bundled Marked **15.0.12** inline tokens for nested bold, italic,
and strikethrough, plus a local highlight token extension. It never changes the
global README parser. Token offsets map to overlapping native style marks; every
nested delimiter stays hidden. Inline code is literal, while surrounding emphasis
can still apply. Inline toolbar toggles remove only the requested style layer.

Heading typography is applied through CodeMirror's `addLineClass(..., 'text', ...)`
to the measured `pre.CodeMirror-line`. Heading selectors override native pre styles.
Do not add vertical margins to line wrappers: those sit outside CodeMirror's text
measurement and misalign cursor/selection overlays. Use measured font size and line
height for heading spacing. The DOM regression checks native class composition,
heading text-class placement, and zero margins. Actual pixel geometry requires a
browser with a layout engine; jsdom supplies only fixed editor viewport dimensions.


Lists use a hanging indent on the measured text element. The note view handles
CodeMirror's `renderLine` event and measures the full visible prefix in the current
font, including leading indentation, multi-digit numbers, whitespace and checkboxes.
Tabs expand to the editor's configured tab stops. First-line `text-indent` offsets
the added left padding, so markers stay at the original position while continuation
lines align under the item text. The event reads `lineInfo(...).textClass` because
CodeMirror copies that class to the rendered element after dispatching `renderLine`.
Temporary measurement spans are removed immediately; source mode and disposal remove
all contributed list presentation. No spaces or newlines are inserted into notes.
