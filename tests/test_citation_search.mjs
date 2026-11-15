import {adoptBuffer} from './support/source-buffers.mjs';
import {withToolRuntime} from './support/tool-runtime.mjs';
// Exercise real CodeMirror 5.65.16 documents and public bibliography/search operations.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
class Element {
  constructor(tag){this.tag=tag;this.children=[];this.style={};this.events={};this.value='';this.clientWidth=600;this.clientHeight=600;}
  setAttribute(k,v){this[k]=v;}
  append(...children){this.children.push(...children);}
  appendChild(child){this.append(child);return child;}
  replaceChildren(...children){this.children=children;}
  addEventListener(k,v){this.events[k]=v;}
  scrollIntoView(){}
  cloneNode(){return new Element(this.tag);}
  contains(target){return this===target || this.children.some(child=>child.contains?.(target));}
  remove(){this.removed=true;}

}
const document={createElement:tag=>new Element(tag),createTextNode:text=>({textContent:text}),documentElement:{},body:new Element('body'),events:{},addEventListener(k,v){this.events[k]=v;},removeEventListener(k,v){if(this.events[k]===v)delete this.events[k];}};
const window={document,DraftMatch:{},events:{},addEventListener(k,v){this.events[k]=v;},removeEventListener(k,v){if(this.events[k]===v)delete this.events[k];}};
const context=vm.createContext({window,document,navigator:{userAgent:'',platform:''},setTimeout,clearTimeout});
vm.runInContext(readFileSync(new URL('../static/vendor/codemirror/codemirror.min.js',import.meta.url),'utf8'),context);
vm.runInContext(withToolRuntime(readFileSync(new URL('../static/workspace.js',import.meta.url),'utf8')),context);
const {CodeMirror}=context,{Workspace}=window,calls=[];
let bib='@article{barker2026, title={Current buffer}}';
const workspace=new Workspace({base:'/draft',api:async(path,options)=>{
  calls.push(path);
  assert.equal(path,'/api/bibliography/entries');
  assert.equal(JSON.parse(options.body).text,bib);
  return {entries:[{key:'barker2026',title:'Current buffer',author:'Barker',year:'2026'}, {key:'smith2020',title:'Other work',author:'Smith',year:'2020'}]};
}});
workspace.cites={bib_files:['references.bib'],entries:[{key:'stale'}]};
workspace.file='main.tex';workspace.editorHost=new Element('div');
adoptBuffer(workspace,'references.bib',{doc:{getValue:()=>bib}});
adoptBuffer(workspace,'unlinked.bib',{text:'',doc:{getValue:()=>{throw Error('Unlinked files must never be read');}}});
await assert.rejects(workspace.bibliographyEntries('unlinked.bib'),/not linked/);
let doc=new CodeMirror.Doc('See~\\cite{');doc.setCursor({line:0,ch:doc.getValue().length});
const keymaps=[], listeners=new Map();
let coords={bottom:20,left:20}, scroll={top:0}, focused=true, readOnly=false;
const emit=(event,...args)=>{for(const fn of listeners.get(event)||[])fn(workspace.cm,...args);};
workspace.cm={getCursor:()=>doc.getCursor(),getLine:line=>doc.getLine(line),somethingSelected:()=>doc.somethingSelected(),
  on(event,fn){if(!listeners.has(event))listeners.set(event,new Set());listeners.get(event).add(fn);},off(event,fn){listeners.get(event).delete(fn);},
  getOption:()=>readOnly,hasFocus:()=>focused,cursorCoords:()=>coords,getScrollInfo:()=>scroll,addKeyMap:map=>keymaps.push(map),removeKeyMap:map=>keymaps.splice(keymaps.indexOf(map),1),
  replaceRange:(...args)=>doc.replaceRange(...args),focus(){this.focused=true;}};
