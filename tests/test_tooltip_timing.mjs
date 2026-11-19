// Exercise actual tooltip timing and cancellation without wall-clock waits.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {Element} from './support/pane-dom.mjs';

/** Build a tooltip DOM host. Pre: test-owned tag. Post: detached node; no external effects.
 * @returns {Element} Host. @throws {void} None. Related: pane DOM fixture.
 */
function element(tag){
  const node=new Element(tag);
  node.hasAttribute=key=>node.getAttribute(key)!==null;
  node.contains=other=>!!other&&(other===node||node.children.some(child=>child.contains(other)));
  node.matches=selector=>selector.split(',').some(part=>{
    if(part===':popover-open')return false;
    if(part===':focus-visible')return !!node.focusVisible;
    if(part==='[hidden]')return !!node.hidden;
    if(part==='[inert]')return !!node.inert;
    if(part.startsWith('['))return [...part.matchAll(/\[([\w-]+)(?:=([^\]]+))?\]/g)]
      .every(([,key,value])=>value?node.getAttribute(key)===value:node.hasAttribute(key));
    return node.tagName===part.toUpperCase();
  });
  node.closest=selector=>node.matches(selector)?node:node.parentElement?.closest(selector)||null;
  node.getBoundingClientRect=()=>({left:10,top:10,bottom:30,width:100,height:20});
  return node;
}
const body=element('body'),listeners={};
let notifyMutation;
const document={body,createElement:element,addEventListener(type,handler){(listeners[type]??=[]).push(handler);}};
const filename=element('button');filename.tool=true;filename.setAttribute('title','full-file-name.pdf');
filename.setAttribute('data-tooltip-delay','1500');
const folder=element('summary');folder.setAttribute('title','Full folder name');folder.setAttribute('data-tooltip-delay','1500');
const button=element('button');button.tool=true;button.setAttribute('title','Move file');
body.append(filename,folder,button);
let now=0,sequence=0;const timers=new Map();
const context=vm.createContext({document,AbortController,MutationObserver:class{constructor(callback){notifyMutation=callback;}observe(){}disconnect(){}},
  window:{innerWidth:1000,innerHeight:800,addEventListener(){},EditorTools:{Tool:{forControl:node=>node.tool}}},
  setTimeout:(callback,delay)=>{const id=++sequence;timers.set(id,{at:now+delay,callback});return id;},
  clearTimeout:id=>timers.delete(id)});
vm.runInContext(readFileSync(new URL('../static/tool-ui.js',import.meta.url),'utf8'),context);
const ui=new context.window.ToolUI(body),tip=body.children.at(-1);
/** Advance the virtual clock. Pre: pending test timers. Post: due callbacks run once.
 * @returns {void} Nothing. @throws {*} Callback failure. Related: ToolUI's production scheduler.
 */
function advance(milliseconds){
  now+=milliseconds;
  for(const [id,timer] of [...timers])if(timer.at<=now){timers.delete(id);timer.callback();}
}
const hover=target=>body.events.pointerover({target,pointerType:'mouse',buttons:0});
const dispatch=type=>{for(const handler of listeners[type]||[])handler({});};
hover(filename);advance(1499);assert.equal(tip.hidden,true);
advance(1);assert.equal(tip.hidden,false);assert.equal(tip.textContent,'full-file-name.pdf');
assert.equal(tip.style.pointerEvents,'none','filename labels cannot intercept drop targets');
assert.equal(filename.hasAttribute('title'),false,'native title must not bypass the delay');
hover(button);advance(149);assert.equal(tip.hidden,true);advance(1);assert.equal(tip.hidden,false);
assert.equal(tip.style.pointerEvents,'','button tooltip behavior stays unchanged');
hover(folder);advance(1499);assert.equal(tip.hidden,true);advance(1);
assert.equal(tip.textContent,'Full folder name');assert.equal(folder.hasAttribute('title'),false);
hover(filename);advance(500);dispatch('dragstart');advance(2000);assert.equal(tip.hidden,true);
hover(folder);advance(2000);assert.equal(tip.hidden,true,'hovering a drop destination cannot show labels during dragging');
dispatch('dragend');hover(filename);advance(1500);assert.equal(tip.hidden,false);
dispatch('dragover');assert.equal(tip.hidden,true,'native file drags also clear labels');
hover(filename);body.events.pointerout({target:filename,relatedTarget:null});advance(2000);
assert.equal(tip.hidden,true,'leaving a file cancels its pending label');
button.setAttribute('data-tool-group','');button.setAttribute('aria-expanded','false');
hover(button);advance(150);assert.equal(tip.hidden,false);
button.setAttribute('aria-expanded','true');notifyMutation([{type:'attributes',target:button}]);
assert.equal(tip.hidden,true,'opening a toolbar group hides its visible label');
hover(button);advance(150);assert.equal(tip.hidden,true,'the group label stays hidden while the dropdown is open');
button.setAttribute('aria-expanded','false');hover(button);
button.setAttribute('aria-expanded','true');advance(150);
assert.equal(tip.hidden,true,'a pending tooltip also checks whether the group has opened');
button.setAttribute('aria-expanded','false');hover(button);advance(150);
assert.equal(tip.hidden,false,'hover help returns after the group closes');
button.setAttribute('data-tooltip','off');notifyMutation([{type:'attributes',target:button}]);
assert.equal(tip.hidden,true,'opting out dismisses existing help');
hover(button);advance(150);assert.equal(tip.hidden,true,'opted-out controls suppress hover help');
button.focusVisible=true;body.events.focusin({target:button});advance(0);
assert.equal(tip.hidden,true,'visible category labels suppress focus help too');
assert.equal(button.getAttribute('data-tool-info'),'Move file','opting out preserves Tool metadata');
button.removeAttribute('data-tooltip');hover(button);advance(150);assert.equal(tip.hidden,false);
ui.dispose();assert.equal(timers.size,0);
console.log('PASS: delayed filenames and folders, unchanged button timing, native-title removal, drag suppression and timer cleanup');
