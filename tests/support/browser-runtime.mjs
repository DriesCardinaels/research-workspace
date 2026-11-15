import {readFileSync} from 'node:fs';
import {withBuiltInTools} from './tool-runtime.mjs';
import {withFileTypeCatalog} from './filetype-runtime.mjs';

/** Read a production module with its explicit built-in fixture composition.
 * @param {string} name Module path relative to static, with optional .js extension.
 * @pre Name is a trusted test-authored local module path.
 * @post No alternate implementation is created; real composition and assets are used.
 * @return {string} Executable classic-script source.
 * @throws {Error} Missing source or dependency file.
 */
export function productionModule(name) {
  const path=name.endsWith('.js')?name:name+'.js';
  const source=readFileSync(new URL('../../static/'+path,import.meta.url),'utf8');
  if(path==='toolbar.js')return withBuiltInTools(source);
  if(path==='file-types.js')return withFileTypeCatalog(source);
  return source;
}
