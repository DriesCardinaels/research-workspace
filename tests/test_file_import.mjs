import {withToolRuntime} from './support/tool-runtime.mjs';
// Exercise browser import routing without reading files or accessing a real project.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const context=vm.createContext({console,document:{documentElement:{dataset:{}},getElementById:()=>({})}});
const source=withToolRuntime(readFileSync(new URL('../static/app.js',import.meta.url),'utf8')).split("window.addEventListener('beforeunload'")[0];
vm.runInContext(source,context);
const run=code=>vm.runInContext(code,context);
await run(`
  project={id:'test'};editor=null;
  globalThis.requests=[];globalThis.messages=[];
  api=async(path,options)=>{requests.push([path,JSON.parse(options.body)]);return path.endsWith('/import-check')?[]:{id:'pdf',folder_id:null};};
  readImportFile=async file=>'encoded:'+file.name;
  refresh=async()=>{};flush=async()=>{};openDocument=async()=>{};
  message=text=>messages.push(text);
  globalThis.document={getElementById:()=>({checked:false})};
`);
await run(`importFiles([{name:'main.tex',size:4},{name:'references.bib',size:4},{name:'image.webp',size:4},{name:'paper.PDF',size:4}])`);
const requests=JSON.parse(run('JSON.stringify(requests)'));
assert.deepEqual(requests.map(([path])=>path),[
  '/api/projects/test/imports/file','/api/projects/test/imports/file',
  '/api/projects/test/imports/file','/api/projects/test/imports/file',
]);
assert.equal(requests[0][1].name,'main.tex');
assert.equal(requests[0][1].data,'encoded:main.tex');
assert.equal(requests[3][1].name,'paper.PDF','PDFs use the same placement route as all files');
assert.equal(requests[3][1].parent,'');
await run(`requests=[];importFiles([{name:'nested.pdf',size:4},{name:'notes.md',size:4}],{parent:'Reading',source_document:null})`);
assert.equal(run("requests.every(([path,body])=>path.endsWith('/imports/file')&&body.parent==='Reading')"),true);
await run(`requests=[];importDestination={project:'test',parent:'Reading',source_document:null};importFiles([{name:'selected.pdf',size:4}]);`);
assert.equal(run('requests[0][1].parent'),'Reading','toolbar follows the selected directory');
await run(`requests=[];importDestination={project:'other',parent:'Elsewhere',source_document:null};importFiles([{name:'root.pdf',size:4}]);`);
assert.equal(run('requests[0][1].parent'),'','destinations cannot leak between projects');
await run(`requests=[];editor={root:{inert:false}};api=async()=>{throw new Error('name conflict');};`);
await assert.rejects(run(`importFiles([{name:'existing.tex',size:1}])`),/name conflict/);
assert.equal(run('editor.root.inert'),false,'failure restores editor interaction');
await assert.rejects(run(`importFiles([{name:'large.tex',size:201*1024*1024}])`),/maximum size/);
console.log('PASS: mixed imports retain explicit and selected destinations without PDF wrappers; conflicts and size limits propagate; editor is restored');
