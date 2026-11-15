import {adoptBuffer} from './support/source-buffers.mjs';
import {withBuiltInTools} from './support/tool-runtime.mjs';
import {withFileTypeCatalog} from './support/filetype-runtime.mjs';
import {withToolRuntime} from './support/tool-runtime.mjs';
// Run: node tests/test_toolbars.mjs
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

class Element {
  /** Model a mounted control. Pre: tag; post: node with independently mutable UI state. */
  constructor(tag) { this.tag=tag; this.children=[]; this.attributes={}; this.events={}; this.hidden=false; }
  /** Add a presentation class.
   * @param {void} none No arguments. @pre Node exists. @post Class names are deduplicated.
   * @return {object} Minimal class-list interface. @throws {Error} None.
   */
  get classList() { return {add:name=>{this.className=[...new Set([...(this.className||'').split(' ').filter(Boolean),name])].join(' ');}}; }
  /** Attach existing nodes. Pre: controls; post: order retained without cloning. */
  append(...nodes) { this.children.push(...nodes); }
  /** Insert controls before status text.
   * @param {...Element} nodes Controls to prepend. @pre Nodes exist. @post Order is preserved.
   * @return {void} Nothing. @throws {Error} None.
   */
  prepend(...nodes) { this.children.unshift(...nodes); }
  /** Replace rendered content. Pre: nodes; post: previous log or controls detached. */
  replaceChildren(...nodes) { this.children=nodes; }
  /** Read the first rendered node. Pre: none; post: DOM-compatible empty-content test. */
  get firstChild() { return this.children[0] || null; }
  /** Store accessibility state. Pre: name/value; post: string attribute. */
  setAttribute(name,value) { this.attributes[name]=String(value); }
  /** Read DOM metadata. @param {string} name Attribute name. @pre Node exists.
   * @post No change. @return {string|null} Stored attribute. @throws {void} None. */
  getAttribute(name) { return this.attributes[name] ?? null; }
  /** Record local handlers. Pre: event name and callback; post: event callable by the test. */
  addEventListener(name,callback) { this.events[name]=callback; }
}
const window={};
vm.runInNewContext(withBuiltInTools(readFileSync(new URL('../static/toolbar.js',import.meta.url),'utf8')),{window,document:{createElement:tag=>new Element(tag)}});
const {Tool,ToolRegistry,registry}=window.EditorTools;
let creations=0, executions=0;
class ExtensionTool extends Tool {
  static label='Custom action';
  /** Create an extension without changing owners or renderers. Pre: command service; post: one button. */
  create({execute}) { creations++;const button=new Element('button');button.addEventListener('click',execute);return button; }
  /** Refresh capability state. Pre: mounted button; post: busy documents disable the command. */
  update(button,{busy}) { button.disabled=!!busy; }
}
const extensions=new ToolRegistry();
extensions.register('custom',ExtensionTool,{views:['source','both']});
const context={view:'source',execute:()=>executions++,busy:false};
const toolbar=extensions.mount('custom',context,'Extension tools');
const wrapper=toolbar.element.children[0],control=wrapper.children[0];
assert.equal(control.attributes.title,'Custom action','tool label supplies hover text by default');
assert.equal(control.attributes['aria-label'],'Custom action','tool label supplies accessible name');
assert.equal(control.attributes['data-tool-label'],'Custom action','metadata is available to tooltip renderers');
class MissingLabel extends Tool {}
class BlankLabel extends Tool { static label='  '; }
class InvalidInfo extends Tool { static label='Valid'; static info=' '; }
assert.throws(()=>extensions.register('custom',MissingLabel),/static label/);
assert.throws(()=>extensions.register('custom',BlankLabel),/static label/);
assert.throws(()=>extensions.register('custom',InvalidInfo),/info/);
const described=new Element('button');
window.EditorTools.ToolInfo.apply(described,{label:'Import files',info:'Import files into this project'});
assert.equal(described.attributes.title,'Import files into this project');
assert.equal(described.attributes['aria-label'],'Import files');
window.EditorTools.ToolInfo.apply(described,{label:'Fallback'},true);
assert.equal(described.attributes.title,'Import files into this project','registry preserves detailed hover help');
assert.equal(described.attributes['aria-label'],'Import files');
assert.throws(()=>window.EditorTools.ToolInfo.apply(described,{}),/non-empty label/);
assert.throws(()=>window.EditorTools.ToolInfo.apply(described,{label:'  '}),/non-empty label/);
control.events.click(); assert.equal(executions,1);
toolbar.refresh({...context,view:'pdf',busy:true});
assert.equal(wrapper.hidden,true);assert.equal(toolbar.element.hidden,true);assert.equal(control.disabled,true);
toolbar.refresh({...context,view:'both'});
assert.equal(wrapper.hidden,false);assert.equal(control.disabled,false);
assert.equal(wrapper.children[0],control,'view changes retain controls, focus targets and listeners');
assert.equal(creations,1,'refresh does not recreate tools');
assert.throws(()=>extensions.register('custom',ExtensionTool),/already registered/);
assert.throws(()=>extensions.register('custom',class {}),/Tool subclass/);

