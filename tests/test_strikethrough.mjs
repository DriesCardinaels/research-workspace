import {withToolRuntime} from './support/tool-runtime.mjs';
// Run: node --experimental-vm-modules tests/test_strikethrough.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=process.env.RESEARCH_WORKBENCH_TEST_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const PDFLib=createRequire(import.meta.url)(root+'/static/vendor/pdf-lib/pdf-lib.min.js');
globalThis.DOMMatrix=class DOMMatrix {};
const pdfjs=await import(pathToFileURL(root+'/static/vendor/pdfjs/pdf.min.mjs'));
pdfjs.GlobalWorkerOptions.workerSrc=pathToFileURL(root+'/static/vendor/pdfjs/pdf.worker.min.mjs').href;
const source=await PDFLib.PDFDocument.create();
for(const rotation of [0,90,180,270]){
 const page=source.addPage([612,792]);page.setCropBox(20,30,560,720);page.setRotation(PDFLib.degrees(rotation));
 page.drawText('Text remains selectable after strikethrough.',{x:60,y:700,size:16});
}
const bytes=await source.save();
// Initialize the real worker module before the browser loader assigns its URL.
const bootstrap=pdfjs.getDocument({data:bytes.slice(),isEvalSupported:false});
await bootstrap.promise;await bootstrap.destroy();
let savedAnnotations={version:1,highlights:[],strokes:[]}, exported, drawn=[];
const realLoad=PDFLib.PDFDocument.load.bind(PDFLib.PDFDocument);
PDFLib.PDFDocument.load=async (...args)=>{
 const doc=await realLoad(...args);
 doc.getPages().forEach((p,index)=>{const original=p.drawLine.bind(p);p.drawLine=opts=>{drawn.push({index,...opts});return original({...opts,start:{...opts.start},end:{...opts.end}});};});
 return doc;
};
function element(tag){return {tag,attributes:{},children:[],events:{},get lastChild(){return this.children.at(-1);},classList:{remove(){},toggle(){}},setAttribute(k,v){this.attributes[k]=v;},append(...items){this.children.push(...items);},replaceChildren(...items){this.children=items;},addEventListener(k,fn){this.events[k]=fn;}};}
const context=vm.createContext({window:{PDFLib,getSelection:()=>({removeAllRanges(){}})},document:{createElement:element,createElementNS:(_,tag)=>element(tag),removeEventListener(){}},Uint8Array,console,setTimeout,clearTimeout,fetch:async (url,opts={})=>{
 if(opts.method==='PUT'){
  if(url.endsWith('/annotations')){
   const {base,...annotations}=JSON.parse(opts.body);savedAnnotations=annotations;
   return {ok:true,json:async()=>({annotations:savedAnnotations})};
  }
  exported=opts.body;return {ok:true};
 }
 return url.endsWith('/annotations')?{ok:true,json:async()=>savedAnnotations}:{ok:true,arrayBuffer:async()=>bytes.slice().buffer};
}});
new vm.Script(withToolRuntime(fs.readFileSync(root+'/static/annotator.js','utf8')),{importModuleDynamically:specifier=>import(pathToFileURL(root+specifier))}).runInContext(context);
const prototype=context.window.PdfAnnotator.prototype;
function viewer(){return Object.assign(Object.create(prototype),{
 o:{pdfUrl:'/original',annUrl:'/annotations',exportUrl:'/annotated',openExportUrl:'/annotated'},
 cfg:{highlight_colors:[{id:'yellow',label:'Yellow',hex:'#ffe066'}]},ann:{version:1,highlights:[],strokes:[]},undoStack:[],pages:[],
 buildPages(){},renderBar(){},renderList(){},redraw(){},setStatus(message){this.lastStatus=message;},body:{},bar:{},status:element('span'),scroller:element('div')
});}
const a=viewer();await a.open();assert.equal(a.doc?.numPages,4,a.scroller.children[0]?.textContent || a.lastStatus);
const rects=[{p:1,x:45,y:50,w:190,h:18},{p:1,x:45,y:75,w:80,h:18}];
const mark=a.addHighlight({rects,text:'remove these words'},'yellow','strikethrough');
assert.equal(mark.type,'strikethrough');assert.equal(a.markColor(mark).label,'Remove text');
a.undo();assert.equal(a.ann.highlights.length,0);
a.ann.highlights.push(mark);a.lastScale=1;a.eraseAt({num:1},[50,55]);assert.equal(a.ann.highlights.length,0);
a.undo();assert.equal(a.ann.highlights.length,1);
for(let p=2;p<=4;p++)a.addHighlight({rects:rects.map(r=>({...r,p})),text:'remove these words'},'yellow','strikethrough');
// Old highlight records with no type remain highlighted.
a.ann.highlights.push({id:'old',page:1,rects:[{p:1,x:45,y:110,w:100,h:18}],color:'yellow',text:'old highlight',comments:[]});
const screen={num:1,hl:element('svg'),marks:element('div'),ink:element('svg')};
a.drawAnnotations(screen);
assert.equal(screen.hl.children.filter(x=>x.tag==='line').length,2);
assert.equal(screen.hl.children.filter(x=>x.tag==='rect').length,1);
assert.equal(screen.hl.children[0].attributes.y1,59);
// The replacement action must open its editor immediately and save the input
// using the real comment form handler, including refusing an empty comment.
a.selMenu={hidden:false};a.openPop=(h)=>{a.openedComment=h;};
const replacementRect={p:1,x:45,y:140,w:120,h:18};
const replacement=a.replaceText({rects:[replacementRect],text:'old wording'},{});
assert.equal(replacement.type,'strikethrough');assert.equal(replacement.intent,'replace');
assert.equal(a.openedComment,replacement);assert.equal(a.selMenu.hidden,true);
assert.equal(a.markColor(replacement).label,'Replace text');
const form=a.renderThread(replacement,{});
assert.equal(form.input.attributes['aria-label'],'Replacement text');
const saveButton=form.box.lastChild.lastChild;
assert.equal(saveButton.textContent,'Save replacement');
form.input.value='  ';saveButton.events.click();assert.equal(replacement.comments.length,0);
form.input.value='new wording';saveButton.events.click();
assert.equal(replacement.comments[0].text,'Replacement: new wording');
assert.ok(await a.flush());
const b=viewer();await b.open();assert.equal(b.ann.highlights.filter(h=>h.type==='strikethrough').length,5);
assert.equal(b.ann.highlights.at(-1).comments[0].text,'Replacement: new wording');
await b.exportPdf();assert.ok(exported,b.lastStatus);assert.equal(drawn.length,9);
for(const [i,line] of drawn.entries()){
 const r=i<8?rects[i%2]:replacementRect;const viewport=b.pages[line.index].base;
 const start=viewport.convertToViewportPoint(line.start.x,line.start.y);
 const end=viewport.convertToViewportPoint(line.end.x,line.end.y);
 for(const [actual,expected] of [[start[0],r.x],[start[1],r.y+r.h/2],[end[0],r.x+r.w],[end[1],r.y+r.h/2]])assert.ok(Math.abs(actual-expected)<1e-6);
}
const exportedTask=pdfjs.getDocument({data:exported.slice(),isEvalSupported:false});
const output=await exportedTask.promise;
for(let n=1;n<=4;n++){
 const page=await output.getPage(n);const content=await page.getTextContent();
 assert.ok(content.items.some(item=>item.str.includes('Text remains selectable')));
 if(n===1){
  const notes=await page.getAnnotations();
  assert.ok(notes.some(note=>note.contentsObj?.str.includes('Replacement: new wording')),'replacement must be exported as a PDF comment');
 }
 const ops=await page.getOperatorList();
 assert.ok(ops.fnArray.includes(pdfjs.OPS.constructPath),'exported markup must contain drawing operations');
}
await exportedTask.destroy();await a.destroy();await b.destroy();
console.log('PASS: replacement creation, comment form, PDF comment export, strikethrough selection data, multiline rendering, undo, erase, persistence/reopen, old highlights, and real PDF export on cropped pages at 0/90/180/270 degrees');
