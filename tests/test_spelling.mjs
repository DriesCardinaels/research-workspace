// Exercise local Hunspell dictionaries through the production controller and lexer.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import nspell from '../static/vendor/spelling/checker.mjs';
const source = name => readFileSync(new URL('../static/' + name,import.meta.url),'utf8');
const timers = new Map(); let timerId = 0;
const storage = new Map();
class Target {
  events = new Map();
  addEventListener(type,fn,options = {}) {
    if (!this.events.has(type)) this.events.set(type,new Set());
    this.events.get(type).add(fn);
    options.signal?.addEventListener('abort',() => this.events.get(type).delete(fn),{once:true});
  }
  removeEventListener(type,fn) { this.events.get(type)?.delete(fn); }
  dispatch(type,event = {}) { for (const fn of [...(this.events.get(type) || [])]) fn(event); }
}
class Element extends Target {
  constructor(tag) { super(); this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.style = {}; this.offsetWidth = 200; this.offsetHeight = 100; }
  setAttribute(key,value) { this.attrs[key] = String(value); }
  getAttribute(key) { return this.attrs[key] ?? null; }
  removeAttribute(key) { delete this.attrs[key]; }
  append(child) { this.children.push(child); child.parent = this; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  contains(child) { return this === child || this.children.some(node => node.contains(child)); }
  focus() { document.activeElement = this; }
}
const document = Object.assign(new Target(),{createElement:tag => new Element(tag),body:new Element('body'),activeElement:null});
const browser = new Target();
const context = vm.createContext({console,document,AbortController,innerWidth:800,innerHeight:600,
  addEventListener:browser.addEventListener.bind(browser),removeEventListener:browser.removeEventListener.bind(browser), localStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)},setTimeout:fn=>{timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id)});
context.window = context;
for (const name of ['toolbar.js','vendor/marked/marked.min.js','writing.js','spelling.js']) vm.runInContext(source(name),context);
const {Service,attach} = context.Spelling;
const dictionaries = new Map(), loads = [];
const loader = async language => {
  loads.push(language);
  const checker = nspell({aff:source('vendor/spelling/' + language + '/index.aff'),dic:source('vendor/spelling/' + language + '/index.dic')});
  dictionaries.set(language,checker); return checker;
};
const service = new Service({storage:{getItem:()=>null,setItem(){}},loader});
assert.equal(service.language,'en-US'); assert.equal(loads.length,0,'dictionary loading is lazy');
/** Drain debounce callbacks and async dictionary settlement without wall-clock sleeps.
 * @pre Test timers own all scheduled work. @post Pending notifications are processed.
 * @throws {Error} Controller failure.
 */
async function settle() { for (let i=0;i<12;i++) {const batch=[...timers.values()];timers.clear();for(const fn of batch)fn();await Promise.resolve();} }
/** Model CodeMirror's public host events and document-owned marks.
 * @pre Synthetic prose only. @post Old document marks remain inspectable after swap.
 * @throws {void} None.
 */