const owner={getToolbarControl(id) { return this[id]; }, isLatexSource() { return this.file.endsWith('.tex'); }, isBibliographySource() { return this.file.endsWith('.bib'); }, file:'main.tex',formatControls:new Element('format'),commentBtn:new Element('comment'),referencesBtn:new Element('references')};
const source=registry.mount('workspace.source',{owner,view:'both'},'Source');
assert.equal(source.element.children.length,3);
assert.equal(source.element.children[2].hidden,true,'metadata checker is absent from LaTeX toolbar');
owner.file='references.bib';source.refresh({owner,view:'both'});
assert.equal(source.element.children[0].hidden,true,'BibTeX does not offer LaTeX formatting');
assert.equal(source.element.children[2].hidden,false,'bibliography checks remain available');
source.refresh({owner,view:'pdf'});assert.equal(source.element.hidden,true);
const build=registry.mount('workspace.build',{owner:{getToolbarControl() { return control; }},view:'pdf'},'Build');
assert.equal(build.element.hidden,false,'PDF-only view exposes its build control');
build.refresh({owner:{},view:'source'});
assert.equal(build.element.hidden,true,'source-only view does not place a build button above source');
build.refresh({owner:{},view:'both'});
assert.equal(build.element.hidden,false,'split view keeps compilation beside the preview');
let selected;
const pdfOwner={getToolbarState:()=>({readOnly:pdfOwner.readOnly,tool:'select'}),runToolbarCommand:fn=>fn(),readOnly:false,setTool:id=>{selected=id;}};
const marks=registry.mount('pdf.marks',{owner:pdfOwner,view:'review'},'Marks');
marks.element.children[1].children[0].events.click();assert.equal(selected,'highlight');
pdfOwner.readOnly=true;marks.refresh({owner:pdfOwner,view:'review'});
assert.equal(marks.element.hidden,true,'read-only PDFs do not expose editing commands');
window.DraftMatch={};
vm.runInNewContext(withToolRuntime(readFileSync(new URL('../static/workspace.js',import.meta.url),'utf8')),{window,setTimeout,clearTimeout,document:{createElement:tag=>new Element(tag)}});
const paneWorkspace=new window.Workspace({});
Object.assign(paneWorkspace,{view:'both',file:'main.tex',statusBar:new Element('footer'),tabBar:new Element('tabs'),
  compileControls:new Element('compile'),reviewBtn:new Element('comments'),changesBtn:new Element('changes'),
  formatControls:new Element('format'),commentBtn:new Element('comment'),referencesBtn:new Element('references')});
