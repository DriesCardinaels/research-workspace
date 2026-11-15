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
try {
  for(const css of ['static/theme.css','static/workspace.css','static/toolbar.css','static/vendor/codemirror/codemirror.min.css','static/features/markdown/preview.css']) {
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
