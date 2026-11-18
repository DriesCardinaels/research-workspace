// Exercise geometry and PDF-pane lifecycle without a layout engine or network.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const viewers=[];
const element=tag=>({style:{},children:[],append(...nodes){this.children.push(...nodes);},replaceChildren(...nodes){this.children=nodes;},setAttribute(){},remove(){this.removed=true;},getContext(){return {measureText:text=>({width:text.length})};}});
const context=vm.createContext({URLSearchParams,document:{createElement:element},window:{}});
for(const name of ['annotations.js','sources.js','pdf-preview.js'])vm.runInContext(readFileSync(new URL('../static/features/notes/'+name,import.meta.url),'utf8'),context);
const sources=context.window.NoteSources, preview=context.window.NotePdfPreview;
const viewport={transform:[1,0,0,-1,0,200]};
const item=(str,x=10,y=150)=>({str,width:str.length*10,transform:[10,0,0,10,x,y],fontName:'font'});
const content={items:[item('Before: A quoted passage. After.')],styles:{font:{ascent:.8,fontFamily:'serif'}}};
let rects=preview.rectangles(content,viewport,'A quoted passage');
assert.equal(rects.length,1);assert.equal(rects[0].x,90);assert.equal(rects[0].y,42);assert.equal(rects[0].w,160);assert.equal(rects[0].h,10);
assert.equal(preview.rectangles(content,viewport,'Different unrelated quote').length,0);
assert.equal(preview.rectangles({items:[item('A quoted passage. A quoted passage.')]},viewport,'A quoted passage').length,0,'ambiguous text is never guessed');
assert.equal(preview.rectangles({items:[item('A quoted pas-'),item('sage',10,130)]},viewport,'A quoted passage').length,2,'wrapped/hyphenated passages retain line rectangles');
rects=preview.rectangles({items:[{...item('A quoted passage'),dir:'rtl'}]},viewport,'A quoted passage');assert.equal(rects[0].w,160);
const base='/api/projects/'+'a'.repeat(32)+'/documents/'+'b'.repeat(32), href=base+'/original#page=1';
let note='“A quoted passage” [Source p. 1]('+sources.location(href,'#f5c2e7')+')';
context.window.PdfAnnotator=class {
 constructor(options){this.options=options;this.root=element('div');this.loadAnnotationSnapshot({version:1,strokes:[],highlights:[{id:'review',text:'Existing review',page:1,rects:[],comments:[{text:'Review comment'}],color:'yellow'}]});this.pages=[{base:viewport,page:{getTextContent:async()=>content}}];viewers.push(this);}
 loadAnnotationSnapshot(snapshot){this.savedAnn=snapshot;this.ann={...snapshot};}
 async open(){this.doc={};}
 setMarks(marks){this.ann.highlights=marks;}
 scrollToRect(page,y){this.location={page,y};}
 goToPage(page){this.location={page};}
 async destroy(){this.destroyed=true;}
};
const controller=preview.create({session:{getText:()=>note},pdfSourceColors:{}});
controller.update(note);await controller.show({href:sources.location(href,'#f5c2e7'),reference:sources.references(note)[0]});
assert.equal(viewers.length,1);assert.equal(viewers[0].options.readOnly,true);
assert.equal(viewers[0].ann.highlights[0].id,'review','existing reviews survive quote overlays');
assert.equal(viewers[0].ann.highlights[1].color,'#f5c2e7');assert.equal(viewers[0].location.y,42,'navigation scrolls directly to marked text');
assert.equal(viewers[0].options.markRecolor(viewers[0].ann.highlights[0]),null,'an archived review exposes no writer');
note=sources.recolorLine(note,'#89b4fa');controller.update(note);await controller.show({href:sources.references(note)[0].href,reference:sources.references(note)[0]});
assert.equal(viewers.length,1,'same PDF is reused');assert.equal(viewers[0].ann.highlights[1].color,'#89b4fa','note recoloring updates the actual PDF overlay');
// A single note quote can point to several PDF passages without inflating the quote count.
viewers[0].pages.push({base:viewport,page:{getTextContent:async()=>content}});
const secondHref=href.replace('page=1','page=2');
note='“A quoted passage” [Source]('+href+') [Continuation]('+secondHref+')';
controller.update(note);await controller.show({href});
assert.equal(viewers[0].ann.highlights.length,3,'both source passages are marked alongside the existing review');
assert(controller.element.children[0].textContent.startsWith('1 of 1 quote marked'),'multiple source passages count as one note quote');
const contextHref=sources.location(href,'#f5c2e7','A quoted passage','context');
note+='\n\n“A paraphrase with different wording” [Context]('+contextHref+')';
controller.update(note);await controller.show({href:contextHref,reference:sources.references(note).at(-1)});
assert.equal(viewers[0].ann.highlights.length,3,'a paraphrase does not create an unrelated quote highlight');
assert(controller.element.children[0].textContent.includes('1 of 2 quotes marked'));
assert(controller.element.children[0].textContent.includes('1 context-only (not verbatim)'));
note='“A quoted passage” [Source]('+href+')';
note=note.replace('A quoted passage','Unmatched paraphrase');controller.update(note);await controller.show({href});
assert.equal(viewers[0].ann.highlights.length,1,'unmatched quotes clear old overlays without erasing reviews');
assert(controller.element.children[0].textContent.includes('No unique text match'));

