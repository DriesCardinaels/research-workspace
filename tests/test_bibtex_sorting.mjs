import {adoptBuffer} from './support/source-buffers.mjs';
import {withBuiltInTools} from './support/tool-runtime.mjs';
import {withFileTypeCatalog} from './support/filetype-runtime.mjs';
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

document.createElementNS = (_ns, tag) => element();
vm.runInContext(withFileTypeCatalog(readFileSync(new URL('../static/file-types.js', import.meta.url), 'utf8')), context);
vm.runInContext(readFileSync(new URL('../static/bibtex-sorting.js', import.meta.url), 'utf8'), context);
const {BibtexSorting}=window;
const sort=BibtexSorting.sort;
const z='@article{Zulu,title={Z {nested, title}},url={https://example.test/a%20b}}';
const a='@book(alpha, title="A {nested, title}", year=2026)';
assert.equal(sort(z+'\r\n\r\n'+a),a+'\r\n\r\n'+z);
assert.equal(sort(''), '');
assert.equal(sort('% file header\n\n'+z+'\n\n% Alpha entry\n'+a), '% file header\n\n% Alpha entry\n'+a+'\n\n'+z);
assert.equal(sort('% Zulu entry\n'+z+'\n\n% Alpha entry\n'+a), '% Alpha entry\n'+a+'\n\n% Zulu entry\n'+z);
assert.equal(sort(z+' % Z inline\n\n'+a+' % A inline'), a+' % A inline\n\n'+z+' % Z inline');
const macro='@string{venue = "Journal"}';
const preamble='@preamble{"Prefix" # venue}';
const comment='@comment{An anchored block {with @article{fake}}}';
for(const special of [macro,preamble,comment,'@comment(An anchored (nested) block)']){
 const input=z+'\n\n'+special+'\n\n'+z+'\n\n'+a;
 assert.equal(sort(input),z+'\n\n'+special+'\n\n'+a+'\n\n'+z,'special records anchor independently sortable sections');
}
const duplicate='@book{ALPHA,title={Second definition}}';
assert.equal(sort(z+'\n'+a+'\n'+duplicate),a+'\n'+duplicate+'\n'+z,'equal normalized keys retain original order');
assert.equal(sort('@misc{b}\n@misc{a}'),'@misc{a}\n@misc{b}');
const escaped=String.raw`@misc{z,title={Escaped \{brace\} and \"quote\"},note="Quoted ) text"}`;
assert.equal(sort(escaped+'\n'+a),a+'\n'+escaped);
assert.equal(sort(z+'\nUnstructured section text\n'+a),z+'\nUnstructured section text\n'+a);
const referencing='@inproceedings{zchild, title={Child}, crossref={aparent}}';
const parent='@proceedings{aparent,title={Parent}}';
assert.equal(sort(z+'\n'+a+'\n'+referencing+'\n'+z+'\n'+parent),a+'\n'+z+'\n'+referencing+'\n'+parent+'\n'+z,'cross-reference entries anchor dependency ordering');
const literal='@book{z,title={Literal crossref={aparent}}}';
assert.equal(sort(literal+'\n'+a),a+'\n'+literal,'dependency-like text inside a value is not a field');
const unicode='@misc{éclair,title={😀 café}}';
assert.equal(sort(unicode+'\n'+a),a+'\n'+unicode);
for(const text of [z+'\n@book{broken,title={unfinished}', '@book{,title={empty key}}', '@article bad', '@book(bad,title={x}})'])
 assert.throws(()=>sort(text),error=>error.name==='SyntaxError');
assert.throws(()=>sort(null),error=>error.name==='TypeError');
assert.throws(()=>BibtexSorting.edit(z,-1,0),error=>error.name==='RangeError');
const input=z+'\r\n\r\n'+a;
const workspace=new Workspace({message:(text,error)=>{if(error)throw Error(text);}});
workspace.file='references.BIB';
const doc=CodeMirror.Doc(input,'bibtex',0,'\r\n');
adoptBuffer(workspace,workspace.file,{doc,saved:input});
const caret=input.indexOf('nested');doc.setCursor(doc.posFromIndex(caret));
let readonly=false;
workspace.cm={getOption:()=>readonly,getSelection:()=>doc.getSelection(),getValue:()=>doc.getValue(),getCursor:which=>doc.getCursor(which),
 indexFromPos:position=>doc.indexFromPos(position),posFromIndex:index=>doc.posFromIndex(index),
 operation:operation=>operation(),replaceRange:(...args)=>doc.replaceRange(...args),setSelection:(...args)=>doc.setSelection(...args),focus(){}};
const mounted=window.EditorTools.registry.mount('bibtex.tools',{owner:workspace,view:'source',publicContext:workspace.getToolCapabilities()},'Bibliography');
const button=mounted.element.children[0].children[0];
await window.EditorTools.Tool.activate(button);
assert.equal(doc.getValue(),a+'\r\n\r\n'+z);
assert.equal(workspace.unsaved,true,'sorting participates in normal dirty tracking');
assert.equal(doc.indexFromPos(doc.getCursor()),doc.getValue().indexOf('nested',a.length),'caret follows its moved record');
assert.equal(doc.historySize().undo,1,'sorting creates one native undo step');
doc.undo();assert.equal(doc.getValue(),input);doc.redo();assert.equal(doc.getValue(),sort(input));
const history=doc.historySize().undo;
await window.EditorTools.Tool.activate(button);assert.equal(doc.historySize().undo,history,'already sorted files do not gain an undo step');
workspace.file='main.tex';mounted.refresh({owner:workspace,view:'source',publicContext:workspace.getToolCapabilities()});
assert.equal(mounted.element.hidden,true,'the contribution is BibTeX-only');
workspace.file='references.BIB';readonly=true;
doc.setValue(input);const before=doc.getValue();mounted.refresh({owner:workspace,view:'source',publicContext:workspace.getToolCapabilities()});
await window.EditorTools.Tool.activate(button);assert.equal(doc.getValue(),before,'read-only editor refuses mutation');
readonly=false;doc.setValue('@book{broken');const incomplete=doc.getValue();
assert.throws(()=>workspace.editSelection(BibtexSorting.edit),error=>error.name==='SyntaxError');
assert.equal(doc.getValue(),incomplete,'validation failures are atomic');
console.log('PASS: BibTeX sorting preserves entries, comments, macros, CRLF and selections; stable ordering, validation atomicity, Tool registration, one-step undo, no-op and read-only behavior');
