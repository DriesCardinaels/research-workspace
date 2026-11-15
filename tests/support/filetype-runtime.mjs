import {readFileSync} from 'node:fs';
const catalog=JSON.parse(readFileSync(new URL('../../extensions/filetypes.json',import.meta.url),'utf8'));
const composition=readFileSync(new URL('../../static/filetype-adapters.js',import.meta.url),'utf8');
/** Compose real filetype infrastructure with the same inert metadata as HTTP bootstrap.
 * @param {string} source Production module text.
 * @pre VM supplies the browser fixture. @post Public built-ins use authoritative metadata.
 * @return {string} Executable classic-script module. @throws {Error} File read failure.
 */
export function withFileTypeCatalog(source) {
  return `if(typeof window==='undefined')globalThis.window=globalThis;\nwindow.WorkbenchFileTypeCatalog=${JSON.stringify(catalog)};\n`+source+'\n'+composition;
}
