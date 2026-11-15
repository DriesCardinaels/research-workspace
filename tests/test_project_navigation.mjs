import {withFileTypeCatalog} from './support/filetype-runtime.mjs';
import {withToolRuntime} from './support/tool-runtime.mjs';
// Project/file routing and failed-save protection, using the real app functions.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const elements=new Map(), storage=new Map();
class Element {
  /** Minimal DOM node. Pre: tag; post: tree node supporting navigation rendering. */
  constructor(tag){this.tag=tag;this.children=[];this.attributes={};const classes=new Set();this.classList={add:k=>classes.add(k),remove:k=>classes.delete(k),toggle:(k,on)=>{if(on)classes.add(k);else classes.delete(k);},contains:k=>classes.has(k)};}
  /** Append children. Pre: nodes; post: ordered children; no external effects. */
  append(...children){this.children.push(...children);}
  /** Replace children. Pre: nodes; post: previous children detached. */
  replaceChildren(...children){this.children=[...children];}
  /** Store accessibility metadata. Pre: string key; post: attribute recorded. */
  setAttribute(key,value){this.attributes[key]=value;}
  /** Remove metadata. Pre: attribute name; post: attribute absent. */
  removeAttribute(key){delete this.attributes[key];}
  /** Find controls. Pre: selector; post: no mock controls outside the rendered tree. */
  querySelectorAll(){return [];}
  addEventListener(name,handler){this['on'+name]=handler;}
}
const document={documentElement:{dataset:{}},getElementById(id){if(!elements.has(id))elements.set(id,new Element('div'));return elements.get(id);},createElement(tag){return new Element(tag);},createElementNS(namespace,tag){return new Element(tag);}};
const context=vm.createContext({document,history:{replaceState(){}},location:{pathname:'/',search:''},localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},console});
const source=withToolRuntime(readFileSync(new URL('../static/app.js',import.meta.url),'utf8')).split("window.addEventListener('beforeunload'")[0];
vm.runInContext(withFileTypeCatalog(readFileSync(new URL('../static/file-types.js',import.meta.url),'utf8')),context);
vm.runInContext(source,context);
const run=code=>vm.runInContext(code,context);
await run(`(async()=>{
  project={id:'one',folder:'/one'};current={id:'paper',name:'paper.pdf'};deskView='file';sidebarMode='project';
  projects=[{...project,name:'Research',available:true},{id:'two',folder:'/two',name:'Reading',available:true}];
  expandedProjects.add('one');
  projectTrees.set('one',{children:[{name:'Paper',kind:'paper',document:'paper',children:[
    {name:'main.tex',path:'main.tex',type:'tex',kind:'file'},
    {name:'paper.pdf',kind:'pdf',document:'paper'}]}]});
  renderProjects();
})()`);
const all=node=>[node,...node.children.flatMap(all)];
assert.equal(elements.get('workspaceProjects').children.length,2);
assert.equal(elements.get('projectTree').children.length,1);
assert.equal(all(elements.get('projectTree')).filter(n=>n.tag==='details').length,1);
assert.equal(all(elements.get('projectTree')).filter(n=>n.tag==='button').length,2);
assert.ok(all(elements.get('projectTree')).some(n=>n.attributes['aria-current']==='page'));
assert.equal(elements.get('workspaceSidebar').hidden,true,'project navigation replaces workspace navigation');
assert.equal(elements.get('documentSidebar').hidden,false);
assert.equal(elements.get('sidebarFiles').attributes['aria-pressed'],'true');
await run(`(async()=>{
  globalThis.retained={unsaved:true};draftView=retained;
  await switchSidebar('workspace');
})()`);
assert.equal(run('deskView'),'file','navigation toggle does not close the active file');
assert.equal(run('draftView===retained'),true,'navigation toggle retains unsaved source buffers');
assert.equal(elements.get('workspaceSidebar').hidden,false);
assert.equal(elements.get('documentSidebar').hidden,true);
await run("switchSidebar('project')");
assert.equal(run('draftView===retained'),true);
assert.equal(elements.get('workspaceSidebar').hidden,true);
assert.equal(elements.get('documentSidebar').hidden,false);
assert.equal(elements.get('sidebarProjects').attributes['aria-pressed'],'false');

