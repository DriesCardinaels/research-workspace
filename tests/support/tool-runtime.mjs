import {readFileSync} from 'node:fs';
const core=readFileSync(new URL('../../static/toolbar.js',import.meta.url),'utf8');
const contributions=['latex','pdf','tabs'].map(name=>readFileSync(new URL('../../static/features/'+name+'/tools.js',import.meta.url),'utf8')).join('\n');
const sourceModels=['core/source-text.js','features/bibliography/citations.js','features/bibliography/popup.js','features/bibliography/providers.js','editors/source/projection.js','editors/source/build-controller.js','editors/source/save-queue.js','editors/source/buffers.js','features/review/state.js','features/review/cards.js','features/review/panel.js'].map(path=>readFileSync(new URL('../../static/'+path,import.meta.url),'utf8')).join('\n');
const runtime=core+'\n'+contributions+'\n'+sourceModels;
/** Compose built-in tools for fixtures that explicitly load toolbar.js.
 * @param {string} source Real core source. @pre Browser fixture is initialized.
 * @post The same concrete contributions as index.html are installed.
 * @return {string} Executable source. @throws {Error} Registration failure in the VM.
 */
export function withBuiltInTools(source){return source+'\n'+contributions+'\n'+sourceModels;}

/** Load the same required Tool runtime as index.html in isolated VM tests.
 * @param {string} source Module source. @pre VM supplies its DOM fixture.
 * @post Existing registries are retained; window/global bindings match a classic browser script.
 * @return {string} Executable source. @throws {Error} Runtime file read failure.
 */
export function withToolRuntime(source){return `if(typeof window==='undefined')globalThis.window=globalThis;\nif(!window.EditorTools){${runtime}\n}\nglobalThis.EditorTools=window.EditorTools;\nif(!window.SourceProjection){${sourceModels}\n}\n`+source;}

const panes=readFileSync(new URL('../../static/panes.js',import.meta.url),'utf8');
/** Load real pane and Tool modules in an isolated browser fixture.
 * @param {string} source Domain module. @pre Fixture implements native dialog DOM.
 * @post One shared pane registry exists. @return {string} Executable source. @throws {Error} Read failure.
 */
export function withPaneRuntime(source){return withToolRuntime(`if(!window.EditorPanes){${panes}\n}\n`+source);}
