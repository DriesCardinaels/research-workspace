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


## Project files and PDF source locations

Use **Add project file** at the cursor or after a selection. The picker loads all
file leaves from the current project tree. Links can point to multiple PDFs, notes,
READMEs or other project files. Path links use `#project-file?path=...` and include
`source_document` for linked source roots. Managed PDFs use `document` with the
exact revision ID. Files open by their registered handler, with PDFs reusing the
note's side pane and unsupported types revealed in Finder on macOS. Use Raw Markdown
to update a path link after renaming or moving its target.

Select a quote and use **Link quote to PDF page**. Choose any project PDF, including files
inside folders and linked sources. Enter its physical PDF page (cover = page 1),
or leave the page blank to search for the selected quote. Search normalizes case,
accents, punctuation, ligatures, whitespace, and line hyphenation. It requires at
least twelve letters/digits. Repeated matches are listed so the user can enter
the intended page; missing/scanned text needs a manual page. Manual pages are
checked against the PDF page count. No OCR or external service is used.

A source persists as an ordinary Markdown link, labeled `Source p. 12`, targeting
`/api/projects/PROJECT_ID/documents/REVISION_ID/original#page=12`.
The formatted note displays a keyboard-accessible link. It opens the existing
read-only PDF viewer beside the note, preserving its buffer, selection and undo.
Linked notes open in Both mode by default. Notes/Both/PDF controls share the
resizable workspace used by README and TeX previews.
PDF revisions remain fixed even when the source file gains a newer version.
Choose a source color to underline the quote and highlight the matching PDF passage.
Place the cursor on a linked quote and use **Quote underline color** to change both.
Color and optional verbatim matching text persist in the link fragment as
`&color=89b4fa&match=URL_ENCODED_PASSAGE`. Legacy page-only links remain supported.
For paraphrases, supply the actual PDF passage in the quote-link dialog. Missing or repeated
passages show a warning rather than marking guessed text.

PDF marks are note-owned overlays rebuilt from saved source links, alongside existing
PDF review marks. They do not modify original PDF bytes or stored review annotations.
Unsaved source color edits update the overlay immediately; save the note to retain them.

An optional comment stores the source link inside the existing encoded annotation;
**View comments** renders those links as clickable sources while keeping other
comment content literal. Raw Markdown exposes the complete link for editing or
removal. Source creation and removal use native undo and explicit saving.

`sources.js` owns safe local-link parsing, quote normalization/search, reference
ranges, color serialization and comment rendering. `pdf-preview.js` owns matched
quote geometry and the PDF preview lifecycle. Load both between `annotations.js`
and `editor.js`. The text presentation receives a third, optional host context argument;
the application supplies `listProjectSources`, `openProjectSource`, and
`pdfSourceColors` capabilities.
No new dependencies: bundled PDF.js **6.1.200**, Marked **15.0.12**, and
CodeMirror **5.65.16**. Tests: `node tests/test_notes.mjs` and
`node --experimental-vm-modules tests/test_note_sources.mjs`, and
`node tests/test_note_pdf_preview.mjs`.

## HTTP toolbar counterparts

`GET /api/note-tools` describes every toolbar action. `GET P/note-file` reads source
and annotations; `POST P/note-file/actions` applies atomic SHA-checked edits, with
optional dry-run and inverse snapshots. Content behavior lives in
`research_workbench/domain/note_tools.py`; IO in `application/note_files.py`.
`tests/test_notes.mjs` checks that every registered note/shared-text toolbar action
appears in the API catalog and compares representative native edits against the
Python implementation. Add both paths and parity cases when extending a toolbar.
API ranges use Unicode code points, unlike native CodeMirror's UTF-16 indices.
API calls edit saved files; the browser retains unsaved buffers and local history.
PDF quote search is available through `P/note-sources/locate`; explicit PDF links
and optional comment storage use `notes.pdfSource`. See `/API.md` and `/llms.txt`.


Linked sources distinguish `kind=quote` (default) from `kind=context`. Context-only
links label a paraphrase or related discussion; they navigate to the PDF page but
do not draw a verbatim-quote highlight. `notes.pdfSource` accepts `options.kind`;
recoloring preserves it. The counter groups source passages by note quote, so a
quote with a continuation page is counted once. Linked quotes use dotted
underlines regardless of whether they also have a comment.
