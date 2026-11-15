import {withBuiltInTools} from './support/tool-runtime.mjs';
import {Element,createDocument} from './support/pane-dom.mjs';
// Public table and command interfaces: node tests/test_latex_table.mjs
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';

const document=createDocument();
const window = { DraftMatch: {} };
const context = vm.createContext({window,document});
for (const file of ['toolbar', 'panes', 'workspace', 'latex-table']) {
  const source=readFileSync(new URL(`../static/${file}.js`, import.meta.url), 'utf8');
  vm.runInContext(file==='toolbar'?withBuiltInTools(source):source,context);
}
const { LatexTable, Workspace, EditorTools } = window;
const edit = LatexTable.edit('', 0, 0);
assert.match(edit.insert, /\\begin\{tabular\}\{ll\}/);
assert.equal(edit.insert.slice(edit.selFrom, edit.selTo), 'Cell 1,1');
assert.equal(edit.insert.match(/ \\\\/g).length, 3);
const source = 'Before: A&B\t50%\nα_β\t$4 after';
const start = source.indexOf('A&B'), end = source.indexOf(' after');
const converted = LatexTable.edit(source, start, end, {caption:'Results & costs',label:'tab:costs',alignment:'lr'});
assert.ok(converted.insert.startsWith('\n\\begin{table}'));
assert.ok(converted.insert.endsWith('\\end{table}\n'));
assert.match(converted.insert, /A\\&B & 50\\%/);
assert.match(converted.insert, /α\\_β & \\\$4/);
assert.ok(converted.insert.indexOf('\\caption{') < converted.insert.indexOf('\\label{'));
assert.equal(converted.insert.slice(converted.selFrom-start,converted.selTo-start),'A\\&B');
const crlf = LatexTable.edit('a\r\nb\tc\r\nd\te\r\nf',3,11);
assert.equal(crlf.insert.replace(/\r\n/g,'' ).includes('\n'),false);
for (const options of [{rows:0},{columns:31},{rows:1.5},{alignment:'xx'},{label:'bad}'},{label:'tab:missing-caption'}]) assert.throws(()=>LatexTable.edit('',0,0,options));
assert.throws(()=>LatexTable.edit('a\tb\nc',0,5),/same number/);
assert.throws(()=>LatexTable.edit('a\tb',0,3,{columns:3}),/requested rows/);
assert.throws(()=>LatexTable.edit('',-1,0),/selection/);
assert.throws(()=>LatexTable.edit('',0,1),/selection/);
assert.equal(typeof LatexTable.escape,'undefined','escaping remains private');
const registry = new EditorTools.SourceCommandRegistry();
let called = 0;
registry.register({id:'custom',name:'Custom',label:'Custom',icon:'x',group:'text',execute:owner=>owner.custom()});
registry.execute('custom',{custom:()=>called++});assert.equal(called,1);
registry.list().pop();assert.equal(registry.list().length,1,'list does not expose registry storage');
assert.throws(()=>registry.register(registry.list()[0]),/already registered/);
assert.throws(()=>registry.execute('missing',{}),/Unknown source/);
assert.throws(()=>registry.register({id:'broken'}),/require/);
registry.register({id:'fails',name:'Fails',label:'Fails',icon:'x',group:'text',execute:()=>{throw new Error('command failed');}});
assert.throws(()=>registry.execute('fails',{}),/command failed/,'lower-level dispatch propagates');
const workspace = Object.create(Workspace.prototype);
const errors=[];workspace.say=(message,error)=>errors.push([message,error]);
await workspace.runToolbarCommand(()=>registry.execute('fails',workspace));
await workspace.runToolbarCommand(()=>Promise.reject(new Error('async failed')));
assert.deepEqual(errors,[['command failed',true],['async failed',true]]);
assert.ok(EditorTools.sourceCommands.list().some(command=>command.id==='table'));
assert.equal(new EditorTools.ToolRegistry().areas,undefined,'registration storage remains private');
// Exercise the actual modal's submit recovery, success and disposal through public entry points.
const tableOwner={getSourceSelection:()=>'',insertTable:options=>{ if(options.rows===0)throw new Error('Invalid row count');tableOwner.inserted=options; }};
const dialog=window.LatexTableDialog.open(tableOwner),form=dialog.children[0];
const fields=Object.fromEntries(form.children.filter(node=>node.tag==='label').map(label=>[label.children[0].name,label.children[0]]));
assert.equal(dialog.getAttribute('aria-label'),'Insert LaTeX table');
assert.equal(dialog.open,true);
fields.rows.value='0';form.events.submit({preventDefault(){}});
assert.equal(dialog.open,true,'invalid input retains modal');
assert.equal(form.children.find(node=>node.getAttribute('role')==='alert').textContent,'Invalid row count');
fields.rows.value='2';fields.columns.value='3';fields.caption.value='Caption';
form.events.submit({preventDefault(){}});
assert.equal(tableOwner.inserted.rows,2);assert.equal(tableOwner.inserted.columns,3);
assert.equal(dialog.removed,true,'successful submission disposes modal');
const cancel=window.LatexTableDialog.open(tableOwner);
cancel.querySelectorAll('button').find(node=>node.textContent==='Cancel').events.click();
assert.equal(cancel.removed,true);
const failed=window.LatexTableDialog.open(tableOwner);
tableOwner.getSourceSelection=()=> 'Changed';
failed.children[0].events.submit({preventDefault(){}});
assert.match(failed.children[0].children.find(node=>node.getAttribute('role')==='alert').textContent,/selection changed/);
assert.equal(failed.open,true);
failed.close();
// Compile real generated tables using only the standard article class.
const dir=mkdtempSync(join(tmpdir(),'research-workbench-tables-'));
try {
  const literal='a\\b & 50%\t$#_{}~^\nfirst\tlast';
  const table=LatexTable.edit(literal,0,literal.length,{caption:'A & B',label:'tab:test'}).insert;
  writeFileSync(join(dir,'table.tex'),'\\documentclass{article}\n\\begin{document}\n'+edit.insert+'\n'+table+'\n\\end{document}');
  const compiled=spawnSync('pdflatex',['-interaction=nonstopmode','-halt-on-error','table.tex'],{cwd:dir,encoding:'utf8'});
  if (compiled.error?.code==='ENOENT') console.log('SKIP: pdflatex unavailable');
  else assert.equal(compiled.status,0,compiled.stdout);
} finally { rmSync(dir,{recursive:true,force:true}); }
console.log('PASS: table generation, escaping, validation, CRLF, command extensibility, private storage, boundary errors and LaTeX compilation');
