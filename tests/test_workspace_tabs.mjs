import {adoptBuffer} from './support/source-buffers.mjs';
import {productionModule} from './support/browser-runtime.mjs';
// Tab activation, close protection and neighbor selection through public workspace methods.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
class Element {
  /** @param {string} tag Tag name. @pre Valid tag. @post Empty node.
   * @return {Element} Node. @throws {void} None. */
  constructor(tag) { this.tag=tag; this.children=[]; this.attrs={}; this.events={}; this.style={}; }
  /** @param {string} k Key. @param {*} v Value. @pre Node exists.
   * @post Attribute stored. @return {void} Nothing. @throws {void} None. */
  setAttribute(k,v) { this.attrs[k]=String(v); }
  /** @param {...Element} nodes Children. @pre Node exists. @post Children appended.
   * @return {void} Nothing. @throws {void} None. */
  append(...nodes) { this.children.push(...nodes); for(const node of nodes)node.parent=this; }
  /** @param {...Element} nodes Children. @pre Node exists. @post Children replaced.
   * @return {void} Nothing. @throws {void} None. */
  replaceChildren(...nodes) { this.children=nodes; for(const node of nodes)node.parent=this; }
  /** @param {string} k Event name. @param {Function} fn Handler. @pre Node exists.
   * @post Handler registered. @return {void} Nothing. @throws {void} None. */
  addEventListener(k,fn) { this.events[k]=fn; }
  /** @param {Element} node Target. @pre Tree exists. @post No change.
   * @return {boolean} Containment. @throws {void} None. */
  contains(node) { return node===this || this.children.some(child=>child.contains(node)); }
  /** @param {void} none No args. @pre Node exists. @post Node detached.
   * @return {void} Nothing. @throws {void} None. */
  remove() { if(this.parent)this.parent.children=this.parent.children.filter(n=>n!==this);this.removed=true; }
  /** @param {string} selector State selector. @pre Node exists. @post No change.
   * @return {boolean} Popup visibility. @throws {void} None. */
  matches(selector) { assert.equal(selector,':popover-open');return !!this.open; }
  /** @param {void} none No args. @pre Node exists. @post Popup visible.
   * @return {void} Nothing. @throws {void} None. */
  showPopover() { this.open=true; }
  /** @param {void} none No args. @pre Node exists. @post Popup hidden.
   * @return {void} Nothing. @throws {void} None. */
  hidePopover() { this.open=false; }
  /** @param {void} none No args. @pre Node exists. @post Focus moved.
   * @return {void} Nothing. @throws {void} None. */
  focus() { document.activeElement=this; }
  /** @param {void} none No args. @pre Node exists. @post No change.
   * @return {object} Menu rectangle. @throws {void} None. */
  getBoundingClientRect() { return {width:210,height:260}; }
  /** @param {string} selector Enabled-button selector. @pre Tree exists. @post No change.
   * @return {Element[]} Enabled buttons. @throws {void} None. */
  querySelectorAll(selector) {
    assert.equal(selector,'button:not(:disabled)');
    return this.children.flatMap(child=>[...(child.tag==='button'&&!child.disabled?[child]:[]),...child.querySelectorAll(selector)]);
  }
  /** @param {string} selector Enabled-button selector. @pre Tree exists. @post No change.
   * @return {Element|undefined} First match. @throws {void} None. */
  querySelector(selector) { return this.querySelectorAll(selector)[0]; }

}
const listeners=new Map();
const document={createElement:tag=>new Element(tag),activeElement:null,
  addEventListener:(name,fn)=>listeners.set(name,fn),
  removeEventListener:(name,fn)=>{if(listeners.get(name)===fn)listeners.delete(name);}};
