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
f=fixture({saved:{'pdf-editor.color-scheme':'frappe'}});
const host=new f.Element('dialog'),section=f.api.mount(host);
const all=node=>[node,...node.children.flatMap(all)];
const radios=all(section).filter(node=>node.name==='settingsAppearance');
const paletteRadios=()=>all(section).filter(node=>node.name==='settingsColorScheme');
const choosePalette=value=>{const input=paletteRadios().find(node=>node.value===value);input.checked=true;input.events.change();};
const selectedPalette=()=>paletteRadios().find(node=>node.checked)?.value;
const choose=value=>{const input=radios.find(node=>node.value===value);input.checked=true;input.events.change();};
const samples=all(section).filter(node=>node.className==='appearance-editor');
const swatches=all(section).filter(node=>node.className==='appearance-swatch-chip');
assert.deepEqual(swatches.map(node=>node.style['--swatch-color']),['#303446','#292c3c','#c6d0f5','#8caaee','#ca9ee6']);
assert.equal(radios.length,3);assert.deepEqual(radios.map(node=>node.value),['system','light','dark']);
assert.ok(radios.every(node=>node.type==='radio'&&node.name==='settingsAppearance'));
assert.equal(paletteRadios().length,8);
assert.ok(paletteRadios().every(node=>node.type==='radio'));
assert.equal(selectedPalette(),'frappe');
assert.equal(all(section).filter(node=>node.tagName==='select').length,0);
const paletteSamples=all(section).filter(node=>node.className==='appearance-scheme-preview');
assert.deepEqual(paletteSamples.map(node=>node.style['--sample-base']),['#282c34','#1e1e2e','#24273a','#303446','#282a36','#2e3440','#1a1b26','#002b36']);
assert.equal(paletteSamples[1].style['--sample-mauve'],'#cba6f7');assert.equal(radios[2].checked,true);
// System shows both real saved schemes; Light and Dark show their respective scheme.
assert.equal(samples.length,4);
assert.deepEqual(samples.map(node=>node.style['--sample-base']),['#eff1f5','#303446','#eff1f5','#303446']);
const originalRadios=paletteRadios();
choosePalette('mocha');
assert.deepEqual(paletteRadios(),originalRadios,'scheme changes retain native radio nodes and keyboard focus');
assert.equal(selectedPalette(),'mocha');
assert.equal(f.storage.get('pdf-editor.color-scheme'),'mocha');assert.equal(f.root.dataset.colorScheme,'mocha');
assert.equal(samples[1].style['--sample-base'],'#1e1e2e');assert.equal(samples[3].style['--sample-base'],'#1e1e2e');
choose('light');assert.equal(f.root.dataset.colorScheme,'latte');
assert.deepEqual(radios.map(node=>node.checked),[false,true,false]);assert.equal(f.footer.value,'light');
assert.equal(paletteRadios().length,4);
assert.equal(selectedPalette(),'latte');
assert.deepEqual(all(section).filter(node=>node.className==='appearance-scheme-preview').map(node=>node.style['--sample-base']),['#eff1f5','#eceff4','#e1e2e7','#fdf6e3']);
choosePalette('solarized-light');
assert.equal(f.storage.get('pdf-editor.light-color-scheme'),'solarized-light');
assert.equal(f.root.style['--panel'],'#fdf6e3');assert.equal(f.root.dataset.colorScheme,'solarized-light');
assert.equal(samples[0].style['--sample-base'],'#fdf6e3');assert.equal(samples[2].style['--sample-base'],'#fdf6e3');
assert.deepEqual(swatches.map(node=>node.style['--swatch-color']),['#fdf6e3','#eee8d5','#586e75','#2176b5','#6c71c4']);
choose('dark');assert.equal(selectedPalette(),'mocha');choose('light');assert.equal(selectedPalette(),'solarized-light');
choose('system');assert.equal(f.root.dataset.theme,'light');f.media.matches=true;f.media.change();
assert.equal(f.root.dataset.colorScheme,'mocha');assert.deepEqual(radios.map(node=>node.checked),[true,false,false]);
assert.equal(swatches[0].style['--swatch-color'],'#1e1e2e','system changes update the palette preview');
f.api.apply('light');assert.deepEqual(radios.map(node=>node.checked),[false,true,false],'quick switch keeps previews selected');
radios[2].checked=false;radios[2].events.change();assert.equal(f.root.dataset.theme,'light','unchecked radio events do not change mode');
f.storage.set('pdf-editor.light-color-scheme','nord-light');f.storage.set('pdf-editor.theme','light');f.events.storage({key:'pdf-editor.light-color-scheme'});
assert.equal(selectedPalette(),'nord-light');assert.equal(samples[0].style['--sample-base'],'#eceff4');
const unchecked=paletteRadios().find(node=>node.value==='latte');unchecked.checked=false;unchecked.events.change();
assert.equal(f.root.dataset.colorScheme,'nord-light','unchecked palette events do not apply a scheme');
f.api.unmount(section);f.api.apply('dark');assert.equal(radios[1].checked,true,'unmount releases preview updates');
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
