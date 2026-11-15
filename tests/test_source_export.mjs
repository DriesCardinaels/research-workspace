import {productionModule} from './support/browser-runtime.mjs';
// Source ZIP uses a registered Tool, saves first and preserves buffers after errors.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
class Element {
  constructor(tag){this.tag=tag;this.attrs={};this.children=[];this.events={};this.classList={add(){},remove(){},toggle(){}};}
  setAttribute(k,v){this.attrs[k]=v;}
  getAttribute(k){return this.attrs[k]??null;}
  append(...nodes){this.children.push(...nodes);}
  removeAttribute(k){delete this.attrs[k];}
  addEventListener(k,fn){this.events[k]=fn;}
  removeEventListener(){}
  remove(){calls.push('removed');}
  click(){calls.push(['download',this.download]);}
}
const calls=[];const document={createElement:tag=>new Element(tag),createElementNS:(_,tag)=>new Element(tag),body:new Element('body')};
const window={DraftMatch:{}};
const context=vm.createContext({window,document,console,setTimeout:fn=>fn(),URL:{createObjectURL:()=>{calls.push('blob-url');return 'blob:fixture';},revokeObjectURL:()=>calls.push('revoked')}});
for (const name of ['toolbar','file-types','workspace','latex-source-session','source-export']) vm.runInContext(productionModule(name), context);
/** @pre Source transport. @post Workspace exposes only its public export capability. @return Workspace. */
function owner(sourceOnly=true){const options={base:'/api/projects/one/documents/paper/draft',message:text=>calls.push(['message',text]),download:async(path,name,options)=>calls.push(['request',path,name,JSON.parse(options.body)])};
 if(sourceOnly)options.sourceSession=new window.LatexSourceSession({base:'/api/projects/one',api(){throw Error('No source read needed for export');}});
 const ws=new window.Workspace(options);ws.status={main:'main.tex'};ws.root.inert=false;ws.renderTabs=()=>calls.push(['busy',ws.getToolCapabilities().sourceExportBusy]);ws.saveAll=async()=>calls.push('save');return ws;}
const source=owner();await window.EditorTools.registry.execute('workspace.build','source.download-zip',{owner:source,publicContext:source.getToolCapabilities()});
assert.equal(calls[1],'save');assert.equal(calls[2][0],'request');assert.equal(calls[2][1],'/api/projects/one/latex/archive');assert.equal(calls[2][2],'main-source.zip');assert.equal(calls[2][3].path,'main.tex');assert.equal(source.root.inert,false);assert.equal(source.getToolCapabilities().sourceExportBusy,false);
calls.length=0;source.saveAll=async()=>{throw Error('save conflict');};await assert.rejects(source.downloadSourceArchive(),/save conflict/);assert.equal(calls.filter(call=>call[0]==='request').length,0);assert.equal(source.root.inert,false);
calls.length=0;const linked=owner(false);await linked.downloadSourceArchive();assert.equal(calls[2][1],'/api/projects/one/documents/paper/draft/archive');assert.deepEqual(Object.keys(calls[2][3]),[]);
linked.o.download=async()=>{throw Error('compilation failed');};await assert.rejects(linked.downloadSourceArchive(),/compilation failed/);assert.equal(linked.root.inert,false);assert.equal(linked.getToolCapabilities().sourceExportBusy,false);
// Binary downloads validate error/type responses before dispatching a native anchor.
calls.length=0;context.fetch=async(path,options)=>{assert.equal(options.headers['X-PDF-Token'],'current');return {ok:true,headers:{get:()=> 'application/zip'},blob:async()=>({})};};
await window.SourceDownloads.download('/archive','source.zip',{method:'POST',body:'{}'},'current');assert.deepEqual(calls,['blob-url',['download','source.zip'],'removed','revoked']);
calls.length=0;context.fetch=async()=>({ok:false,json:async()=>({error:'compile error'})});await assert.rejects(window.SourceDownloads.download('/archive','source.zip',{},'current'),/compile error/);assert.equal(calls.length,0);
console.log('PASS: source archive Tool, save/build guards, linked/source routes, download errors and object URL cleanup');