const window={DraftMatch:{},innerWidth:800,innerHeight:600};
const context=vm.createContext({window,document});
for (const file of ['toolbar','workspace']) vm.runInContext(productionModule(file), context);
const ws=new window.Workspace({action:fn=>fn()});
ws.tabs.push('main.tex','introduction.tex','references.bib');
ws.tabBar=new Element('div'); ws.file='main.tex';
ws.renderTabs();
const labels=()=>ws.tabBar.children.map(e=>e.children[0].textContent);
const original=['main.tex','introduction.tex','references.bib'];
assert.deepEqual(labels(),original);
ws.openFile=async file=>{ws.file=file;ws.renderTabs();};
await ws.tabBar.children[1].children[0].events.click();
assert.equal(ws.file,'introduction.tex');
assert.deepEqual(labels(),original,'activation retains order');
assert.equal(ws.tabBar.children[1].children.some(e=>e.className==='ws-tab-pin'),false,'unpinned tab has no pin icon');
ws.setTabPinned('introduction.tex',true);
assert.equal(ws.isTabPinned('introduction.tex'),true);
assert.deepEqual(labels(),original,'pinning retains order');
assert.equal(ws.tabBar.children[1].children.length,2,'pinned tab has unpin and no close');
await ws.closeTab('introduction.tex');
assert.deepEqual(Array.from(ws.tabs),original,'public close protects pinned tabs');
ws.tabBar.children[1].children[1].events.click();
assert.equal(ws.isTabPinned('introduction.tex'),false);
assert.equal(ws.tabBar.children[1].children.length,2);
assert.equal(ws.tabBar.children[1].children.some(e=>e.className==='ws-tab-pin'),false,'unpin icon click restores close control');
ws.schedulePaper=()=>{}; ws.refreshPaper=()=>{}; ws.run=fn=>fn(); ws.status={main:'main.tex'};
await ws.closeTab('introduction.tex');
assert.equal(ws.file,'references.bib','closing active tab selects the following neighbor');
assert.deepEqual(Array.from(ws.tabs),['main.tex','references.bib']);
assert.deepEqual(labels(),['main.tex','references.bib'],'neighbor activation does not move tabs');
assert.throws(()=>ws.setTabPinned('missing.tex',true),/closed tab/);
assert.equal(ws.pinnedTabs,undefined,'pin state remains private');
console.log('PASS: stable tab order, pin/unpin controls, protected close and adjacent activation');

/** Build an isolated workspace with public source buffers.
 * @param {void} none No arguments. @pre VM initialized. @post New independent tab fixture.
 * @return {Workspace} Workspace. @throws {Error} Fixture construction failure. */
function fixture() {
  const owner=new window.Workspace({action:fn=>fn()});
  owner.tabs.push('a.tex','b.tex','c.tex','d.tex'); owner.file='b.tex';
  owner.tabBar=new Element('div'); owner.schedulePaper=()=>{}; owner.run=fn=>fn();
  owner.openFile=async file=>{owner.file=file;owner.renderTabs();};
  for(const file of owner.tabs)adoptBuffer(owner,file,{saved:'saved',doc:{getValue:()=>file==='c.tex'?'dirty':'saved'}});
  owner.renderTabs(); return owner;
}
/** Mount registered tab menu actions without browser rendering.
 * @param {Workspace} owner Owner. @param {string} file Target tab.
 * @pre Open tab. @post Registry snapshot created.
 * @return {Element[]} Action buttons. @throws {Error} Mount failure. */
