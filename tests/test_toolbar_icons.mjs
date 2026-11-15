import {productionModule} from './support/browser-runtime.mjs';
// Shared source/PDF icon geometry and independently registered extensions.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
class Element {
  /** Model SVG creation.
   * @param {string} tag Element name. @pre Valid tag. @post Empty independent node.
   * @return {Element} Node. @throws {Error} None.
   */
  constructor(tag){this.tag=tag;this.attributes={};this.children=[];}
  /** Record an attribute.
   * @param {string} name Attribute. @param {*} value Value. @pre Node exists.
   * @post Attribute stored as text. @return {void} Nothing. @throws {Error} None.
   */
  setAttribute(name,value){this.attributes[name]=String(value);}
  /** Append geometry.
   * @param {...Element} children Geometry. @pre Nodes exist. @post Child order retained.
   * @return {void} Nothing. @throws {Error} None.
   */
  append(...children){this.children.push(...children);}
}
const window={DraftMatch:{}};
const context=vm.createContext({window,document:{createElementNS:(_ns,tag)=>new Element(tag)}});
for (const name of ['toolbar','workspace','latex-table']) vm.runInContext(productionModule(name), context);
const {ToolbarIconSet,icons,sourceCommands}=window.EditorTools;
for(const name of ['bold','italic','code','quote','citation','link','footnote','comment','more','commentLines','table','select','highlight','strike','replace','pen','eraser','undo','redo','minus','plus','fit','notes','copy','save','refresh','chevronDown','close','pin']){
  const element=icons.create(name),markup=icons.markup(name);
  assert.equal(element.attributes.width,'18');assert.equal(element.attributes.height,'18');
  assert.equal(element.attributes['stroke-width'],'1.75');assert.equal(element.attributes.stroke,'currentColor');
  assert.equal(element.attributes['stroke-linecap'],'round');assert.equal(element.attributes['stroke-linejoin'],'round');
  assert.equal(element.children[0].attributes.d.length>0,true);
  assert.match(markup,/class="toolbar-icon"/);assert.match(markup,/stroke-width="1.75"/);
}
for(const command of sourceCommands.list()){
  assert.match(command.icon,/width="18" height="18"/);
  assert.match(command.icon,/stroke-width="1.75"/);
  assert.equal((command.icon.match(/stroke-width=/g)||[]).length,1,'no source command overrides shared stroke weight');
}
const extensions=new ToolbarIconSet();
extensions.register('custom','M2 2h20');assert.match(extensions.markup('custom'),/M2 2h20/);
assert.throws(()=>extensions.register('custom','M1 1'),/already registered/);
assert.throws(()=>icons.markup('missing'),/Unknown toolbar icon/);
assert.throws(()=>icons.create('missing'),/Unknown toolbar icon/);
assert.equal(icons.paths,undefined,'catalog geometry stays private');
console.log('PASS: source, table, PDF, compile and overflow icons share size, stroke, color and extensible private catalog');
