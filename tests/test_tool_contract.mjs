import {productionModule} from './support/browser-runtime.mjs';
// Public Tool and filetype interfaces: definitions, current context, state and independent contributions.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
class Element {
  constructor(tag){this.tag=tag;this.attributes={};this.children=[];this.events={};this.classList={add(){}};}
  setAttribute(key,value){this.attributes[key]=String(value);}
  getAttribute(key){return this.attributes[key]??null;}
  removeAttribute(key){delete this.attributes[key];}
  append(...children){this.children.push(...children);}
  addEventListener(name,handler){this.events[name]=handler;}
  removeEventListener(name){delete this.events[name];}
  click(){return this.events.click?.();}
  remove(){this.removed=true;}
}
const window={},document={createElement:tag=>new Element(tag),createElementNS:(_ns,tag)=>new Element(tag)};
const context=vm.createContext({window,document});
for (const file of ['toolbar.js','file-types.js']) vm.runInContext(productionModule(file), context);
const {Tool,ToolRegistry}=window.EditorTools;
const definition={id:'save',label:'Save',icon:'save',showText:true,presentation:{background:'soft',size:'compact'},execute:({session})=>session.save(),enabled:({session})=>session.dirty,state:({session})=>({pressed:session.selected,busy:session.busy})};
const old={dirty:true,selected:false,save(){throw Error('stale session');}}, calls=[];
const current={dirty:true,selected:true,busy:true,save(){calls.push('saved');}};
const registry=new ToolRegistry();registry.contribute('custom',definition);
const mount=registry.mount('custom',{session:old,run:fn=>fn()},'Tools');
const button=mount.element.children[0].children[0];
assert.ok(Tool.forControl(button) instanceof Tool);
assert.equal(button.children[1].textContent,'Save');
assert.equal(button.getAttribute('data-tool-background'),'soft');
mount.refresh({session:current,run:fn=>fn()});
button.events.click();assert.deepEqual(calls,['saved']);
assert.equal(button.getAttribute('aria-pressed'),'true');
assert.equal(button.getAttribute('aria-busy'),'true');
assert.equal(button.getAttribute('data-tool-selected'),'true');
current.dirty=false;mount.refresh({session:current,run:fn=>fn()});
button.events.click();assert.deepEqual(calls,['saved'],'disabled commands cannot execute programmatically');
assert.equal(button.disabled,true);
assert.throws(()=>registry.contribute('custom',definition),/already registered/);
assert.throws(()=>new Tool({...definition,label:' '}),/label/);
assert.throws(()=>new Tool({...definition,showText:'yes'}),/showText/);
assert.throws(()=>new Tool({...definition,icon:null,showText:false}),/show text/);
assert.throws(()=>new Tool({...definition,presentation:{background:'arbitrary'}}),/presentation/);
const failures=[];
const failing=new Tool({id:'error',label:'Fail',showText:true,execute:async()=>{throw Error('failure');}});
const failedButton=failing.create({run:async fn=>{try{await fn();}catch(error){failures.push(error.message);}}});
await failedButton.events.click();assert.deepEqual(failures,['failure']);
const declared=new Element('button');declared.click=()=>{throw Error('Synthetic click must not execute an action');};
const action=Tool.bind(declared,{id:'declared',label:'Declared action',showText:true,execute:()=>calls.push('concrete')});
assert.equal(Tool.forControl(declared),action);Tool.activate(declared);assert.equal(calls.at(-1),'concrete');
assert.equal(Tool.adopt,undefined,'automatic legacy handler adapters are removed');
let pointerEvent;
const pointerControl=new Element('button');
Tool.bind(pointerControl,{id:'pointer',label:'Pointer action',showText:true,execute:({event})=>{pointerEvent=event;}});
const originalEvent={clientX:123,clientY:456,target:{name:'child'},preventDefault(){this.prevented=true;}};
Tool.activate(pointerControl,originalEvent);
assert.equal(pointerEvent.clientX,123);assert.equal(pointerEvent.clientY,456);assert.equal(pointerEvent.currentTarget,pointerControl);
pointerEvent.preventDefault();assert.equal(originalEvent.prevented,true);
mount.dispose();assert.equal(mount.element.removed,true);assert.equal(Tool.forControl(button),undefined);
const {FileTypeRegistry}=window.FileTypes;
const types=new FileTypeRegistry();const extensions=['.notes'];const areas=['notes.tools'];
types.register({id:'notes',label:'Notes',extensions,toolbarAreas:areas,open:({launch})=>launch()});
extensions.push('.evil');areas.push('evil');
assert.equal(types.resolve('FILE.NOTES').id,'notes');assert.equal(types.resolve('file.evil'),null);
assert.deepEqual([...types.resolve('file.notes').toolbarAreas],['notes.tools']);
assert.throws(()=>types.register({id:'duplicate',label:'Other',extensions:['.notes'],open(){}}),/already registered/);
let launches=0;types.resolve('a.notes').open({launch:()=>launches++});assert.equal(launches,1);
assert.equal(window.FileTypes.registry.resolve('references.BIB').capabilities.bibliography,true);
const keyboardHost=new Element('section');
let keyboardCalls=0;
const keyboardRegistry=new ToolRegistry().contribute('keys',{id:'save-key',label:'Save',showText:true,shortcut:'Ctrl/Cmd+S',enabled:context=>context.enabled,execute:()=>keyboardCalls++});
const keyboardMount=keyboardRegistry.mount('keys',{keyTarget:keyboardHost,enabled:true,run:fn=>fn()},'Keyboard');
const keyboardEvent=()=>({key:'s',ctrlKey:true,defaultPrevented:false,preventDefault(){this.defaultPrevented=true;},stopPropagation(){}});
keyboardHost.events.keydown(keyboardEvent());assert.equal(keyboardCalls,1);
keyboardMount.refresh({enabled:false,run:fn=>fn()});
const disabledKey=keyboardEvent();keyboardHost.events.keydown(disabledKey);
assert.equal(keyboardCalls,1);assert.equal(disabledKey.defaultPrevented,true,'disabled save reserves its shortcut without invoking the browser');
assert.equal(Tool.matchesShortcut('Ctrl/Cmd+S',{...keyboardEvent(),isComposing:true}),false);
assert.throws(()=>new Tool({...definition,shortcut:'Unknown+S'}),/shortcut/);
keyboardMount.dispose();assert.equal(keyboardHost.events.keydown,undefined);
const viewCalls=[];
const shared=new Tool({id:'shared',label:'Shared operation',showText:true,execute:({name})=>viewCalls.push(name)});
const firstView=shared.create({name:'first',run:fn=>fn()}),secondView=shared.create({name:'second',run:fn=>fn()});
shared.update(firstView,{name:'updated-first',run:fn=>fn()});
Tool.activate(firstView);Tool.activate(secondView);
assert.deepEqual(viewCalls,['updated-first','second'],'one Tool can serve multiple views without context leakage');
console.log('PASS: Tool definitions, presentation, selected state, current-session dispatch, shared-view isolation, disabled guards, recovery, concrete bindings and disposal');