workspace.updateCitePop(true);
const popup=workspace.editorHost.children[0], search=popup.children[0], options=popup.children[1];
await new Promise(resolve=>setImmediate(resolve));
assert.equal(popup.hidden,false,'typing the opening cite brace exposes search');
assert.equal(search['aria-label'],'Search linked references');
assert.equal(options.children.filter(child=>child.role==='option').length,2);
search.value='BARKER2026';search.events.input();
assert.equal(options.children.filter(child=>child.role==='option').length,1,'bibkey matching is case insensitive');
search.value='Current buffer';search.events.input();
assert.equal(options.children[0].children[0].textContent,'barker2026','titles search unsaved buffers');
search.value='2020';search.events.input();assert.equal(options.children[0].children[0].textContent,'smith2020');
search.value='external unknown';search.events.input();assert.equal(options.children.filter(child=>child.role==='option').length,0);
search.value='barker';search.events.input();
search.events.keydown({key:'Enter',preventDefault(){},stopPropagation(){}});
assert.equal(doc.getValue(),'See~\\cite{barker2026}','selection completes the key and missing closing brace');
assert.equal(popup.hidden,true);assert.equal(keymaps.length,0);
// Existing commas, whitespace and braces survive replacement of the current key.
doc=new CodeMirror.Doc('See~\\cite{first, smi}');doc.setCursor({line:0,ch:19});
workspace.updateCitePop(true);await new Promise(resolve=>setImmediate(resolve));
keymaps[0].Enter();assert.equal(doc.getValue(),'See~\\cite{first, smith2020}');
// Closing while loading cannot resurrect a stale popup.
let release;workspace.bibliographyEntries=()=>new Promise(resolve=>release=resolve);
doc=new CodeMirror.Doc('~\\cite{');doc.setCursor({line:0,ch:7});workspace.updateCitePop(true);await new Promise(resolve=>setImmediate(resolve));workspace.closeCitePop();release([]);
await new Promise(resolve=>setImmediate(resolve));assert.equal(popup.hidden,true);
workspace.bibliographyEntries=async()=>{throw Error('Bibliography unavailable');};
workspace.updateCitePop(true);await new Promise(resolve=>setImmediate(resolve));
assert.equal(options.children[0].textContent,'Bibliography unavailable');
assert.ok(calls.every(path=>path==='/api/bibliography/entries'),'autocomplete never contacts OpenAlex or saves source');
// Public controller works independently of Workspace, owns events and releases everything.
workspace.closeCitePop();
listeners.clear();
const host=new Element('div');
const node=(tag,attrs,...children)=>{
  const element=new Element(tag);
  for(const [key,value] of Object.entries(attrs||{})) {
    if(key.startsWith('on'))element.addEventListener(key.slice(2),value);
    else if(key==='text')element.textContent=value;
    else element.setAttribute(key,value);
  }
  element.append(...children);return element;
};
let pending=[], enabled=true;
const controller=new window.CitationPopup({editor:workspace.cm,host,node,enabled:()=>enabled,
  entries:()=>new Promise((resolve,reject)=>pending.push({resolve,reject}))});
