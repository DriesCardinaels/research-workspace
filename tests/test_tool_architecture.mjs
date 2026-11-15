// Prevent separate production button handlers and automatic legacy adapters from returning.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const index=readFileSync(new URL('../static/index.html',import.meta.url),'utf8');
const modules=[...index.matchAll(/<script src="\/static\/([^"?]+)(?:\?[^" ]*)?"/g)].map(match=>match[1]).filter(name=>!name.startsWith('vendor/'));
for(const module of modules){
 const source=readFileSync(new URL('../static/'+module,import.meta.url),'utf8');
 assert.doesNotMatch(source,/\.onclick\s*=|\bonclick\s*:/,module+' must declare a Tool instead of an independent button handler');
 assert.doesNotMatch(source,/ExistingControlTool|Tool\.adopt\(/,module+' must not disguise existing handlers as Tools');
 if(!['toolbar.js','tool-ui.js'].includes(module)){
  const clickBindings=[...source.matchAll(/([\w.]+)\.addEventListener\(["']click["']/g)].map(match=>match[1]);
  // Document-link delegation is content navigation, like the PDF scroller, rather than a button action.
  const contentTargets=new Set(['this.scroller']);
  if(module==='features/markdown/preview.js'){
   assert.match(source,/event\.target\.closest\('a'\)/,'Markdown delegates only rendered anchor navigation');
   contentTargets.add('this.element');
  }
  assert.deepEqual(clickBindings.filter(target=>!contentTargets.has(target)),[],module+' delegates button activation to Tool.bind');
 }
}
const workspace=readFileSync(new URL('../static/workspace.js',import.meta.url),'utf8');
const render=workspace.slice(workspace.indexOf('    renderBibliographyDiagnostics('),workspace.indexOf('    getBibliographyToolState('));
assert.doesNotMatch(render,/ws-bib-diagnostic-controls|onAutomatic\(event|Recheck file/,'diagnostic actions must not be duplicated below the toolbar');
assert.match(index,/bibliography-tools\.js/);
assert.doesNotMatch(workspace,/bibDiagnosticsPanel|class: 'ws-bib-diagnostics'/,'the obsolete bottom bar is removed');
console.log('PASS: every loaded application module declares concrete button Tools; no separate onclick handlers or legacy adapters; bibliography actions occur only in toolbar contributions');
