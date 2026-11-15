import {Element,createDocument} from './support/pane-dom.mjs';
// Exercise real repository dialog Tools: failed push and successful-push/failed-refresh states.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {withPaneRuntime as withToolRuntime} from './support/tool-runtime.mjs';

const nodes=new Map();const document=createDocument();
 document.getElementById=id=>{if(!nodes.has(id))nodes.set(id,document.createElement(id==='githubDialog'?'dialog':'button'));const node=nodes.get(id);node.setAttribute('aria-label',id);return node;};
const context=vm.createContext({document,console});
vm.runInContext(withToolRuntime(readFileSync(new URL('../static/app.js',import.meta.url),'utf8')).split("window.addEventListener('beforeunload'")[0],context);
const run=code=>vm.runInContext(code,context);
run(`project={id:'one'};draftView=null;flush=async()=>{};
 globalThis.pushFails=true;globalThis.refreshFails=false;globalThis.reads=0;globalThis.pushes=0;
 api=async(path,options={})=>{
  if(path.endsWith('/push')){pushes++;if(pushFails)throw Error('GitHub rejected SSH authentication.');return {commit:'a'.repeat(40),url:'git@github.com:example/repo.git',branch:'main'};}
  reads++;if(refreshFails&&reads>1)throw Error('Status unavailable');
  return {linked:true,url:'git@github.com:example/repo.git',branch:'main',paper_id:'paper',head:'a'.repeat(40),sources:[{paper_id:'paper',name:'main.pdf'}]};
 };`);
await run('openRepository()');await run("window.EditorTools.Tool.activate(document.getElementById('githubPush'))");
assert.equal(nodes.get('githubStatus').textContent,'Push failed.');assert.match(nodes.get('githubError').textContent,/SSH authentication/);assert.equal(nodes.get('githubDialog').inert,false);assert.equal(run('pushes'),1);
run('pushFails=false;refreshFails=true;reads=0;pushes=0');await run('openRepository()');await run("window.EditorTools.Tool.activate(document.getElementById('githubPush'))");
assert.match(nodes.get('githubStatus').textContent,/^Pushed /);assert.match(nodes.get('githubError').textContent,/push succeeded, but repository status/);assert.equal(run('pushes'),1,'refresh failure must never retry publication');assert.equal(nodes.get('githubDialog').inert,false);
run('refreshFails=false;reads=0;pushes=0');await run('openRepository()');await run("window.EditorTools.Tool.activate(document.getElementById('githubPush'))");assert.match(nodes.get('githubStatus').textContent,/^Pushed /);assert.equal(nodes.get('githubError').textContent,'');
console.log('PASS: repository dialog reports push failure, preserves confirmed success after refresh failure and never retries publication');
