// Independent local/remote contributions use the real controller and isolated cache/cooldown state.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const window={};
const context=vm.createContext({window,setTimeout,clearTimeout});
for(const file of ['features/bibliography/providers.js','bibliography-diagnostics.js'])
  vm.runInContext(readFileSync(new URL('../static/'+file,import.meta.url),'utf8'),context);
const {DiagnosticProviders}=window.BibliographyDiagnosticProviders;
const registry=new DiagnosticProviders(),calls=[];
const source='@article{k,title={Example},year=2025}';
const snapshot={file:'references.bib',text:source,scope:'fixture'};
const entry={key:'k',type:'article',fields:{title:'Example',year:'2025'}};
registry.register({id:'local-note',label:'Local note',scope:'file',diagnose:({entries,counts})=>{
  entries[0].fields.year='mutated';counts.clear();
  return [{key:'k',code:'fixture-local',start:9,end:10,message:'Local message'}];
}});
registry.register({id:'unavailable',label:'Unavailable',scope:'entry',compare:async()=>{
  calls.push('unavailable');throw Error('Provider offline');
}});
registry.register({id:'fixture',label:'Fixture',scope:'entry',compare:async({entry,request})=>{
  assert.equal(entry.fields.year,'2025','other providers cannot alter this input');
  calls.push('fixture');
  return request('/api/fixture/diagnose',{key:entry.key});
}});
assert.throws(()=>registry.register({id:'fixture',label:'Duplicate',scope:'entry',compare(){}}),/already registered/);
let latest;
const owner={getBibliographySnapshot:()=>({...snapshot}),
  requestBibliographyDiagnostics:async(path,data)=>{
    if(path==='/api/bibliography/entries')return {entries:[structuredClone(entry)]};
    assert.equal(path,'/api/fixture/diagnose');
    return {warnings:[{key:data.key,code:'fixture-year',field:'year',message:'Remote message'}]};
  },renderBibliographyDiagnostics:(snapshot,warnings,state)=>{latest={snapshot,warnings,state};}};
const storage={getItem:()=>null,setItem(){}};
const controller=new window.BibliographyDiagnostics(owner,{providers:registry,storage,interval:0,remoteDelay:0});
await controller.refresh();
assert.deepEqual(calls,['unavailable','fixture']);
assert.deepEqual(Array.from(latest.warnings,w=>w.code),['fixture-local','fixture-year']);
assert.match(latest.state.error,/offline/);
await controller.refresh();
assert.deepEqual(calls,['unavailable','fixture'],'failed provider cooldown and successful provider cache are independent');
assert.match(latest.state.error,/paused/);
assert.equal(latest.warnings.length,2);
await controller.refresh(true);
assert.deepEqual(calls,['unavailable','fixture','unavailable','fixture']);
controller.suppress(latest.warnings[0]);
assert.equal(latest.warnings.length,1);
controller.restore();assert.equal(latest.warnings.length,2);
controller.dispose();
console.log('PASS: independently registered diagnostics, isolated inputs, provider failure/cooldown/cache isolation and suppression');
