# Markdown and README authoring

All `.md` and `.markdown` files use the catalog's independent text adapter, including
case-insensitive README filenames. The dedicated `markdown.tools` and `markdown.extra` areas supply
headings, emphasis, strikeout, links, screenshots, linked badges, inline/fenced
code, quotes, bullet/number/task lists, tables, details/summary, horizontal rules
and a generated table of contents. These cover the recurring structures in
[the README examples](../../../docs/README_RESEARCH.md).

Controls use shared icons, hover labels, accessible names and Tool dispatch.
The heading picker offers H1–H6 and Paragraph. It transforms the cursor line or
complete selected lines, replacing existing ATX heading markers, with native undo
and CRLF preservation. `TextSession.transformLines(transform)` supplies this block
formatting boundary without exposing the native document. Numbered and bulleted
lists are both directly available. Heading levels, bullet/number/task lists, images,
badges, code blocks, contents and collapsible sections use distinct semantic icons
registered by the Markdown feature through the shared icon catalog.
Common formatting actions remain in the source toolbar; less frequent
insertions live in the More Markdown tools popover, mounted from `markdown.extra`.
It supports Escape, outside dismissal, current-session refresh and disposal.
Bold, italic and link have Ctrl/Cmd+B, I and K shortcuts. Save and native undo/redo
remain in `text.actions`. Inserted placeholders are ordinary editable Markdown;
no badge status, repository URL, screenshot or license is inferred as fact.

## Public contracts

`TextPreviews.register(filetypeId, factory)` composes one trusted preview factory
per catalog ID. The host calls the factory with `{file, imageURL(path),
openFile(path)}` and expects `{element, update(text), dispose(), label?}`. The optional
label names the right pane. The host supplies
the current unsaved text; providers must not access native documents, save buffers
or issue their own authenticated requests. Relative resource routes retain the
same project and source-document authorization. Factories own their DOM/listeners.
Disposal happens before file switching and when the host is destroyed.

`TextWorkspace.setPreviewMode('edit'|'split'|'preview')` retains the native buffer,
history and per-file layout. The document header labels these modes **Source**,
**Both** and **Preview**, following the LaTeX editor's layout switch. Both is the
initial Markdown view. The left column owns file tabs, formatting and raw source;
the right column owns its preview heading and rendered document. The workspace
fills the viewer height. A divider keeps the panes side by side and supports
pointer dragging, ArrowLeft/ArrowRight and Home (reset). `setSplitRatio(ratio)`
confines the source fraction to 25–75% without touching buffers.
Toolbar context exposes `previewMode` and `setPreviewMode(mode)`.
Editing tools are disabled in Preview. Other filetypes retain their text editor.
Preview refreshes only when source text changes and preserves its scroll offset.
`mount({headerSlot})` moves the layout switch into the existing document header;
without a slot it stays at the top of the editor. Disposal removes moved controls
and their bindings, and switching to plain text hides the switch.

`MarkdownPreview.contents(text)` returns a navigation snippet for parsed headings,
ignoring fenced examples and suffixing duplicate anchors.
`MarkdownPreview.relativePath(file, resource)` resolves within the selected source
root, rejecting traversal, malformed encoding, absolute paths and backslashes.
Add actions in `tools.js` through the public Tool registry and session
`getText/getSelection/replaceSelection` methods. New operations must preserve
native newline conventions and remain one undoable edit.

## Rendering and limits

Bundled Marked **15.0.12** parses GFM. Bundled DOMPurify **3.4.18** sanitizes its
output before DOM insertion; scripts, event handlers, forms, frames, styles,
embedded media, SVG markup and author-supplied IDs/names are excluded. Generated
heading IDs support contents links. HTTPS/HTTP images and badges may load remotely;
relative PNG/JPEG images use the existing authorized image route. Other local image
formats retain the backend's existing restrictions. Local document links open
through the text host; unsupported file types produce the normal visible error.
External links open separately with `noopener noreferrer`.

This is a local GitHub-style approximation, not GitHub's rendering service.
GitHub-specific alerts, Mermaid, math, automatic repository issue/user references,
syntax coloring and custom raw-HTML anchors are not implemented. Code remains
readable as escaped text. No GitHub token, network render request or CDN is needed.

Load `text-editor.js`, the two vendor scripts, `preview.js`, then `tools.js` before
application startup. Load `preview.css` for scoped typography and layout.
Validate with `node tests/test_markdown.mjs` and the real DOM fixture
`tests/markdown-browser.html`, plus text-session/navigation and vendor checks.
The fixture also runs in jsdom **26.1.0** using
`node tests/run_markdown_dom.mjs /path/to/jsdom/lib/api.js`. jsdom is an optional
development dependency, not shipped with the application. It checks parser output,
sanitization, native editing, modes, navigation, conflicts and disposal; viewport
geometry and appearance still require a graphical browser.
