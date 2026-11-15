import {withToolRuntime} from './support/tool-runtime.mjs';
// Run: node tests/test_markup_sync.mjs
// Real annotator methods, with transport/DOM stubs: remote marks and pending edits.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

let response, sentBody;
const context = vm.createContext({window: {}, console, clearTimeout, setTimeout() {},
  fetch: async (url, options) => {sentBody = options?.body; return response;}});
vm.runInContext(withToolRuntime(readFileSync(new URL('../static/annotator.js', import.meta.url), 'utf8')), context);
const clone = value => JSON.parse(JSON.stringify(value));
const mark = (id, text = '') => ({id, text, color: 'yellow', rects: [{p: 1, x: 1, y: 2, w: 3, h: 4}], comments: []});
const snapshot = (...highlights) => ({version: 1, highlights, strokes: []});

// Build a saved viewer without a DOM. Requires an annotation snapshot; returns isolated
// mutable state using production methods. No I/O occurs until a tested method runs.
function viewer(base) {
  return Object.assign(Object.create(context.window.PdfAnnotator.prototype), {
    o: {annUrl: '/annotations'}, savedAnn: clone(base), ann: clone(base), revision: 1,
    redraw() {}, renderBar() {}, renderList() {}, setStatus(text) {this.status = text;}, doc: {},
  });
}

const base = snapshot(mark('local'));
const a = viewer(base), localObject = a.ann.highlights[0];
a.ann.highlights[0].color = 'blue'; a.dirty = true;
const server = snapshot({...mark('local'), color: 'blue'}, mark('remote'));
response = {ok: true, json: async () => ({annotations: server})};
assert.equal(await a.saveNow(), true);
assert.deepEqual(JSON.parse(sentBody).base, base, 'save includes the last observed server snapshot');
assert.equal(a.ann.highlights.length, 2, 'an API addition survives a visual save');
assert.equal(a.ann.highlights[0], localObject, 'undo entries keep their object identity');
assert.equal(a.dirty, false);
assert.deepEqual(clone(a.savedAnn), server);

// Edits made during a request remain dirty and do not erase the server addition.
const b = viewer(base), sent = clone(b.ann);
b.ann.highlights[0].text = 'typed during save';
b.adoptSavedAnnotations(sent, snapshot(mark('local'), mark('remote')));
assert.equal(b.ann.highlights[0].text, 'typed during save');
assert.deepEqual(Array.from(b.ann.highlights, x => x.id), ['local', 'remote']);
b.ann.highlights.splice(0, 1);
b.adoptSavedAnnotations(snapshot(mark('local'), mark('remote')), snapshot(mark('local'), mark('remote')));
assert.deepEqual(Array.from(b.ann.highlights, x => x.id), ['remote'], 'a deletion made during save stays deleted');

const c = viewer(base);
c.dirty = true;
response = {ok: false, json: async () => ({error: 'Mark changed in another client.'})};
assert.equal(await c.saveNow(), false);
assert.equal(c.dirty, true);
assert.deepEqual(clone(c.ann), base);
assert.match(c.status, /Not saved/);

const d = viewer(base);
response = {ok: true, json: async () => snapshot(mark('local'), mark('api'))};
await d.refreshAnnotations();
assert.equal(d.ann.highlights.length, 2);
d.dirty = true;
response = {ok: true, json: async () => snapshot()};
await d.refreshAnnotations();
assert.equal(d.ann.highlights.length, 2, 'refresh cannot discard unsaved edits');

// Check again after I/O: typing that begins during a request also blocks adoption.
const e = viewer(base);
response = {ok: true, json: async () => {e.dirty = true; return snapshot(mark('remote'));}};
await e.refreshAnnotations();
assert.deepEqual(clone(e.ann), base);

// The application polls only idle views and retries rather than consuming a revision
// while a pending composer prevents refresh. Requires a live view stub; no timers run.
let revision = 'first', refreshes = 0, reloads = 0;
const poll = vm.createContext({
  document: {hidden: false, activeElement: {matches: () => false}},
  draftView: null, editor: {pop: {hidden: true}, async refreshAnnotations() {refreshes++;}},
  current: {id: 'paper'}, project: {id: 'project'}, busy: false,
  api: async () => ({revision}), endpoint: () => '/document', setInterval() {},
});
const appSource = withToolRuntime(readFileSync(new URL('../static/app.js', import.meta.url), 'utf8'));
vm.runInContext(appSource.slice(appSource.indexOf('// Reflect local API writes')), poll);
await poll.refreshApiMarkup(); await poll.refreshApiMarkup();
assert.equal(refreshes, 1, 'unchanged markup does not reload repeatedly');
revision = 'second'; poll.editor.dirty = true;
await poll.refreshApiMarkup(); assert.equal(refreshes, 1);
poll.editor.dirty = false; await poll.refreshApiMarkup(); assert.equal(refreshes, 2);
let pendingReview=true;
poll.draftView = {hasPendingReviewEdits:()=>pendingReview, async reload() {reloads++;}};
await poll.refreshApiMarkup(); assert.equal(reloads, 0, 'a draft reply is never discarded by polling');
pendingReview=false; await poll.refreshApiMarkup(); assert.equal(reloads, 1);
poll.draftView.unsaved = true; revision = 'third';
await poll.refreshApiMarkup(); assert.equal(reloads, 1);
poll.draftView.unsaved = false; await poll.refreshApiMarkup(); assert.equal(reloads, 2);
console.log('PASS: concurrent save merge, undo identity, in-flight edits/deletes, conflicts, idle refresh and typing races');
