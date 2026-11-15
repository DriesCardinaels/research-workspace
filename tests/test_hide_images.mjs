import {adoptBuffer} from './support/source-buffers.mjs';
import {withToolRuntime} from './support/tool-runtime.mjs';
// Hide images in the LaTeX workspace: the toggle, the two page counts, which PDF the pane shows,
// both builds running at once, and no comment marks or SyncTeX jumps on the figure-free PDF.
// Run: node tests/test_hide_images.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// A minimal DOM: enough for h(), the toggle and the count.
class El {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.listeners = {}; this.hidden = false; this.title = ''; this.className = ''; }
  get classList() {
    const el = this, set = () => new Set(el.className.split(' ').filter(Boolean));
    return {
      contains: (c) => set().has(c),
      toggle: (c, on) => { const s = set(); if (on ?? !s.has(c)) s.add(c); else s.delete(c); el.className = [...s].join(' '); },
    };
  }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'hidden') this.hidden = true; if (k === 'title') this.title = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  click() { for (const fn of this.listeners.click || []) fn({ currentTarget: this }); }
  append(...nodes) { this.children.push(...nodes); }
  prepend(...nodes) { this.children.unshift(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  get textContent() { return this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join(''); }
  set textContent(t) { this.children = [String(t)]; }
}
const document = { createElement: (tag) => new El(tag), addEventListener() {}, removeEventListener() {} };

// A fake PDF viewer: the draft PDF has 17 pages unless a test says otherwise; the figure-free one is set per build.
const viewers = [];
let draftPages = 17, noFigPages = 14;
class PdfAnnotator {
  constructor(o) {
    this.o = o; this.root = new El('div'); this.scroller = { scrollTop: 0, scrollHeight: 1 }; this.scale = null;
    this.pages = []; this.marksSet = 0; this.destroyed = false; viewers.push(this);
  }
  async open() { const n = this.o.pdfUrl.includes('/no-figures/pdf') ? noFigPages : draftPages; this.pages = Array.from({ length: n }, (_, i) => ({ num: i + 1 })); }
  async destroy() { this.destroyed = true; }
  setMarks() { this.marksSet++; }
  setScale(s) { this.scale = s; }
  renderBar() {}
  flash() {}
  scrollToRect() { this.scrolled = true; }
}

const window = { DraftMatch: {} };
vm.runInNewContext(withToolRuntime(readFileSync(new URL('../static/workspace.js', import.meta.url), 'utf8')), { window, document, PdfAnnotator, console, clearTimeout, setTimeout });
const { Workspace } = window;

// The server: each request waits until the test answers it, so overlapping builds can be seen.
const pending = [];
function request(path, options) { let answer, reject; const p = new Promise((r, j) => { answer = r; reject = j; }); pending.push({ path, options, answer, reject }); return p; }
async function waitFor(path) {
  for (let i = 0; i < 50 && !pending.some((x) => x.path === path); i++) await new Promise((r) => setTimeout(r, 0));
  return pending.findIndex((x) => x.path === path);
}
async function answer(path, body) {
  const i = await waitFor(path);
  assert.ok(i >= 0, `no request for ${path}; pending: ${pending.map((x) => x.path).join(', ')}`);
  pending.splice(i, 1)[0].answer(body);
}
const messages = [];
let lastAction = Promise.resolve();
const ws = new Workspace({
  api: (path, options) => (path === '/d' ? Promise.resolve({ changes: [], notes: [], files: [], builds: [] }) : request(path.replace(/^\/d/, ''), options)),
  base: '/d', token: 't', colors: {}, message: (text, err) => messages.push({ text, err: !!err }),
  action: (fn) => { lastAction = Promise.resolve().then(fn).catch((e) => messages.push({ text: e.message, err: true })); return lastAction; },
});
// The parts of the workspace that this test does not cover.
Object.assign(ws, {
  status: { changes: [], notes: [], files: [], builds: [] }, live: false,
  saveAll: async () => {}, syncFiles: async () => {}, renderTop() {}, applyMarks() {}, renderReview() {}, renderBuild() {},
  loadCitations: async () => {}, citeProblems: () => [], visibleNotes: () => [], markedChanges: () => [], bibName: () => 'references.bib',
  pageData: async () => [], placeStrokes: async () => [], renderLog(r) { this.loggedBuild = r; },
  pdfPane: new El('div'), file: 'main.tex',
});
ws.noFigBar = ws.noFigControls();
const btn = ws.noFigBtn, info = ws.noFigInfo;
const current = () => viewers[viewers.length - 1];

// Off: the draft PDF with its marks; the button sits after the page box in its toolbar.
await ws.loadPdf();
assert.equal(current().o.readOnly, false);
assert.match(current().o.pdfUrl, /^\/d\/pdf\?t=/);
assert.ok(current().o.barExtra.length === 2 && current().o.barExtra[0] === btn && current().o.barExtra[1] === info); // shown after the page box
assert.equal(current().marksSet, 1);
assert.equal(ws.pagesWithFigures, 17);
assert.equal(info.hidden, true);
assert.equal(btn.getAttribute('aria-pressed'), 'false');
console.log('PASS: off, the pane shows the draft PDF with marks; the count is hidden');

// On: one figure-free build, then the pane shows that PDF read-only, without marks, and both counts.
btn.click();
await answer('/no-figures', { ok: true, pages: 14, removed: { figure: 5, teaserfigure: 1 }, at: 1, errors: [], log: '' });
await lastAction;
assert.equal(btn.getAttribute('aria-pressed'), 'true');
assert.ok(btn.classList.contains('on'));
assert.equal(ws.pdfMode, 'no-figures');
assert.equal(current().o.readOnly, true);
assert.match(current().o.pdfUrl, /^\/d\/no-figures\/pdf\?t=/);
assert.ok(current().o.barExtra.length === 2 && current().o.barExtra[0] === btn && current().o.barExtra[1] === info); // shown after the page box
assert.equal(current().marksSet, 0, 'no comment or change marks on the figure-free PDF');
assert.equal(info.hidden, false);
assert.equal(info.textContent, '14 pages without figures · 17 with');
assert.match(info.title, /Removed: 5 × figure, 1 × teaserfigure\. Tables stay\./);
console.log('PASS: on, the pane shows the PDF without figures and "14 pages without figures · 17 with"');

// SyncTeX positions belong to the draft PDF: the arrows refuse, and selecting a comment does not scroll this PDF.
await assert.rejects(ws.sourceToPdf(), /Hide images is on/);
await assert.rejects(ws.pdfToSource(), /Hide images is on/);
ws.marks = [{ id: 'note-a', rects: [{ p: 1, y: 10 }] }];
ws.status.notes = [{ id: 'a', file: 'main.tex', start: 0, end: 1, status: 'open' }];
Object.assign(ws, { openFile: async () => {}, reveal() {} });
adoptBuffer(ws,'main.tex',{doc:{getValue:()=> 'x'},saved:'x'});
ws.select('note', 'a', { source: false, pdf: true });
await new Promise((r) => setTimeout(r, 0));
assert.equal(current().scrolled, undefined);
ws.getSourceBuffers().close('main.tex');
console.log('PASS: no SyncTeX jumps or mark scrolling on the figure-free PDF');

// A build (Live or Recompile) starts both builds at once and shows both new counts.
draftPages = 16; noFigPages = 13;
const build = ws.compile();
assert.ok(await waitFor('/compile') >= 0 && await waitFor('/no-figures') >= 0, 'both builds are requested before either returns');
assert.equal(info.textContent, '14 pages without figures · 17 with · updating…');
await answer('/no-figures', { ok: true, pages: 13, removed: { figure: 5, teaserfigure: 1 }, at: 2, errors: [], log: '' });
await answer('/compile', { ok: true, pages: 16, errors: [], log: '', seconds: 1, at: 2 });
await build;
assert.equal(ws.pdfMode, 'no-figures');
assert.match(current().o.pdfUrl, /\/no-figures\/pdf/);
assert.equal(info.textContent, '13 pages without figures · 16 with');
console.log('PASS: each build makes both PDFs in parallel and updates both counts');

// A failed figure-free build is reported next to the button with its log; the pane falls back to the draft PDF.
const failing = ws.compile();
await answer('/compile', { ok: true, pages: 16, errors: [], log: '', seconds: 1, at: 3 });
await answer('/no-figures', { ok: false, pages: null, removed: null, errors: ['./main.tex:3: Undefined control sequence.'], log: 'log text', at: 3 });
await failing;
assert.equal(ws.pdfMode, 'draft');
assert.equal(current().o.readOnly, false);
assert.match(info.textContent, /^Build without figures failed/);
info.children.find((c) => c.textContent === 'Log').click();
assert.equal(ws.loggedBuild.label, 'Build without figures: errors');
assert.ok(messages.some((m) => m.err && /Build without figures failed/.test(m.text)));
console.log('PASS: a failed build without figures shows an error and its log; the draft PDF stays');

// Off again: the draft PDF with marks, the count hidden. A build still running when turned off is ignored.
btn.click();
await lastAction;
assert.equal(btn.getAttribute('aria-pressed'), 'false');
assert.equal(info.hidden, true);
assert.equal(ws.pdfMode, 'draft');
assert.equal(current().marksSet, 1);
btn.click(); // on: build pending
await new Promise((r) => setTimeout(r, 0));
const turningOn = lastAction;
await ws.setHideImages(false); // off before the build returns
await answer('/no-figures', { ok: true, pages: 13, removed: {}, at: 4, errors: [], log: '' });
await turningOn;
assert.equal(ws.pdfMode, 'draft');
assert.equal(ws.noFig, null);
assert.equal(current().o.readOnly, false);
assert.equal(pending.length, 0);
console.log('PASS: off restores the draft PDF; a late build result is ignored');

// Active-file builds show pending state before even saving, then target the displayed file for Live.
ws.renderBuild = Workspace.prototype.renderBuild;
ws.recompileBtn = new El('button'); ws.recompileLabel = new El('span'); ws.buildInfo = new El('button');
ws.compileArrow = new El('button'); ws.activeCompileBtn = new El('button'); ws.promoteBtn = new El('button');
function assertBusy(file) {
  assert.equal(ws.recompileBtn.disabled, true);
  assert.equal(ws.compileArrow.disabled, true);
  assert.equal(ws.activeCompileBtn.disabled, true);
  assert.equal(ws.promoteBtn.disabled, true);
  assert.equal(ws.recompileBtn.classList.contains('running'), true);
  assert.equal(ws.recompileLabel.textContent, 'Recompiling…');
  assert.equal(ws.buildInfo.textContent, `Compiling ${file || 'paper'}…`);
}
function assertIdle() {
  assert.equal(ws.recompileBtn.disabled, false);
  assert.equal(ws.compileArrow.disabled, false);
  assert.equal(ws.activeCompileBtn.disabled, false);
  assert.equal(ws.recompileBtn.classList.contains('running'), false);
  assert.equal(ws.recompileLabel.textContent, 'Recompile');
}
const activeResponse = (at) => ({ ok: true, file: 'review-notes/claims.tex', pages: 1, at, seconds: 1, errors: [], log: '' });
ws.file = 'review-notes/claims.tex';
const activeBuild = ws.compileActiveFile();
assertBusy('review-notes/claims.tex');
assert.ok(await waitFor('/compile-active') >= 0);
ws.file = 'main.tex';
await answer('/compile-active', activeResponse(5));
await activeBuild;
assertIdle();
assert.equal(ws.pdfMode, 'active-file');
assert.equal(current().o.readOnly, true);
assert.match(current().o.pdfUrl, /active-file\/pdf\?path=review-notes%2Fclaims.tex/);
assert.equal(current().marksSet, 0);
await assert.rejects(ws.sourceToPdf(), /standalone file preview/);
await assert.rejects(ws.pdfToSource(), /standalone file preview/);
const liveBuild = ws.compile({ live: true });
assertBusy('review-notes/claims.tex');
assert.match(ws.previewInfo.textContent, /Recompiling/);
assert.equal(ws.previewReturnBtn.disabled, true);
const index = await waitFor('/compile-active');
assert.equal(JSON.parse(pending[index].options.body).path, 'review-notes/claims.tex', 'Live targets displayed preview, not the main.tex source tab');
assert.equal(pending.some((x) => x.path === '/compile'), false);
// An edit while building queues the same file, even after switching tabs.
ws.compile({ live: true });
ws.file = 'sections/intro.tex';
await answer('/compile-active', activeResponse(6));
await liveBuild;
const queuedIndex = await waitFor('/compile-active');
assert.ok(queuedIndex >= 0);
assertBusy('review-notes/claims.tex');
assert.equal(JSON.parse(pending[queuedIndex].options.body).path, 'review-notes/claims.tex');
const queuedBuild = ws.compiling;
await answer('/compile-active', activeResponse(7));
await queuedBuild;
assertIdle();
assert.equal(ws.activeFilePreview.at, 7);
const previousPdf = current();
const failed = ws.compile({ live: true });
await answer('/compile-active', { ok: false, errors: ['bad LaTeX'], log: 'bad LaTeX' });
await failed;
assertIdle();
assert.equal(current(), previousPdf, 'failure leaves last good preview intact');
assert.match(ws.previewInfo.textContent, /Update failed.*previous PDF/);
assert.match(ws.buildInfo.textContent, /error/);
const thrown = ws.compile({ live: true });
const failedIndex = await waitFor('/compile-active');
pending.splice(failedIndex, 1)[0].reject(new Error('save or build unavailable'));
await thrown;
assertIdle();
assert.match(ws.lastBuild.errors[0], /unavailable/);
assert.equal(current(), previousPdf);
// Ordinary Recompile keeps its full-paper target and visible pending state.
const manualBuild = ws.compile();
assertBusy(null);
await answer('/compile', { ok: true, pages: 17, errors: [], log: '', seconds: 1, at: 8 });
await manualBuild;
assertIdle();
assert.equal(ws.pdfMode, 'draft');
assert.equal(current().o.readOnly, false);
const paperLive = ws.compile({ live: true });
assertBusy(null);
ws.compile({ live: true });
await answer('/compile', { ok: true, pages: 17, errors: [], log: '', seconds: 1, at: 9 });
await paperLive;
assert.ok(await waitFor('/compile') >= 0, 'paper edits queue another paper build');
const queuedPaper = ws.compiling;
assertBusy(null);
await answer('/compile', { ok: false, errors: ['paper error'], log: 'paper error' });
await queuedPaper;
assertIdle();
assert.match(ws.buildInfo.textContent, /error/);
assert.equal(pending.length, 0);
console.log('PASS: both build targets show pending status; Live rebuilds displayed target; queued edits and failures clean up safely');
