import {adoptBuffer} from './support/source-buffers.mjs';
import {withBuiltInTools} from './support/tool-runtime.mjs';
import {withToolRuntime} from './support/tool-runtime.mjs';
// Formatting exercises the bundled CodeMirror 5.65.16 Doc, history and save boundary.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const element = () => ({
  attrs: {}, children: [], style: {}, classList: { toggle() {} },
  setAttribute(key, value) { this.attrs[key] = value; this[key] = value; },
  append(...children) { this.children.push(...children); },
  appendChild(child) { this.children.push(child); return child; },
  replaceChildren(...children) { this.children = children; },
  addEventListener(name, handler) { this['on' + name] = handler; }, cloneNode() { return element(); },
});
const document = { createElement: element, createTextNode: (text) => ({ textContent: text }), documentElement: {}, body: element(), addEventListener() {} };
const window = { DraftMatch: {}, document, addEventListener() {} };
const preferences = new Map();
const localStorage = { getItem: (key) => preferences.get(key) ?? null, setItem: (key, value) => preferences.set(key, value) };
const context = vm.createContext({ window, localStorage, document, navigator: { userAgent: '', platform: '' }, setTimeout, clearTimeout });
vm.runInContext(readFileSync(new URL('../static/vendor/codemirror/codemirror.min.js', import.meta.url), 'utf8'), context);
vm.runInContext(withBuiltInTools(readFileSync(new URL('../static/toolbar.js', import.meta.url), 'utf8')), context);
vm.runInContext(withToolRuntime(readFileSync(new URL('../static/workspace.js', import.meta.url), 'utf8')), context);
vm.runInContext(readFileSync(new URL('../static/source-formatting.js', import.meta.url), 'utf8'), context);
const { CodeMirror } = context;
const { Workspace } = window;

const { BibtexFormatter, SourceFormatterRegistry, formatters } = window.SourceFormatting;
const input = '@article{Key,title={A {Nested, Title}},author="Doe, Jane",year=2026}';
const expected = '@article{Key,\n  title  = {A {Nested, Title}},\n  author = "Doe, Jane",\n  year   = 2026\n}';
assert.equal(BibtexFormatter.format(input), expected);
const cluttered = '@article{clean,\n  ABSTRACT = {Long {nested, text} with "quotes"},\n  title = {  A   useful\n\n title  },\n  eprint = {\n\n    https://doi.org/10.1177/0018720816644364\n\n  },\n  year = 2026,\n}';
const cleaned = '@article{clean,\n  title  = {A useful title},\n  eprint = {https://doi.org/10.1177/0018720816644364},\n  year   = 2026,\n}';
assert.equal(BibtexFormatter.format(cluttered), cleaned, 'abstracts and whitespace padding are removed');
assert.equal(BibtexFormatter.format(cleaned), cleaned, 'cleanup is idempotent');
assert.equal(BibtexFormatter.format('@misc{only,abstract="Text, with commas"}'), '@misc{only,}');
assert.equal(BibtexFormatter.format('@misc{first,abstract={One},title={Text},abstract={Two}}'), '@misc{first,\n  title = {Text}\n}');
assert.equal(BibtexFormatter.format('@string{abstract = "Keep me"}'), '@string{abstract = "Keep me"}');
assert.equal(BibtexFormatter.format('@misc{comments,\n% keep comment\nabstract={Remove me},\ntitle={Text}}'), '@misc{comments,\n% keep comment\n\ntitle={Text}}');
assert.equal(BibtexFormatter.format(String.raw`@misc{escaped,note={Keep\  this\ }}`), String.raw`@misc{escaped,
  note = {Keep\  this\ }
}`, 'escaped spaces stay literal');
for (const source of [
  input,
  '@book(k, title="A {nested \"quote\"}", month=jan # " and " # feb,)',
  String.raw`@misc{unicode, title={É 😀 \{literal\} and \"o}, note={a
    multiline value,  with spaces}, url={https://example.test/a%20b}}`,
  '% @article{ignored, broken\n' + input + '\n% between entries\n@book{two,title={Second}}',
  '@string{j = "Journal"}\n@preamble{"Prefix" # j}\n@comment{Keep "literal" text}\n' + input,
  '@article{a, % retain comment\n title={Text}, year=2020}',
  '@misc{empty}\n@misc{fields,}\n' + input,
  input.replaceAll('}', '}').replaceAll(',', ',\r\n'),
]) {
  const formatted = BibtexFormatter.format(source);
  assert.equal(formatted.replace(/\s/g, ''), source.replace(/\s/g, ''), 'non-whitespace content is invariant');
  assert.equal(BibtexFormatter.format(formatted), formatted, 'formatting is idempotent');
}
assert.equal(BibtexFormatter.format(input+'\n'+input), expected+'\n\n'+expected);
assert.ok(!BibtexFormatter.format(input+'\r\n').replaceAll('\r\n', '').includes('\n'), 'CRLF is preserved');
for (const malformed of ['@article{k,title={unfinished}', '@book(k,title="unfinished)', input+'\n@book{k']) {
  assert.throws(() => BibtexFormatter.format(malformed), /Incomplete/);
}
assert.equal(formatters.format('main.tex', '  literal source  '), '  literal source  ');
assert.equal(formatters.supports('folder/REFERENCES.BIB'), true);
const custom = new SourceFormatterRegistry();
custom.register('.custom', {format: text => text.toUpperCase()});
assert.equal(custom.format('test.CUSTOM', 'value'), 'VALUE');
assert.throws(() => custom.register('.custom', {format: text => text}), /already registered/);

