import {withBuiltInTools} from './support/tool-runtime.mjs';
// Formatting exercises the bundled CodeMirror 5.65.16 Doc, history and save boundary.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const element = () => ({
  attrs: {}, children: [], style: {}, classList: { toggle() {} },
  setAttribute(key, value) { this.attrs[key] = value; this[key] = value; },
  append(...children) { this.children.push(...children); },
  appendChild(child) { this.children.push(child); return child; },
  replaceChildren(...children) { this.children = children; },
  addEventListener(name, handler) { this['on' + name] = handler; }, cloneNode() { return element(); },
});
const document = { createElement: element, createTextNode: (text) => ({ textContent: text }), documentElement: {}, body: element(), addEventListener() {} };
const window = { DraftMatch: {}, document, addEventListener() {} };
const preferences = new Map();
const localStorage = { getItem: (key) => preferences.get(key) ?? null, setItem: (key, value) => preferences.set(key, value) };
const context = vm.createContext({ window, localStorage, document, navigator: { userAgent: '', platform: '' }, setTimeout, clearTimeout });
vm.runInContext(readFileSync(new URL('../static/vendor/codemirror/codemirror.min.js', import.meta.url), 'utf8'), context);
vm.runInContext(withBuiltInTools(readFileSync(new URL('../static/toolbar.js', import.meta.url), 'utf8')), context);
vm.runInContext(readFileSync(new URL('../static/text-editor.js', import.meta.url), 'utf8'), context);

const {TextSession}=window;
let revision='original', pending, rejectSave=false;
const writes=[];
const persist=async update=>{writes.push(update);if(rejectSave)throw Error('conflict');if(pending)await pending;return {sha:revision};};
const session=new TextSession({file:'notes.md',text:'First\r\nSecond',sha:revision},persist);
assert.equal(session.getText(),'First\r\nSecond');assert.equal(session.unsaved,false);
session.replaceSelection('New ');assert.equal(session.getText(),'New First\r\nSecond');
session.undo();assert.equal(session.unsaved,false);session.redo();assert.equal(session.unsaved,true);
let finish;pending=new Promise(resolve=>finish=resolve);
const saving=session.save();
session.replaceSelection('Later');
revision='accepted';finish();await saving;pending=null;
assert.equal(session.unsaved,true,'edits made during save remain dirty');
await session.save();assert.equal(session.unsaved,false);
assert.equal(writes[1].sha,'accepted','next save uses the accepted revision');
session.replaceSelection('Conflict');rejectSave=true;
const retained=session.getText();await assert.rejects(session.save(),/conflict/);
assert.equal(session.getText(),retained);assert.equal(session.unsaved,true);
assert.throws(()=>session.reload({file:'notes.md',text:'external',sha:'outside'}),/Save local/);
rejectSave=false;await session.save();
session.reload({file:'notes.md',text:'External\r\ntext',sha:'outside'});
assert.equal(session.getText(),'External\r\ntext');assert.equal(session.unsaved,false);
assert.equal(session.history().undo,0,'external replacement clears obsolete undo history');
assert.throws(()=>session.reload({file:'wrong.txt',text:'bad',sha:'bad'}),/Save local/);
console.log('PASS: private text sessions preserve Unicode/CRLF, native history, in-flight edits, save revisions, failed saves and safe external reloads');
