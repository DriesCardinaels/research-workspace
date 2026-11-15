import {adoptBuffer} from './support/source-buffers.mjs';
import {withToolRuntime} from './support/tool-runtime.mjs';
// Combined LaTeX source follows inputs without modifying editable file buffers.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const WritingCheck = require('../static/writing.js');
// A minimal DOM boots the bundled CodeMirror without a browser. All text editing,
// selections, text marks and undo/redo below use its real Doc implementation (5.65.16).
const element = () => ({
  attrs: {}, children: [], style: {}, classList: { toggle() {} },
  setAttribute(key, value) { this.attrs[key] = value; this[key] = value; },
  append(...children) { this.children.push(...children); },
  appendChild(child) { this.children.push(child); return child; },
  replaceChildren(...children) { this.children = children; },
  addEventListener() {}, cloneNode() { return element(); },
});
const document = { createElement: element, createTextNode: (text) => ({ textContent: text }), documentElement: {}, body: element(), addEventListener() {} };
const window = { DraftMatch: {}, WritingCheck, document, addEventListener() {} };
const preferences = new Map();
const localStorage = { getItem: (key) => preferences.get(key) ?? null, setItem: (key, value) => preferences.set(key, value) };
const context = vm.createContext({ window, WritingCheck, localStorage, document, navigator: { userAgent: '', platform: '' }, setTimeout, clearTimeout });
vm.runInContext(readFileSync(new URL('../static/vendor/codemirror/codemirror.min.js', import.meta.url), 'utf8'), context);
vm.runInContext(withToolRuntime(readFileSync(new URL('../static/workspace.js', import.meta.url), 'utf8')), context);
vm.runInContext(readFileSync(new URL('../static/latex-table.js', import.meta.url), 'utf8'), context);
const { CodeMirror } = context;
const { Workspace } = window;
const files = {
  'main.tex': String.raw`\documentclass{article}
\includeonly{sections/intro}
\begin{document}
Start here.
% \input{missing-comment}
\input{sections/setup}
\include{sections/intro}
\include{omitted}
\input sections/end
\end{document}`,
  'sections/setup.tex': String.raw`\section{Ignored heading}One two. \input{nested}`,
  'sections/nested.tex': 'Three four.',
  'sections/intro.tex': String.raw`Five six. \footnote{Seven eight.}`,
  'sections/end.tex': 'Nine ten.',
  'unused.tex': 'This is not part of the paper.',
};
let result = await Workspace.combinedSource('main.tex', Object.keys(files), async (f) => files[f]);
assert.equal(result.warnings.length, 0);
assert.ok(result.text.indexOf('One two') < result.text.indexOf('Three four'));
assert.ok(result.text.indexOf('Three four') < result.text.indexOf('Five six'));
assert.ok(!result.text.includes('This is not part'));
assert.equal(WritingCheck.countWords(WritingCheck.wordMask(result.text)), 12);
// A standalone subfile contributes its document body, not a second document wrapper.
result = await Workspace.combinedSource('main.tex', ['main.tex', 'child.tex'], async (f) => f === 'main.tex'
  ? String.raw`\begin{document}Before. \subfile{child} After.\end{document}`
  : String.raw`\documentclass[main.tex]{subfiles}\begin{document}Child words.\end{document}Not printed.`);