emit('changes',[{origin:'+input'}]);await new Promise(resolve=>setImmediate(resolve));
const view=host.children[0], input=view.children[0], list=view.children[1];
pending.shift().resolve(Array.from({length:12},(_,i)=>({key:'key'+i,title:'Title '+i,author:'Author',year:'2026'})));
await new Promise(resolve=>setImmediate(resolve));
assert.notEqual(input['aria-controls'], search['aria-controls'],'multiple editors have independent ARIA identities');
assert.equal(keymaps.length,1);
keymaps[0].Down();assert.equal(list.children[1]['aria-selected'],'true');
keymaps[0].PageDown();assert.equal(list.children[9]['aria-selected'],'true');
keymaps[0].PageDown();assert.equal(list.children[11]['aria-selected'],'true');
keymaps[0].PageUp();keymaps[0].Up();assert.equal(list.children[2]['aria-selected'],'true');
input.events.keydown({key:'PageUp',preventDefault(){},stopPropagation(){}});
coords={bottom:570,left:590};emit('scroll');
assert.equal(view.style.left,'216px');assert.equal(view.style.top,'340px');
scroll={top:700};emit('scroll');assert.equal(view.hidden,true);assert.equal(keymaps.length,0);
scroll={top:0};coords={bottom:20,left:20};
controller.update(true);await new Promise(resolve=>setImmediate(resolve));
const stale=pending.shift();controller.close();controller.update(true);await new Promise(resolve=>setImmediate(resolve));
stale.resolve([{key:'stale'}]);await new Promise(resolve=>setImmediate(resolve));
assert.equal(list.children[0].textContent,'Reading linked bibliography…');
pending.shift().resolve([{key:'fresh'}]);await new Promise(resolve=>setImmediate(resolve));
// Pointer acceptance preserves UTF-16 source offsets and history origin.
doc=new CodeMirror.Doc('😀~\\cite{');doc.setCursor({line:0,ch:doc.getValue().length});controller.update();
list.children[0].events.pointerdown({preventDefault(){}});
assert.equal(doc.getValue(),'😀~\\cite{fresh}');assert.equal(view.hidden,true);
// Swap-document, selection, unsupported file and outside-pointer dismissal.
doc=new CodeMirror.Doc('~\\cite{');doc.setCursor({line:0,ch:7});
controller.update(true);emit('swapDoc');assert.equal(view.hidden,true);
controller.update(true);enabled=false;controller.update();assert.equal(view.hidden,true);enabled=true;
controller.update(true);document.events.pointerdown({target:input});assert.equal(view.hidden,false);
document.events.pointerdown({target:new Element('outside')});assert.equal(view.hidden,true);
// Escape/Tab from search and Enter from editor; read-only and selections reject completion.
controller.update(true);await new Promise(resolve=>setImmediate(resolve));
for(const request of pending)request.resolve([{key:'tabbed'}]);pending=[];
await new Promise(resolve=>setImmediate(resolve));
input.events.keydown({key:'Escape',preventDefault(){},stopPropagation(){}});assert.equal(view.hidden,true);
controller.update(true);await new Promise(resolve=>setImmediate(resolve));
pending.shift().resolve([{key:'tabbed'}]);await new Promise(resolve=>setImmediate(resolve));
input.events.keydown({key:'Tab',preventDefault(){},stopPropagation(){}});
assert.equal(doc.getValue(),'~\\cite{tabbed}');
doc=new CodeMirror.Doc('~\\cite{');doc.setCursor({line:0,ch:7});
controller.update(true);readOnly=true;controller.update();assert.equal(view.hidden,true);readOnly=false;
doc.setSelection({line:0,ch:0},{line:0,ch:7});controller.update(true);assert.equal(view.hidden,true);
doc.setCursor({line:0,ch:7});controller.update(true);
focused=false;document.activeElement=input;emit('blur');
await new Promise(resolve=>setTimeout(resolve,170));assert.equal(view.hidden,false,'search focus retains completion');
document.activeElement=null;emit('blur');await new Promise(resolve=>setTimeout(resolve,170));assert.equal(view.hidden,true);
controller.update(true);await new Promise(resolve=>setImmediate(resolve));
focused=false;emit('blur');controller.dispose();controller.dispose();
for(const request of pending)request.resolve([{key:'late'}]);
await new Promise(resolve=>setTimeout(resolve,170));
assert.equal(view.removed,true);assert.equal(keymaps.length,0);controller.update(true);
assert.equal(view.hidden,true);assert.ok([...listeners.values()].every(set=>set.size===0),'controller listeners removed');
workspace.closeCitePop();
console.log('PASS: linked unsaved bibliography, autocomplete, keyboard/pointer selection, positioning, dismissal, stale reads and disposal');