await run(`(async()=>{
  globalThis.calls=[];
  draftView={status:{linked:true},file:'main.tex',openFile:async f=>calls.push(['source',f])};
  openDocument=async(d,opts)=>calls.push(['document',d.id,opts?.review]);
  await openTreeFile(project,{kind:'pdf',document:'paper'},'paper');
})()`);
assert.deepEqual(JSON.parse(run('JSON.stringify(calls)')),[['document','paper',true]],'PDF entries explicitly open full annotation tools');
await run(`(async()=>{
  calls=[];
  await openTreeFile(project,{kind:'file',type:'tex',path:'Source/main.tex',source_path:'main.tex'},'paper');
})()`);
assert.deepEqual(JSON.parse(run('JSON.stringify(calls)')),[['source','main.tex']],'same-paper source selection reuses the existing workspace');
assert.equal(JSON.parse(storage.get('pdf-editor.open:/one')).file,'main.tex');
await run(`(async()=>{calls=[];await openTreeFile(project,{kind:'file',type:'bib',path:'Source/references.bib',source_path:'references.bib'},'paper');})()`);
assert.deepEqual(JSON.parse(run('JSON.stringify(calls)')),[['source','references.bib']],'BibTeX opens the same editable review workspace');
await run(`(async()=>{const original=openTextTreeFile;openTextTreeFile=async(item,entry,owner,factory,kind)=>calls.push(['standalone',entry.path,kind]);calls=[];await openTreeFile(project,{kind:'file',type:'tex',path:'unlinked.tex'},null);openTextTreeFile=original;})()`);
assert.deepEqual(JSON.parse(run('JSON.stringify(calls)')),[['standalone','unlinked.tex','standalone-source']]);
await run(`(async()=>{
  calls=[];
  draftView={root:{inert:false},unsaved:true,saveAll:async()=>{throw new Error('disk conflict');},destroy:async()=>calls.push('destroy')};
})()`);
await assert.rejects(run('closeDraft()'),/disk conflict/);
assert.equal(run('draftView.root.inert'),false);
assert.equal(run('calls.length'),0,'failed save retains the live editor');
await run(`(async()=>{
  calls=[];
  draftView={root:{inert:false},unsaved:true,saveAll:async()=>{calls.push('save');draftView.unsaved=false;},destroy:async()=>calls.push('destroy')};
  await closeDraft();
})()`);
assert.deepEqual(JSON.parse(run('JSON.stringify(calls)')),['save','destroy']);
assert.equal(run('draftView'),null);
await run(`(async()=>{
  deskView='file';calls=[];
  editor={flush:async()=>false,destroy:async()=>calls.push('destroy')};
})()`);
await assert.rejects(run('showDeskHome()'),/Annotations could not be saved/);
assert.equal(run('deskView'),'file','failed PDF save keeps file navigation active');
assert.equal(run('calls.length'),0);
await run(`(async()=>{
  editor={flush:async()=>{calls.push('flush');return true;},destroy:async()=>calls.push('destroy')};
  await showDeskHome();
})()`);
assert.deepEqual(JSON.parse(run('JSON.stringify(calls)')),['flush','destroy']);
assert.equal(run('deskView'),'home');
assert.equal(elements.get('documentSidebar').hidden,true,'workspace overview hides project files');
assert.equal(elements.get('workspaceSidebar').hidden,false,'workspace overview shows Projects mode');
assert.equal(elements.get('workspaceProjects').children.length,2,'project list remains available in Projects mode');
assert.equal(elements.get('projectTree').children.length,0,'home has no file tree');
assert.equal(elements.get('documentTitle').textContent,'Workspace / Project overview');
await run('showProjectOverview()');
assert.equal(run('deskView'),'project');
assert.equal(elements.get('documentSidebar').hidden,false,'active project restores file sidebar');
assert.equal(elements.get('workspaceSidebar').hidden,true,'active project never shows a second sidebar');
assert.equal(elements.get('projectTree').children.length,1);
assert.equal(elements.get('documentTitle').textContent,'Projects / one');
await run('showDeskHome(true)');
assert.equal(run('deskView'),'recent');
assert.equal(elements.get('documentSidebar').hidden,true,'recent files has no active project sidebar');
run("setTheme('light')");
assert.equal(document.documentElement.dataset.theme,'light');
assert.equal(storage.get('pdf-editor.theme'),'light');
assert.equal(elements.get('themeSelect').value,'light');
run("setTheme('dark')");
assert.equal(document.documentElement.dataset.theme,'dark');
run("setTheme('system')");
assert.equal(document.documentElement.dataset.theme,undefined);
assert.equal(storage.get('pdf-editor.theme'),'system');
// Reproduce the payload returned by a server started between project migration
// and the ownership fix: top-level source and PDF siblings, source has no owner.
await run(`(async()=>{
  project={id:'standalone',folder:'/projects/hallmark-technical-note'};
  projects=[{...project,name:'hallmark-technical-note',available:true}];
  documents=[{id:'active-version',paper_id:'stable-paper',name:'hallmark-technical-note.pdf'}];
  current=null;editor=null;draftView=null;deskView='project';sidebarMode='project';
  globalThis.calls=[];
  globalThis.fetch=async()=>({ok:true,json:async()=>({children:[
    {name:'LaTeX source',kind:'source',children:[
      {name:'main.tex',kind:'file',type:'tex',path:'main.tex'},
      {name:'sections',kind:'folder',path:'sections',children:[
        {name:'methods.tex',kind:'file',type:'tex',path:'sections/methods.tex'}
      ]}
    ]},
    {name:'hallmark-technical-note.pdf',kind:'pdf',document:'active-version'}
  ]})});
  openDocument=async d=>{
    current={...documents[0]};calls.push(['document',d.id]);
    draftView={status:{linked:true},file:null,openFile:async file=>{draftView.file=file;calls.push(['source',file]);}};
  };
  await refreshTree();
})()`);
await all(elements.get('projectTree')).find(n=>n.tag==='button'&&n.title==='main.tex').onclick();
assert.deepEqual(JSON.parse(run('JSON.stringify(calls)')),[['document','active-version'],['source','main.tex']],
  'clicking main.tex must open the linked workspace rather than ask to link it again');
await all(elements.get('projectTree')).find(n=>n.tag==='button'&&n.title==='sections/methods.tex').onclick();
assert.deepEqual(JSON.parse(run('JSON.stringify(calls.at(-1))')),['source','sections/methods.tex'],
  'nested source files inherit the same review owner');
console.log('PASS: workspace overview, contextual file sidebar, recent files, save-guarded home navigation; nested projects, PDF/source routing, source context, remembered file, save-before-switch and failed-save protection');
