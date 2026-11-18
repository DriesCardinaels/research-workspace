// Exercise note contributions and presentation against bundled CodeMirror 5.65.16 documents.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {withBuiltInTools} from './support/tool-runtime.mjs';
const element = () => ({setAttribute(){},append(){},addEventListener(){},cloneNode(){return element();}});
const document = {createElement:element,documentElement:{},body:element(),addEventListener(){}};
const context=vm.createContext({URLSearchParams,window:{document,addEventListener(){}},document,navigator:{userAgent:'',platform:''},localStorage:{getItem(){return null;}},setTimeout,clearTimeout});
const load=path=>vm.runInContext(readFileSync(new URL('../static/'+path,import.meta.url),'utf8'),context);
load('vendor/codemirror/codemirror.min.js');
vm.runInContext(withBuiltInTools(readFileSync(new URL('../static/toolbar.js',import.meta.url),'utf8')),context);
load('vendor/marked/marked.min.js');context.window.marked=context.marked;load('text-editor.js');load('features/markdown/tools.js');load('features/notes/annotations.js');load('features/notes/sources.js');load('features/notes/editor.js');load('features/notes/tools.js');
const {TextSession,EditorTools,NoteEditor,TextEditorViews}=context.window;
const session=new TextSession({file:'Notes.txt',text:'Alpha\r\nBeta',sha:'one'},async()=>({sha:'two'}));
let doc;session.attach({getDoc:()=>null,swapDoc:value=>{doc=value;}});
const run=id=>EditorTools.registry.execute('notes.tools','notes.'+id,{session});
doc.setSelection({line:0,ch:0},{line:0,ch:5});
await run('highlight');assert.equal(session.getText(),'=={#f9e2af}Alpha==\r\nBeta');
await run('highlight');assert.equal(session.getText(),'Alpha\r\nBeta','repeating format unwraps selection');
session.undo();assert.equal(session.getText(),'=={#f9e2af}Alpha==\r\nBeta');session.undo();
doc.setSelection({line:0,ch:2},{line:1,ch:4});await run('quote');
assert.equal(session.getText(),'> Alpha\r\n> Beta','blocks format complete selected lines');
session.undo();assert.equal(session.getText(),'Alpha\r\nBeta','block is one undo step');
doc.setSelection({line:0,ch:0},{line:1,ch:4});await run('number');
assert.equal(session.getText(),'1. Alpha\r\n2. Beta');session.undo();
await run('task');assert.equal(session.getText(),'- [ ] Alpha\r\n- [ ] Beta');session.undo();
assert.equal(NoteEditor.describeLine('## Heading').className,'note-h2');
assert.equal(NoteEditor.describeLine('> Quote').className,'note-quote');
const pdfHref='/api/projects/'+'a'.repeat(32)+'/documents/'+'b'.repeat(32)+'/original#page=12';
const sourceLink=context.window.NoteSources.anchor(pdfHref,'Source p. 12',{});
assert.equal(sourceLink.textContent,'Source p. 12','PDF source anchor passes real Tool validation and retains its visible label');
assert.equal(NoteEditor.describeLine('[Source p. 12]('+pdfHref+')').ranges[0].href,pdfHref,'local PDF source becomes a native link widget');
const coloredSource=context.window.NoteSources.location(pdfHref,'#f5c2e7');
assert(NoteEditor.describeLine('A quoted passage [Source]('+coloredSource+')').ranges.some(range=>range.className==='note-source-quote'&&range.underlineColor==='#f5c2e7'),'quote underline uses the durable source RGB color');

