// Exercise the concrete removal Tool and real application transitions without deleting user data.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {withToolRuntime} from './support/tool-runtime.mjs';
class Element {
  constructor(tag){this.tag=tag;this.children=[];this.attributes={};this.events={};this.inert=false;const classes=new Set();this.classList={add:name=>classes.add(name),remove:name=>classes.delete(name),contains:name=>classes.has(name),toggle:(name,on)=>{if(on)classes.add(name);else classes.delete(name);}};}
  append(...children){this.children.push(...children);}
  replaceChildren(...children){this.children=children;}
  setAttribute(name,value){this.attributes[name]=String(value);}
  getAttribute(name){return this.attributes[name]??null;}
  removeAttribute(name){delete this.attributes[name];}
  addEventListener(name,handler){this.events[name]=handler;}
  querySelectorAll(){return [];}
}
const elements=new Map(),storage=new Map();
const document={documentElement:{dataset:{}},getElementById(id){if(!elements.has(id))elements.set(id,new Element('div'));return elements.get(id);},createElement:tag=>new Element(tag),createElementNS:(_ns,tag)=>new Element(tag)};
const context=vm.createContext({document,console,history:{replaceState(){}},location:{pathname:'/',search:''},localStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)}});
vm.runInContext(withToolRuntime(readFileSync(new URL('../static/app.js',import.meta.url),'utf8')).split("window.addEventListener('beforeunload'")[0],context);
const run=source=>vm.runInContext(source,context),all=node=>[node,...(node.children||[]).filter(child=>typeof child==='object').flatMap(all)];
run(`
 globalThis.calls=[];globalThis.confirmChoice=true;globalThis.confirm=()=>confirmChoice;
 projects=[{id:'gone',name:'Unavailable',folder:'/missing',available:false},{id:'active',name:'Active',folder:'/active',available:true}];
 project=null;editor=null;draftView=null;textView=null;deskView='home';
 api=async(path,options)=>{calls.push([path,options.method]);return {removed:path.split('/').pop(),projects:projects.filter(item=>item.id!==path.split('/').pop())};};
 expandedProjects.add('gone');projectTrees.set('gone',{children:[]});
 renderProjects();renderDeskHome();
`);
const sidebarControls=all(elements.get('workspaceProjects')).filter(node=>node.getAttribute?.('data-tool-id')==='workspace.remove-project');
assert.equal(sidebarControls.length,2,'all projects, including unavailable roots, have a removal Tool');
const overviewControls=all(elements.get('viewer')).filter(node=>node.getAttribute?.('data-tool-id')==='workspace.remove-project');
assert.equal(overviewControls.length,2,'overview exposes the same concrete Tool');
storage.set('pdf-editor.open:/missing','remembered');
await context.EditorTools.Tool.activate(sidebarControls[0]);
assert.deepEqual(JSON.parse(run('JSON.stringify(calls)')),[['/api/projects/gone','DELETE']]);
assert.equal(run("projects.some(item=>item.id==='gone')"),false);
assert.equal(storage.has('pdf-editor.open:/missing'),false);
assert.equal(run("projectTrees.has('gone')||expandedProjects.has('gone')"),false);
run(`
 project=projects[0];current={id:'paper'};deskView='file';calls=[];
 globalThis.retained={root:{inert:false},unsaved:true,saveAll:async()=>{calls.push('save');throw Error('save refused');},destroy:async()=>calls.push('destroy')};
 draftView=retained;
`);
await assert.rejects(run('removeProject(projects[0])'),/save refused/);
assert.equal(run('draftView===retained'),true);assert.equal(run('retained.root.inert'),false);
assert.deepEqual(JSON.parse(run('JSON.stringify(calls)')),['save']);
run(`retained.saveAll=async()=>{calls.push('save');retained.unsaved=false;};calls=[];api=async()=>{calls.push('delete');throw Error('settings failure');};`);
await assert.rejects(run('removeProject(projects[0])'),/settings failure/);
assert.equal(run('draftView===retained'),true);assert.equal(run('retained.root.inert'),false);
assert.equal(run('project.id'),'active');assert.equal(run('projects.length'),1);
run(`calls=[];confirmChoice=false;`);await run('removeProject(projects[0])');
assert.equal(run('calls.length'),0,'cancel does not save, close or remove anything');
run(`
 confirmChoice=true;retained.unsaved=true;calls=[];
 api=async(path,options)=>{if(retained.unsaved||!retained.root.inert)throw Error('delete before save or editor freeze');calls.push('delete');return {removed:'active',projects:[]};};
`);
await run('removeProject(projects[0])');
assert.deepEqual(JSON.parse(run('JSON.stringify(calls)')),['save','delete','destroy']);
assert.equal(run('project'),null);assert.equal(run('draftView'),null);assert.equal(run('deskView'),'home');
assert.equal(run('retained.root.inert'),false);assert.equal(run('projects.length'),0);
run(`
 projects=[{id:'active',name:'Active',folder:'/active',available:true},{id:'gone',name:'Gone',folder:'/gone',available:false}];
 project=projects[0];current={id:'paper'};deskView='file';draftView=retained;retained.unsaved=true;calls=[];
 api=async(path,options)=>{calls.push(options.method);return {removed:'gone',projects:[projects[0]]};};
`);
await run('removeProject(projects[1])');
assert.deepEqual(JSON.parse(run('JSON.stringify(calls)')),['DELETE']);
assert.equal(run('draftView===retained&&retained.unsaved'),true,'removing another project leaves active unsaved work untouched');
console.log('PASS: overview/sidebar removal Tools, unavailable projects, confirmation, active save guards, failed-request recovery, recent-cache cleanup and inactive editor preservation');
