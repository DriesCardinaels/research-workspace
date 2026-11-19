// Exercise the dictionary manager with inline lifecycle and Tool dispatch.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createDocument} from './support/pane-dom.mjs';
import {withPaneRuntime} from './support/tool-runtime.mjs';
const document = createDocument(), listeners = new Set(), saved = new Map();
const storage = {
  get length(){return saved.size;},key:index=>[...saved.keys()][index],
  getItem:key=>saved.get(key) ?? null,setItem:(key,value)=>saved.set(key,value),removeItem:key=>saved.delete(key),
};
const context = vm.createContext({document,localStorage:storage,
  addEventListener(type,listener){if(type==='storage')listeners.add(listener);},
  removeEventListener(type,listener){if(type==='storage')listeners.delete(listener);},
});context.window = context;
vm.runInContext(withPaneRuntime(readFileSync(new URL('../static/spelling.js',import.meta.url),'utf8')),context);
const {Service,mountDictionary} = context.Spelling, tools = context.EditorTools.Tool;
const service = new Service({storage});
service.addWord('zebraword');service.addWord('aardvarkword');
service.setLanguage('en-GB');service.addWord('britishword');service.setLanguage('en-US');
const origin = document.createElement('button');document.body.append(origin);origin.focus();
let dispose;
const mount = service => {const host=document.createElement('div');document.body.append(host);dispose=mountDictionary(host,{service});return host;};
const removals = dialog => dialog.querySelector('ul').querySelectorAll('button');
let dialog = mount(service), select = dialog.querySelector('select');
assert.equal(select.value,'en-US');
assert.equal(select.getAttribute('aria-label'),'Dictionary language');
assert.deepEqual(dialog.querySelector('ul').querySelectorAll('span').map(node=>node.textContent),['aardvarkword','zebraword']);
assert.equal(removals(dialog)[0].getAttribute('aria-label'),'Remove “aardvarkword” from US English');
const staleRemove = removals(dialog)[0];
await tools.activate(staleRemove);
assert.deepEqual(Array.from(service.listWords()),['zebraword']);
assert.equal(document.activeElement,removals(dialog)[0],'removal moves focus to the next word');
assert.throws(()=>tools.activate(staleRemove),/no concrete Tool/,'replaced row controls are unbound');
select.value='en-GB';select.events.change();assert.equal(service.language,'en-US','browsing does not select spelling language');
assert.equal(dialog.querySelector('ul').querySelector('span').textContent,'britishword');
saved.set('research-workbench.spelling-word.en-GB.anotherword','1');
for(const listener of listeners)listener({key:'research-workbench.spelling-word.en-GB.anotherword',storageArea:storage});
assert.equal(removals(dialog).length,2,'other-tab additions refresh a manager browsing an inactive locale');
saved.delete('research-workbench.spelling-word.en-GB.anotherword');
for(const listener of listeners)listener({key:'research-workbench.spelling-word.en-GB.anotherword',storageArea:storage});
assert.equal(removals(dialog).length,1,'other-tab removals refresh the inactive locale');
await tools.activate(removals(dialog)[0]);
assert.equal(dialog.querySelector('ul').hidden,true);assert.equal(document.activeElement,select);
assert.equal(dialog.querySelector('[role=status]').textContent,'No added words for UK English.');
assert.equal(new Service({storage}).listWords('en-GB').length,0);
assert.deepEqual(Array.from(service.listWords()),['zebraword'],'deletion preserves other languages');
dispose();assert.equal(listeners.size,0);
service.setLanguage('off');dialog=mount(service);assert.equal(dialog.querySelector('select').value,'en-US');
assert.equal(service.language,'off');dispose();assert.equal(listeners.size,0);
// Failed persistent removal retains the visible row, reports a local error and can retry.
const failingStorage = {...storage,removeItem(){throw Error('denied');}};
const failing = new Service({storage:failingStorage});dialog=mount(failing);
await tools.activate(removals(dialog)[0]);assert.equal(removals(dialog).length,1);
assert.match(dialog.querySelector('[role=alert]').textContent,/Could not remove/);
failingStorage.removeItem=key=>saved.delete(key);await tools.activate(removals(dialog)[0]);
assert.equal(removals(dialog).length,0);assert.equal(dialog.querySelector('[role=alert]').textContent,'');dispose();
console.log('PASS: inline dictionary locale browsing, accessible sorted rows, removal and retry, storage refresh, focus, Off default and cleanup');
