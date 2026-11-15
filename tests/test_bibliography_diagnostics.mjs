import {adoptBuffer} from './support/source-buffers.mjs';
import {withBuiltInTools} from './support/tool-runtime.mjs';
import {withToolRuntime} from './support/tool-runtime.mjs';
// Inline bibliography diagnostics: real parser, CodeMirror marks, controlled provider boundary.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
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
vm.runInContext(readFileSync(new URL('../static/bibliography-diagnostics.js', import.meta.url), 'utf8'), context);
const { CodeMirror } = context;
const { Workspace } = window;

const {BibliographyDiagnostics} = window;
const source = '% 😀\r\n@article{k,title={Known paper},year={2025},doi={10.1234/example}}';
/** Parse fixtures with the production server parser.
 * @param {string} text BibTeX. @pre Python is available. @post No files or network change.
 * @return {object} Parsed entries. @throws {Error} Parser process failure.
 */
function parse(text) {
  const result = spawnSync('python3', ['-c', 'import json,sys; from drafts import parse_bib; print(json.dumps({"entries":parse_bib(sys.stdin.read(), detailed=True)}))'], {input:text,encoding:'utf8'});
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
/** Build controlled transport/storage with the real workspace rendering interface.
 * @param {object} options Optional source, storage, scope or provider implementation.
 * @pre CodeMirror and Workspace loaded. @post Isolated editable buffer and controller created.
 * @return {object} Workspace, controller, calls, storage and widget inspection.
 * @throws {Error} Fixture or parser setup failure.
 */
function harness({text = source, storage, scope = 'test', provider} = {}) {
  const values = new Map();
  storage ??= {getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value)};
  const owner = new Workspace({}), calls = [], widgets = [];
  owner.file = 'references.bib';
  const doc = CodeMirror.Doc(text, 'bibtex', 0, text.includes('\r\n') ? '\r\n' : null);
  adoptBuffer(owner,owner.file,{doc,saved:text});
  owner.o = {base:scope, api:async(path, options) => {
    const data = JSON.parse(options.body); calls.push({path,data});
    if (path === '/api/bibliography/entries') return parse(data.text);
    assert.equal(path, '/api/openalex/diagnose');
    if (provider) return provider(data);
    return {state:'matched',warnings:[{code:'openalex-year',field:'year',key:data.key,
      message:'Possible year mismatch: bibliography “2025”; OpenAlex “2026”.',url:'https://openalex.org/W123'}]};
  }};
  owner.cm = {posFromIndex:index=>doc.posFromIndex(index),markText:(...args)=>doc.markText(...args),
    addLineWidget:(line,node)=>{
      const widget={line,node,cleared:false,clear(){this.cleared=true;}};widgets.push(widget);return widget;
    }};
  owner.say = () => {};
  let latest;
  const render = owner.renderBibliographyDiagnostics;
  owner.renderBibliographyDiagnostics = (snapshot,warnings,state) => {
    latest={snapshot,warnings,state};render.call(owner,snapshot,warnings,state);
  };
  const controller = new BibliographyDiagnostics(owner,{storage,delay:10000,interval:0,remoteDelay:0});
  return {owner,doc,controller,calls,storage,widgets,get latest(){return latest;}};
}

// All duplicate occurrences receive key marks, without sending ambiguous keys upstream.
const duplicates = harness({text:source+'\r\n@book{k,title={Other},year=2024}'});
await duplicates.controller.refresh();
assert.equal(duplicates.latest.warnings.length,2);
assert.ok(duplicates.latest.warnings.every(w=>w.code==='duplicate-key'));
assert.equal(duplicates.calls.filter(c=>c.path.includes('openalex')).length,0);
assert.deepEqual(Array.from(duplicates.doc.getAllMarks(),mark=>{
  const {from,to}=mark.find();return duplicates.doc.getRange(from,to);
}),['k','k']);
assert.ok(duplicates.widgets.filter(w=>!w.cleared).length===2,'warnings render inline at both entries');
duplicates.latest.state.onSuppress(duplicates.latest.warnings[0]);
assert.equal(duplicates.latest.warnings.length,0,'duplicate suppression applies to this key and rule');
assert.equal(duplicates.latest.state.suppressed,1);
assert.equal(duplicates.doc.getValue(),source+'\r\n@book{k,title={Other},year=2024}','suppression never edits source');
duplicates.latest.state.onRestore();
assert.equal(duplicates.latest.warnings.length,2);
duplicates.controller.dispose();