const workspace = Object.create(Workspace.prototype);
const doc = CodeMirror.Doc(input, 'bibtex');
workspace.file = 'references.bib'; adoptBuffer(workspace,workspace.file,{doc,saved:input,sha:'old'});
workspace.cm = {getScrollInfo: () => ({left: 0, top: 120}), scrollTo: (left, top) => assert.equal(top, 120)};
const valueOffset = input.indexOf('Nested') + 3;
doc.setSelection(doc.posFromIndex(valueOffset));
assert.equal(workspace.canFormatFile(), true);
assert.equal(workspace.formatFile(), true);
assert.equal(doc.getValue(), expected);
assert.equal(doc.indexFromPos(doc.getCursor()), expected.indexOf('Nested') + 3, 'cursor follows the same value');
doc.undo(); assert.equal(doc.getValue(), input, 'formatting is one undo step');
doc.redo(); assert.equal(doc.getValue(), expected);
assert.equal(workspace.formatFile(), false, 'reformatting creates no edit');
workspace.sourceMode = {value: 'entire'};
assert.equal(workspace.canFormatFile(), false);
assert.equal(workspace.formatFile(), false);
workspace.sourceMode.value = 'files';

let writes = [];
workspace.api = async (path, options) => {writes.push(JSON.parse(options.body)); return {sha: 'new', notes: [], changes: []};};
workspace.status = {};
for (const name of ['renderTop', 'applyMarks', 'renderReview', 'loadCitations']) workspace[name] = () => {};
doc.undo();
await workspace.save();
assert.equal(writes[0].text, expected, 'save sends formatted source');
assert.equal(workspace.files.get(workspace.file).saved, expected);
await workspace.save(); assert.equal(writes.length, 1, 'unchanged formatted buffer does not save again');
doc.setValue(cluttered);
doc.setCursor(doc.posFromIndex(cluttered.indexOf('useful') + 3));
await workspace.save();
assert.equal(writes.at(-1).text, cleaned, 'automatic saves remove abstracts and compact values');
assert.equal(doc.indexFromPos(doc.getCursor()), cleaned.indexOf('useful') + 3, 'cursor follows surviving text after abstract removal');
doc.undo();
assert.equal(doc.getValue(), cluttered, 'cleanup is one undoable edit');
doc.setValue('@article{k,title={unfinished}');
assert.throws(() => workspace.formatFile(), /Incomplete/);
await workspace.save();
assert.equal(writes.at(-1).text, '@article{k,title={unfinished}', 'incomplete drafts can still be saved unchanged');
workspace.api = async () => {throw new Error('Conflict');};
doc.setValue(input);
await assert.rejects(() => workspace.save(), /Conflict/);
assert.equal(workspace.files.get(workspace.file).saved, '@article{k,title={unfinished}', 'failed saves retain the previous saved baseline');
assert.equal(doc.getValue(), expected, 'formatted edits survive a failed save');

workspace.getToolbarControl = () => element();
workspace.runToolbarCommand = command => command();
const toolbar = window.EditorTools.registry.mount('workspace.source', {owner: workspace, view: 'source'}, 'Source tools');
const formatControl = toolbar.element.children.find(wrapper => wrapper.children[0].textContent === 'Format file');
assert.ok(formatControl && !formatControl.hidden, 'registered formatter exposes the file command');
doc.undo();
formatControl.children[0].onclick();
assert.equal(doc.getValue(), expected, 'toolbar command formats through the public workspace interface');
workspace.file = 'main.tex';
toolbar.refresh({owner: workspace, view: 'source'});
assert.equal(formatControl.hidden, true, 'unsupported file types hide the command');
console.log('ok source formatting, preservation, provider registration, cursor, undo/redo and save recovery');
