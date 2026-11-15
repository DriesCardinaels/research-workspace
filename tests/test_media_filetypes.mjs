import {productionModule} from './support/browser-runtime.mjs';
// Real providers/Tools/CodeMirror documents plus image decoding and lifecycle seams.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
let decode=async()=>{}, responseError=false;const revoked=[],urls=[],requests=[];
class Element {
  constructor(tag){this.tag=tag;this.children=[];this.attrs={};this.style={};this.events={};this.classList={add(){},remove(){},toggle(){}};this.naturalWidth=640;this.naturalHeight=480;}
  setAttribute(k,v){this.attrs[k]=String(v);this[k]=v;}
  getAttribute(k){return this.attrs[k]??null;}
  removeAttribute(k){delete this.attrs[k];}
  append(...nodes){this.children.push(...nodes);}
  appendChild(node){this.children.push(node);return node;}
  replaceChildren(...nodes){this.children=nodes;}
  addEventListener(k,fn){this.events[k]=fn;}
  removeEventListener(){}
  cloneNode(){return new Element(this.tag);}
  remove(){this.removed=true;}
  getBoundingClientRect(){return {width:parseFloat(this.style.width)||320};}
  decode(){return decode();}
}
const document={createElement:tag=>new Element(tag),createElementNS:(_,tag)=>new Element(tag),createTextNode:text=>({textContent:text}),documentElement:{},body:new Element('body'),addEventListener(){}};
const window={document,addEventListener(){}};
const context=vm.createContext({window,document,navigator:{userAgent:'',platform:''},setTimeout,clearTimeout,AbortController,URLSearchParams,console,URL:{createObjectURL:()=>{const url='blob:'+urls.length;urls.push(url);return url;},revokeObjectURL:url=>revoked.push(url)},fetch:async url=>{requests.push(url);return responseError?{ok:false,json:async()=>({error:'File unavailable'})}:{ok:true,headers:{get:()=>url.toLowerCase().includes('.jpg')||url.toLowerCase().includes('.jpeg')?'image/jpeg':'image/png'},blob:async()=>({})};}});
for (const path of ['vendor/codemirror/codemirror.min','toolbar','file-types','text-editor','json-filetype','image-filetypes']) vm.runInContext(productionModule(path), context);
const registry=window.FileTypes.registry, tools=window.EditorTools;
assert.equal(registry.resolve('FIGURE.JPG').id,'jpeg');assert.equal(registry.resolve('figure.jpeg').id,'jpeg');assert.equal(registry.resolve('figure.PNG').id,'png');assert.equal(registry.resolve('config.JSON').id,'json');
let opened;registry.resolve('config.json').open({openText:()=>{opened='text';}});assert.equal(opened,'text');registry.resolve('photo.jpg').open({openSession:factory=>{opened=factory;}});assert.equal(typeof opened,'function');
// JSON validation is read-only even for numeric values that JSON.stringify would round.
const original='{"big":900719925474099312345,"k":1,"k":2}\r\n';const session=new window.TextSession({file:'data.json',text:original,sha:'revision'},async()=>({sha:'next'}),'workbench-json');let status;
tools.registry.execute('json.tools','json.validate',{session,message:text=>{status=text;},run:command=>command()});assert.equal(status,'Valid JSON.');assert.equal(session.getText(),original);assert.equal(session.unsaved,false);
assert.throws(()=>tools.registry.execute('json.tools','json.validate',{session:{getText:()=>'{invalid'},message(){},run:command=>command()}),error=>error.name==='SyntaxError');
const mode=context.CodeMirror.getMode({},'workbench-json'),stream=new context.CodeMirror.StringStream('{"key":123,"flag":true}'),tokens=[];
while(!stream.eol()){stream.start=stream.pos;tokens.push(mode.token(stream));}assert.ok(tokens.includes('property'));assert.ok(tokens.includes('number'));assert.ok(tokens.includes('atom'));
const host=new window.ImageWorkspace({base:'/api/projects/one',message(){}});const controls=host.root.children[0].children.map(wrapper=>wrapper.children[0]);assert.equal(controls[0].disabled,true);
await host.openFile('figure.png');assert.equal(host.file,'figure.png');assert.equal(host.unsaved,false);assert.equal(controls[0].disabled,false);
let image=host.root.children[1].children[0];assert.equal(image.style.maxWidth,'100%');await tools.Tool.activate(controls[1]);assert.equal(image.style.width,'640px');await tools.Tool.activate(controls[0]);await tools.Tool.activate(controls[3]);assert.equal(image.style.width,'400px');
const retained=image;responseError=true;await assert.rejects(host.openFile('missing.png'),/File unavailable/);assert.equal(host.file,'figure.png');assert.equal(host.root.children[1].children[0],retained);responseError=false;
decode=async()=>{throw Error('bad codec');};await assert.rejects(host.openFile('corrupt.png'),/could not be decoded/);assert.equal(host.file,'figure.png');decode=async()=>{};
await host.openFile('photo.jpg','paper');assert.equal(host.sourceDocument,'paper');assert.ok(requests.at(-1).includes('source_document=paper'));assert.ok(revoked.includes(urls[0]));
host.reconnect('/api/projects/two');await host.refreshFromDisk();assert.ok(requests.at(-1).startsWith('/api/projects/two/'));await host.saveAll();
host.destroy();assert.equal(host.root.children[1].children.length,0);assert.ok(revoked.includes(urls.at(-1)));
// A closed or superseded decode must never publish an image or leak its object URL.
const pendingHost=new window.ImageWorkspace({base:'/api/projects/one',message(){}});let release,started;const decoding=new Promise(resolve=>{started=resolve;});decode=()=>{started();return new Promise(resolve=>{release=resolve;});};const opening=pendingHost.openFile('slow.png');await decoding;const slowUrl=urls.at(-1);pendingHost.destroy();assert.ok(revoked.includes(slowUrl),'closing releases pending decoder URLs immediately');release();await opening;assert.equal(pendingHost.file,undefined);assert.ok(revoked.includes(slowUrl));
console.log('PASS: JPG/JPEG/PNG providers, JSON highlighting/validation, real text preservation, image Tools, failed reads, source roots, session renewal and decode cleanup');