const metadata = harness();
await metadata.controller.refresh();
assert.equal(metadata.latest.warnings[0].code,'openalex-year');
assert.equal(metadata.doc.getAllMarks().map(mark=>{
  const {from,to}=mark.find();return metadata.doc.getRange(from,to);
})[0],'{2025}','warning decorates the exact value after Unicode and CRLF');
assert.equal(metadata.calls.filter(c=>c.path.includes('openalex')).length,1);
await metadata.controller.refresh();
assert.equal(metadata.calls.filter(c=>c.path.includes('openalex')).length,1,'unchanged entries reuse cached metadata');
metadata.doc.setValue(metadata.doc.getValue().replace(',year=', ',\r\n  year = '));
await metadata.controller.refresh();
assert.equal(metadata.calls.filter(c=>c.path.includes('openalex')).length,1,'formatting does not spend another lookup');
const mark = metadata.doc.getAllMarks()[0].find();
assert.equal(metadata.doc.getRange(mark.from,mark.to),'{2025}','cached warnings remap to current field locations');
metadata.latest.state.onSuppress(metadata.latest.warnings[0]);
assert.equal(metadata.doc.getAllMarks().length,0,'suppress action clears source underline');
assert.ok(metadata.widgets.every(w=>w.cleared),'suppress action removes inline widgets');
const restored = harness({storage:metadata.storage});
await restored.controller.refresh();
assert.equal(restored.latest.warnings.length,0,'suppression survives a new workspace');
assert.equal(restored.calls.filter(c=>c.path.includes('openalex')).length,0,'cache survives a new workspace');
restored.latest.state.onRestore();
assert.equal(restored.latest.warnings.length,1);
restored.latest.state.onAutomatic(false);
await restored.controller.refresh();
restored.doc.setValue(source.replace('2025','2024'));
await restored.controller.refresh();
assert.equal(restored.calls.filter(c=>c.path.includes('openalex')).length,0,'automatic provider checks can be paused');
await restored.controller.refresh(true);
assert.equal(restored.calls.filter(c=>c.path.includes('openalex')).length,1,'explicit recheck works while automatic checks are paused');
metadata.controller.dispose();restored.controller.dispose();

const failure = harness({provider:async()=>{throw new Error('OpenAlex rate limit reached. Try again later.');}});
await failure.controller.refresh();
assert.equal(failure.latest.warnings.length,0,'provider failures are not bibliography errors');
assert.match(failure.latest.state.error,/rate limit/);
await failure.controller.refresh();
assert.equal(failure.calls.filter(c=>c.path.includes('openalex')).length,1,'failures pause retries');
assert.match(failure.latest.state.error,/paused/);
await failure.controller.refresh(true);
assert.equal(failure.calls.filter(c=>c.path.includes('openalex')).length,2,'explicit retry is available');
failure.controller.dispose();

let release, started;
const waiting = new Promise(resolve=>{started=resolve;});
const stale = harness({provider:()=>new Promise(resolve=>{release=resolve;started();})});
const run = stale.controller.refresh();
await waiting;
stale.doc.setValue(source.replace('2025','2026'));
stale.controller.schedule();
release({warnings:[{code:'openalex-year',field:'year',message:'Old result'}]});
await run;
assert.equal(stale.latest.warnings.length,0,'outdated results cannot decorate edited text');
stale.owner.file='main.tex';
stale.controller.schedule();
assert.equal(stale.owner.getBibliographyToolState().warnings,0,'bibliography state clears on other file types');
stale.controller.dispose();

let resolveClosed, startedClosed;
const closedStarted = new Promise(resolve=>{startedClosed=resolve;});
const closed = harness({provider:()=>new Promise(resolve=>{resolveClosed=resolve;startedClosed();})});
const closedRun = closed.controller.refresh();
await closedStarted;
closed.controller.dispose();
const renderBefore = closed.latest;
resolveClosed({warnings:[{code:'openalex-year',field:'year',message:'Late result'}]});
await closedRun;
assert.equal(closed.latest,renderBefore,'disposed workspace cannot receive late decorations');

let finishComparison, beganComparison;
const began = new Promise(resolve=>{beganComparison=resolve;});
const concurrent = harness({provider:()=>new Promise(resolve=>{finishComparison=resolve;beganComparison();})});
const firstRun = concurrent.controller.refresh();
await began;
concurrent.doc.setValue(source.replace(',year=', ',\r\n  year = '));
const newerRun = concurrent.controller.refresh();
finishComparison({warnings:[{code:'openalex-year',field:'year',message:'Possible year mismatch'}]});
await Promise.all([firstRun,newerRun]);
assert.equal(concurrent.calls.filter(c=>c.path.includes('openalex')).length,1,'formatting during an in-flight check reuses its result');
assert.equal(concurrent.latest.warnings.length,1);
concurrent.controller.dispose();

