// Execute shell initialization with real Tool validation before loading the saved registry.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {withToolRuntime} from './support/tool-runtime.mjs';
class Element {
  constructor(tag){this.tag=tag;this.children=[];this.attrs={};this.dataset={};this.style={};const classes=new Set();this.classList={add:k=>classes.add(k),remove:k=>classes.delete(k),contains:k=>classes.has(k),toggle:(k,on)=>on?classes.add(k):classes.delete(k)};}
  setAttribute(k,v){this.attrs[k]=String(v);}
  getAttribute(k){return this.attrs[k]??null;}
  addEventListener(){}
  removeEventListener(){}
  append(...nodes){this.children.push(...nodes);}
  prepend(...nodes){this.children.unshift(...nodes);}
  replaceChildren(...nodes){this.children=nodes;}
  querySelectorAll(){return [];}
}
const nodes=new Map(),saved=[{id:'paper-project',folder:'/fixture/research',name:'Research',available:true}];
const document={documentElement:{dataset:{}},createElement:tag=>new Element(tag),createElementNS:(_,tag)=>new Element(tag),getElementById:id=>{if(!nodes.has(id))nodes.set(id,new Element('div'));return nodes.get(id);}};
const context=vm.createContext({document,console,location:{hash:''},localStorage:{getItem:()=>null},fetch:async()=>({ok:true,json:async()=>({token:'fixture',projects:saved,last_folder:saved[0].folder})})});
vm.runInContext(withToolRuntime(readFileSync(new URL('../static/app.js',import.meta.url),'utf8')).split("window.addEventListener('beforeunload'")[0],context);
const run=source=>vm.runInContext(source,context);
run('globalThis.homeRendered=false;renderProjects=()=>{};empty=()=>{};renderDeskHome=()=>{homeRendered=true;};');
assert.doesNotThrow(()=>run('shell()'),'creation Tools must not abort startup before saved projects load');
await run('startWorkbench()');assert.equal(run('homeRendered'),true);assert.equal(run('projects[0].folder'),saved[0].folder);
assert.equal(nodes.get('folder').value,saved[0].folder);
const directoryDefinition=run("EditorTools.Tool.activate");assert.equal(typeof directoryDefinition,'function');
run("homeRendered=false;api=async()=>{throw Error('Configuration unavailable');};");await run('startWorkbench()');
assert.equal(run('homeRendered'),false);assert.ok(nodes.get('message').children.some(node=>node.textContent==='Configuration unavailable'),'startup errors must be visible rather than silently stopping');
console.log('PASS: shell Tools validate, saved projects load and startup errors reach the visible boundary');
