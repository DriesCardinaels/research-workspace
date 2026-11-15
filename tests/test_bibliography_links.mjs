import {withToolRuntime} from './support/tool-runtime.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const handlers = {}, events = {}, marks = [], opened = [];
let hook, mode = 'bibtex', selected = false;
let line = 'doi = {https://doi.org/10.1016/j.pss.2020.105119},';
const editor = {
  getWrapperElement: () => ({setAttribute() {}, getAttribute() { return null; }, removeEventListener() {}, addEventListener: (name, callback) => { handlers[name] = callback; }}),
  getMode: () => ({name: mode}),
  coordsChar: ({left, top}) => ({line: 0, ch: left, outside: top < 0}),
  getLine: () => line,
  somethingSelected: () => selected,
  markText: (from, to, options) => {
    const mark = {from, to, options, cleared: false, clear() { this.cleared = true; }};
    marks.push(mark); return mark;
  },
  on: (name, callback) => { events[name] = callback; }
};
vm.runInNewContext(withToolRuntime(readFileSync(new URL('../static/bibliography-links.js', import.meta.url), 'utf8')), {
  CodeMirror: {defineInitHook: callback => { hook = callback; }},
  window: {open: (...args) => opened.push(args)}
});
hook(editor);
const pointer = (ch, extra = {}) => ({clientX: ch, clientY: 1, button: 0, buttons: 0, detail: 1, preventDefault() {}, ...extra});
const hover = ch => handlers.mousemove(pointer(ch));
const click = ch => { handlers.mousedown(pointer(ch)); handlers.click(pointer(ch)); };
hover(15);
assert.equal(marks.length, 1);
assert.equal(line.slice(marks[0].from.ch, marks[0].to.ch), 'https://doi.org/10.1016/j.pss.2020.105119');
assert.equal(marks[0].options.className, 'bib-hover-link');
hover(16);
assert.equal(marks.length, 1, 'moving within the same link retains the decoration');
click(16);
assert.deepEqual(opened[0], ['https://doi.org/10.1016/j.pss.2020.105119', '_blank', 'noopener,noreferrer']);
events.swapDoc();
assert.equal(marks[0].cleared, true);
line = 'doi = {10.1234/example(foo)}';
hover(12); click(12);
assert.equal(opened.at(-1)[0], 'https://doi.org/10.1234/example(foo)');
line = 'url = "https://example.org/paper?q=one&x=two"';
click(15);
assert.equal(opened.at(-1)[0], 'https://example.org/paper?q=one&x=two');
const count = opened.length;
selected = true; click(15); selected = false;
handlers.mousedown(pointer(15)); handlers.click(pointer(23));
handlers.mousedown(pointer(15)); handlers.click(pointer(15, {detail: 2}));
mode = 'stex'; hover(15); click(15);
mode = 'bibtex'; line = 'url = {javascript:alert(1)}'; hover(15); click(15);
line = 'url = {https://example.org}';
handlers.mousedown(pointer(15, {clientY: -1})); handlers.click(pointer(15));
assert.equal(opened.length, count, 'selection, dragging, double click, other modes and unsafe schemes do not open links');
assert.equal(marks.at(-1).cleared, true);
console.log('Bibliography hover links passed');
