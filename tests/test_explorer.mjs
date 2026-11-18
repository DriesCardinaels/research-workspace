import {Element,createDocument} from './support/pane-dom.mjs';
// Exercise explorer event routing with real controller and Tool dispatch.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {withPaneRuntime as withToolRuntime} from './support/tool-runtime.mjs';

const document=createDocument();
const context=vm.createContext({document,AbortController,console,innerWidth:1000,innerHeight:800});
vm.runInContext(withToolRuntime(readFileSync(new URL('../static/explorer.js',import.meta.url),'utf8')),context);
const calls=[];let pending,fail=false;
const explorer=new context.ProjectExplorer({action:fn=>pending=fn(),create:(...args)=>calls.push(['create',...args]),reveal:entry=>calls.push(['reveal',entry]),directories:()=>[{parent:'',label:'Project root'},{parent:'target',label:'target'}],change:async(...args)=>{calls.push(args);if(fail)throw Error('Conflict');}});
const source={project:'p',path:'folder/note.tex',name:'note.tex',owner:null,folder:false},target={project:'p',path:'target',name:'target',owner:null,folder:true};
const wrapper=new Element('div'),file=new Element('button');wrapper.append(file);explorer.bind(file,source);
const event=()=>({preventDefault(){this.prevented=true;},stopPropagation(){this.stopped=true;},dataTransfer:{setData(){}}});
const menuEvent=event();file.oncontextmenu({...menuEvent,clientX:20,clientY:30});
assert.deepEqual(document.body.children.at(-1).children.map(n=>n.textContent),['Show in Finder','Rename…','Move to Folder…','Copy Relative Path','Delete…']);
assert.equal(wrapper.children[1].attributes['aria-label'],'Actions for note.tex');
const rootEntry={...target,path:'',name:'Project root'},rootRow=new Element('div');explorer.bind(rootRow,rootEntry);
assert.equal(rootRow.children[0].attributes['aria-label'],'Actions for Project root');
explorer.openMenu(rootEntry,20,30);
let rootMenu=document.body.children.at(-1);
assert.deepEqual(rootMenu.children.map(n=>n.textContent),['New File…','New Folder…','Show in Finder']);
context.EditorTools.Tool.activate(rootMenu.children[2]);await pending;
assert.equal(calls.at(-1)[0],'reveal');assert.equal(calls.at(-1)[1].path,'');
const deleteRootEvent={...event(),key:'Delete'};rootRow.onkeydown(deleteRootEvent);
assert.equal(deleteRootEvent.prevented,undefined,'root cannot be deleted by keyboard');
explorer.openMenu({...source,path:'',document:'review'},20,30);
assert.deepEqual(document.body.children.at(-1).children.map(n=>n.textContent),['Show in Finder'],'managed snapshots support reveal only');
const folder=new Element('summary');explorer.bind(folder,target);
file.ondragstart(event());const over=event();folder.ondragover(over);assert.equal(over.dataTransfer.dropEffect,'move');
folder.ondrop(event());await pending;assert.equal(calls.at(-1)[2],'target/note.tex');
assert.equal(explorer.canDrop({...target,path:'a'}, {...target,path:'a/child'}),false);
assert.equal(explorer.canDrop(source,{...target,owner:'other'}),false);
assert.equal(explorer.canDrop(source,{...target,project:'other'}),false);
assert.equal(explorer.canDrop(source,{...target,path:'folder'}),false);
await explorer.edit(source,'rename');let dialog=document.body.children.at(-1),form=dialog.children[0];
const input=form.querySelector('input');input.value='renamed.tex';await form.events.submit(event());
assert.equal(calls.at(-1)[2],'folder/renamed.tex');assert.equal(dialog.open,false);
fail=true;await explorer.edit(source,'delete');dialog=document.body.children.at(-1);form=dialog.children[0];await form.events.submit(event());
assert.equal(dialog.open,true);assert.equal(form.querySelector('[role=alert]').textContent,'Conflict');
console.log('PASS: explorer menu, left-click control, drag routing, cycle/root checks, rename and recoverable dialog errors');
// Verify the real application's save boundary precedes every filesystem request.
const nodes=new Map();document.documentElement={dataset:{}};
document.getElementById=id=>{if(!nodes.has(id))nodes.set(id,new Element('div'));return nodes.get(id);};
context.localStorage={getItem:()=>null,removeItem(){}};
vm.runInContext(readFileSync(new URL('../static/app.js',import.meta.url),'utf8').split("window.addEventListener('beforeunload'")[0],context);
vm.runInContext(`
project={id:'p',folder:'/project'};globalThis.order=[];
flush=async()=>order.push('flush');draftView={unsaved:true,saveAll:async()=>{order.push('save');draftView.unsaved=false;}};
leaveDeskFile=async()=>order.push('leave');renderProjects=()=>{};renderProjectOverview=()=>{};
api=async(path,options)=>{order.push('api');globalThis.payload=JSON.parse(options.body);return {destination:payload.destination};};
refresh=async()=>order.push('refresh');message=()=>{};
`,context);
context.entry=source;
await vm.runInContext(`projectExplorer().change(entry,'move','target/note.tex')`,context);
assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(order)',context)),['flush','save','leave','api','refresh']);
assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(payload)',context)),{path:'folder/note.tex',operation:'move',destination:'target/note.tex',source_document:null});
vm.runInContext(`order=[];flush=async()=>{throw Error('Unsaved edits');};`,context);
await assert.rejects(vm.runInContext(`projectExplorer().change(entry,'delete')`,context),/Unsaved edits/);
assert.equal(vm.runInContext('order.length',context),0,'failed saves cannot close the view or mutate disk');
console.log('PASS: real application saves before mutation and failed saves prevent all disk requests');

