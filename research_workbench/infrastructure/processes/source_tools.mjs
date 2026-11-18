/* Headless adapter for trusted, bundled toolbar implementations. No request is executable code. */
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const root = new URL('../../../', import.meta.url);
const actions = new Map(), commands = new Map();
class Tool {}
const registry = {
  /** Collect action definitions without creating controls. Pre: trusted module.
   * Post: detached definitions retained. Returns registry. Throws on duplicate IDs.
   */
  contribute(area, definition) {
    if (actions.has(definition.id)) throw new Error('Duplicate toolbar action');
    actions.set(definition.id, definition); return this;
  },
  /** Ignore UI-only classes. Pre: trusted registration. Post: no DOM. Returns registry; never throws. */
  register() { return this; },
  /** Skip presentation-only groups. Child actions register independently through contribute(). */
  contributeGroup() { return this; },
};
const window = {DraftMatch: {}, SourceText: {}, BibliographyCitations: {}, SourceProjection: {},
  TextPreviews: {register() {}}, EditorTools: {Tool, ControlTool: Tool, registry,
    icons: {markup() { return ''; }, register() {}},
    sourceCommands: {register(command) { commands.set('source.' + command.id, command); }}}};
const context = vm.createContext({window, console: {log() {}}, AbortController});
/** Load only installation-owned scripts. Pre: fixed relative path.
 * Post: definitions registered in isolated context. Returns nothing. Throws IO/JS errors.
 */
function load(path) { vm.runInContext(readFileSync(new URL(path, root), 'utf8'), context, {filename: path, timeout: 2000}); }
for (const path of ['static/vendor/marked/marked.min.js', 'static/workspace.js', 'static/latex-table.js',
  'static/source-formatting.js', 'static/bibtex-sorting.js', 'static/features/markdown/preview.js',
  'static/features/markdown/tools.js', 'static/json-filetype.js']) {
  // JSON's mode registration is inert here; validation below uses the JS JSON parser.
  context.CodeMirror = {defineMode() {}};
  load(path);
  if (context.marked) window.marked = context.marked;
}

const request = JSON.parse(readFileSync(0, 'utf8'));
try {
  if (request.kind === 'catalog') {
    process.stdout.write(JSON.stringify({actions: [
      ...[...actions.values()].filter(item => item.id.startsWith('markdown.') || item.id === 'bibliography.sort-entries' || item.id === 'json.validate')
        .map(item => ({id: item.id, label: item.label})),
      ...[...commands].map(([id, command]) => ({id, label: command.name})),
      {id: 'source.format-file', label: 'Format BibTeX file'},
    ]}));
  } else {
    let text = request.text;
    const {action, options = {}} = request.command;
    const from = [...text].slice(0, request.start).join('').length;
    const to = [...text].slice(0, request.end).join('').length;
    let headings;
    /** Apply a native replacement. Pre: valid edit. Post: in-memory source updated.
     * Returns nothing. Throws on malformed trusted edits. Related: Workspace/LaTeX table.
     */
    const apply = edit => { text = text.slice(0, edit.from) + edit.insert + text.slice(edit.to); };
    if (action === 'source.table') apply(window.LatexTable.edit(text, from, to, options));
    else if (action === 'source.comment') apply(window.Workspace.commentEdit(text, from, to));
    else if (commands.has(action)) apply(window.Workspace.formatEdit(text, from, to, action.slice(7)));
    else if (action === 'source.format-file') text = window.SourceFormatting.BibtexFormatter.format(text);
    else if (action === 'bibliography.sort-entries') text = window.BibtexSorting.sort(text);
    else if (action === 'json.validate') JSON.parse(text);
    else if (action === 'markdown.contents') {
      // The Python HTML text reader replaces the browser sanitizer's textContent operation.
      headings = window.marked.lexer(text).filter(token => token.type === 'heading')
        .map(token => ({depth: token.depth, html: window.marked.parseInline(token.text)}));
    } else if (actions.has(action)) {
      const session = {
        getSelection: () => text.slice(from, to), getText: () => text,
        replaceSelection: insert => { text = text.slice(0, from) + insert + text.slice(to); },
        /** Transform complete selected lines using the browser's selection convention.
         * Pre: valid selection. Post: one in-memory edit. Returns nothing; propagates transform errors.
         */
        transformLines(transform) {
          const start = text.lastIndexOf('\n', from - 1) + 1;
          const probe = to > from && text[to - 1] === '\n' ? to - 1 : to;
          let end = text.indexOf('\n', probe); if (end < 0) end = text.length;
          if (text[end - 1] === '\r') end--;
          const insert = text.slice(start, end).split(/(\r\n|\n)/).map((line, index) => index % 2 ? line : transform(line)).join('');
          text = text.slice(0, start) + insert + text.slice(end);
        },
      };
      actions.get(action).execute({session});
    } else throw new Error('Unknown toolbar action');
    process.stdout.write(JSON.stringify({text, headings}));
  }
} catch (error) {
  process.stdout.write(JSON.stringify({error: error.message}));
}
