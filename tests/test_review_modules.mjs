// Review composition and registered presentation operate without native editors or a Workspace.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const window={};const context=vm.createContext({window});
for(const file of ['toolbar.js','features/review/state.js','features/review/cards.js','features/review/panel.js']) vm.runInContext(readFileSync(new URL('../static/'+file,import.meta.url),'utf8'),context);
const state=new window.ReviewState();
const original={file:'main.tex',quote:'quoted',style:{intent:'replace'},draft:'first'};
state.begin(original);original.style.intent='changed';assert.equal(state.note.style.intent,'replace');
assert.throws(()=>{state.note.draft='mutation';},TypeError);
const revision=state.revision;state.setNoteDraft('new typing');assert.equal(state.completeNote(revision),false);assert.equal(state.note.draft,'new typing');
assert.equal(state.completeNote(state.revision),true);assert.equal(state.note,null);
state.setReply('note-a','first');const replies=state.replies();replies.clear();assert.equal(state.reply('note-a'),'first');
const node=(tag,props={},...children)=>({tag,...props,children:children.flat().filter(Boolean),events:{},
 append(...items){this.children.push(...items);},replaceChildren(...items){this.children=items;},
 addEventListener(type,callback){this.events[type]=callback;},querySelector(){return null;},
 get lastChild(){return this.children.at(-1);}});
let complete;let submitted;
const cards=new window.ReviewCards({state,node,short:text=>text,when:()=>'',kinds:{},actions:{run:fn=>fn(),reload:async()=>{}}});
const [box,send]=cards.replyBox('note-a',text=>{submitted=text;return new Promise(resolve=>{complete=resolve;});});
const inFlight=send.invoke();assert.equal(submitted,'first');box.value='second';box.events.input();complete();await inFlight;
assert.equal(state.reply('note-a'),'second','older submission must retain newer reply typing');
const next=send.invoke();complete();await next;assert.equal(state.reply('note-a'),'');
const {builtInTabs,ReviewPanel}=window.ReviewPanels;
const tabs=builtInTabs();let contribution;
tabs.register({id:'custom',label:s=>`Custom ${s.openNotes}`,render(body,ctx){contribution=ctx;body.append(node('p',{text:ctx.snapshot.notes[0].quote}));}});
assert.throws(()=>tabs.register({id:'custom',label:()=>'',render(){}}),/duplicate/);
const available=tabs.available({writing:false});assert.ok(Object.isFrozen(available));assert.equal(available.length,3);
const values={notes:[{file:'main.tex',start:1,quote:'hello'}],changes:[],openNotes:1,openChanges:0,resolved:0,accepted:0,totalChanges:0,base:1,inactive:[],problems:[],writing:false};
let selected,writing=0;
const panelCards={noteCard:note=>node('article',{text:note.quote}),changeCard:change=>node('article',{text:change.id}),newNoteForm:()=>node('form')};
const panel=new ReviewPanel({state,tabs,cards:panelCards,node,actions:{warning:()=>null,selectTab:id=>{selected=id;},copy(){},writing(){writing++;},visibilityChanged(){}}});
const target=node('section');state.tab='custom';panel.render(target,values);
assert.equal(target.children[1].children[0].text,'hello');assert.equal(contribution.workspace,undefined);assert.equal(contribution.buffers,undefined);
assert.ok(Object.isFrozen(contribution.snapshot.notes[0]));assert.throws(()=>{contribution.snapshot.notes[0].quote='bad';},TypeError);assert.equal(values.notes[0].quote,'hello');
target.children[0].children[0].tool.execute();assert.equal(selected,'comments');
state.tab='writing';panel.render(target,values);assert.equal(state.tab,'comments','unavailable tabs fall back');assert.equal(writing,0);
state.dispose();state.begin(original);state.setReply('note-a','late');state.selected={type:'note',id:'late'};
assert.equal(state.pending,false);assert.equal(state.selected,null);
console.log('PASS: detached review state, submission/typing races, extensible immutable tabs, availability and disposal');
