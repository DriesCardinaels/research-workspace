// Project-level PDF pairing uses native document buffers and public host capabilities.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {withBuiltInTools} from './support/tool-runtime.mjs';
/** Minimal host DOM. Pre: trusted element tag. Post: lifecycle/state changes remain observable. */
function element(tag='div') {
 const attributes=new Map(),classes=new Set(),events=new Map();
 const node={tagName:tag.toUpperCase(),children:[],dataset:{},style:{setProperty(){}},value:'',isConnected:false,
  classList:{add:name=>classes.add(name),remove:name=>classes.delete(name),contains:name=>classes.has(name),toggle:(name,on)=>on?classes.add(name):classes.delete(name)},
  setAttribute(name,value){attributes.set(name,value);},getAttribute:name=>attributes.get(name),
  addEventListener:(name,callback)=>events.set(name,callback),removeEventListener(){},
  append(...nodes){for(const child of nodes){child.remove?.();child.parent=this;this.children.push(child);}},
  replaceChildren(...nodes){this.children=[];this.append(...nodes);},remove(){if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);},
  dispatch:name=>events.get(name)?.({target:node}),cloneNode:()=>element(tag)};
 return node;
}
const document={createElement:element,documentElement:{},body:element(),addEventListener(){}};
const context=vm.createContext({window:{document,addEventListener(){}},document,navigator:{userAgent:'',platform:''},localStorage:{getItem:()=>null},URLSearchParams,AbortController,setTimeout,clearTimeout,requestAnimationFrame:callback=>setTimeout(callback,0)});
const load=path=>vm.runInContext(readFileSync(new URL('../static/'+path,import.meta.url),'utf8'),context);
load('vendor/codemirror/codemirror.min.js');
vm.runInContext(withBuiltInTools(readFileSync(new URL('../static/toolbar.js',import.meta.url),'utf8')),context);
const nativeDoc=context.CodeMirror.Doc, editors=[];
context.CodeMirror=Object.assign((container)=>{
 let doc=nativeDoc('');const wrapper=element();container.append(wrapper);
 const editor={getDoc:()=>doc,swapDoc:value=>{doc=value;},on(){},refresh(){},focus(){},getWrapperElement:()=>wrapper};editors.push(editor);return editor;
},{Doc:nativeDoc});
context.window.FileTypes={registry:{resolve:file=>({id:'text',label:'TXT',capabilities:{text:true},toolbarAreas:[]})}};
load('text-editor.js');load('features/notes/sources.js');
context.window.TextEditorViews.register('text',()=>({mode:'note',mount:async()=>{},dispose(){}}));
const previews=[];
context.window.NotePdfPreview={create:initial=>{
 let current=initial;
 const preview={id:'note-pdf',label:'Source PDF',element:element(),viewLabels:{edit:'Notes',split:'Both',preview:'PDF'},targets:[],updates:[],
  update:text=>preview.updates.push(text),show:async target=>preview.targets.push(target),rebind:next=>{current=next;preview.rebound=current.session.file;},dispose:()=>{preview.disposed=true;preview.element.remove();}};
 previews.push(preview);return preview;
}};
const texts=new Map([['chapter-1.txt','First note without any file links'],['chapter-2.txt','Second note']]),writes=[],errors=[];
const base='/api/projects/'+'a'.repeat(32),pdfBase=base+'/documents/'+'b'.repeat(32);
let catalog=[{target:{path:'book.pdf',sourceDocument:null},entry:{name:'book.pdf'},label:'Book / book.pdf',pdf:true,resolvePdf:async()=>pdfBase}];
const host=new context.window.TextWorkspace({base,api:async(url,options)=>{
 const data=options?JSON.parse(options.body):null,path=data?.path||new URL(url,'http://localhost').searchParams.get('path');
 if(data){writes.push(data);texts.set(path,data.text);}return {file:path,text:texts.get(path),sha:'revision'};
},message:error=>errors.push(error),capabilities:()=>({listProjectSources:async()=>catalog,pdfSourceColors:{}})});
await host.openFile('chapter-1.txt');host.root.isConnected=true;await host.mount();
assert.equal(previews.length,1,'sole project PDF opens without any written file/quote link');
assert(previews[0].targets[0].href.startsWith(pdfBase));assert.equal(writes.length,0);
const firstDoc=editors[0].getDoc();firstDoc.replaceRange(' edited',{line:0,ch:firstDoc.getLine(0).length});
await host.openFile('chapter-2.txt');assert.equal(previews.length,1,'PDF remains open when switching notes');
assert.equal(previews[0].rebound,'chapter-2.txt');assert(!previews[0].disposed);
await host.openFile('chapter-1.txt');assert.equal(editors[0].getDoc(),firstDoc,'returning to a note retains its native buffer and undo history');
assert(editors[0].getDoc().getValue().endsWith(' edited'));assert(host.unsaved);assert.equal(writes.length,0);
const picker=host.root.children[1].children[0].children[1],select=picker.children[1];
select.value='';await select.dispatch('change');assert(previews[0].disposed,'None closes PDF without touching unsaved notes');
assert.equal(previews.length,1,'an explicitly cleared PDF is not automatically reopened');
assert.equal(writes.length,0);assert(host.unsaved);
host.destroy();
// Several source PDFs are listed automatically; the workspace never guesses among them.
catalog=[...catalog,{...catalog[0],target:{path:'other.pdf',sourceDocument:null},entry:{name:'other.pdf'},label:'Other PDF'}];
const multi=new context.window.TextWorkspace({base,api:async()=>({file:'chapter-2.txt',text:'Unlinked note',sha:'one'}),message:error=>errors.push(error),capabilities:()=>({listProjectSources:async()=>catalog,pdfSourceColors:{}})});
await multi.openFile('chapter-2.txt');multi.root.isConnected=true;await multi.mount();
assert.equal(previews.length,1,'multiple PDFs wait for a choice');
const multiSelect=multi.root.children[1].children[0].children[1].children[1];assert.equal(multiSelect.children.length,3,'every project PDF appears automatically');
multiSelect.value='1';await multiSelect.dispatch('change');assert.equal(previews.length,2);assert.equal(previews[1].targets[0].name,'other.pdf');
multi.destroy();assert.equal(errors.length,0);
console.log('PASS: automatic project PDF discovery, pairing without links, retained notes/PDF, no implicit writes, explicit clearing, multiple-source choice and cleanup');
