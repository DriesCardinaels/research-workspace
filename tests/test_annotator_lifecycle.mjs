import {withToolRuntime} from './support/tool-runtime.mjs';
// Run: node --experimental-vm-modules tests/test_annotator_lifecycle.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {pathToFileURL, fileURLToPath} from 'node:url';
const root=process.env.RESEARCH_WORKBENCH_TEST_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// PDF.js constructs a DOMMatrix on import; this test never renders a canvas.
assert.equal(typeof Promise.try, 'function', 'PDF.js lifecycle tests require Node.js 26+ (Promise.try unavailable)');
globalThis.DOMMatrix=class DOMMatrix {};
const pdfjs=await import(pathToFileURL(root+'/static/vendor/pdfjs/pdf.min.mjs'));
const worker=pathToFileURL(root+'/static/vendor/pdfjs/pdf.worker.min.mjs').href;
pdfjs.GlobalWorkerOptions.workerSrc=worker;
const stream='BT /F1 12 Tf 60 720 Td (Lifecycle test) Tj ET';
const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
let pdf='%PDF-1.4\n', offsets=[0];
for(const [i,obj] of objects.entries()){offsets.push(pdf.length);pdf+=`${i+1} 0 obj\n${obj}\nendobj\n`;}
const xref=pdf.length;
pdf+='xref\n0 6\n0000000000 65535 f \n'+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
const bytes=new TextEncoder().encode(pdf);
let removeCount=0, disconnectCount=0;
const context=vm.createContext({window:{},document:{removeEventListener(){removeCount++;},createElement(){return {setAttribute(){}};}},Uint8Array,console,clearTimeout,setTimeout,fetch:async url=>url.endsWith('/annotations')?{ok:true,json:async()=>({version:1,highlights:[],strokes:[]})}:{ok:true,arrayBuffer:async()=>bytes.slice().buffer}});
new vm.Script(withToolRuntime(fs.readFileSync(root+'/static/annotator.js','utf8')),{
  importModuleDynamically:async specifier=>import(pathToFileURL(root+specifier))
}).runInContext(context);
const Annotator=context.window.PdfAnnotator;
function viewer(){
  const a=Object.create(Annotator.prototype);
  Object.assign(a,{o:{pdfUrl:'/document',annUrl:'/annotations'},pages:[],resizeObs:{disconnect(){disconnectCount++;}},io:{disconnect(){disconnectCount++;}},buildPages(){},renderBar(){},renderList(){},setStatus(s){this.lastStatus=s;},scroller:{replaceChildren(){}}});
  return a;
}
// The exact failing call, using a real document from the bundled PDF.js.
const task=pdfjs.getDocument({data:bytes.slice(),isEvalSupported:false});
const first=viewer();first.doc=await task.promise;first.loadingTask=task;
try {
  assert.equal(first.doc.numPages,1);
  await first.destroy();
  assert.equal(task.destroyed,true,'the actual PDF worker must be destroyed');
  await first.destroy(); // Idempotent cleanup.
} finally {if(!task.destroyed)await task.destroy();}
console.log('PASS: real PDF.js document cleanup, including repeated cleanup');
// Exercise open -> teardown repeatedly, covering retention of the task by open().
for(let i=0;i<3;i++){
  const a=viewer();await a.open();
  assert.equal(a.doc?.numPages,1,a.lastStatus);
  const activeTask=a.doc.loadingTask;
  await a.destroy();
  assert.equal(activeTask.destroyed,true);
  assert.equal(a.doc,null);
}
console.log('PASS: three repeated opens and worker shutdowns');
const unopened=viewer();await unopened.destroy();
assert.ok(removeCount>=5);assert.ok(disconnectCount>=10);
console.log('PASS: cleanup before a document has loaded');
