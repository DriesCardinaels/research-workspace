/* Standalone offline PDF library and editor. */
'use strict';
const root = document.getElementById('app');
let token, project, documents = [], current, editor, busy = false, showDeleted = false, folders = [], selectedFolder = 'all';
const cardVersions = new Map();
const colors = {
  highlight_colors: [{id:'yellow',label:'Yellow',hex:'#ffe066'},{id:'green',label:'Green',hex:'#8ce99a'},{id:'blue',label:'Blue',hex:'#74c0fc'},{id:'pink',label:'Pink',hex:'#faa2c1'}],
  pen_colors: [{label:'Black',hex:'#20252d'},{label:'Blue',hex:'#1971c2'},{label:'Red',hex:'#e03131'}], pen_widths:[1,2.5,5]
};
function node(tag, text, cls) { const e=document.createElement(tag); if(text)e.textContent=text; if(cls)e.className=cls; return e; }
async function api(path, options={}) {
  const res=await fetch(path,{...options,headers:{'X-PDF-Token':token,...options.headers}});
  const data=await res.json(); if(!res.ok){const e=new Error(data.error||res.statusText);e.status=res.status;e.matches=data.matches;throw e;} return data;
}
function message(text, error=false) { const e=document.getElementById('message'); e.textContent=text; e.classList.toggle('error',error); }
async function action(fn) {
  if(busy)return; busy=true; root.classList.add('busy');
  const controls=[...root.querySelectorAll('header, aside, #documentControls')];
  for(const control of controls)control.inert=true;
  try{await fn();}catch(e){message(e.message,true);}finally{busy=false;root.classList.remove('busy');for(const control of controls)control.inert=false;}
}
function endpoint(id=current.id) {return `/api/projects/${project.id}/documents/${id}`;}
async function flush() {if(editor && !(await editor.flush()))throw new Error('Annotations could not be saved. Keep this document open and retry.');}
async function choose(folder) {
  await flush();
  const next=await api('/api/projects',{method:'POST',body:JSON.stringify({folder})});
  await editor?.destroy(); editor=null; current=null; project=next; documents=next.documents; folders=next.folders; selectedFolder='all'; showDeleted=false; cardVersions.clear();
  document.getElementById('deletedToggle').checked=false;
  document.getElementById('folder').value=next.folder;
  document.getElementById('projectPath').textContent=next.folder;
  document.getElementById('import').disabled=false;
  document.getElementById('newFolder').disabled=false;
  empty(); library(); message('Project opened. Import PDFs or select a document.');
}
function empty() {
  document.getElementById('documentTitle').textContent='Research Workbench';
  document.getElementById('links').replaceChildren();
  document.getElementById('documentControls').replaceChildren();
  document.getElementById('viewer').replaceChildren(node('div','Choose a project folder, then import a PDF to start highlighting, drawing, and adding comments.','empty'));
}
function library() {
  const list=document.getElementById('library'); list.replaceChildren();
  renderFolders();
  const visible=documents.filter(d=>selectedFolder==='all'||(d.folder_id||'unfiled')===selectedFolder);
  if(!visible.length)list.append(node('p',showDeleted?'No deleted documents.':'No PDFs here yet.','hint'));
  for(const d of visible){
    const row=node('div',null,'document-row');
    const shown=!showDeleted&&current?.paper_id===d.paper_id?current:d;
    const button=node(showDeleted?'div':'button',null,'document'+(current?.paper_id===d.paper_id?' selected':''));
    button.append(node('strong',paperName(d)),node('small',`Version ${shown.number} · ${showDeleted?'Deleted — files preserved':!shown.active?'Archived · Read only':shown.exported?(shown.export_stale?'PDF export needs updating':'Annotated PDF saved'):'Original imported'}`));
    if(selectedFolder==='all'&&d.folder_id)button.append(node('small',folderName(d.folder_id)));
    if(!showDeleted)button.onclick=()=>action(()=>openDocument(shown));
    const control=node('button',showDeleted?'Restore':'Delete','document-action'+(showDeleted?'':' danger'));
    control.setAttribute('aria-label',`${showDeleted?'Restore':'Delete'} ${paperName(d)}`);
    control.onclick=()=>action(()=>showDeleted?restoreDocument(d):deleteDocument(d));
    const footer=node('div',null,'document-footer');
    if(!showDeleted)footer.append(cardVersionMenu(d,shown));
    footer.append(control);row.append(button,footer);list.append(row);
  }
}
function cardVersionMenu(latest,shown){
  const label=node('label',null,'card-version');
  label.append(node('span','Version'));
  const select=node('select');select.setAttribute('aria-label',`Version of ${paperName(latest)}`);
  const populate=versions=>{
    select.replaceChildren();
    for(const v of versions)option(select,v.id,`Version ${v.number} · ${v.active?'Latest':'Archived'}`);
    select.value=shown.id;select.disabled=false;
  };
  populate([shown]);
  if(latest.number>1){
    select.disabled=true;
    const key=`${project.id}:${latest.id}`;
    if(!cardVersions.has(key))cardVersions.set(key,api(endpoint(latest.id)+'/versions'));
    cardVersions.get(key).then(versions=>{
      if(select.isConnected)populate(versions);
    }).catch(e=>{
      cardVersions.delete(key);
      if(select.isConnected){select.title=e.message;message('Could not load version history. Reopen the folder to retry.',true);}
    });
  }
  select.onchange=()=>action(async()=>{
    try{await openDocument({id:select.value});}
    finally{library();}
  });
  label.append(select);return label;
}
async function refresh(){
  if(!project)return;
  const id=project.id, deleted=showDeleted;
  const [result,nextFolders]=await Promise.all([api(`/api/projects/${id}/${deleted?'deleted':'documents'}`),api(`/api/projects/${id}/folders`)]);
  if(project?.id!==id || showDeleted!==deleted)return;
  documents=result; folders=nextFolders;
  const updated=result.find(d=>d.id===current?.id);if(updated)current=updated;
  library();
}
function confirmDelete(d){
  const dialog=document.getElementById('deleteDialog');
  document.getElementById('deleteDescription').textContent=`Remove “${paperName(d)}” from Documents? All its versions, original PDFs, annotated copies, and comments will be kept. You can restore it from Deleted documents.`;
  dialog.returnValue='cancel';
  return new Promise(resolve=>{
    dialog.addEventListener('close',()=>resolve(dialog.returnValue==='delete'),{once:true});
    dialog.showModal();
  });
}
async function deleteDocument(d){
  if(!(await confirmDelete(d)))return;
  const active=current?.paper_id===d.paper_id?editor:null;
  // Freeze the current page during its final save and deletion request.
  if(active)active.root.inert=true;
  try{
    if(active)await flush();
    await api(endpoint(d.id),{method:'DELETE'});
    if(active){
      await active.destroy(); editor=null; current=null; empty();
    }
    await refresh();
    message(`Deleted “${paperName(d)}”. Restore it from Deleted documents if needed.`);
  }finally{if(active)active.root.inert=false;}
}
async function restoreDocument(d){
  await api(endpoint(d.id)+'/restore',{method:'POST'});
  await refresh(); message(`Restored “${paperName(d)}”. Uncheck Deleted documents to open it.`);
}
function paperName(d){return d.version_storage?d.name:d.file;}
function folderName(id){return folders.find(f=>f.id===id)?.name||'Unfiled';}
function option(select,value,label){const o=node('option',label);o.value=value;select.append(o);}
function renderFolders(){
  const select=document.getElementById('paperFolder');
  select.replaceChildren(); option(select,'all','All papers');option(select,'unfiled','Unfiled');
  for(const f of folders)option(select,f.id,f.name);
  select.value=selectedFolder; select.disabled=!project;
}
async function newFolder(){
  const dialog=document.getElementById('folderDialog'), input=document.getElementById('folderName');
  input.value='';dialog.returnValue='cancel';
  const result=await new Promise(resolve=>{dialog.addEventListener('close',()=>resolve(dialog.returnValue),{once:true});dialog.showModal();input.focus();});
  if(result!=='create')return;
  const folder=await api(`/api/projects/${project.id}/folders`,{method:'POST',body:JSON.stringify({name:input.value})});
  selectedFolder=folder.id;await refresh();
  if(current)await documentControls(current);
  message(`Folder “${folder.name}” created. Import PDFs here or use Move to folder on an open paper.`);
}
async function documentControls(d){
  const versions=await api(endpoint(d.id)+'/versions');
  if(current?.id!==d.id)return;
  const controls=document.getElementById('documentControls');controls.replaceChildren();
  const versionLabel=node('label','Version '), version=node('select');version.id='versionMenu';version.setAttribute('aria-label','Version');
  for(const v of versions)option(version,v.id,`Version ${v.number}${v.active?' · Latest':' · Archived'} · ${new Date(v.created*1000).toLocaleDateString()}`);
  version.value=d.id;
  version.onchange=()=>{const next=versions.find(v=>v.id===version.value);action(async()=>{try{await openDocument(next);}finally{version.value=current?.id||d.id;}});};
  versionLabel.append(version);controls.append(versionLabel);
  const folderLabel=node('label','Move to folder '), move=node('select');move.setAttribute('aria-label','Move to folder');
  option(move,'','Unfiled');for(const f of folders)option(move,f.id,f.name);move.value=d.folder_id||'';
  move.onchange=()=>action(async()=>{
    try{const updated=await api(endpoint(d.id)+'/folder',{method:'PUT',body:JSON.stringify({folder_id:move.value||null})});current=updated;await refresh();message(`Paper and all versions moved to “${folderName(updated.folder_id)}”.`);}
    finally{move.value=current?.folder_id||'';}
  });
  folderLabel.append(move);controls.append(folderLabel);
  if(!d.active)controls.append(node('span','Archived version · PDF and comments preserved','version-notice'));
}
async function openDocument(d){
  await flush();
  // Fetch current metadata, since another tab may have imported a newer version.
  const versions=await api(endpoint(d.id)+'/versions');
  d=versions.find(v=>v.id===d.id);
  await editor?.destroy(); editor=null; current=d;
  const base=endpoint();
  document.getElementById('documentTitle').textContent=paperName(d);
  const links=document.getElementById('links'); links.replaceChildren();
  const original=node('a','Open original'); original.href=base+'/original';original.target='_blank';original.rel='noopener'; links.append(original);
  const exported=node('a','Open saved PDF');exported.href=base+'/annotated';exported.target='_blank';exported.rel='noopener';exported.hidden=!d.exported;exported.id='savedPDF';links.append(exported);
  editor=new PdfAnnotator({pdfUrl:base+'/original',annUrl:base+'/annotations',exportUrl:base+'/annotated',openExportUrl:base+'/annotated',colors,readOnly:!d.active,headers:{'X-PDF-Token':token},onSaved:()=>refresh().catch(e=>message(e.message,true)),onExport:()=>{exported.hidden=false;refresh().catch(e=>message(e.message,true));}});
  document.getElementById('viewer').replaceChildren(editor.root);
  library();await documentControls(d);await editor.open();
  message(d.active?'Marks and comments save automatically. Save PDF updates the shareable annotated copy.':'Viewing an archived version. Its PDF and comments are preserved. Choose Latest from the Version menu to edit.');
}
async function duplicateChoice(name,matches){
  const dialog=document.getElementById('versionDialog'), select=document.getElementById('matchingPaper');
  document.getElementById('versionDescription').textContent=`“${name}” already exists. Add this to version control and keep this as the latest version? Older PDFs and their comments stay in version history. The new upload starts without editable marks or comments.`;
  select.replaceChildren();
  for(const d of matches)option(select,d.id,`${paperName(d)} · ${folderName(d.folder_id)} · Version ${d.number} · ${new Date(d.created*1000).toLocaleString()}`);
  select.parentElement.hidden=matches.length===1;
  dialog.returnValue='cancel';
  const choice=await new Promise(resolve=>{dialog.addEventListener('close',()=>resolve(dialog.returnValue),{once:true});dialog.showModal();});
  return choice==='latest'?{version_of:select.value}:choice==='separate'?{separate:true}:null;
}
async function importFiles(files){
  if(!project)throw new Error('Choose a project folder first.');
  let last, skipped=0;
  const active=editor;if(active)active.root.inert=true;
  try{
    for(const file of files){
      if(!file.name.toLowerCase().endsWith('.pdf'))throw new Error(`${file.name}: select a PDF file.`);
      if(file.size>200*1024*1024)throw new Error(`${file.name}: maximum size is 200 MB.`);
      let matches=await api(`/api/projects/${project.id}/import-check`,{method:'POST',body:JSON.stringify({name:file.name})});
      let choice=matches.length?await duplicateChoice(file.name,matches):{};
      if(choice===null){skipped++;continue;}
      message(`Importing ${file.name}…`);
      const encoded=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.onerror=()=>reject(new Error('Could not read PDF.'));reader.readAsDataURL(file);});
      // Flush the old version before archiving it, with editing frozen throughout.
      await flush();
      while(choice!==null){
        try{
          last=await api(`/api/projects/${project.id}/documents`,{method:'POST',body:JSON.stringify({name:file.name,data:encoded,folder_id:['all','unfiled'].includes(selectedFolder)?null:selectedFolder,...choice})});break;
        }catch(e){
          if(e.status!==409)throw e;
          matches=await api(`/api/projects/${project.id}/import-check`,{method:'POST',body:JSON.stringify({name:file.name})});
          if(!matches.length)throw e;
          choice=await duplicateChoice(file.name,matches);
          if(choice===null)skipped++;
        }
      }
      await refresh();
    }
    if(last){showDeleted=false;selectedFolder=last.folder_id||'unfiled';document.getElementById('deletedToggle').checked=false;await refresh();await openDocument(last);}
    else if(skipped)message('Import cancelled. Existing papers and versions were kept.');
  }finally{if(active)active.root.inert=false;}
}
function shell(){
  root.innerHTML=`<header><div><h1>Research Workbench</h1><p>Local files. Your annotations. One project folder.</p></div><div class="folder-controls"><label for="folder">Project folder</label><div class="folder-row"><input id="folder" placeholder="/path/to/my-pdfs" autocomplete="off"><button id="browse">Choose folder…</button><button id="open">Open folder</button></div></div></header><div id="message" role="status" aria-live="polite">Choose a project folder to begin.</div><main><aside><div class="library-heading"><h2>Documents</h2><button id="import" disabled>Import PDFs…</button></div><input type="file" id="files" accept="application/pdf,.pdf" multiple hidden><p id="projectPath" class="project-path">No project selected</p><label class="deleted-toggle"><input type="checkbox" id="deletedToggle"> Deleted documents</label><div class="paper-folders"><label for="paperFolder">Folders</label><div><select id="paperFolder" disabled aria-label="Folders"></select><button id="newFolder" disabled>New folder</button></div></div><div id="library"></div><p class="hint">Drop PDFs here to import.<br>Matching filenames can be added as a new version. Older PDFs and comments are kept.</p></aside><section class="editor"><div class="document-heading"><h2 id="documentTitle">Research Workbench</h2><nav id="links"></nav></div><div id="documentControls" class="document-controls"></div><div id="viewer"></div></section></main><dialog id="deleteDialog" aria-labelledby="deleteTitle" aria-describedby="deleteDescription"><form method="dialog"><h2 id="deleteTitle">Delete document?</h2><p id="deleteDescription"></p><div class="dialog-actions"><button value="cancel" autofocus>Cancel</button><button value="delete" class="danger">Delete document</button></div></form></dialog><dialog id="folderDialog" aria-labelledby="folderTitle"><form method="dialog"><h2 id="folderTitle">New folder</h2><label for="folderName">Folder name</label><input id="folderName" required maxlength="100" autocomplete="off"><div class="dialog-actions"><button value="cancel" formnovalidate>Cancel</button><button value="create">Create folder</button></div></form></dialog><dialog id="versionDialog" aria-labelledby="versionTitle" aria-describedby="versionDescription"><form method="dialog"><h2 id="versionTitle">Add a new version?</h2><p id="versionDescription"></p><label>Existing paper<select id="matchingPaper" aria-label="Existing paper"></select></label><div class="dialog-actions"><button value="cancel" autofocus>Cancel</button><button value="separate">Keep as separate paper</button><button value="latest" class="primary">Add as latest version</button></div></form></dialog>`;
  document.getElementById('newFolder').onclick=()=>action(newFolder);
  document.getElementById('paperFolder').onchange=e=>action(async()=>{selectedFolder=e.target.value;library();});
  document.getElementById('deletedToggle').onchange=()=>action(async()=>{showDeleted=document.getElementById('deletedToggle').checked;await refresh();});
  document.getElementById('open').onclick=()=>action(()=>choose(document.getElementById('folder').value));
  document.getElementById('folder').onkeydown=e=>{if(e.key==='Enter')document.getElementById('open').click();};
  document.getElementById('browse').onclick=()=>action(async()=>{const r=await api('/api/choose-folder',{method:'POST',body:'{}'});if(!r.cancelled)await choose(r.folder);});
  document.getElementById('import').onclick=()=>document.getElementById('files').click();
  document.getElementById('files').onchange=e=>{const files=[...e.target.files];e.target.value='';action(()=>importFiles(files));};
  document.querySelector('aside').ondragover=e=>e.preventDefault();
  document.querySelector('aside').ondrop=e=>{e.preventDefault();const files=[...e.dataTransfer.files];action(()=>importFiles(files));};
  empty();
}
window.addEventListener('beforeunload',e=>{if(editor?.dirty||editor?.savePromise||editor?.exporting||busy){e.preventDefault();e.returnValue='';}});
window.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='s'){e.preventDefault();if(editor&&!editor.o.readOnly)action(()=>editor.exportPdf());}});
(async()=>{shell();try{const config=await api('/api/config');token=config.token;document.getElementById('folder').value=config.last_folder;if(config.last_folder)await action(()=>choose(config.last_folder));}catch(e){message(e.message,true);}})();