function host(text) {
  const listeners = new Map(), marks = [];
  const makeDoc = value => ({
    text:value, getValue(){return this.text;},getLine(line){return this.text.split('\n')[line];},getRange(from,to){return this.getLine(from.line).slice(from.ch,to.ch);},getCursor:()=>({line:0,ch:1}),
    markText(from,to,options){const mark={text:value.split('\n')[from.line].slice(from.ch,to.ch),from,to,options,cleared:false,find(){return this.cleared ? undefined : {from:this.from,to:this.to};},clear(){this.cleared=true;}};marks.push(mark);return mark;},
  });
  let doc = makeDoc(text), viewport = {from:0,to:text.split('\n').length};
  const edits = []; let readOnly = false;
  const cm = {getOption:() => readOnly,coordsChar:() => ({line:0,ch:1}),cursorCoords:() => ({left:12,bottom:30}),focus(){document.activeElement = null;},replaceRange(value,from,to,origin){edits.push({value,from,to,origin});doc.text=doc.text.slice(0,from.ch)+value+doc.text.slice(to.ch);for(const fn of listeners.get('changes')||[])fn();},getDoc:()=>doc,getViewport:()=>viewport,getLineTokens:()=>[],operation:fn=>fn(),on:(event,fn)=>{if(!listeners.has(event))listeners.set(event,new Set());listeners.get(event).add(fn);},off:(event,fn)=>listeners.get(event)?.delete(fn)};
  return {cm,marks,edits,readOnly(value){readOnly=value;},active:()=>marks.filter(mark=>!mark.cleared),emit:(event,detail)=>{for(const fn of listeners.get(event)||[])fn(cm,detail);},swap(value){doc=makeDoc(value);viewport={from:0,to:value.split('\n').length};this.emit('swapDoc');},viewport(from,to){viewport={from,to};this.emit('viewportChange');},listeners};
}
let file = 'notes.md'; const h = host('color colour speling');
const controller = attach(h.cm,{service,file:()=>file});
await settle(); assert.deepEqual(h.active().map(m=>m.text),['colour','speling']);
assert.ok(h.active()[0].options.attributes.title.includes('US English'));
service.setLanguage('en-GB');assert.equal(h.active().length,0,'language changes immediately clear old-language marks');
await settle();assert.deepEqual(h.active().map(m=>m.text),['color','speling']);
service.setLanguage('nl');h.swap('onderzoek onderzoukk');await settle();assert.deepEqual(h.active().map(m=>m.text),['onderzoukk']);
service.setLanguage('en-US'); h.swap('# speling\n`speling` [correct words](https://speling.example)\n```js\nspeling\n```\n~~speling~~ and ~speling~\n<!-- note-metadata-speling -->\n[ref]: https://speling.example\nGood words');
await settle();assert.deepEqual(h.active().map(m=>m.from.line),[0,5,5],'Markdown syntax/code/links/metadata are excluded while headings and emphasis remain prose');
h.viewport(8,9);await settle();assert.equal(h.active().length,0,'only the visible source is decorated');
h.viewport(0,9);await settle();assert.equal(h.active().length,3);
file='notes.txt'; h.swap('---\n    speling\n```\nspeling');await settle();assert.deepEqual(h.active().map(m=>m.text),['speling','speling'],'plain text does not discard fenced, indented or frontmatter-like prose');
file='paper.tex';h.swap('\\begin{document}\n\\section{speling}\nText speling \\citep{speling} $speling$\n\\keywords{speling}\n\\footnote{speling}\n\\end{document}');await settle();assert.deepEqual(h.active().map(m=>m.from.line),[1,2,4],'LaTeX headings/footnotes remain checked while references/math/metadata are skipped');
h.swap('\\begin{figure}\n\\includegraphics{speling.png}\n\\caption{speling}\n\\end{figure}\n\\begin{table}\n\\caption{speling}\n\\begin{tabular}{ll} speling \\end{tabular}\n\\end{table}');await settle();assert.deepEqual(h.active().map(m=>m.from.line),[2,5],'figure/table captions remain prose while image paths and tabular syntax are excluded');
file='metadata.json'; h.swap('{"speling":"speling"}');await settle();assert.equal(h.active().length,0,'metadata/code filetypes are excluded');
file='notes.md';h.swap('speling');await settle();const oldMarks=h.active();h.swap('Correct words');assert.ok(oldMarks.every(m=>m.cleared),'swap clears marks from the detached document');await settle();assert.equal(h.active().length,0);
h.swap('speling');await settle();service.setLanguage('off');assert.equal(h.active().length,0);await settle();assert.equal(h.active().length,0);
service.setLanguage('en-US');await settle();assert.equal(h.active().length,1);controller.dispose();await settle();assert.equal(h.active().length,0);assert.ok([...h.listeners.values()].every(set=>set.size===0),'disposal removes every editor listener');assert.equal(loads.filter(x=>x==='en-US').length,1,'loaded dictionaries are reused');
// Suggestions use the selected real dictionary and the normal editor mutation seam.
const menus = () => document.body.children.filter(node => node.className?.includes('spelling-menu'));
const rightClick = (host,{underline = true,key,shiftKey = false} = {}) => {
  const event = {clientX:100,clientY:120,key,shiftKey,defaultPrevented:false,
    target:{closest:() => underline ? {} : null},preventDefault(){this.defaultPrevented=true;},stopPropagation(){}};
  host.emit(key ? 'keydown' : 'contextmenu',event); return event;
};
const suggestionsHost = host('wrnog words'), suggestionsController = attach(suggestionsHost.cm,{service,file:()=>'notes.txt'});
await settle();
assert.equal(rightClick(suggestionsHost,{underline:false}).defaultPrevented,false,'ordinary source keeps its native context menu');
suggestionsHost.readOnly(true);assert.equal(rightClick(suggestionsHost).defaultPrevented,false,'read-only source cannot offer replacements');suggestionsHost.readOnly(false);
assert.equal(rightClick(suggestionsHost).defaultPrevented,true);
let menu = menus()[0];assert.equal(menu.attrs.role,'menu');assert.equal(menu.children[0].textContent,'wrong');
assert.equal(document.activeElement,menu.children[0]);
context.EditorTools.Tool.activate(menu.children[0]);
assert.equal(suggestionsHost.cm.getDoc().getValue(),'wrong words');
assert.equal(suggestionsHost.edits.length,1);assert.equal(suggestionsHost.edits[0].origin,'spelling','one normal edit with an origin that cannot merge into typing');
assert.equal(menus().length,0);await settle();assert.equal(suggestionsHost.active().length,0);
suggestionsHost.swap('colour');await settle();rightClick(suggestionsHost);
assert.ok(menus()[0].children.some(button=>button.textContent==='color'),'US dictionary supplies US spelling');
service.setLanguage('en-GB');assert.equal(menus().length,0,'preference changes dismiss suggestions');await settle();assert.equal(suggestionsHost.active().length,0);
service.setLanguage('nl');suggestionsHost.swap('onderezoek');await settle();rightClick(suggestionsHost);
assert.ok(menus()[0].children.some(button=>button.textContent==='onderzoek'),'Dutch suggestions use the selected dictionary');
suggestionsHost.swap('wrnog');assert.equal(menus().length,0,'swapping documents dismisses suggestions');
service.setLanguage('en-US');await settle();
rightClick(suggestionsHost,{key:'F10',shiftKey:true});menu=menus()[0];assert.ok(menu,'keyboard context menu opens at the misspelled caret');
menu.dispatch('keydown',{key:'End',preventDefault(){}});assert.equal(document.activeElement,menu.children.at(-1));
menu.dispatch('keydown',{key:'Escape',preventDefault(){}});assert.equal(menus().length,0,'Escape dismisses the menu');
rightClick(suggestionsHost);menu=menus()[0];suggestionsHost.readOnly(true);
context.EditorTools.Tool.activate(menu.children[0]);assert.equal(suggestionsHost.edits.length,1,'read-only state is checked again at activation');suggestionsHost.readOnly(false);
rightClick(suggestionsHost);menu=menus()[0];
suggestionsHost.active()[0].from = {line:0,ch:2};
context.EditorTools.Tool.activate(menu.children[0]);assert.equal(suggestionsHost.edits.length,1,'a moved mark cannot replace a different range');
suggestionsHost.swap('wrnog');await settle();rightClick(suggestionsHost);menu=menus()[0];
suggestionsHost.cm.getDoc().text='other';context.EditorTools.Tool.activate(menu.children[0]);
assert.equal(suggestionsHost.edits.length,1,'exact-range guard refuses stale words even without a change notification');
suggestionsHost.swap('wrnog');await settle();rightClick(suggestionsHost);document.dispatch('contextmenu',{});assert.equal(menus().length,0,'opening another context menu dismisses spelling');
rightClick(suggestionsHost);suggestionsHost.emit('changes');assert.equal(menus().length,0,'edits dismiss suggestions');await settle();
rightClick(suggestionsHost);suggestionsController.dispose();assert.equal(menus().length,0,'disposal dismisses suggestions');
assert.ok([...document.events.values(),...browser.events.values()].every(set=>set.size===0),'dismissal releases global listeners');
// Personal words are locale-specific preferences, never source edits.
const savedWords = new Map([
  ['research-workbench.spelling-word.en-US.%ZZ','1'],
  ['research-workbench.spelling-word.en-US.wrnog','malformed'],
  ['research-workbench.spelling-word.en-US.OTHER','1'],
]);
const personalStorage = {
  get length(){return savedWords.size;},key:index=>[...savedWords.keys()][index],
  getItem:key=>savedWords.get(key) ?? null,setItem:(key,value)=>savedWords.set(key,value),removeItem:key=>savedWords.delete(key),
};
const personalLoader = async language => dictionaries.get(language);
const personal = new Service({storage:personalStorage,loader:personalLoader});
const personalHost = host('wrnog'), peerHost = host('wrnog'); let personalFile = 'notes.txt';
const personalController = attach(personalHost.cm,{service:personal,file:()=>personalFile});
const peerController = attach(peerHost.cm,{service:personal,file:()=>'paper.tex'});
await settle();assert.equal(personalHost.active().length,1,'malformed saved values are ignored');assert.equal(peerHost.active().length,1);
rightClick(personalHost);menu=menus()[0];
const addButton = () => menus()[0].children.find(button=>button.textContent==='Add to dictionary');
assert.ok(addButton(),'suggestion menu includes a personal dictionary action');
context.EditorTools.Tool.activate(addButton());
assert.equal(menus().length,0);assert.equal(personal.language,'en-US');
await settle();assert.equal(personalHost.active().length,0);assert.equal(peerHost.active().length,0,'all active controllers refresh');
assert.equal(personalHost.cm.getDoc().getValue(),'wrnog');assert.equal(personalHost.edits.length,0,'adding a word creates no edit, dirty change or undo entry');
assert.equal(peerHost.edits.length,0);
const reloaded = new Service({storage:personalStorage,loader:personalLoader});await reloaded.ensure();
assert.equal(reloaded.language,'en-US');assert.equal(reloaded.correct('WRNOG'),true,'reload restores normalized personal words');
personal.setLanguage('en-GB');await settle();assert.equal(personalHost.active().length,1,'personal words do not leak to another English locale');
personal.setLanguage('nl');await settle();assert.equal(personalHost.active().length,1,'personal words do not leak to Dutch');
personal.setLanguage('en-US');personalHost.swap('quuxflarbel');await settle();rightClick(personalHost);menu=menus()[0];
assert.equal(menu.children[0].textContent,'No spelling suggestions');assert.ok(addButton(),'zero suggestions still permits adding');
assert.equal(document.activeElement,addButton(),'zero-suggestion menu focuses its action');
context.EditorTools.Tool.activate(addButton());await settle();assert.equal(personalHost.active().length,0);
assert.equal(personalHost.edits.length,0);
personalHost.swap('stalespeling');await settle();rightClick(personalHost);menu=menus()[0];personalFile='other.txt';
context.EditorTools.Tool.activate(addButton());assert.equal(personal.correct('stalespeling'),false,'file identity guards dictionary actions');
rightClick(personalHost);personalHost.cm.getDoc().text='different';context.EditorTools.Tool.activate(addButton());
assert.equal(personal.correct('stalespeling'),false,'exact word guards dictionary actions');
personalHost.swap('stalespeling');await settle();rightClick(personalHost);personalHost.readOnly(true);
context.EditorTools.Tool.activate(addButton());assert.equal(personal.correct('stalespeling'),false,'read-only activation cannot add');personalHost.readOnly(false);
rightClick(personalHost);const staleAdd = addButton();personal.setLanguage('nl');
assert.throws(()=>context.EditorTools.Tool.activate(staleAdd),/no concrete Tool/,'language changes unbind old actions');await settle();assert.equal(personal.correct('stalespeling'),false);
personal.setLanguage('en-US');personalHost.swap('concurrentword');await settle();
const otherTab = new Service({storage:personalStorage,loader:personalLoader});
otherTab.addWord('concurrentword');personal.addWord('anotherpersonalword');
browser.dispatch('storage',{key:'research-workbench.spelling-word.en-US.concurrentword',storageArea:personalStorage});
await settle();assert.equal(personalHost.active().length,0,'storage events refresh existing hosts after another tab adds a word');
const concurrentReload = new Service({storage:personalStorage,loader:personalLoader});await concurrentReload.ensure();
assert.equal(concurrentReload.correct('concurrentword'),true);assert.equal(concurrentReload.correct('anotherpersonalword'),true,'concurrent tabs preserve independent additions');
assert.equal(otherTab.removeWord('CONCURRENTWORD','en-US'),true);
assert.equal(new Service({storage:personalStorage,loader:personalLoader}).listWords('en-US').includes('concurrentword'),false,'removal persists across reload');
browser.dispatch('storage',{key:'research-workbench.spelling-word.en-US.concurrentword',storageArea:personalStorage});
await settle();assert.equal(personalHost.active().length,1,'removing a stored word in another tab restores its marks');
personal.addWord('zebraword');personal.addWord('aardvarkword');
const words = personal.listWords('en-US');assert.equal(words[0],'aardvarkword');words.length=0;
assert.ok(personal.listWords('en-US').length,'word listing is a snapshot');
personal.setLanguage('en-GB');personal.addWord('wrnog');personal.setLanguage('en-US');personalHost.swap('wrnog');await settle();
assert.equal(personalHost.active().length,0);
assert.equal(personal.removeWord('WRNOG','en-GB'),true,'inactive locales can be managed');
assert.equal(personal.language,'en-US');assert.equal(personal.correct('wrnog'),true,'other locale deletion preserves active personal word');
assert.equal(personal.removeWord('wrnog','en-US'),true);await settle();
assert.equal(personalHost.active().length,1);assert.equal(peerHost.active().length,1,'removal refreshes all active editors');
assert.equal(personalHost.edits.length,0,'removal does not create source edits');
assert.throws(()=>personal.listWords('off'),/Unsupported/);assert.equal(personal.removeWord('word','off'),false);
const failingDeleteStorage = {...personalStorage,removeItem(){throw Error('denied');}};
const cannotDelete = new Service({storage:failingDeleteStorage,loader:personalLoader});
assert.equal(cannotDelete.removeWord('aardvarkword','en-US'),false);assert.ok(cannotDelete.listWords('en-US').includes('aardvarkword'),'failed deletion retains the word');
const silentDelete = new Service({storage:{...personalStorage,removeItem(){}},loader:personalLoader});
assert.equal(silentDelete.removeWord('aardvarkword','en-US'),false,'a no-op storage deletion cannot report success');
savedWords.clear();browser.dispatch('storage',{key:null,storageArea:personalStorage});
assert.equal(personal.correct('anotherpersonalword'),false,'external storage clearing removes persisted personal words');
personalController.dispose();peerController.dispose();await settle();
assert.ok([...document.events.values(),...browser.events.values()].every(set=>set.size===0),'personal dictionaries release storage and menu listeners with their hosts');
const denied = new Service({storage:{get length(){throw Error('denied');},getItem(){throw Error('denied');},setItem(){throw Error('denied');}},loader:personalLoader});
await denied.ensure();assert.equal(denied.addWord('sessionword'),true);assert.equal(denied.correct('sessionword'),true,'storage failure keeps session words usable');
let finish;
const race = new Service({storage:{getItem:()=>null},loader:()=>new Promise(resolve=>finish=resolve)});
const request = race.ensure();await Promise.resolve();race.setLanguage('off');finish(dictionaries.get('en-US'));await request;assert.equal(race.language,'off');assert.equal(race.checker,null,'a stale request cannot restore spelling after Off');
const failing=new Service({storage:{getItem:()=>null},loader:async()=>{throw Error('missing asset');}});await failing.ensure();assert.equal(failing.status,'error');
assert.equal(new Service({storage:{getItem(){throw Error('denied');}}}).language,'en-US');
console.log('PASS: local dictionaries, syntax masks, viewport lifecycle, guarded suggestion/personal-word menus, locale persistence, concurrent storage, storage failures and editor mutation isolation');
