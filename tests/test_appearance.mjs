// Exercise real preference resolution, CSS token output, and Settings events without a server.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../static/appearance.js',import.meta.url),'utf8');
function fixture({saved={},dark=false,denied=false}={}){
  const storage=new Map(Object.entries(saved)),events={},media={matches:dark,addEventListener:(_,fn)=>media.change=fn};
  class Element{
    constructor(tag){this.tagName=tag;this.children=[];this.style={setProperty:(key,value)=>this.style[key]=value};this.dataset={};this.isConnected=true;this.events={};}
    append(...nodes){this.children.push(...nodes);}
    replaceChildren(...nodes){this.children=nodes;}
    setAttribute(name,value){this[name]=value;}
    addEventListener(name,fn){this.events[name]=fn;}
  }
  const root=new Element('html'),footer=new Element('select');
  const context=vm.createContext({document:{documentElement:root,getElementById:()=>footer,createElement:tag=>new Element(tag)},matchMedia:()=>media,addEventListener:(name,fn)=>events[name]=fn,localStorage:{getItem:key=>{if(denied)throw Error('Denied');return storage.get(key);},setItem:(key,value)=>{if(denied)throw Error('Denied');storage.set(key,value);}}});
  vm.runInContext(source,context);context.setTheme=value=>context.WorkbenchAppearance.apply(value);
  return {api:context.WorkbenchAppearance,root,footer,media,storage,events,Element};
}
let f=fixture();
assert.equal(f.root.dataset.theme,'dark');assert.equal(f.root.dataset.colorScheme,'one-dark');
assert.equal(f.root.style['--panel'],'#282c34');assert.equal(f.root.style['--ink'],'#abb2bf');
f.api.select('mocha');assert.equal(f.storage.get('pdf-editor.color-scheme'),'mocha');assert.equal(f.root.style['--panel'],'#1e1e2e');
f=fixture({saved:Object.fromEntries(f.storage)});assert.equal(f.root.dataset.colorScheme,'mocha');
f.api.apply('light');assert.equal(f.root.dataset.colorScheme,'latte');assert.equal(f.root.style['--panel'],'#eff1f5');assert.equal(f.root.style['--ink'],'#4c4f69');assert.equal(f.root.style['--accent'],'#1e66f5');
f.api.select('nord-light');assert.equal(f.root.dataset.colorScheme,'nord-light','selecting a light scheme must update the active light palette');f.api.select('latte');
f.api.select('frappe');assert.equal(f.root.dataset.colorScheme,'latte');f.api.apply('dark');assert.equal(f.root.dataset.colorScheme,'frappe');
f.api.apply('system');assert.equal(f.root.dataset.theme,'light');f.media.matches=true;f.media.change();assert.equal(f.root.dataset.theme,'dark');
f.api.apply('light');f.media.change();assert.equal(f.root.dataset.theme,'light');
f.storage.set('pdf-editor.color-scheme','macchiato');f.api.apply('dark');f.events.storage({key:'pdf-editor.color-scheme'});assert.equal(f.root.dataset.colorScheme,'macchiato');
f.api.select('__proto__');assert.equal(f.root.dataset.colorScheme,'one-dark');
f=fixture({saved:{'pdf-editor.color-scheme':'invalid','pdf-editor.theme':'light'}});assert.equal(f.root.dataset.colorScheme,'latte');f.api.apply('dark');assert.equal(f.root.dataset.colorScheme,'one-dark');
f=fixture({denied:true});assert.doesNotThrow(()=>f.api.select('frappe'));assert.equal(f.root.dataset.colorScheme,'frappe');
const host=new f.Element('dialog'),section=f.api.mount(host),selects=section.children.filter(node=>node.tagName==='select');
assert.equal(selects.length,2);assert.equal(selects[1].children.length,8);
selects[1].value='mocha';selects[1].events.change();assert.equal(f.root.dataset.colorScheme,'mocha');
selects[0].value='light';selects[0].events.change();assert.equal(f.root.dataset.colorScheme,'latte');
assert.equal(selects[0].value,'light');assert.equal(f.footer.value,'light');
const preview=section.children.at(-1);assert.equal(preview.children.length,8);assert.equal(preview['aria-label'],'Catppuccin Latte (default) palette');
// Drive the exact mounted UI path: a light selection must change tokens and preview.
assert.equal(selects[1].children.length,4);
selects[1].value='solarized-light';selects[1].events.change();
assert.equal(f.root.style['--panel'],'#fdf6e3');assert.equal(preview['aria-label'],'Solarized Light palette');
assert.equal(f.root.dataset.colorScheme,'solarized-light');
selects[0].value='dark';selects[0].events.change();assert.equal(selects[1].value,'mocha');
selects[0].value='light';selects[0].events.change();assert.equal(selects[1].value,'solarized-light');
f=fixture({saved:{'pdf-editor.theme':'light','pdf-editor.light-color-scheme':'tokyo-day','pdf-editor.color-scheme':'dracula'}});
assert.equal(f.root.style['--panel'],'#e1e2e7');f.api.apply('dark');assert.equal(f.root.style['--panel'],'#282a36');
f.storage.set('pdf-editor.theme','light');f.storage.set('pdf-editor.light-color-scheme','nord-light');f.events.storage({key:'pdf-editor.light-color-scheme'});
assert.equal(f.root.dataset.colorScheme,'nord-light');
f.api.apply('system');assert.equal(f.root.dataset.colorScheme,'nord-light');f.media.matches=true;f.media.change();assert.equal(f.root.dataset.colorScheme,'dracula');
f.storage.clear();f.events.storage({key:null});assert.equal(f.root.dataset.colorScheme,'one-dark');
for(const [mode,ids] of [['dark',['one-dark','mocha','macchiato','frappe','dracula','nord','tokyo-night','solarized-dark']],['light',['latte','nord-light','tokyo-day','solarized-light']]]){
  f.api.apply(mode);
  for(const id of ids){f.api.select(id);assert.equal(f.root.dataset.colorScheme,id);assert.match(f.root.style['--panel'],/^#[0-9a-f]{6}$/);}
}
f.api.select('__proto__');assert.equal(f.root.dataset.colorScheme,'latte');
console.log('PASS: default palette, persistence, Latte, system changes, cross-tab schemes, invalid storage, storage denial and Settings controls');