function actions(owner,file) {
  return window.EditorTools.registry.mount('workspace.tabs',{owner,file,dismiss:()=>{}},'Tabs').element.children.map(e=>e.children[0]);
}
let owner=fixture(); owner.setTabPinned('a.tex',true);
assert.deepEqual(actions(owner,'b.tex').map(e=>e.textContent),['Close','Close Others','Close to the Right','Close Saved','Close Non-Pinned','Close All','Pin']);
assert.equal(actions(owner,'a.tex')[0].disabled,true,'Close disabled for pinned tab');
assert.equal(actions(owner,'a.tex').at(-1).textContent,'Unpin');
assert.equal(actions(owner,'d.tex')[2].disabled,true,'no tabs to right');
let prompts=0; context.confirm=()=>{prompts++;return false;};
await actions(owner,'b.tex')[4].events.click();
assert.deepEqual(Array.from(owner.tabs),['a.tex','b.tex','c.tex','d.tex'],'batch cancellation changes nothing');
assert.equal(prompts,1,'one confirmation for batch');
context.confirm=()=>true;
await actions(owner,'b.tex')[4].events.click();
assert.deepEqual(Array.from(owner.tabs),['a.tex'],'Close Non-Pinned protects pins');
assert.equal(owner.file,'a.tex');
owner=fixture(); owner.setTabPinned('a.tex',true);
await actions(owner,'b.tex')[1].events.click();
assert.deepEqual(Array.from(owner.tabs),['a.tex','b.tex'],'Close Others protects pinned tabs and target');
owner=fixture(); owner.setTabPinned('d.tex',true);
await actions(owner,'b.tex')[2].events.click();
assert.deepEqual(Array.from(owner.tabs),['a.tex','b.tex','d.tex'],'Close Right excludes pinned tabs');
owner=fixture();
await actions(owner,'b.tex')[3].events.click();
assert.deepEqual(Array.from(owner.tabs),['c.tex'],'Close Saved retains dirty tab');
owner=fixture(); owner.setTabPinned('a.tex',true);
let readOnly, blankDoc;
context.CodeMirror={Doc:text=>({text})};
owner.closeCitePop=()=>{};
owner.cm={swapDoc:doc=>{blankDoc=doc;},setOption:(key,value)=>{assert.equal(key,'readOnly');readOnly=value;}};
await actions(owner,'b.tex')[5].events.click();
assert.deepEqual(Array.from(owner.tabs),[],'explicit Close All includes pinned tabs');
assert.equal(owner.file,null); assert.equal(readOnly,true); assert.equal(blankDoc.text,'');
assert.equal(owner.isTabPinned('a.tex'),false,'closed pins cleared');
assert.equal(owner.files.size,0,'closed file buffers disposed');
owner=fixture(); const snapshot=owner.getOpenTabs();snapshot.reverse();
assert.deepEqual(Array.from(owner.getOpenTabs()),['a.tex','b.tex','c.tex','d.tex'],'public snapshot cannot mutate order');
let target;
owner.openTabMenu=(...args)=>{target=args;};
let prevented=false;
owner.tabBar.children[2].events.contextmenu({preventDefault:()=>{prevented=true;},clientX:42,clientY:63});
assert.equal(prevented,true);assert.deepEqual(target,['c.tex',42,63]);assert.equal(owner.file,'b.tex','context menu does not activate clicked tab');
console.log('PASS: registered context actions, disabled states, batch cancellation, pin protection and empty editor');

owner=fixture();
owner.openTabMenu('b.tex',40,60);
let menu=owner.root.children.at(-1);
assert.equal(menu.attrs.popover,'manual','menu owns dismissal rather than native light-dismiss');
const item=menu.querySelectorAll('button:not(:disabled)').find(e=>e.textContent==='Pin');
listeners.get('pointerdown')({target:item});
assert.equal(menu.open,true,'inside left pointerdown must not dismiss before click');
assert.equal(menu.removed,undefined,'menu remains mounted until click is delivered');
await item.events.click();
assert.equal(owner.isTabPinned('b.tex'),true,'left click executes pin before menu is disposed');
assert.equal(menu.removed,true); assert.equal(listeners.size,0,'action removes outside listener');
owner.openTabMenu('b.tex',40,60); menu=owner.root.children.at(-1);
const disabled=menu.children[0].children[0].children[0];
assert.equal(disabled.disabled,true);
listeners.get('pointerdown')({target:disabled});
assert.equal(menu.open,true,'clicking disabled menu item does not dismiss');
menu.events.keydown({key:'Escape',preventDefault:()=>{}});
assert.equal(menu.removed,true);assert.equal(listeners.size,0,'Escape cleans dismissal listener');
owner.openTabMenu('b.tex',40,60); menu=owner.root.children.at(-1);
listeners.get('pointerdown')({target:new Element('outside')});
assert.equal(menu.removed,true);assert.equal(listeners.size,0,'outside click dismisses and cleans listener');
console.log('PASS: left-pointerdown retains menu until action click; disabled items, Escape and outside dismissal');