const noLookup = harness({text:'@misc{unfinished,title={Not closed}'});
await noLookup.controller.refresh();
assert.equal(noLookup.calls.filter(c=>c.path.includes('openalex')).length,0,'incomplete entries do not trigger lookups');
noLookup.controller.dispose();
const blockedStorage = harness({storage:{getItem(){throw Error('blocked');},setItem(){throw Error('blocked');}}});
await blockedStorage.controller.refresh();
assert.match(blockedStorage.latest.state.storageError,/session/);
assert.equal(blockedStorage.latest.warnings.length,1,'storage failures do not disable diagnostics');
blockedStorage.controller.dispose();
// An older still-running server returns entry metadata without the new source ranges.
const olderServer = harness({text:source+'\r\n@book{k,title={Other},year=2024}\r\n@book{third,title={Third},year=2020}'});
const currentApi = olderServer.owner.o.api;
olderServer.owner.o.api = async (path, options) => {
  if (path === '/api/openalex/diagnose') throw Object.assign(new Error('Project session expired. Reopen the project folder.'), {status:404});
  const response = await currentApi(path, options);
  return {entries:response.entries.map(({start,end,key_start,key_end,field_ranges,...metadata})=>metadata)};
};
await olderServer.controller.refresh();
assert.equal(olderServer.latest.warnings.length,2);
assert.deepEqual(Array.from(olderServer.doc.getAllMarks(),mark=>{
  const {from,to}=mark.find();return olderServer.doc.getRange(from,to);
}),['k','k'],'legacy parser metadata must still underline both duplicate keys');
assert.deepEqual(olderServer.widgets.filter(widget=>!widget.cleared).map(widget=>widget.line),[1,2],
  'legacy metadata must put inline warnings next to each duplicate, never at the end of the file');
assert.match(olderServer.latest.state.error,/restart.*server/i,'an unavailable diagnosis route must explain the server mismatch');
olderServer.controller.dispose();

const nestedSource = '% @article{ignored,title={Fake}}\r\n@comment{ @book{alsoIgnored,title={Fake}} }\r\n'
  + '@article(real, % } @book{commented,\r\n title={A {nested, title} 😀}, year={2025}, note="a, b")';
const nested = harness({text:nestedSource});
const nestedApi = nested.owner.o.api;
nested.owner.o.api = async (path,options) => {
  const response = await nestedApi(path,options);
  if (path !== '/api/bibliography/entries') return response;
  return {entries:response.entries.map(({start,end,key_start,key_end,field_ranges,...metadata})=>metadata)};
};
await nested.controller.refresh();
assert.equal(nested.latest.warnings.length,1,'comments and nested values cannot introduce phantom entries');
const nestedMark = nested.doc.getAllMarks()[0].find();
assert.equal(nested.doc.getRange(nestedMark.from,nestedMark.to),'{2025}',
  'client source ranges find field values in parenthesis records with nested braces, quotes and comments');
nested.controller.dispose();
console.log('ok bibliography inline diagnostics, provider checks, cache, suppression, stale results, disposal and recovery');


// Tool-facing state contains immutable data and public operations, never controller callbacks.
const toolbarDiagnostics = harness();
await toolbarDiagnostics.controller.refresh();
const toolState = toolbarDiagnostics.owner.getBibliographyToolState();
assert.equal(Object.isFrozen(toolState), true);
assert.equal(toolState.warnings, 1);
assert.equal('onRecheck' in toolState, false);
toolbarDiagnostics.owner.runBibliographyOperation('automatic', false);
assert.equal(toolbarDiagnostics.owner.getBibliographyToolState().automatic, false);
await toolbarDiagnostics.controller.refresh();
toolbarDiagnostics.owner.runBibliographyOperation('suppress', toolbarDiagnostics.latest.warnings[0]);
assert.equal(toolbarDiagnostics.owner.getBibliographyToolState().warnings, 0);
assert.equal(toolbarDiagnostics.owner.getBibliographyToolState().suppressed, 1);
toolbarDiagnostics.owner.runBibliographyOperation('restore');
assert.equal(toolbarDiagnostics.owner.getBibliographyToolState().warnings, 1);
toolbarDiagnostics.owner.file = 'main.tex';
assert.throws(() => toolbarDiagnostics.owner.runBibliographyOperation('recheck'), /diagnostics are updating/);
toolbarDiagnostics.controller.dispose();
console.log('PASS: toolbar diagnostics use immutable snapshots and public operations; preferences, suppression and stale-file guards remain intact');