assert.equal(WritingCheck.countWords(WritingCheck.wordMask(result.text)), 4);
assert.ok(!result.text.includes('Not printed'));
// Repeated inputs are included each time; comments and literal examples are untouched.
result = await Workspace.combinedSource('main.tex', ['main.tex', 'a.tex'], async (f) => f === 'a.tex' ? 'Repeated text.' : String.raw`\input{a}\input{a}
\begin{verbatim}\input{missing}\end{verbatim}
\verb|\input{missing-too}|`);
assert.equal(result.warnings.length, 0);
assert.equal(result.text.match(/Repeated text/g).length, 2);
// Missing, dynamic and recursive inputs are reported and cannot loop or escape.
result = await Workspace.combinedSource('main.tex', ['main.tex', 'a.tex'], async (f) => f === 'a.tex' ? String.raw`\input{main}` : String.raw`\input{a}\input{missing}\input{\dynamic}\input{../../outside}`);
assert.equal(result.warnings.length, 4);
assert.match(result.warnings[0], /Circular input/);
assert.match(result.text, /\\input\{missing\}/);
// Whole-paper refresh uses unsaved buffers but never opens tabs or saves files.
const requests = [];
const ws = new Workspace({ base: '/draft', api: async (path) => {
  requests.push(path);
  const file = decodeURIComponent(path.split('=')[1]);
  return { text: files[file] };
} });
ws.status = { main: 'main.tex', files: Object.keys(files) };
ws.updateWordCount = () => {};
const dirty=adoptBuffer(ws,'sections/intro.tex',{saved:files['sections/intro.tex']});
dirty.doc.setValue('New unsaved text here.');
await ws.refreshPaper();
assert.match(ws.paperSource.text, /New unsaved text here/);
assert.equal(ws.files.size, 1);
assert.equal(ws.tabs.length, 0);
assert.equal(dirty.saved, files['sections/intro.tex']);
assert.ok(requests.every((p) => p.includes('/file?path=')));
assert.ok(!requests.some((p) => p.includes('unused')));
const count = ws.paperCount;
dirty.doc.setValue('Short edit.');
await ws.refreshPaper();
assert.equal(ws.paperCount, count - 2);
// Transient read failures do not poison the text cache.
const retry = new Workspace({ base: '/draft', api: async () => { if (retry.fail) throw new Error('Temporary'); return { text: 'Recovered words.' }; } });
retry.status = { main: 'main.tex', files: ['main.tex'] };
retry.updateWordCount = () => {};
retry.fail = true;
await retry.refreshPaper();
assert.equal(retry.paperSource.warnings.length, 1);
retry.fail = false;
await retry.refreshPaper();
assert.equal(retry.paperSource.warnings.length, 0);
assert.equal(retry.paperCount, 2);
// Integration fixture: main-file prose before/after includes, nested inputs, Unicode,
// CRLF, unsaved buffers, a standalone subfile and an omitted file.
const fixture = {
  'main.tex': String.raw`\documentclass{article}
\begin{document}
Before the sections.
\input{a}
Between the sections.
\input{b}
After the sections.
\end{document}`,
  'a.tex': 'First 😀 sentence uses very clear words.\r\nA second sentence follows.\r\n',
  'b.tex': 'We utilize a complicated procedure, with several decisions, and with many alternatives that the reader must understand before the next step can happen and before any result becomes available for inspection.\n',
  'unused.tex': 'Unused words never enter the score.',
};
const calls = [], errors = [];
const editor = new Workspace({ base: '/draft', message: (text) => errors.push(text), api: async (url, options) => {
  calls.push({ url, options });
  if (options?.method === 'PUT') {
    const body = JSON.parse(options.body);
    assert.equal(body.sha, 'sha:' + body.path);
    fixture[body.path] = body.text;
    return { sha: body.sha, notes: editor.status.notes, changes: editor.status.changes };
  }
  if (url.includes('/file?')) { const file = decodeURIComponent(url.split('=')[1]); return { text: fixture[file], sha: 'sha:' + file }; }
  if (url.includes('/writing/ignores')) return { writing_ignores: [JSON.parse(options.body)] };
  if (url.includes('/synctex/view')) return [{ page: 2, y: 40 }];
  throw new Error('Unexpected API request: ' + url);
} });
const status = { linked: true, main: 'main.tex', files: Object.keys(fixture), draft_pdf: true, notes: [], changes: [], writing_ignores: [] };
let activeDoc = CodeMirror.Doc(''), refreshed = 0;
const wired = new WeakSet();
const cm = new Proxy({
  getDoc: () => activeDoc,
  swapDoc(doc) {
    const old = activeDoc; activeDoc = doc;
    if (!wired.has(doc)) {
      wired.add(doc);
      doc.on('beforeChange', (_, change) => { if (doc === activeDoc) editor.checkPaperEdit(change); });
      doc.on('change', (_, change) => { if (doc === activeDoc) editor.applyPaperEdit(change); });
    }
    return old;
  },
  refresh: () => refreshed++, getScrollInfo: () => ({ left: 0, top: 0, clientHeight: 800 }), scrollTo() {},
  charCoords: () => ({ top: 0 }), focus() {}, clearGutter() {}, setGutterMarker() {},
  getOption: () => false,
  /** @param {string} name Option key. @param {*} value Option value.
   * @pre Editor fixture exists. @post Validates reopening enables editing.
   * @return {void} Nothing. @throws {AssertionError} Unexpected option. */
  setOption(name, value) { assert.equal(name, 'readOnly'); assert.equal(value, false); },
  operation: (fn) => fn(),
}, { get(target, name) { return name in target ? target[name] : typeof activeDoc[name] === 'function' ? activeDoc[name].bind(activeDoc) : activeDoc[name]; } });
Object.assign(editor, {
  status, cm, sourceMode: Object.assign(element(), { value: 'files' }), entireInfo: element(),
  left: element(), srcComment: { hidden: true }, view: 'source', reviewOpen: true, reviewTab: 'writing',
  renderTabs() {}, renderTop() {}, renderBuild() {}, renderReview() {}, renderWritingBody() {},
  loadCitations() {}, loadPdf: async () => {}, readingOrder: async () => [],
  headerCount: element(), file: null,
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
await editor.openFile('main.tex');
const originalMainDoc = activeDoc;
originalMainDoc.setCursor({ line: 2, ch: 3 });
await settle();
await editor.setSourceMode('entire');
const combinedDoc = activeDoc;
assert.notEqual(combinedDoc, originalMainDoc);
assert.equal(editor.entire, true);
assert.equal(editor.sourceMode.attrs['aria-pressed'], 'true');
assert.equal(preferences.get('pdf-editor.ws.sourceMode'), 'entire');
assert.equal(editor.files.has('unused.tex'), false);
assert.equal(editor.files.size, 3);
assert.ok(!combinedDoc.getValue().includes('\\input{a}'));
assert.ok(combinedDoc.getValue().includes('First 😀 sentence'));
assert.ok(!combinedDoc.getValue().includes('\r'));
assert.equal(editor.wResult.file, 'Entire paper');
const fullScores = WritingCheck.analyze(combinedDoc.getValue()).scores;
assert.deepEqual(editor.wResult.scores, fullScores);
assert.ok(fullScores.words > WritingCheck.analyze(fixture['main.tex']).scores.words);
assert.ok(fullScores.words > WritingCheck.analyze(fixture['a.tex']).scores.words);
assert.ok(editor.wResult.marks.some((m) => m.file === 'b.tex' && m.rule === 'long'));
assert.ok(editor.wResult.marks.some((m) => m.file === 'a.tex' && m.rule === 'intensifier'));

// A comment and a tracked change in different inputs both appear at the right visible words.
const cpIndex = (text, token) => [...text.slice(0, text.indexOf(token))].length;
const note = { id: 'a-note', file: 'a.tex', start: cpIndex(fixture['a.tex'], 'clear'), end: cpIndex(fixture['a.tex'], 'clear') + 5,
  line: 1, status: 'open', comments: [{ text: 'Clarify this.' }] };
const change = { id: 'b-change', file: 'b.tex', new_start: 3, new_end: 10, old: 'use', kind: 'replaced', status: 'open' };
editor.status.notes = [note]; editor.status.changes = [change]; editor.showChanges = true;
editor.applyMarks();
assert.equal(editor.cmMarks.length, 2);
for (const mark of editor.cmMarks) {
  const range = mark.find();
  const text = combinedDoc.getRange(range.from, range.to);
  assert.equal(text, mark.wsItem.type === 'note' ? 'clear' : 'utilize');
}

// Multi-cursor edits in one CodeMirror operation update both backing files and undo
// together. Pending mappings must account for earlier edits in the same operation.
const multiBefore = combinedDoc.getValue();
const multiA = multiBefore.indexOf('First'), multiB = multiBefore.indexOf('We utilize');
combinedDoc.setSelections([
  { anchor: combinedDoc.posFromIndex(multiA), head: combinedDoc.posFromIndex(multiA + 5) },
  { anchor: combinedDoc.posFromIndex(multiB), head: combinedDoc.posFromIndex(multiB + 2) },
]);
combinedDoc.replaceSelections(['Opening', 'They'], 'around', '+input');
await settle();
assert.ok(editor.files.get('a.tex').doc.getValue().startsWith('Opening'));
assert.ok(editor.files.get('b.tex').doc.getValue().startsWith('They'));
assert.equal(editor.paperSource.text, combinedDoc.getValue());
combinedDoc.undo(); await settle();
assert.equal(combinedDoc.getValue(), multiBefore);
assert.equal(editor.files.get('a.tex').doc.getValue(), fixture['a.tex']);
assert.equal(editor.files.get('b.tex').doc.getValue(), fixture['b.tex']);
combinedDoc.redo(); await settle();
assert.ok(editor.files.get('a.tex').doc.getValue().startsWith('Opening'));
assert.ok(editor.files.get('b.tex').doc.getValue().startsWith('They'));
combinedDoc.undo(); await settle();
combinedDoc.clearHistory();

// Edit the second CRLF line, then undo/redo through real CodeMirror history. The main
// include statements survive, while the projected cursor remains in the combined editor.
let at = combinedDoc.getValue().indexOf('A second');
combinedDoc.replaceRange('Another', combinedDoc.posFromIndex(at), combinedDoc.posFromIndex(at + 1), '+input');
await settle();
assert.match(editor.files.get('a.tex').doc.getValue(), /\r\nAnother second/);
assert.equal(editor.files.get('main.tex').doc.getValue(), fixture['main.tex']);
assert.equal(editor.paperSource.text, combinedDoc.getValue());
assert.equal(editor.unsaved, true);
editor.applyMarks();
let projectedComment = editor.cmMarks.find((m) => m.wsItem.id === 'a-note').find();
assert.equal(combinedDoc.getRange(projectedComment.from, projectedComment.to), 'clear');
await editor.openFile('a.tex');
assert.equal(editor.cmMarks.filter((m) => m.wsItem.id === 'a-note').length, 1, 'comments remain visible on an unsaved file after switching views');
await editor.setSourceMode('entire');
projectedComment = editor.cmMarks.find((m) => m.wsItem.id === 'a-note').find();
assert.equal(combinedDoc.getRange(projectedComment.from, projectedComment.to), 'clear');
combinedDoc.undo(); await settle();
assert.equal(editor.files.get('a.tex').doc.getValue(), fixture['a.tex']);
assert.equal(editor.paperSource.text, combinedDoc.getValue());
combinedDoc.redo(); await settle();
assert.match(editor.files.get('a.tex').doc.getValue(), /\r\nAnother second/);
assert.equal(editor.paperSource.text, combinedDoc.getValue());

// A comment selected after Unicode and CRLF is saved to the input, with native code-point
// offsets rather than the combined document's coordinates. The original input is updated.
at = combinedDoc.getValue().indexOf('second');
combinedDoc.setSelection(combinedDoc.posFromIndex(at), combinedDoc.posFromIndex(at + 6));
const target = await editor.sourceTarget();
assert.equal(target.file, 'a.tex'); assert.equal(target.quote, 'second');
assert.equal(target.start, cpIndex(fixture['a.tex'], 'second'));
assert.ok(calls.some((c) => c.options?.method === 'PUT' && JSON.parse(c.options.body).path === 'a.tex'));
assert.ok(fixture['main.tex'].includes('\\input{a}'));
assert.equal(editor.entire, true);

// Rebuilding an unchanged projection must preserve both the editor and its history.
const history = combinedDoc.historySize();
await editor.refreshPaper();
assert.equal(activeDoc, combinedDoc);
assert.deepEqual(combinedDoc.historySize(), history);

// File tabs share the latest editable buffers; returning restores the full document.
await editor.openFile('a.tex');
assert.equal(editor.entire, false);
assert.match(activeDoc.getValue(), /Another second/);
assert.equal(editor.wResult.file, 'a.tex');
await editor.setSourceMode('entire');
assert.equal(activeDoc, combinedDoc);
assert.equal(editor.wResult.file, 'Entire paper');
assert.equal(editor.sourceMode.attrs['aria-pressed'], 'true');

// Formatting and saving the combined document uses the ordinary editor methods and
// saves every changed file, including files never opened as tabs.
let bAt = combinedDoc.getValue().indexOf('utilize');
combinedDoc.setSelection(combinedDoc.posFromIndex(bAt), combinedDoc.posFromIndex(bAt + 7));
editor.wrap('bold'); await settle();
assert.ok(editor.files.get('b.tex').doc.getValue().includes('\\textbf{utilize}'));
at = combinedDoc.getValue().indexOf('Before');
combinedDoc.replaceRange('Earlier', combinedDoc.posFromIndex(at), combinedDoc.posFromIndex(at + 6), '+input');
await settle();
await editor.save();
assert.ok(fixture['b.tex'].includes('\\textbf{utilize}'));
assert.ok(fixture['main.tex'].includes('Earlier'));
assert.ok(fixture['main.tex'].includes('\\input{b}'));
assert.equal(editor.unsaved, false);

// Source/PDF navigation and selecting a review comment stay in the combined view.
editor.pdf = { scrollToRect(page, y) { assert.equal(page, 2); assert.equal(y, 40); } };
await editor.revealSource('a.tex', note.start, note.end);
assert.equal(combinedDoc.getSelection(), 'clear');
assert.equal(editor.entire, true);
await editor.sourceToPdf();
assert.ok(calls.at(-1).url.includes('path=a.tex&line=1'));
editor.select('note', note.id, { source: true, pdf: false }); await settle();
assert.equal(editor.entire, true);
assert.equal(combinedDoc.getSelection(), 'clear');
editor.reviewTab = 'writing'; editor.runWriting();
const writingMark = editor.wResult.marks.find((m) => m.file === 'b.tex' && m.rule === 'plain');
assert.ok(writingMark);
editor.startNote = (value) => { editor.newNote = value; };
await editor.commentWriting(writingMark);
assert.equal(editor.newNote.file, 'b.tex');
assert.equal(editor.newNote.quote, 'utilize');
await editor.ignoreWriting(writingMark, true);
assert.equal(editor.status.writing_ignores[0].file, 'b.tex');
assert.ok(editor.wResult.ignored.some((m) => m.rule === 'plain'));

// Citation diagnostics retain native file offsets, even when scanned in the combined view.
at = combinedDoc.getValue().indexOf('Another second');
combinedDoc.replaceRange('\\cite{missing} ', combinedDoc.posFromIndex(at), combinedDoc.posFromIndex(at), '+input');
await settle();
editor.cites = { entries: [], problems: [{ file: 'a.tex', start: 99, key: 'stale' }], bib_files: ['refs.bib'], missing_bib: [], duplicates: [] };
editor.citeKeySet = new Set();
editor.refreshCiteMarks();
assert.equal(editor.citeProblems().length, 1);
const citation = editor.citeProblems()[0];
assert.equal(citation.file, 'a.tex');
assert.equal(citation.line, 2);
assert.equal(editor.files.get('a.tex').doc.getValue().slice(citation.start, citation.end), 'missing');
assert.equal(combinedDoc.getValue().slice(citation.displayStart, citation.displayEnd), 'missing');
await editor.revealSource(citation.file, citation.start, citation.end, false);
assert.equal(editor.entire, true);
assert.equal(combinedDoc.getSelection(), 'missing');
await editor.save();

// Failed saves retain both views' edits and their original path/SHA; there is no flattened
// write to main.tex. A following successful save uses the same normal file API.
const apiBeforeConflict = editor.o.api;
editor.o.api = async (url, options) => {
  if (options?.method === 'PUT') throw new Error('The source changed on disk.');
  return apiBeforeConflict(url, options);
};
at = combinedDoc.getValue().indexOf('Another second');
combinedDoc.replaceRange('Extra ', combinedDoc.posFromIndex(at), combinedDoc.posFromIndex(at), '+input');
await settle();
await assert.rejects(editor.save(), /changed on disk/);
assert.equal(editor.unsaved, true);
assert.ok(editor.files.get('a.tex').doc.getValue().includes('Extra Another'));
assert.ok(combinedDoc.getValue().includes('Extra Another'));
editor.o.api = apiBeforeConflict;
await editor.save();

// Reject cross-file edits/comment anchors and edits of generated separators without touching
// either the projection or the source. Repeated passages are deliberately edited in a file tab.
const before = combinedDoc.getValue(), nativeBefore = editor.files.get('a.tex').doc.getValue();
at = before.indexOf('% --- a.tex');
combinedDoc.replaceRange('corrupt', combinedDoc.posFromIndex(at), combinedDoc.posFromIndex(at + 5), '+input');
await settle();
assert.equal(combinedDoc.getValue(), before);
assert.equal(editor.files.get('a.tex').doc.getValue(), nativeBefore);
assert.match(errors.at(-1), /File separators/);
await assert.rejects(editor.targetAt(before.indexOf('clear'), before.indexOf('utilize') + 7), /one source file/);
const repeated = await Workspace.combinedSource('main.tex', ['main.tex', 'a.tex'], async (f) => f === 'main.tex' ? '\\input{a}\\input{a}' : 'Repeat.');
assert.equal(Workspace.projectionSpans(repeated, 'a.tex', 0, 6).length, 2);
assert.throws(() => Workspace.applyProjectionEdit(repeated, repeated.text.indexOf('Repeat'), repeated.text.indexOf('Repeat') + 6, 'Other'), /more than once/);

// External disk updates rebuild the paper and scores, while a dirty buffer is retained
// with a conflict flag and its comment anchors are never overwritten by the external text.
fixture['b.tex'] = 'A short replacement sentence.\n';
// Use a different SHA to simulate the disk update.
const realApi = editor.o.api;
editor.o.api = async (url, options) => {
  const response = await realApi(url, options);
  return url.includes('path=b.tex') ? { ...response, sha: 'new-b' } : response;
};
await editor.syncFiles();
assert.ok(combinedDoc.getValue().includes('A short replacement sentence.'));
assert.equal(editor.wResult.scores.words, WritingCheck.analyze(combinedDoc.getValue()).scores.words);
assert.equal(combinedDoc.historySize().undo, 0, 'external rebuild invalidates stale projected undo');

// A dirty input wins over an external disk refresh and is flagged, not silently overwritten.
at = combinedDoc.getValue().indexOf('First');
combinedDoc.replaceRange('Local ', combinedDoc.posFromIndex(at), combinedDoc.posFromIndex(at), '+input');
await settle();
fixture['a.tex'] = 'External replacement.\r\n';
const apiBeforeDirtyReload = editor.o.api;
editor.o.api = async (url, options) => {
  const response = await apiBeforeDirtyReload(url, options);
  return url.includes('path=a.tex') ? { ...response, sha: 'external-a' } : response;
};
await editor.syncFiles();
assert.equal(editor.files.get('a.tex').stale, true);
assert.ok(combinedDoc.getValue().includes('Local First'));
assert.ok(!combinedDoc.getValue().includes('External replacement'));
assert.equal(editor.paperSource.text, combinedDoc.getValue());

// Opening always selects an individual file now that the combined-view control is removed.
editor.renderShell = () => { editor.sourceMode.value = 'files'; activeDoc = CodeMirror.Doc(''); };
preferences.set('pdf-editor.ws.sourceMode', 'entire');
await editor.open(status);
assert.equal(editor.entire, false);
assert.equal(editor.files.get('main.tex').isAttached(editor.cm), true);
await editor.setSourceMode('files');
assert.equal(preferences.get('pdf-editor.ws.sourceMode'), 'files');
await editor.open(status);
assert.equal(editor.entire, false);
assert.equal(editor.files.get('main.tex').isAttached(editor.cm), true);
preferences.set('pdf-editor.ws.sourceMode', 'invalid');
await editor.open(status);
assert.equal(editor.entire, false);
console.log('PASS: full-paper editing with real CodeMirror docs, native undo/redo, multi-file saves, CRLF/Unicode comment anchors, marks, navigation, writing scores, external reloads and remembered mode');

// Public table insertion uses the actual CodeMirror Doc, including undo and validation atomicity.
const tableDoc = activeDoc, beforeTable = tableDoc.getValue();
tableDoc.setCursor(tableDoc.posFromIndex(beforeTable.indexOf('\\end{document}')));
tableDoc.clearHistory();
editor.insertTable({rows:2,columns:3,caption:'Results',label:'tab:results'});
assert.ok(tableDoc.getValue().includes('\\begin{tabular}{lll}'));
assert.equal(tableDoc.getSelection(),'Cell 1,1');
assert.equal(tableDoc.historySize().undo,1);
tableDoc.undo(); assert.equal(tableDoc.getValue(),beforeTable);
tableDoc.redo(); assert.ok(tableDoc.getValue().includes('\\label{tab:results}'));
tableDoc.undo();
assert.throws(()=>editor.insertTable({rows:0}),/rows/);
assert.equal(tableDoc.getValue(),beforeTable,'invalid tables never mutate source');
const getOption = cm.getOption;
cm.getOption = () => true;
assert.throws(()=>editor.insertTable(),/editable/);
assert.equal(tableDoc.getValue(),beforeTable);
cm.getOption = getOption;
console.log('PASS: public table insertion, native editor undo/redo, read-only guards and validation atomicity');
