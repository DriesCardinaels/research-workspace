// Optional DOM integration runner: node tests/run_markdown_dom.mjs [path/to/jsdom/lib/api.js].
// Uses jsdom 26.1.0 for real parsing/sanitization; geometric rendering needs a browser.
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
const {JSDOM}=await import(process.argv[2]?pathToFileURL(resolve(process.argv[2])).href:'jsdom');
const root=new URL('../',import.meta.url), fixture=new URL('markdown-browser.html',import.meta.url);
const {window}=new JSDOM('',{url:'http://localhost/tests/markdown-browser.html',runScripts:'outside-only',pretendToBeVisual:true});
// jsdom has no layout engine. Supply only CodeMirror measurement and window-focus seams.
window.focus=()=>{};
window.Range.prototype.getBoundingClientRect=()=>({left:0,right:0,top:0,bottom:0});
window.Range.prototype.getClientRects=()=>[];
// A nonzero editor viewport lets CodeMirror render lines in this layout-free DOM.
for (const [property,size] of Object.entries({clientHeight:600,offsetHeight:600,clientWidth:900,offsetWidth:900})) {
  Object.defineProperty(window.HTMLElement.prototype,property,{configurable:true,get(){
    return this.classList.contains('CodeMirror') || this.classList.contains('CodeMirror-scroll') ? size : 0;
  }});
}
const nativeElementRect=window.HTMLElement.prototype.getBoundingClientRect;
window.HTMLElement.prototype.getBoundingClientRect=function(){
  // List indentation consumes measured prefix widths; jsdom itself cannot measure text.
  return this.classList.contains('note-list-measure') ? {width:this.textContent.length*8} : nativeElementRect.call(this);
};
// jsdom does not implement native modal opening; preserve the close event lifecycle.
window.HTMLDialogElement.prototype.showModal ??= function(){ this.open=true; };
window.HTMLDialogElement.prototype.close ??= function(){ this.open=false;this.dispatchEvent(new window.Event('close')); };
try {
  for(const css of ['static/style.css','static/theme.css','static/workspace.css','static/toolbar.css','static/vendor/codemirror/codemirror.min.css','static/editors/line-numbers.css','static/features/markdown/preview.css','static/features/notes/editor.css']) {
    const style=window.document.createElement('style');style.textContent=readFileSync(new URL(css,root),'utf8');window.document.head.append(style);
  }
  window.document.body.innerHTML='<pre id="results"></pre><div id="header"></div><div id="host"></div>';
  for(const match of readFileSync(fixture,'utf8').matchAll(/<script(?: src="([^"]+)")?>([\s\S]*?)<\/script>/g)) {
    window.eval(match[1]?readFileSync(new URL(match[1],fixture),'utf8'):match[2]);
  }
  const deadline=Date.now()+5000,results=window.document.getElementById('results');
  while(!/ALL CHECKS PASSED|FAIL /.test(results.textContent)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
  console.log(results.textContent);assert.match(results.textContent,/ALL CHECKS PASSED/);
} finally {window.close();}
