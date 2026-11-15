import {withToolRuntime} from './support/tool-runtime.mjs';
// Run: node tests/test_comment_copy.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
function element(tag) {
  return { tag, attributes: {}, children: [], events: {}, style: {}, classList: { toggle() {} },
    get lastChild() { return this.children.at(-1); },
    setAttribute(k, v) { this.attributes[k] = v; },
    addEventListener(k, v) { this.events[k] = v; },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; }, focus() {} };
}
const window = { DraftMatch: {} }, copied = [];
const context = vm.createContext({ window, document: { createElement: element },
  navigator: { clipboard: { writeText: async (text) => copied.push(text) } },
  location: { origin: 'http://localhost' }, setTimeout() {}, console });
for (const file of ['workspace.js', 'annotator.js']) vm.runInContext(withToolRuntime(readFileSync(new URL('../static/' + file, import.meta.url), 'utf8')), context);
const all = (node) => [node, ...(node.children || []).filter((n) => typeof n === 'object').flatMap(all)];
const buttons = (node, label) => all(node).filter((n) => n.tag === 'button' && n.attributes['aria-label'] === label);
const click = (btn) => btn.events.click({ currentTarget: btn, stopPropagation() {} });
const comments = [{ author: 'Author', text: '  First line\n\nSecond line 😀  ', created_at: 1 }, { author: 'Codex', text: 'Reply\twith tabs\n', created_at: 2 }];
async function checkComments(view) {
  const copies = buttons(view, 'Copy comment');
  assert.equal(copies.length, comments.length);
  for (let i = 0; i < copies.length; i++) {
    await click(copies[i]);
    assert.equal(copied.at(-1), comments[i].text, 'copy must preserve whitespace, Unicode and reply text exactly');
  }
}
const ws = Object.assign(Object.create(window.Workspace.prototype), {
  o: { action: (fn) => fn(), base: '/draft', doc: { name: 'Paper' } },
  say() {}, marks: [],
  status: { root: '/source', main: 'main.tex', notes: [], changes: [] }, citeProblems: () => [],
});
const note = { id: 'note1', file: 'main.tex', line: 4, start: 12, anchor: 'edited', quote: 'Old passage', current: 'New passage', comments, status: 'open' };
const change = { id: 'change1', file: 'main.tex', line: 5, kind: 'replaced', old: 'Before', new: 'After', comments, status: 'accepted', history: [] };
for (const view of [ws.noteCard(note), ws.noteCard({ ...note, status: 'resolved' }), ws.changeCard(change), ws.changeCard(change, true)]) {
  await checkComments(view);
  const thread = all(view).find((n) => n.textContent === 'Copy thread');
  assert.ok(thread);
  await click(thread);
  for (const text of ['/source', 'main.tex:', 'id `', 'Comment thread:', 'Author:', 'Codex:']) assert.ok(copied.at(-1).includes(text), text);
}
// Note copy belongs beside Resolve/Reopen, using the existing wrapping button row.
for (const status of ['open', 'resolved']) {
  const card = ws.noteCard({ ...note, status });
  const footer = card.children.at(-1);
  assert.equal(footer.className, 'ws-buttons');
  assert.deepEqual(footer.children.map((n) => n.textContent), ['Copy thread', status === 'resolved' ? 'Reopen' : 'Resolve', 'Reply']);
  assert.ok(!all(card.children[0]).some((n) => n.textContent === 'Copy thread'));
}
const css = readFileSync(new URL('../static/workspace.css', import.meta.url), 'utf8');
assert.match(css, /\.ws-buttons\{[^}]*flex-wrap:wrap/);
assert.match(css, /\.ws-buttons button\{[^}]*padding:3px 8px/);
ws.status.notes = [note]; ws.status.changes = [{ ...change, status: 'open', new_start: 30 }];
const bulk = ws.llmTextNow().text;
assert.ok(bulk.includes(ws.reviewItemText({ n: note }, 1)));
assert.ok(bulk.includes(ws.reviewItemText({ c: change }, 2)));
assert.ok(ws.reviewItemText({ n: note }).includes('New passage'));
assert.ok(ws.reviewItemText({ n: note }).includes('Old passage'));
assert.ok(ws.reviewItemText({ n: { ...note, anchor: 'lost' } }).includes('position lost'));
const pdf = Object.assign(Object.create(window.PdfAnnotator.prototype), {
  o: {}, cfg: { highlight_colors: [{ id: 'yellow', label: 'Yellow', hex: '#ffe066' }] },
  setStatus() {}, pop: element('div'), place() {}, redraw() {}, root: element('div'), list: element('div'), showList: true,
});
const mark = { id: 'h1', page: 1, color: 'yellow', text: 'Passage', comments, rects: [{ p: 1, y: 1 }] };
await checkComments(pdf.renderThread(mark, {}).box);
pdf.o.readOnly = true;
pdf.openPop(mark, {});
await checkComments(pdf.pop);
assert.ok(all(pdf.pop).some((n) => n.textContent === 'Copy with comments'));
pdf.ann = { highlights: [mark], strokes: [] };
pdf.renderList();
await checkComments(pdf.list);
assert.ok(all(pdf.list).some((n) => n.tag === 'button' && n.className === 'pdfa-item-open'));
for (const node of all(pdf.list).filter((n) => n.tag === 'button')) assert.equal(all(node).filter((n) => n.tag === 'button').length, 1, 'no nested buttons');
console.log('ok: exact comment copying, replies, resolved and inactive workspace items, anchored thread and bulk export, editable/archived PDF and notes list');