assert(!NoteEditor.describeLine('`[Source p. 12]('+pdfHref+')`').ranges.some(range=>range.href),'inline code never activates source links');
assert(!NoteEditor.describeLine('[unsafe](javascript:alert(1))').ranges.some(range=>range.href),'arbitrary links cannot open PDF context');
assert.equal(NoteEditor.describeLine('- [x] Done').className,'note-list');
assert.equal(NoteEditor.describeLine('==Marked== **Bold** `==literal==`').ranges.length,3);
assert.equal(NoteEditor.describeLine('\\==literal==').ranges.length,0,'escaped markers remain literal');
for (const [source,plain,styles] of [
  ['*The **Psychology** of **Money***','The Psychology of Money',['italic','bold']],
  ['***Both***','Both',['italic','bold']],
  ['**Bold and *italic* text**','Bold and italic text',['bold','italic']],
  ['*Italic and **bold** text*','Italic and bold text',['italic','bold']],
  ['=={#f5c2e7}***Highlighted***==','Highlighted',['highlight','italic','bold']],
  ['**=={#89b4fa}*Blue*==**','Blue',['bold','highlight','italic']],
  ['~~***Strike***~~','Strike',['strike','bold','italic']],
  ['**`*literal*`**','*literal*',['bold','code']],
  ['__Bold _italic_ text__','Bold italic text',['bold','italic']],
]) {
 const result=NoteEditor.describeLine(source), hidden=new Set();
 for(const [from,to] of result.markers)for(let index=from;index<to;index++)hidden.add(index);
 assert.equal([...source].filter((_,index)=>!hidden.has(index)).join(''),plain,source+' hides every nested marker');
 for(const style of styles)assert(result.ranges.some(range=>range.className==='note-'+style),source+' applies '+style);
}
assert.equal(NoteEditor.toggleFormat('**Bold**','*'),'***Bold***','italic stacks onto bold');
assert.equal(NoteEditor.toggleFormat('*Italic*','**'),'***Italic***','bold stacks onto italic');
assert.equal(NoteEditor.toggleFormat('***Both***','*'),'**Both**','removing italic preserves bold');
assert.equal(NoteEditor.toggleFormat('***Both***','**'),'*Both*','removing bold preserves italic');
assert.equal(NoteEditor.toggleFormat('=={#f9e2af}**Bold**==','**'),'=={#f9e2af}Bold==','removing bold preserves a highlight');
assert.equal(context.window.marked.lexer('==text==')[0].tokens[0].type,'text','notes extensions never modify the global Markdown parser');
const model=context.window.NoteAnnotations;
assert.equal(model.palette.length,8);
assert.equal(model.highlight('==Old==\r\nNew','#89b4fa'),'=={#89b4fa}Old==\r\n=={#89b4fa}New==');
assert.equal(model.highlight('=={#89b4fa}Old==','#f5c2e7'),'=={#f5c2e7}Old==','recolor replaces existing metadata');
assert.throws(()=>model.highlight('text','red;display:none'),/valid/);
const annotated=model.annotate('Alpha\r\nBeta','Review <script> & **details**\nSecond paragraph');
const entries=model.comments(annotated);
assert.equal(entries.length,2);assert.equal(entries[0].comment,'Review <script> & **details**\nSecond paragraph');
assert.equal(annotated.slice(entries[1].start,entries[1].end),entries[1].raw,'comment offsets retain CRLF');
assert.equal(model.comments('```\n'+annotated+'\n```').length,0,'fenced examples are not comments');
assert.equal(model.comments('`'+entries[0].raw+'`').length,0,'inline code is not a comment');
assert.equal(NoteEditor.describeLine('`'+entries[0].raw+'`').ranges.some(range=>range.className==='note-comment'),false);
assert.equal(NoteEditor.describeLine('=={#89b4fa}Blue==').ranges[0].color,'#89b4fa');
assert.equal(NoteEditor.describeLine(entries[0].raw).ranges[0].title,entries[0].comment,'comment tooltip is literal data');
doc.setValue(annotated);doc.clearHistory();
session.replaceTextRange(entries[0].start,entries[0].end,entries[0].text,entries[0].raw);
assert.equal(model.comments(session.getText()).length,1,'removing a comment preserves annotated text');
session.undo();assert.equal(session.getText(),annotated);
assert.throws(()=>session.replaceTextRange(0,3,'x','stale'),/changed/);
await session.save();const persisted=session.getText();session.reload({file:session.file,text:persisted,sha:'three'});
assert.equal(model.comments(session.getText())[0].comment,entries[0].comment,'comments survive save and reload');
const events=new Map(), options={lineNumbers:true,extraKeys:{Tab:'indentMore'}}, classes=new Set(), marks=new Set(), lines=new Map();
const editor={
 getDoc:()=>doc,getOption:key=>options[key],setOption:(key,value)=>{options[key]=value;},
 getWrapperElement:()=>({append(){},classList:{toggle:(name,on)=>on?classes.add(name):classes.delete(name),remove:name=>classes.delete(name)}}),
 on:(name,handler)=>events.set(name,handler),off:name=>events.delete(name),operation:fn=>fn(),refresh(){},
 listSelections:()=>doc.listSelections(),getCursor:()=>doc.getCursor(),lineCount:()=>doc.lineCount(),getLine:line=>doc.getLine(line),
 addLineClass:(line,where,name)=>{assert.equal(where,'text','block typography belongs to the measured text line');lines.set(line,name);return line;},removeLineClass:line=>lines.delete(line),
 markText:(from,to,style)=>{const mark={from,to,style,clear:()=>marks.delete(mark)};marks.add(mark);return mark;},
 somethingSelected:()=>doc.somethingSelected(),replaceRange:(...args)=>doc.replaceRange(...args),replaceSelection:(...args)=>doc.replaceSelection(...args),
};
doc.setValue('# Title\r\n==Highlight==\r\n```\r\n**literal**\r\n```');doc.clearHistory();doc.setCursor(0,0);
const before=doc.getValue(), view=TextEditorViews.get('text')(editor);
// Simulate proportional marker widths; renderLine must include indentation and task markers.
const originalCreate=document.createElement;
document.createElement=()=>({setAttribute(){},remove(){},getBoundingClientRect(){
 return {width:[...this.textContent].reduce((sum,char)=>sum+({'1':6,'0':9,'.':4,' ':4,'-':6,'[':5,']':5,x:7}[char]||8),0)};
}});
for(const [text,width] of [['1. Item',14],['10. Item',23],['- Item',10],['  - [x] Task',39],['\t- Item',26]]){
 const line={style:{},classList:{contains:()=>true}};
 events.get('renderLine')(editor,{text},line);
 assert.equal(line.style.paddingLeft,(4+width)+'px',text+' reserves the measured marker width');
 assert.equal(line.style.textIndent,-width+'px',text+' keeps the first marker outside the text column');
}
document.createElement=originalCreate;
assert.equal(doc.getValue(),before,'list layout never changes note contents');
assert(classes.has('notes-editor'));assert.equal(options.lineNumbers,true);
assert([...marks].some(mark=>mark.from.line===1&&mark.style.className==='note-marker'));
assert.equal([...marks].find(mark=>mark.style.className==='note-highlight').style.css,'--note-highlight-color:'+model.palette[0].color,'legacy highlights use the default palette color');
assert([...marks].some(mark=>mark.from.line===0&&mark.style.collapsed&&mark.style.atomic),'syntax stays hidden even on the active line');
assert(![...marks].some(mark=>mark.from.line===3),'fenced code remains literal');
assert.equal(doc.historySize().undo,0,'decorations never enter undo history');
view.setMode('source');assert.equal(marks.size,0);assert.equal(lines.size,0);assert.equal(doc.getValue(),before);
view.setMode('note');assert(marks.size>0);
doc.setValue('=={#89b4fa}Selected==');
events.get('change')();
assert.equal([...marks].find(mark=>mark.style.className==='note-highlight').style.css,'--note-highlight-color:#89b4fa','saved highlight colors drive the theme-aware style');
doc.setSelection({line:0,ch:11},{line:0,ch:18});view.selectHighlight();
assert.equal(doc.getSelection(),'=={#89b4fa}Selected==','recolor expands a visible selection around hidden metadata');
for (const [source,expected] of [['1. First','1. First\r\n2. '],['- [x] Done','- [x] Done\r\n- [ ] '],['> Quote','> Quote\r\n> '],['- ','']]) {
 doc.setValue(source);doc.setCursor(0,source.length);options.extraKeys.Enter(editor);
 assert.equal(doc.getValue(),expected);
}
view.dispose();assert.equal(marks.size,0);assert.equal(lines.size,0);assert.equal(events.size,0);
assert.equal(options.lineNumbers,true);assert.equal(options.extraKeys.Tab,'indentMore');assert(!classes.has('notes-editor'));
await session.save();assert.equal(session.unsaved,false);
console.log('PASS: note formatting, native undo/CRLF, syntax visibility, fences, list continuation, literal saves and view disposal');
