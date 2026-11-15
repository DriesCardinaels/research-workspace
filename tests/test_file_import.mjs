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
  '/api/projects/test/imports/file','/api/projects/test/import-check','/api/projects/test/documents',
]);
assert.equal(requests[0][1].name,'main.tex');
assert.equal(requests[0][1].data,'encoded:main.tex');
await run(`requests=[];editor={root:{inert:false}};api=async()=>{throw new Error('name conflict');};`);
await assert.rejects(run(`importFiles([{name:'existing.tex',size:1}])`),/name conflict/);
assert.equal(run('editor.root.inert'),false,'failure restores editor interaction');
await assert.rejects(run(`importFiles([{name:'large.tex',size:201*1024*1024}])`),/maximum size/);
console.log('PASS: mixed imports route correctly; conflicts and size limits propagate; editor is restored');
