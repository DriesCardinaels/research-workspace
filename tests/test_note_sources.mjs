// Run: node --experimental-vm-modules tests/test_note_sources.mjs (Node built-ins only).
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const forms=[], contributions=new Map(), viewers=[];
/** Minimal DOM seam. Pre: trusted tag. Post: supports native link/modal event lifecycles. */
function element(tag) {
  const listeners=new Map();
  return {tagName:tag.toUpperCase(),children:[],open:false,append(...nodes){this.children.push(...nodes);},
    addEventListener(name,callback){listeners.set(name,callback);},
    fire(name,event={}){return listeners.get(name)?.(event);},close(){this.open=false;this.fire('close');},
    setAttribute(){}};
}
const document={createElement:element,createTextNode:text=>({textContent:text})};
let pages=['Cover','Every one has their own unique experience with how the world works.'], destroyed=0;
const pdfjs={GlobalWorkerOptions:{},getDocument:()=>({promise:Promise.resolve({numPages:pages.length,
  getPage:async number=>({getTextContent:async()=>({items:[{str:pages[number-1]}]})})}),destroy:async()=>{destroyed++;}})};
const context=vm.createContext({URLSearchParams,window:{},document,Uint8Array,fetch:async()=>({ok:true,arrayBuffer:async()=>new ArrayBuffer(1)})});
const module=new vm.SyntheticModule(['GlobalWorkerOptions','getDocument'],function(){
  this.setExport('GlobalWorkerOptions',pdfjs.GlobalWorkerOptions);this.setExport('getDocument',pdfjs.getDocument);
},{context});
await module.link(()=>{});await module.evaluate();
const load=name=>vm.runInContext(readFileSync(new URL('../static/features/notes/'+name,import.meta.url),'utf8'),context,
  {importModuleDynamically:async()=>module});
context.window.EditorTools={icons:{register(){}},registry:{contribute:(_area,tool)=>contributions.set(tool.id,tool)},
  Tool:{bind:(node,tool)=>node.execute=tool.execute}};
context.window.EditorPanes={form:definition=>{const spec={definition,dialog:element('dialog')};forms.push(spec);return spec;},
  open:(dialog)=>{dialog.open=true;return dialog;}};
context.window.PdfAnnotator=class {
  constructor(options){assert(options.colors,'host provides annotator color configuration');this.options=options;this.root=element('div');viewers.push(this);}
  async open(){this.doc={};}
  goToPage(page){this.page=page;}
  async destroy(){this.destroyed=true;}
};
load('annotations.js');load('sources.js');load('tools.js');
const source=context.window.NoteSources, base='/api/projects/'+'a'.repeat(32)+'/documents/'+'b'.repeat(32), href=base+'/original#page=2';
assert.equal(source.parse(href).page,2);
for(const invalid of ['javascript:alert(1)','https://example.org'+href,href.replace('page=2','page=0'),href.replace('page=2','page=1.5'),href.replace('page=2','page=9007199254740992')]) assert.equal(source.parse(invalid),null);
assert.equal(source.normalize('“Expe-\nrience,” it’s déjà vu.'),source.normalize('experience its deja vu'));
assert.deepEqual(Array.from(await source.locate(base,'Every one has their own unique experience')), [2]);
assert.equal(destroyed,1,'search worker always released');
pages.push(pages[1]);assert.deepEqual(Array.from(await source.locate(base,pages[1])),[2,3],'ambiguity is retained');
await assert.rejects(()=>source.locate(base,'short'),/longer/);
assert.deepEqual(Array.from(await source.locate(base,'',3)),[3]);
await assert.rejects(()=>source.locate(base,'',4),/only 3 pages/);
assert.equal(destroyed,4,'invalid manual location also releases its worker');
const sideTargets=[], writingView={disposed:false,trackDialog(){}}, colors={};
const ui={writingView,pdfSourceColors:colors,run:command=>command(),openSidePreview:(id,factory,target)=>sideTargets.push({id,factory,target})};
await source.preview(href,ui,{quote:'Quoted passage'});
assert.equal(sideTargets[0].id,'note-pdf');assert.equal(sideTargets[0].target.href,href,'PDF opens through the shared split workspace');
assert.equal(sideTargets[0].target.reference.quote,'Quoted passage');
const rich=source.location(href,'#f5c2e7','Exact source passage');
assert.equal(source.parse(source.location(rich,'#89b4fa',undefined,'context')).kind,'context');
assert.equal(source.parse(rich).color,'#f5c2e7');assert.equal(source.parse(rich).match,'Exact source passage');
assert.equal(source.references('“A quoted passage” [Source]('+rich+')')[0].quote,'“A quoted passage”');
const onlyComment=context.window.NoteAnnotations.annotate('A quoted passage','Context [Source]('+rich+')');
assert.equal(source.references(onlyComment)[0].color,'#f5c2e7','comment-only sources retain the quote color');
assert.equal(source.parse(source.references(source.recolorLine(onlyComment,'#89b4fa'))[0].href).match,'Exact source passage','recoloring retains matching text');
assert.equal(source.references('```\n“Quote” [Source]('+rich+')\n```').length,0);
const body=element('p');source.renderComment(body,'<script> [Source p. 2]('+href+') [bad](javascript:alert(1))',ui);
assert.equal(body.children[0].textContent,'<script> ');assert.equal(body.children[1].tagName,'A');
assert(body.children.at(-1).textContent.includes('[bad]'),'unsafe comment markup remains literal');
let selected='Every one has their own unique experience', replacement;
const toolContext={...ui,session:{getSelection:()=>selected,replaceSelection:text=>replacement=text},
  listProjectSources:async()=>[{label:'Book.pdf',pdf:true,resolvePdf:async()=>base}]};
const tool=contributions.get('notes.pdfSource');await tool.execute(toolContext);
let submit=forms.at(-1).definition.onSubmit;
await assert.rejects(()=>submit({source:'0',page:'',comment:''}),/pages 2, 3/);
await submit({source:'0',page:'2',comment:'Read surrounding paragraphs'});
const entry=context.window.NoteAnnotations.comments(replacement)[0];assert.equal(entry.text,selected);assert(entry.comment.includes(href),'source survives inside encoded comment');
await submit({source:'0',page:'3',comment:''});assert(replacement.includes('[Source p. 3]('+base+'/original#page=3&color=89b4fa)'));
selected='Changed';await assert.rejects(()=>submit({source:'0',page:'2',comment:''}),/Selection changed/);
writingView.disposed=true;const count=forms.length;await tool.execute(toolContext);assert.equal(forms.length,count,'navigation cannot reopen a stale source dialog');
console.log('PASS: quote matching, duplicate matches, page bounds, safe comment links, context navigation/cleanup, persistence and stale selections');
