import {withFileTypeCatalog} from './support/filetype-runtime.mjs';
import {withToolRuntime} from './support/tool-runtime.mjs';
// A new editor adapter participates in navigation without adding filetype branches.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const nodes=new Map(),storage=new Map();
const element=()=>({inert:false,children:[],replaceChildren(...children){this.children=children;},setAttribute(){},classList:{add(){},remove(){},toggle(){}}});
const document={documentElement:{dataset:{}},getElementById(id){if(!nodes.has(id))nodes.set(id,element());return nodes.get(id);}};
const context=vm.createContext({document,localStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)},console});
vm.runInContext(withFileTypeCatalog(readFileSync(new URL('../static/file-types.js',import.meta.url),'utf8')),context);
vm.runInContext(withToolRuntime(readFileSync(new URL('../static/app.js',import.meta.url),'utf8')).split("window.addEventListener('beforeunload'")[0],context);
const run=code=>vm.runInContext(code,context);
await run(`
  project={id:'fixture',folder:'/fixture'};projects=[project];current={id:'paper'};draftView=null;
  globalThis.calls=[];globalThis.adapters=[];globalThis.rejectRead=false;
  editor={flush:async()=>{calls.push('pdf-save');return true;},destroy:async()=>calls.push('pdf-dispose')};
  renderProjects=()=>{};
  globalThis.factory=options=>{
    const adapter={root:{inert:false},file:null,sourceDocument:null,unsaved:false,rejectSave:false,
      openFile:async(file,owner)=>{if(rejectRead)throw Error('read refused');adapter.file=file;adapter.sourceDocument=owner;calls.push('open:'+file);},
      saveAll:async()=>{calls.push('text-save');if(adapter.rejectSave)throw Error('save refused');adapter.unsaved=false;},
      destroy:()=>{adapter.disposed=true;calls.push('text-dispose');},reconnect(){},refreshFromDisk:async()=>{},
      mount:async({headerSlot})=>{if(document.getElementById('viewer').children[0]!==adapter.root)throw Error('Editor measured before attachment');if(headerSlot!==document.getElementById('links'))throw Error('Missing shared header');calls.push('mounted');}};
    adapters.push(adapter);return adapter;
  };
  FileTypes.registry.register({id:'notes',label:'Notes',extensions:['.notes'],open:context=>context.openSession(factory)});
  FileTypes.registry.register({id:'other',label:'Other',extensions:['.other'],open:context=>context.openSession(factory)});
`);
await run(`openTreeFile(project,{path:'new.notes',name:'new.notes'},null)`);
assert.deepEqual(JSON.parse(run('JSON.stringify(calls)')),['open:new.notes','pdf-save','pdf-dispose','mounted']);
assert.equal(nodes.get('documentTitle').textContent,'new.notes');
assert.equal(JSON.parse(storage.get('pdf-editor.open:/fixture')).file,'new.notes');
await run(`openTreeFile(project,{path:'second.notes',name:'second.notes'},null)`);
assert.equal(run('adapters.length'),1,'compatible editors reuse buffers');
assert.equal(run('textView.file'),'second.notes');
run('rejectRead=true');
await assert.rejects(run(`openTreeFile(project,{path:'new.other',name:'new.other'},null)`),/read refused/);
assert.equal(run('textView===adapters[0]'),true,'read failure retains the current editor');
assert.equal(run('adapters[1].disposed'),true,'failed candidate is disposed');
run('rejectRead=false;textView.unsaved=true;textView.rejectSave=true');
await assert.rejects(run(`openTreeFile(project,{path:'new.other',name:'new.other'},null)`),/save refused/);
assert.equal(run('textView===adapters[0]'),true,'failed save keeps the old editor and its dirty state');
assert.equal(run('textView.unsaved'),true);
assert.equal(run('adapters[2].disposed'),true);
run('textView.rejectSave=false');
await run(`openTreeFile(project,{path:'new.other',name:'new.other'},null)`);
assert.equal(run('adapters[0].disposed'),true);
assert.equal(run('textView===adapters[3]'),true);
await assert.rejects(run(`openTreeFile(project,{path:'unknown.zzz',name:'unknown.zzz'},null)`),/does not have an editor/);
assert.equal(run('textView===adapters[3]'),true);
console.log('PASS: independent editor registration, compatible-session reuse, remembered identity, failed-read/save protection, candidate cleanup and unknown-file rejection');

// The project tree participates in the shared editor/PDF workspace without note links.
await run(`
  textView=adapters[3];textView.canPreviewProjectPdf=true;textView.unsaved=true;
  globalThis.pdfTargets=[];textView.previewProjectPdf=async(href,name)=>pdfTargets.push({href,name});
  refresh=async()=>calls.push('catalog-refresh');
`);
const beforePdfCalls=JSON.parse(run('JSON.stringify(calls)'));
await run(`openPdfTreeFile(project,{kind:'pdf',document:'book',name:'Book.pdf'},null)`);
assert.equal(run('pdfTargets[0].href'),'/api/projects/fixture/documents/book/original#page=1&kind=context');
assert.equal(run('textView.unsaved'),true,'sidebar PDF opening does not save or discard note edits');
assert.deepEqual(JSON.parse(run('JSON.stringify(calls)')), [...beforePdfCalls,'catalog-refresh']);
await run(`api=async()=>{textView.file='changed.other';return {id:'new-pdf'};}`);
await run(`openPdfTreeFile(project,{kind:'file',type:'pdf',path:'folder/book.pdf',name:'Book.pdf'},null)`);
assert.equal(run('pdfTargets.length'),1,'late PDF resolution cannot replace a newly selected file');
console.log('PASS: sidebar PDFs join the active project workspace and stale resolutions preserve the current file');
