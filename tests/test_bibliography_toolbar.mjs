import {productionModule} from './support/browser-runtime.mjs';
// Filetype contributions exercise the real Tool registry and shared dispatcher.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
class Element {
  /** Create a DOM fixture. @param {string} tag Tag. @pre None. @post Empty node.
   * @return {Element} Node. @throws {void} None.
   */
  constructor(tag){this.tag=tag;this.attributes={};this.children=[];this.events={};}
  setAttribute(key,value){this.attributes[key]=String(value);}
  getAttribute(key){return this.attributes[key]??null;}
  append(...children){this.children.push(...children);}
  addEventListener(name,handler){this.events[name]=handler;}
  removeEventListener(name){delete this.events[name];}
  remove(){this.removed=true;}
}
const window={},document={createElement:tag=>new Element(tag)};
const context=vm.createContext({window,document});
for (const name of ['toolbar','file-types','bibliography-tools']) vm.runInContext(productionModule(name), context);
const calls=[],state={warnings:0,automatic:true,suppressed:0,pending:false,problem:''};
const owner={file:'references.bib',isBibliographySource(){return this.file.endsWith('.bib');},
  getBibliographyToolState:()=>Object.freeze({...state}),runToolbarCommand:command=>command(),
  runBibliographyOperation(operation,value){calls.push([operation,value]);if(operation==='automatic')state.automatic=value;},
  focusBibliographyWarning(){calls.push(['focus']);}};
const registry=window.EditorTools.registry;
const mounted=registry.mount('bibtex.tools',{owner,view:'source'},'Bibliography tools');
const controls=mounted.element.children.map(wrapper=>wrapper.children[0]);
assert.equal(controls.length,5,'all diagnostics belong to the registered filetype toolbar');
assert.equal(controls[0].textContent,'0 warnings');assert.equal(controls[0].disabled,true);
assert.equal(controls[1].attributes.role,'switch');assert.equal(controls[1].attributes['aria-checked'],'true');
window.EditorTools.Tool.activate(controls[1]);mounted.refresh({owner,view:'source'});
assert.equal(controls[1].attributes['aria-checked'],'false');
window.EditorTools.Tool.activate(controls[2]);assert.equal(calls.filter(([name])=>name==='recheck').length,1);
Object.assign(state,{warnings:2,suppressed:1,pending:true,problem:'Restart the editor server to enable checks.'});
mounted.refresh({owner,view:'both'});
assert.equal(controls[0].textContent,'2 warnings');assert.equal(controls[0].disabled,false);
window.EditorTools.Tool.activate(controls[0]);assert.deepEqual(calls.at(-1),['focus']);
assert.equal(mounted.element.children[3].hidden,false);
window.EditorTools.Tool.activate(controls[3]);assert.equal(calls.at(-1)[0],'restore');
assert.equal(controls[4].textContent,'OpenAlex unavailable');
assert.equal(controls[4].getAttribute('title'),state.problem);
assert.equal(controls[4].getAttribute('aria-label'),state.problem,'full recovery details remain accessible');
assert.equal(mounted.element.children[2].children[0],controls[2],'background publications preserve focus targets');
owner.file='main.tex';mounted.refresh({owner,view:'source'});
assert.equal(mounted.element.hidden,true,'BibTeX tools are absent from LaTeX toolbars');
const before=calls.length;window.EditorTools.Tool.activate(controls[2]);assert.equal(calls.length,before,'stale controls cannot check another filetype');
assert.deepEqual([...window.FileTypes.registry.get('bibtex').toolbarAreas],['workspace.source','bibtex.tools']);
mounted.dispose();assert.equal(controls[2].events.click,undefined);
console.log('PASS: modular bibliography warning count, Auto OpenAlex, recheck, restore and status contributions; shared dispatch, stable controls, filetype isolation and disposal');
