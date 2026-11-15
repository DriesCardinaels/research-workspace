import {withToolRuntime} from './support/tool-runtime.mjs';
// The compile menu must enter the top layer: the real header scrolls horizontally,
// which clips a conventional absolutely positioned dropdown below its bounds.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const ids = new Map();
class El {
  constructor(tag) { this.tag = tag; this.attrs = {}; this.children = []; this.events = {}; this.style = {}; this.open = false; }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') ids.set(String(v), this); }
  append(...xs) { this.children.push(...xs); }
  addEventListener(k, fn) { (this.events[k] ||= []).push(fn); }
  dispatch(k, e = {}) { for (const fn of this.events[k] || []) fn(e); }
  click() { let prevented=false;this.dispatch('click',{preventDefault(){prevented=true;}}); if(prevented)return; const popover = ids.get(this.attrs.popovertarget); if (popover) { if (popover.open) popover.hidePopover(); else popover.showPopover(); } }
  matches(selector) { if (selector === ':focus-visible') return !!this.keyboardFocus; assert.equal(selector, ':popover-open'); return this.open; }
  showPopover() { this.open = true; this.dispatch('beforetoggle', { newState: 'open' }); this.dispatch('toggle'); }
  hidePopover() { this.open = false; this.dispatch('beforetoggle', { newState: 'closed' }); this.dispatch('toggle'); }
  getBoundingClientRect() { return this.className === 'ws-compile-controls' ? { left: 640, right: 790, width: 150, bottom: 40 } : { width: parseFloat(this.style.width) || 180, height: 35 }; }
  focus() { this.focused = true; }
}
const listeners = new Map();
const eventTarget = { addEventListener(k, fn) { listeners.set(k, fn); }, removeEventListener(k) { listeners.delete(k); } };
const window = { DraftMatch: {}, innerWidth: 800, innerHeight: 600, ...eventTarget };
vm.runInNewContext(withToolRuntime(readFileSync(new URL('../static/workspace.js', import.meta.url), 'utf8')), {
  window, document: { createElement: (tag) => new El(tag), getElementById:id=>ids.get(id), ...eventTarget },
});
const ws = new window.Workspace({ action: (fn) => fn() });
let compiled = 0;
ws.compileActiveFile = () => { compiled++; };
ws.recompileBtn = new El('button');
const controls = ws.compileOptions();
assert.equal(controls.children[0], ws.recompileBtn, 'the main Recompile button stays attached');
assert.equal(ws.compileMenu.attrs.popover, 'auto', 'menu must escape the scrolling header in the top layer');
ws.compileArrow.click();
assert.equal(ws.compileMenu.open, true);
assert.equal(ws.compileArrow.attrs['aria-expanded'], 'true');
assert.equal(ws.compileMenu.style.top, '39px', 'dropdown overlaps the split button edge to avoid a seam');
assert.equal(ws.compileMenu.style.left, '640px');
assert.equal(ws.compileMenu.style.width, '150px', 'dropdown matches the full split button width');
assert.equal(ws.activeCompileBtn.focused, undefined, 'pointer opening does not force a menu focus ring');
assert.equal(controls.attrs['data-open'], 'true');
assert.equal(ws.compileArrow.children[0].className, 'ws-compile-chevron');
assert.ok(listeners.has('scroll') && listeners.has('resize'));
window.innerWidth = 500;
listeners.get('resize')();
assert.equal(ws.compileMenu.style.left, '342px', 'resize keeps menu inside viewport');
ws.activeCompileBtn.click();
assert.equal(compiled, 1);
assert.equal(ws.compileMenu.open, false);
assert.equal(ws.compileArrow.attrs['aria-expanded'], 'false');
assert.equal(listeners.size, 0, 'closed menu removes positioning listeners');
ws.compileArrow.click();
ws.compileArrow.click();
assert.equal(ws.compileMenu.open, false, 'clicking the arrow again closes it');
// Keyboard opening moves focus to the option; native dismissal also updates joined corners.
ws.compileArrow.keyboardFocus = true;
ws.compileArrow.click();
assert.equal(ws.activeCompileBtn.focused, true);
ws.compileMenu.hidePopover();
assert.equal(ws.compileArrow.attrs['aria-expanded'], 'false');
assert.equal(controls.attrs['data-open'], 'false');
const css = readFileSync(new URL('../static/workspace.css', import.meta.url), 'utf8');
assert.match(css, /\.ws-compile-options\{[^}]*position:fixed/);
assert.match(css, /\.ws-compile-options\{[^}]*margin:0/);
console.log('PASS: compile dropdown uses the top layer, hugs the full split button and opens, closes and compiles');