const sourceHeader=paneWorkspace.createPaneBars();
const nodes=element=>[element,...element.children.flatMap(nodes)];
assert.equal(sourceHeader.children[0].children[0],paneWorkspace.tabBar,'file tabs have their own navigation strip');
assert.equal(nodes(sourceHeader).includes(paneWorkspace.compileControls),false,'source header contains no compile controls');
assert.ok(nodes(sourceHeader).includes(paneWorkspace.formatControls),'registered source commands remain mounted');
assert.ok(nodes(paneWorkspace.previewHeader).includes(paneWorkspace.compileControls),'PDF header owns compilation');
const compileIdentity=paneWorkspace.compileControls;
for(const toolbar of paneWorkspace.toolbars)toolbar.refresh({owner:paneWorkspace,view:'pdf'});
assert.ok(nodes(paneWorkspace.previewHeader).includes(compileIdentity),'view switches retain the same build controls and handlers');
vm.runInNewContext(withFileTypeCatalog(readFileSync(new URL('../static/file-types.js',import.meta.url),'utf8')),{window});
let sourceExtensionCalls=0;
registry.contribute('latex.tools',{id:'latex.extension',label:'LaTeX extension',showText:true,execute:context=>{
  assert.equal(context.fileType,'latex');assert.equal(context.owner,undefined);assert.equal(context.cm,undefined);
  assert.equal(typeof context.editor.editSelection,'function');sourceExtensionCalls++;
}});
registry.contribute('bibtex.tools',{id:'bibtex.extension',label:'BibTeX extension',showText:true,execute:()=>{}});
paneWorkspace.refreshFileToolbars();
const extra=nodes(sourceHeader).find(node=>node.attributes['data-tool-id']==='latex.extension');
assert.ok(extra,'filetype-specific tools mount without changing the source host');
await extra.events.click();assert.equal(sourceExtensionCalls,1);
paneWorkspace.file='references.bib';paneWorkspace.refreshFileToolbars();
assert.equal(nodes(sourceHeader).includes(extra),false,'switching filetypes removes previous contributions');
assert.ok(nodes(sourceHeader).some(node=>node.attributes['data-tool-id']==='bibtex.extension'));
const workspace=Object.create(window.Workspace.prototype);
workspace.status={base_number:26,changes:[{}],builds:[{ok:true,log:'Saved compiler output'}]};
workspace.log=new Element('log');workspace.log.hidden=true;workspace.promoteBtn=new Element('button');
workspace.renderVersionAction();assert.equal(workspace.promoteBtn.disabled,false);
adoptBuffer(workspace,'main.tex',{saved:'saved',doc:{getValue:()=>'unsaved'}});
workspace.renderVersionAction();assert.equal(workspace.promoteBtn.disabled,true,'version action respects unsaved source');
workspace.getSourceBuffers().close('main.tex');
let releaseBuild;
const heldSave=new Promise(resolve=>{releaseBuild=resolve;});
const busyWorkspace=new window.Workspace({base:'/fixture',api:async()=>({ok:false,errors:[],log:''}),message(){}});
busyWorkspace.status={...workspace.status};busyWorkspace.promoteBtn=new Element('button');
busyWorkspace.saveAll=()=>heldSave;busyWorkspace.renderLog=()=>{};
busyWorkspace.renderBuild=()=>busyWorkspace.renderVersionAction();
const pendingBuild=busyWorkspace.compileActiveFile({file:'main.tex'});
assert.equal(busyWorkspace.promoteBtn.disabled,true,'version action remains disabled while compiling');
releaseBuild();await pendingBuild;
workspace.toggleLog(true);
assert.equal(workspace.log.hidden,false);
assert.equal(workspace.log.children.at(-1).textContent,'Saved compiler output','initial log opens saved output without compiling');
workspace.toggleLog(false);assert.equal(workspace.log.hidden,true);
console.log('PASS: class registration, view/capability scoping, stable controls, dynamic state, BibTeX and read-only previews');

// PDF actions use only public operations and respect archive/preview capabilities.
const actionsCalled=[];
let actionState={readOnly:false,bareBar:false,noteCount:2,showNotes:true,canCopyAll:true};
const actionOwner={getToolbarState:()=>actionState,runToolbarCommand:fn=>fn(),undo:()=>actionsCalled.push('undo'),
  redo:()=>actionsCalled.push('redo'),toggleNotes:()=>actionsCalled.push('notes'),copyToolbarComments:()=>actionsCalled.push('copy'),exportPdf:()=>actionsCalled.push('export')};
const actions=registry.mount('pdf.actions',{owner:actionOwner,view:'review'},'Actions');
for(const item of actions.element.children)item.children[0].events.click({currentTarget:item.children[0]});
assert.deepEqual(actionsCalled,['undo','redo','notes','copy','export']);
assert.equal(actions.element.children[2].children[0].textContent,'Notes (2)');
actionState={...actionState,readOnly:true};actions.refresh({owner:actionOwner,view:'review'});
assert.deepEqual(actions.element.children.map(item=>item.hidden),[true,true,false,false,true]);
actionState={...actionState,readOnly:false,bareBar:true};actions.refresh({owner:actionOwner,view:'pdf'});
assert.deepEqual(actions.element.children.map(item=>item.hidden),[false,false,true,false,true]);
console.log('PASS: PDF actions dispatch through public methods and honor review/preview/read-only capabilities');