// Native file drops and folder actions must retain the exact import destination.
const imported=[],selected=[];
const importExplorer=new context.ProjectExplorer({action:fn=>pending=fn(),
  import:(entry,files)=>imported.push({entry,files}),select:entry=>selected.push(entry)});
const destinationRow=document.createElement('summary');importExplorer.bind(destinationRow,target);
destinationRow.onclick();assert.equal(selected[0].path,'target');
const nativeDrag=event();nativeDrag.dataTransfer.types=['Files'];destinationRow.ondragover(nativeDrag);
assert.equal(nativeDrag.dataTransfer.dropEffect,'copy');assert.equal(nativeDrag.stopped,true);
const nativeDrop=event();nativeDrop.dataTransfer.files=[{name:'paper.pdf'},{name:'notes.md'}];
destinationRow.ondrop(nativeDrop);await pending;
assert.equal(imported[0].entry.path,'target');assert.equal(imported[0].files[0].name,'paper.pdf');
assert.equal(nativeDrop.stopped,true,'folder imports cannot bubble into root imports');
importExplorer.openMenu(target,20,30);
const importAction=document.body.children.at(-1).children.find(button=>button.textContent==='Import Files…');
assert.ok(importAction);context.EditorTools.Tool.activate(importAction);await pending;
assert.equal(imported[1].entry.path,'target');assert.equal(imported[1].files,undefined);
console.log('PASS: native folder drops, folder selection and context-menu imports preserve their destination');

// Existing archive-only PDFs must expose the same actions as ordinary disk files.
vm.runInContext(`
  navigationIcon=()=>document.createElement('span');fileBadge=()=>document.createElement('span');
  globalThis.pdfTree=document.createElement('div');
  appendTree(pdfTree,[{kind:'pdf',name:'book.pdf',path:'book.pdf',document:'review'}],project,'p',null);
  flush=async()=>{};
`,context);
const legacyPdf=vm.runInContext('pdfTree.children[0].children[0]',context);
assert.equal(legacyPdf.draggable,true,'existing managed PDFs cannot remain locked in the tree');
assert.equal(legacyPdf.getAttribute('data-tooltip-delay'),'1500','file labels use a deliberate hover delay');
legacyPdf.oncontextmenu({...event(),clientX:20,clientY:30});
assert.deepEqual(document.body.children.at(-1).children.map(button=>button.textContent),
  ['Show in Finder','Rename…','Move to Folder…','Copy Relative Path','Delete…']);
await vm.runInContext(`projectExplorer().change({project:'p',path:'book.pdf',name:'book.pdf',owner:null,document:'review'},'move','books/book.pdf')`,context);
assert.equal(vm.runInContext('payload.document',context),'review','moves must identify the archive review to preserve history');
assert.equal(vm.runInContext('payload.destination',context),'books/book.pdf');
console.log('PASS: legacy PDFs support dragging, rename, move and delete with review-aware mutation routing');