note='“A quoted passage” [Source]('+href+')';controller.update(note);await controller.show({href});
const previousColorControl=viewers[0].options.markRecolor(viewers[0].ann.highlights[1]),previousLocation=viewers[0].location;
const nextNote=note;
controller.rebind({session:{getText:()=>nextNote},pdfSourceColors:{}});
await new Promise(resolve=>setImmediate(resolve));
assert.equal(viewers.length,1,'switching note buffers retains the PDF document');
assert.equal(viewers[0].location,previousLocation,'switching notes preserves PDF scroll');
await assert.rejects(()=>previousColorControl.apply('#f5c2e7'),/source changed/,'old quote controls cannot edit another note with identical text');
controller.dispose();await new Promise(resolve=>setImmediate(resolve));assert(viewers[0].destroyed,'worker is released on disposal');

const noteComment=context.window.NoteAnnotations.annotate('A quoted passage','Context [Source]('+href+')');
note='Intro\r\n'+noteComment+'\r\nEnd';
const writes=[];
const editable=preview.create({session:{getText:()=>note,replaceTextRange(start,end,text,expected){
  assert.equal(note.slice(start,end),expected);note=note.slice(0,start)+text+note.slice(end);
}},pdfSourceColors:{highlight_colors:[{id:'pink',label:'Pink',hex:'#fcc2d7'}]},pdfReviewWriter:async()=>async ({base,...snapshot})=>{
  writes.push({base,snapshot});return snapshot;
}});
await editable.show({href});
const writable=viewers.at(-1), colorControl=mark=>writable.options.markRecolor(mark);
const quoteColor=colorControl(writable.ann.highlights[1]);
await quoteColor.apply('#a6e3a1');
assert.equal(writable.ann.highlights[1].color,'#a6e3a1');
assert.equal(sources.references(note)[0].color,'#a6e3a1','recoloring the PDF changes the encoded note link');
assert(note.startsWith('Intro\r\n')&&note.endsWith('\r\nEnd'),'the note edit preserves surrounding CRLF lines');
assert.equal(writes.length,0,'note overlays write only to the note buffer');
const review=colorControl(writable.ann.highlights[0]);
await review.apply('pink');
assert.equal(writable.ann.highlights[0].color,'pink');
assert.equal(writable.ann.highlights[0].comments[0].text,'Review comment');
assert.equal(writes[0].base.highlights[0].color,'yellow');
assert.equal(writes[0].snapshot.highlights.length,1,'only stored PDF reviews are sent to the PDF writer');
assert.equal(writable.ann.highlights[1].color,'#a6e3a1','saving a review leaves the note overlay in place');
editable.dispose();

let releaseLoad;
const originalOpen=context.window.PdfAnnotator.prototype.open;
context.window.PdfAnnotator.prototype.open=function(){return new Promise(resolve=>{releaseLoad=()=>{this.doc={};resolve();};});};
const loadingController=preview.create({session:{getText:()=>note},pdfSourceColors:{}});
const pendingOpen=loadingController.show({href});loadingController.dispose();releaseLoad();await pendingOpen;
await new Promise(resolve=>setImmediate(resolve));assert(viewers.at(-1).destroyed,'disposal during loading releases the late worker');
assert.equal(viewers.at(-1).location,undefined,'disposed source cannot navigate after loading');
context.window.PdfAnnotator.prototype.open=originalOpen;

console.log('PASS: quote rectangles, ambiguity, line wrapping, colored PDF marks, review preservation, reuse, recoloring and cleanup');
