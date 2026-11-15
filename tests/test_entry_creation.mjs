import {withFileTypeCatalog} from './support/filetype-runtime.mjs';
import {Element,createDocument} from './support/pane-dom.mjs';
// Exercise the actual creation dialog, extension selector and server payload routing.
import {withPaneRuntime as withToolRuntime} from './support/tool-runtime.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const nodes=new Map();

const document=createDocument();
 document.getElementById=id=>{if(!nodes.has(id))nodes.set(id,document.createElement(/Dialog$|Picker$/.test(id)?'dialog':'div'));const node=nodes.get(id);node.setAttribute('aria-label',id);return node;};
const context=vm.createContext({document,localStorage:{getItem:()=>null},console});
vm.runInContext(withFileTypeCatalog(readFileSync(new URL('../static/file-types.js',import.meta.url),'utf8')),context);
vm.runInContext(withToolRuntime(readFileSync(new URL('../static/app.js',import.meta.url),'utf8')).split("window.addEventListener('beforeunload'")[0],context);
const run=code=>vm.runInContext(code,context);
run(`
project={id:'project',folder:'/project'};deskView='project';
projectTrees.set('project',{children:[
 {name:'sections',path:'sections',kind:'folder',children:[]},
 {name:'Collection',path:'library:one',kind:'folder',children:[]},
 {name:'Paper',kind:'paper',document:'owner',children:[
  {name:'LaTeX source',kind:'source',children:[{name:'nested',path:'nested',kind:'folder',children:[]}]}]}
]});
globalThis.calls=[];globalThis.pending=null;globalThis.fail=false;
refreshTree=async()=>calls.push('refresh');renderProjectOverview=()=>calls.push('overview');message=()=>{};
action=fn=>{pending=fn();};
api=async(path,options)=>{calls.push([path,JSON.parse(options.body)]);if(fail)throw Error('Name exists');return {path:JSON.parse(options.body).name};};
FileTypes.registry.register({id:'custom',label:'Custom',extensions:['.custom'],capabilities:{text:true},open:()=>{}});
`);
const directories=JSON.parse(run('JSON.stringify(creationDirectories(projectTrees.get("project")))'));
assert.equal(directories.length,4,'disk folders and linked source roots are selectable; collections are excluded');
assert.deepEqual(directories.at(-1),{label:'LaTeX source (owner)/nested',parent:'nested',source_document:'owner'});
await run(`showCreateEntry('file')`);
assert.equal(nodes.get('createEntryDialog').open,true);
assert.ok(nodes.get('entryType').children.some(option=>option.value==='.custom'),'new registered providers appear without UI changes');
assert.ok(!nodes.get('entryType').children.some(option=>option.value==='.pdf'),'binary stubs are excluded');
nodes.get('entryName').value='notes';nodes.get('entryType').value='.custom';nodes.get('entryType').onchange();
assert.equal(nodes.get('entryName').value,'notes.custom');
assert.deepEqual(nodes.get('entryName').selection,[0,5],'typing replaces the basename while retaining the selected extension');
nodes.get('entryParent').value='3';
nodes.get('createEntryForm').onsubmit({preventDefault(){}});await run('pending');
assert.deepEqual(JSON.parse(run('JSON.stringify(calls.find(call=>Array.isArray(call)))')),
 ['/api/projects/project/entries',{kind:'file',name:'notes.custom',parent:'nested',source_document:'owner'}]);
assert.equal(nodes.get('createEntryDialog').open,false);
assert.equal(nodes.get('createEntrySubmit').disabled,false);
await run(`showCreateEntry('directory')`);
assert.equal(nodes.get('entryType').hidden,true);
nodes.get('entryParent').value='0';nodes.get('entryName').value='sections';run('fail=true');
nodes.get('createEntryForm').onsubmit({preventDefault(){}});
await assert.rejects(run('pending'),/Name exists/);
assert.equal(nodes.get('createEntryDialog').open,true,'failed creation keeps the form and input');
assert.equal(nodes.get('entryError').textContent,'Name exists');
assert.equal(nodes.get('createEntrySubmit').disabled,false);
console.log('PASS: real directory destinations, linked ownership, registered extension choices, creation payload and recoverable dialog errors');
