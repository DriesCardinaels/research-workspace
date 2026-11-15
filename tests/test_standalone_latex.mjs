import {productionModule} from './support/browser-runtime.mjs';
// Source-only LaTeX must use the real existing Workspace shell, split panes and Tools.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
class Element {
  /** @pre DOM fixture. @post Empty node with normal layout/control state. @throws None. */
  constructor(tag){this.tag=tag;this.children=[];this.attrs={};this.style={};this.events={};this.dataset={};const classes=new Set();this.classList={add:x=>classes.add(x),remove:x=>classes.delete(x),contains:x=>classes.has(x),toggle:(x,on)=>on?classes.add(x):classes.delete(x)};}
  setAttribute(k,v){this.attrs[k]=String(v);if(k.startsWith('data-'))this.dataset[k.slice(5)]=String(v);if(['value','hidden','disabled'].includes(k))this[k]=v;}
  getAttribute(k){return this.attrs[k]??null;}
  removeAttribute(k){delete this.attrs[k];}
  append(...nodes){this.children.push(...nodes);}
  prepend(...nodes){this.children.unshift(...nodes);}
  replaceChildren(...nodes){this.children=nodes;}
  insertBefore(node,other){this.children.splice(this.children.indexOf(other),0,node);}
  addEventListener(k,fn){(this.events[k]||=[]).push(fn);}
  removeEventListener(){}
  querySelectorAll(selector){return this.children.filter(x=>typeof x==='object').flatMap(x=>[...(selector==='button'&&x.tag==='button'?[x]:[]),...x.querySelectorAll(selector)]);}
  matches(){return false;}
  getBoundingClientRect(){return {width:800,left:0,right:800,bottom:40};}
  get firstChild(){return this.children[0];}
  get lastChild(){return this.children.at(-1);}
  remove(){}
  focus(){}
}
const calls=[];let response,pending;
let active;
const CodeMirror=()=>({on(){},off(){},setOption(){},getOption(){return false;},getDoc:()=>active,swapDoc:doc=>{active=doc;},refresh(){},getSelection:()=>'',getValue:()=>active?.getValue()||'',clearGutter(){},operation:fn=>fn(),getScrollInfo:()=>({left:0,top:0}),getCursor:()=>({line:0,ch:0})});
CodeMirror.Doc=text=>({getValue:()=>text,getCursor:()=>({line:0,ch:0}),setCursor(){}});
class PdfAnnotator {
  constructor(options){this.options=options;this.root=new Element('pdf');this.scroller={scrollTop:0,scrollHeight:100};this.scale=1;this.pages=[];calls.push(['pdf',options.pdfUrl]);}
  async open(){calls.push('open-pdf');}
  async destroy(){calls.push('destroy-pdf');}
  relayout(){}
  setScale(){}
}
const window={DraftMatch:{},addEventListener(){},removeEventListener(){},innerWidth:1000};
const context=vm.createContext({window,document:{createElement:tag=>new Element(tag),addEventListener(){},removeEventListener(){}},localStorage:{getItem:()=>null,setItem(){}},CodeMirror,PdfAnnotator,setTimeout,clearTimeout,requestAnimationFrame:fn=>fn(),console,ResizeObserver:class{observe(){}disconnect(){}}});
for (const name of ['toolbar','file-types','workspace','latex-source-session']) vm.runInContext(productionModule(name), context);
context.EditorTools=window.EditorTools;
const sourceStatus={linked:false,source_only:true,selected:'main.tex',main:'main.tex',files:['main.tex','references.bib'],notes:[],changes:[],builds:[],base_number:0,draft_pdf:false};
/** @pre Isolated routes. @post Only source routes are called; no PDF is needed to open. @return Workspace. */
function create(){const options={base:'/api/projects/one',api:async(url,options={})=>{
 calls.push([url,options.method||'GET']);
 if(url.includes('/latex/source'))return {...sourceStatus,draft_pdf:!!response?.ok&&!response.linked,document:response?.document};
 if(url.includes('/text-file'))return {file:'main.tex',text:'source',sha:'sha'};
 if(url.includes('/latex/citations'))return {entries:[],problems:[],bib_files:[],duplicates:[],missing_bib:[]};
 if(url.endsWith('/latex/compile'))return pending?await pending:response;
 throw new Error('Unexpected route '+url);
},message:message=>calls.push(['message',message]),action:command=>command(),onLinked:async result=>calls.push(['linked',result.document.id])};
const session=new window.LatexSourceSession(options);const ws=new window.Workspace({...options,sourceSession:session,token:'token',colors:{}});
// Unrelated text analysis and review painting are covered by their own suites.
for(const name of ['refreshPaper','applyMarks','refreshCiteMarks','renderReview','updateWordCount','setSourceMode','loadCitations'])ws[name]=async()=>{};
ws.readingOrder=async()=>['main.tex'];
return ws;}
const editor=create();await editor.openFile('main.tex');
const header=new Element('nav');
editor.root.isConnected=true;let measured=0;
const refresh=editor.cm.refresh;editor.cm.refresh=()=>{assert.equal(editor.root.isConnected,true);measured++;refresh();};
await editor.mount({headerSlot:header});
assert.ok(measured>0,'first visible frame must measure the source editor after attachment');
assert.equal(header.firstChild,editor.headerTools,'layout Tools belong in the shared document header');
assert.ok(editor instanceof window.Workspace,'source must use the existing editor');
assert.equal(editor.root.className,'ws');assert.equal(editor.left.className,'ws-left');assert.equal(editor.right.className,'ws-right');assert.equal(editor.split.className,'ws-split');
assert.equal(editor.view,'both');assert.equal(editor.left.hidden,false);assert.equal(editor.right.hidden,false);assert.equal(editor.split.hidden,false);
assert.equal(editor.file,'main.tex');assert.equal(editor.pdf,undefined,'split preview exists before a PDF does');
assert.equal(editor.recompileBtn.disabled,false);assert.equal(editor.commentBtn.disabled,true);
assert.ok(editor.toolbars.length>=3,'existing source, build and action Tools are mounted');
assert.equal(calls.some(call=>Array.isArray(call)&&call[0].endsWith('/latex/compile')),false);
await window.EditorTools.Tool.activate(editor.viewSwitch.children[0]);assert.equal(editor.right.hidden,true);
await window.EditorTools.Tool.activate(editor.viewSwitch.children[2]);assert.equal(editor.left.hidden,true);
await window.EditorTools.Tool.activate(editor.viewSwitch.children[1]);assert.equal(editor.right.hidden,false);assert.equal(editor.left.hidden,false);
// Saving remains the existing Workspace operation; build order and linked transition are preserved.
editor.saveAll=async()=>calls.push('save');response={ok:false,errors:['build failed'],log:'failure'};calls.length=0;await editor.compile();assert.equal(calls[0],'save');assert.equal(editor.pdf,undefined);assert.equal(editor.compiling,null);
response={ok:true,linked:false,document:{id:'paper'},seconds:1};calls.length=0;await editor.compile();assert.equal(calls[0],'save');assert.ok(calls.some(call=>call[0]==='pdf'&&call[1].includes('/documents/paper/source-preview')));assert.equal(editor.pdfPane.children[0],editor.pdf.root,'compiled output uses the existing PDF pane');
response={ok:true,linked:true,document:{id:'paper'},file:'main.tex'};calls.length=0;await editor.compile();assert.ok(calls.some(call=>call[0]==='linked'));
editor.reconnect('/api/projects/two');response={ok:false,errors:[],log:'failure'};calls.length=0;await editor.compile();assert.ok(calls.some(call=>call[0]==='/api/projects/two/latex/compile'));
await editor.destroy();
// Closing while a build runs cannot reopen a view or replace a new workspace.
response=undefined;const closed=create();await closed.openFile('main.tex');closed.saveAll=async()=>{};let release;pending=new Promise(resolve=>{release=resolve;});const build=closed.compile();await Promise.resolve();await closed.destroy();calls.length=0;release({ok:true,linked:true,document:{id:'paper'}});await build;assert.equal(calls.length,0);
console.log('PASS: source-only LaTeX reuses the existing Workspace, split panes, toolbar, compile lifecycle and PDF renderer');
