/* Standalone offline PDF library and editor. */
'use strict';
const root = document.getElementById('app');
// Theme: 'system' follows the OS; 'dark' and 'light' are fixed. Stored per browser.
const THEMES=['system','dark','light'];
/** Apply an explicit theme or system preference. Pre: theme name; post: CSS theme
 * and native controls agree; invalid stored values fall back to system appearance. */
function applyTheme(t){if(globalThis.WorkbenchAppearance){globalThis.WorkbenchAppearance.apply(t);return;}if(t==='system'||!THEMES.includes(t))delete document.documentElement.dataset.theme;else document.documentElement.dataset.theme=t;}
/** Save a chosen appearance. Pre: supported theme; post: current and future tabs
 * use it. Browser storage denial does not prevent the immediate theme change. */
function setTheme(value){
  theme=THEMES.includes(value)?value:'system';applyTheme(theme);
  try{localStorage.setItem('pdf-editor.theme',theme);}catch{}
  const select=document.getElementById('themeSelect');if(select)select.value=theme;
}
let theme=(()=>{try{return localStorage.getItem('pdf-editor.theme')||'dark';}catch{return 'dark';}})();
applyTheme(theme);
let token, project, documents = [], current, editor, draftView = null, busy = false, showDeleted = false, folders = [], selectedFolder = 'all';
let textView = null;
let independentEditorKind = null;
const cardVersions = new Map();
let projects = [], projectTrees = new Map(), deskView='home', sidebarMode='workspace';
/** Workspace project-removal action, independently rendered in overview and sidebar. */
class RemoveProjectTool extends globalThis.EditorTools.Tool {
  /** Define the removal action independently of any particular project.
   * @param {void} none No arguments; the target arrives through public Tool context.
   * @pre Shared Tool runtime is initialized. @post The action can be reused by different views.
   * @return {RemoveProjectTool} Concrete action. @throws {TypeError} Invalid metadata.
   */
  constructor() {
    super({ id: 'workspace.remove-project', label: 'Remove project',
      info: 'Remove this project from the workspace. Files remain on disk.', icon: 'close', showText: false,
      execute: ({ project, remove }) => remove(project) });
  }
  /** Name the target project without exposing application state.
   * @param {HTMLElement} control Rendered action. @param {object} context Public project identity.
   * @pre Context contains a registered project. @post Accessible name identifies that project.
   * @return {void} Nothing. @throws {TypeError} Invalid target identity.
   */
  update(control, context) {
    super.update(control, context);
    control.setAttribute('aria-label', 'Remove project ' + (context.project.name || context.project.folder));
  }

}
/** Render a project removal Tool without adding another action handler.
 * @param {object} item Registered project. @pre Shared Tool runtime is initialized.
 * @post One accessible icon uses the application recovery and save guards.
 * @return {HTMLButtonElement} Removal control. @throws {Error} DOM failure.
 */
function projectRemovalButton(item) {
  const control = new RemoveProjectTool().create({ project: item, remove: removeProject, run: action });
  control.classList.add('desk-remove-project'); return control;
}
/** Forget a project after confirmation and, when active, successfully saving its editors.
 * @param {object} item Registered project, including unavailable folders.
 * @pre Invoked through the application Tool recovery boundary.
 * @post Registration and recent-file cache disappear; files on disk are preserved.
 * Save/request failures retain the active editor, project list and interactive state.
 * @return {Promise<void>} Removal completion or cancellation.
 * @throws {Error} Save failure, unknown project or failed registry publication.
 */
async function removeProject(item) {
  if (!projects.some(entry => entry.id === item.id)) throw new Error('Project is no longer registered.');
  if (!confirm('Remove “' + (item.name || item.folder) + '” from the workspace? Files, annotations and versions will remain on disk.')) return;
  const active = project?.id === item.id;
  const controls = active ? [textView?.root, draftView?.root, editor?.root].filter(Boolean) : [];
  const previous = controls.map(control => control.inert);
  for (const control of controls) control.inert = true;
  try {
    if (active) {
      await flush();
      if (draftView?.unsaved) await draftView.saveAll();
      if (textView?.unsaved || draftView?.unsaved) throw new Error('Edits remain unsaved. Kept the project open.');
    }
    let result;
    try { result = await api('/api/projects/' + item.id, { method: 'DELETE' }); }
    catch (error) {
      if (error.status === 404 && error.message === 'Route not found.') throw new Error('Restart the Workbench server to enable removing projects.');
      throw error;
    }
    if (active) {
      await closeDraft(); await editor?.destroy(); editor = null; current = null; project = null;
      documents = []; folders = []; selectedFolder = 'all'; showDeleted = false;
      document.getElementById('import').disabled = true; document.getElementById('newFolder').disabled = true;
      document.getElementById('deletedToggle').checked = false;
      document.getElementById('folder').value = ''; document.getElementById('projectPath').textContent = 'No project selected';
    }
    projects = result.projects; projectTrees.delete(item.id); expandedProjects.delete(item.id);
    for (const key of cardVersions.keys()) if (key.startsWith(item.id + ':')) cardVersions.delete(key);
    try { localStorage.removeItem('pdf-editor.open:' + item.folder); } catch { /* Storage denial does not undo successful removal. */ }
    if (active) await showDeskHome();
    else { renderProjects(); if (deskView === 'home' || deskView === 'recent') renderDeskHome(deskView === 'recent'); }
    message('Project removed from the workspace. Files remain on disk.');
  } finally { controls.forEach((control, index) => { control.inert = previous[index]; }); }
}

/** Remember the active file. Pre: selected document; post: browser restart restores it.
 * Storage denial is harmless; actual source and annotations are saved by their editors. */
function rememberFile(){
  if(project && textView){
    try{localStorage.setItem('pdf-editor.open:'+project.folder,JSON.stringify({text:true,file:textView.file,source_document:textView.sourceDocument,name:textView.file,openedAt:Date.now()}));}catch{}
    return;
  }
  if(!project||!current)return;
  try{localStorage.setItem('pdf-editor.open:'+project.folder,JSON.stringify({document:current.id,review:!draftView,file:draftView?.file,name:draftView?.file||paperName(current),openedAt:Date.now()}));}catch{}
}

const expandedProjects = new Set();
const treeState = (()=>{try{return JSON.parse(localStorage.getItem('pdf-editor.tree')||'{}');}catch{return {};}})();

/** Persist branch expansion. Pre: stable branch key; post: future renders retain it.
 * Storage failures are ignored; no document or review data is changed. */
function rememberBranch(key, open){
  treeState[key]=open;
  try{localStorage.setItem('pdf-editor.tree',JSON.stringify(treeState));}catch{}
}

/** Read the current workspace tree, including ownership from older servers.
 * @pre Registered project. @post Fresh tree returned without changing the UI.
 * @throws {Error} Tree request failed. Related: refreshTree and projectFileCatalog.
 */
async function readProjectTree(item){
  const tree=await api(`/api/projects/${item.id}/tree`);
  // Older running servers still wrap a standalone paper in its former library node.
  const only=tree.children.length===1?tree.children[0]:null;
  if(only?.kind==='paper'&&only.name===item.folder.split('/').filter(Boolean).pop()){
    tree.children=only.children.map(entry=>entry.kind==='source'?{...entry,document:only.document}:entry);
  }
  // Intermediate servers flatten standalone projects without carrying the source's
  // review owner. Bind it from the unique PDF sibling, preserving explicit owners.
  const papers=tree.children.filter(entry=>entry.kind==='pdf'&&entry.document);
  if(papers.length===1){
    tree.children=tree.children.map(entry=>entry.kind==='source'&&!entry.document&&!entry.source_document
      ?{...entry,document:papers[0].document}:entry);
  }
  return tree;
}

/** Fetch the active project's structure. Pre: open project; post: cached fresh tree.
 * API errors propagate; stale responses cannot replace a different project's tree. */
async function refreshTree(){
  if(!project)return;
  const item=project, tree=await readProjectTree(item);
  if(project?.id!==item.id)return;
  projectTrees.set(item.id,tree);renderProjects();
}

/** Render compact workspace navigation and only the active project's file tree.
 * Pre: mounted shell; post: project list and file navigation match deskView.
 * Text is escaped by node(); file actions retain the existing save guards. */
function renderProjects(){
  const workspace=document.getElementById('workspaceProjects'), files=document.getElementById('projectTree');
  if(!workspace||!files)return;
  workspace.replaceChildren();files.replaceChildren();
  for(const item of projects){
    const button=node('button',null,'desk-project-link'+(['project','file'].includes(deskView)&&project?.id===item.id?' selected':''));
    button.type='button';button.title=item.folder;
    button.append(node('span','','desk-project-dot'),node('span',item.name,'desk-project-name'));
    if(!item.available)button.append(node('span','Unavailable','desk-unavailable'));
    if(['project','file'].includes(deskView)&&project?.id===item.id)button.setAttribute('aria-current','true');
    globalThis.EditorTools.Tool.bind(button, { id: 'app.activate-project', label: 'Open project ' + (item.name || item.folder), showText: true, execute: () =>action(()=>activateProject(item)) });
    const entry=node('div',null,'desk-project-entry');entry.append(button,projectRemovalButton(item));workspace.append(entry);
  }
  if(project&&['project','file'].includes(deskView)){
    const tree=projectTrees.get(project.id);
    if(tree){
      if(globalThis.ProjectExplorer){
        const rootRow=node('div',null,'explorer-root');rootRow.tabIndex=0;
        rootRow.append(navigationIcon('folder'),node('span','Project root'));
        projectExplorer().bind(rootRow,{project:project.id,path:'',name:'Project root',owner:null,folder:true});files.append(rootRow);
      }
      appendTree(files,tree.children,project,project.id,null);
      if(!tree.children.length)files.append(node('p','No files yet. Create a file or import files to begin.','hint'));
      if(tree.truncated)files.append(node('p','Large project: only the first 5,000 entries are shown.','hint'));
    }
  }
  updateDeskChrome();
}

/** Switch navigation panels without replacing the live editor.
 * Pre: mounted shell; post: exactly one panel is visible. Returning to Files
 * from the workspace overview opens the selected project's overview safely. */
async function switchSidebar(mode){
  if(mode==='project'&&!project)return;
  if(mode==='project'&&!['project','file'].includes(deskView))return showProjectOverview();
  sidebarMode=mode==='project'?'project':'workspace';updateDeskChrome();
}

/** Synchronize the single sidebar and its panel toggle.
 * Pre: shell; post: workspace or file navigation, never two visible sidebars.
 * Panel switches preserve the live PDF/source editor and pending changes. */
function updateDeskChrome(){
  const active=!!project&&['project','file'].includes(deskView);
  if(!project)sidebarMode='workspace';
  const files=!!project&&sidebarMode==='project';
  const collapsed=root.classList.contains('sidebar-collapsed');
  root.classList.toggle('workspace-home',!active);
  root.classList.toggle('sidebar-project',files);
  document.getElementById('navigationSidebar').hidden=collapsed;
  document.getElementById('workspaceSidebar').hidden=files;
  document.getElementById('documentSidebar').hidden=!files;
  for(const [id,selected] of [['sidebarProjects',!files],['sidebarFiles',files]]){
    const button=document.getElementById(id);
    button.setAttribute('aria-pressed',String(selected));button.classList.toggle('selected',selected);
  }
  document.getElementById('sidebarFiles').disabled=!project;
  const toggle=document.getElementById('sidebarToggle');
  toggle.hidden=false;
  toggle.setAttribute('aria-expanded',String(!collapsed));
  toggle.setAttribute('aria-label',collapsed?'Show sidebar':'Hide sidebar');
  toggle.title=collapsed?'Show sidebar':'Hide sidebar';
  document.getElementById('reloadDisk').hidden=!active;
  document.getElementById('workspaceFiles').hidden=!active;
  document.getElementById('workspaceHome').classList.toggle('selected',deskView==='home');
  document.getElementById('workspaceRecent').classList.toggle('selected',deskView==='recent');
  document.getElementById('projectOverview').classList.toggle('selected',deskView==='project');
  document.getElementById('activeProjectName').textContent=project?project.folder.split('/').filter(Boolean).pop():'Project';
  document.getElementById('activeProjectName').title=document.getElementById('activeProjectName').textContent;
}

/** Build a small navigation icon. Pre: known name; post: decorative, inert SVG.
 * Paths are fixed UI assets; file names and other user data never enter markup. */
function navigationIcon(name){
  const paths={folder:'M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z',
    appearance:'M12 3a9 9 0 1 0 0 18V3Z M12 3a9 9 0 0 1 0 18',
    settings:'M4 7h16 M4 17h16 M9 4v6 M15 14v6',
    storage:'M5 4h14l3 11v5H2v-5L5 4Z M2 15h20 M6 18h.01 M10 18h.01',
    grid:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
    clock:'M12 8v5l3 2 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
    'folder-plus':'M3 7V5h6l2 3h10v12H3V7 M12 11v6 M9 14h6',
    'file-plus':'M14 3H5v18h14V8L14 3 M14 3v5h5 M8 14h8 M12 10v8',
    plus:'M12 5v14 M5 12h14',upload:'M12 16V3 M7 8l5-5 5 5 M4 16v4h16v-4',
    overview:'M3 4h18v16H3z M3 9h18 M9 9v11',branch:'M6 6v12 M6 12c8 0 12-1 12-6 M8 4a2 2 0 1 1-4 0 2 2 0 0 1 4 0 M8 20a2 2 0 1 1-4 0 2 2 0 0 1 4 0 M20 4a2 2 0 1 1-4 0 2 2 0 0 1 4 0'};
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
  for(const [key,value] of Object.entries({viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'1.6','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true',class:'navigation-icon'}))svg.setAttribute(key,value);
  const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d',paths[name]||paths.folder);svg.append(path);return svg;
}

/** Activate a saved project. Pre: registry entry; post: overview and file sidebar.
 * Missing folders and save failures preserve the current editor. */
async function activateProject(item){
  if(!item.available)throw new Error('This project folder is unavailable. Reconnect it before opening.');
  if(project?.id===item.id)await showProjectOverview();else await choose(item.folder,false);
}

/** Leave a file for an overview. Pre: navigation action; post: saved work and no
 * active viewer. Errors propagate before state is changed or the viewer removed. */
async function leaveDeskFile(){
  await flush();await closeDraft();await editor?.destroy();editor=null;current=null;
  document.getElementById('links').replaceChildren();
  document.getElementById('documentControls').replaceChildren();
}

/** Return to the workspace. Pre: shell; post: all projects or recent files, with
 * project files hidden. Save errors keep the current project and editor active. */
async function showDeskHome(recent=false){
  await leaveDeskFile();deskView=recent?'recent':'home';sidebarMode='workspace';
  history.replaceState(null,'',location.pathname+location.search);
  renderProjects();renderDeskHome(recent);
}

/** Show the active project overview. Pre: loaded project; post: file tree and
 * actual project documents displayed. Saves finish before the previous view closes. */
async function showProjectOverview(){
  if(!project)return showDeskHome();
  await leaveDeskFile();deskView='project';sidebarMode='project';
  root.classList.remove('sidebar-collapsed');
  document.getElementById('sidebarToggle').setAttribute('aria-expanded','true');
  renderProjects();renderProjectOverview();
}

/** Open the project picker. Pre: mounted dialog; post: path entry focused.
 * Native dialog dismissal never creates or changes a project. */
function addProject(){
  const dialog=document.getElementById('projectPicker');
  if(!dialog.open)window.EditorPanes.open(dialog);
  document.getElementById('folder').focus();
}

/** Build a labeled overview heading. Pre: strings; post: DOM without injected HTML. */
function deskPage(title,subtitle,eyebrow){
  const page=node('div',null,'desk-page'), head=node('div',null,'desk-page-heading'), text=node('div');
  text.append(node('span',eyebrow,'desk-eyebrow'),node('h1',title),node('p',subtitle,'desk-subtitle'));
  head.append(text);page.append(head);return {page,head};
}

/** Render registered projects as a research desk. Pre: registry loaded; post:
 * available projects and remembered files are actionable without opening files on disk. */
function renderDeskHome(recent=false){
  document.getElementById('documentTitle').removeAttribute('title');
  document.getElementById('documentTitle').textContent='Workspace / '+(recent?'Recent files':'Project overview');
  const {page,head}=deskPage(recent?'Recent files':'Project overview','Your writing, sources and reading. Together.','Research desk');
  const add=node('button','+ Add project','desk-button desk-primary');globalThis.EditorTools.Tool.bind(add, { id: 'app.add-project', label: 'Add project', showText: true, execute: () => addProject() });head.append(add);
  if(!recent){
    const heading=node('div',null,'desk-list-heading');heading.append(node('span','All projects'),node('span',String(projects.length),'desk-count'));page.append(heading);
    const list=node('div',null,'desk-project-list');
    for(const item of projects){
      const row=node('button',null,'desk-project-row');row.type='button';
      const title=node('span',null,'desk-row-title');title.append(node('strong',item.name),node('small',item.folder));
      row.append(node('span','P','desk-folder-icon'),title,node('span',item.available?'Local project':'Folder unavailable','desk-row-meta'),node('span','↗','desk-row-arrow'));
      globalThis.EditorTools.Tool.bind(row, { id: 'app.open-project', label: 'Open project ' + (item.name || item.folder), showText: true, execute: () =>action(()=>activateProject(item)) });
      const entry=node('div',null,'desk-project-item');entry.append(row,projectRemovalButton(item));list.append(entry);
    }
    if(!projects.length){const empty=node('div',null,'desk-empty');empty.append(node('h2','A place for your research'),node('p','Add a project folder to keep LaTeX sources, reading PDFs and reviews together.'));list.append(empty);}
    page.append(list);
  }
  const recentHeading=node('div',null,'desk-recent-heading');recentHeading.append(node('h2',recent?'Opened in this browser':'Continue working'),node('span','Recent files across your projects'));page.append(recentHeading);
  const remembered=[];
  for(const item of projects){
    try{const saved=JSON.parse(localStorage.getItem('pdf-editor.open:'+item.folder)||'null');if(saved?.name)remembered.push({item,saved});}catch{}
  }
  remembered.sort((a,b)=>(b.saved.openedAt||0)-(a.saved.openedAt||0));
  const files=node('div',null,'desk-recent-list');
  for(const {item,saved} of remembered){
    const row=node('button',null,'desk-recent-row'), text=node('span',null,'desk-row-title');
    text.append(node('strong',saved.name),node('small',item.name));
    row.append(fileBadge(saved.text?saved.file?.split('.').pop():saved.review?'pdf':'tex','desk-file-icon'),text,node('span','↗','desk-row-arrow'));
    globalThis.EditorTools.Tool.bind(row, { id: 'app.open-recent', label: 'Open ' + saved.name, showText: true, execute: () =>action(async()=>{
      if(!item.available)throw new Error('This project folder is unavailable.');
      if(project?.id!==item.id)await choose(item.folder,false);
      if(saved.text)return openTreeFile(item,{path:saved.file,name:saved.file},saved.source_document);
      await openDocument({id:saved.document},{review:saved.review});
      if(draftView&&saved.file&&draftView.status?.files?.includes(saved.file))await draftView.openFile(saved.file);
    }) });files.append(row);
  }
  if(!remembered.length)files.append(node('p','Files you open will appear here.','desk-empty-recent'));
  page.append(files);document.getElementById('viewer').replaceChildren(page);
}

/** Show actual files in the selected project. Pre: loaded documents/tree; post:
 * overview rows open the full PDF or LaTeX tool with the file sidebar retained. */
function renderProjectOverview(){
  const name=project.folder.split('/').filter(Boolean).pop();
  document.getElementById('documentTitle').removeAttribute('title');
  document.getElementById('documentTitle').textContent='Projects / '+name;
  const {page,head}=deskPage(name,'Source files, PDFs and reviews in one project.','Project overview');
  const add=node('button','+ Import files','desk-button desk-primary');globalThis.EditorTools.Tool.bind(add, { id: 'app.import-overview', label: 'Import files', showText: true, execute: () =>document.getElementById('files').click() });head.append(add);
  const location=node('div',null,'desk-project-location');location.append(node('span','Save location'),node('span',project.folder));page.append(location);
  const heading=node('div',null,'desk-list-heading');heading.append(node('span',showDeleted?'Deleted PDFs':'PDFs'),node('span',String(documents.length),'desk-count'));page.append(heading);
  const list=node('div',null,'desk-project-list');
  for(const doc of documents){
    const row=node('button',null,'desk-project-row'),text=node('span',null,'desk-row-title');
    text.append(node('strong',paperName(doc)),node('small',`V${doc.number} · ${pdfOverviewLocation(doc)}`));
    row.append(fileBadge('pdf','desk-file-icon'),text,node('span',showDeleted?'Restore PDF':doc.exported?'Annotated PDF saved':'Open PDF','desk-row-meta'),node('span','↗','desk-row-arrow'));
    globalThis.EditorTools.Tool.bind(row, { id: 'app.open-overview-file', label: 'Open ' + paperName(doc), showText: true, execute: () =>action(()=>showDeleted?restoreDocument(doc):openDocument(doc)) });list.append(row);
  }
  if(!documents.length)list.append(node('p','Select a file in the sidebar or import a PDF to begin.','desk-empty-recent'));
  page.append(list);
  const note=node('p','Open a PDF to view, comment, or annotate. Select a file in Project files to edit its source or preview its contents.','desk-overview-note');page.append(note);
  document.getElementById('viewer').replaceChildren(page);
}

/** Describe a PDF's containing folder for the overview.
 * @param {object} doc Document metadata, optionally containing a project file path.
 * @pre Folder metadata is loaded; linked source paths use source:<paper-id>:<path>.
 * @post Document metadata is unchanged; internal source identities stay hidden.
 * @return {string} Relative folder, root label, collection name or imported PDF label.
 * @throws {TypeError} If doc is absent.
 */
function pdfOverviewLocation(doc){
  const path=doc.project_file?.replace(/^source:[^:]+:/,'');
  if(path){const boundary=path.lastIndexOf('/');return boundary<0?'Project root':path.slice(0,boundary)+'/';}
  return doc.folder_id?folderName(doc.folder_id):'Imported PDF';
}

/** Build a labeled file badge with a consistent type color.
 * Pre: extension and existing badge class; post: safe DOM using a fixed color group.
 * File labels remain visible so the type can also be identified without color. */
function fileBadge(type,cls='file-type'){
  const extension=String(type||'').toLowerCase();
  const provider=globalThis.FileTypes?.registry.resolve('file.'+extension);
  const kinds={pdf:'pdf',tex:'tex',bib:'bib',png:'image',jpg:'image',jpeg:'image',svg:'image',webp:'image',sty:'style',cls:'style',md:'text',txt:'text'};
  const labels={pdf:'PDF',tex:'TeX',bib:'BIB',png:'PNG',jpg:'JPG',jpeg:'JPG',svg:'SVG',webp:'IMG',sty:'STY',cls:'CLS',md:'MD',txt:'TXT'};
  const badge=node('span',provider?.label||labels[extension]||'FILE',cls);
  badge.setAttribute('data-file-kind',provider?.kind||kinds[extension]||'text');return badge;
}

/** Configure the active project's GitHub destination and explicitly push commits.
 * Pre: active project; post: local link saved or reviewed commit pushed on click.
 * Errors stay in the dialog; ordinary edits and builds never publish anything. */
async function openRepository(){
  if(!project)throw new Error('Open a project first.');
  const base=`/api/projects/${project.id}/github`, dialog=document.getElementById('githubDialog');
  const url=document.getElementById('githubUrl'), branch=document.getElementById('githubBranch'), source=document.getElementById('githubSource');
  const save=document.getElementById('githubSave'), push=document.getElementById('githubPush'), status=document.getElementById('githubStatus'), error=document.getElementById('githubError');
  let state;
  try{state=await api(base);}catch(e){if(e.status===404)throw new Error('Restart the editor server to enable GitHub repository linking.');throw e;}
  url.value=state.url||'';branch.value=state.branch||'main';source.replaceChildren();
  for(const item of state.sources)option(source,item.paper_id,item.name);
  source.value=state.paper_id||state.sources[0]?.paper_id||'';
  let working=false;
  const render=()=>{
    save.disabled=!state.sources.length;
    push.disabled=!state.linked||!!state.error||!state.head;
    status.textContent=state.error||(!state.sources.length?'Link a paper to its LaTeX source before linking GitHub.':state.linked?
      `Destination: ${state.url} · ${state.branch}\nCommitted source: ${state.head?.slice(0,12)||'unavailable'}\n${state.source_root||''}`:
      'Save the repository link first. This does not commit or push files.');
    if(state.uncommitted)status.textContent+='\nUncommitted edits are not included. Save a version or commit them before pushing those edits.';
    error.textContent='';
  };
  const run=async fn=>{
    if(working)return;working=true;dialog.inert=true;error.textContent='';
    try{await fn();}catch(e){if(status.textContent==='Pushing the reviewed commits…')status.textContent='Push failed.';error.textContent=e.message;}
    finally{working=false;dialog.inert=false;}
  };
  globalThis.EditorTools.Tool.bind(save, { id: 'app.save-repository', label: 'Save repository link', showText: true, execute: () =>run(async()=>{
    state=await api(base,{method:'PUT',body:JSON.stringify({url:url.value.trim(),branch:branch.value.trim(),paper_id:source.value})});render();
    document.getElementById('githubLink').title=`${state.url} · ${state.branch}`;
  }) });
  globalThis.EditorTools.Tool.bind(push, { id: 'app.push-repository', label: 'Push commits', showText: true, execute: () =>run(async()=>{
    await flush();if(draftView?.unsaved)await draftView.saveAll();
    status.textContent='Pushing the reviewed commits…';
    const result=await api(base+'/push',{method:'POST',body:JSON.stringify({expected_url:state.url,expected_branch:state.branch,expected_head:state.head})});
    const completed=`Pushed ${result.commit.slice(0,12)} to ${result.url} · ${result.branch}.`;
    status.textContent=completed;
    try{state=await api(base);render();status.textContent=completed;}
    catch(e){throw new Error('The push succeeded, but repository status could not be refreshed. '+e.message);}
  }) });
  for(const field of [url,branch,source])field.oninput=()=>{push.disabled=true;status.textContent='Save the changed link before pushing.';};
  render();window.EditorPanes.open(dialog);
}

let explorerController, importDestination=null;
/** Create the explorer through public application save, creation and refresh boundaries.
 * @pre Browser explorer module loaded. @post Controller shared across tree redraws.
 * @return {ProjectExplorer} Controller. @throws {Error} Mutations propagate to action().
 */
function projectExplorer(){
  if(explorerController)return explorerController;
  explorerController=new globalThis.ProjectExplorer({
    action,select:entry=>{importDestination={project:entry.project,parent:entry.path,source_document:entry.owner};},
    import:(entry,files)=>{
      if(project?.id!==entry.project)throw new Error('The active project changed.');
      importDestination={project:entry.project,parent:entry.path,source_document:entry.owner};
      if(files)return importFiles(files,importDestination);
      document.getElementById('files').click();
    },reveal:async entry=>{
      if(project?.id!==entry.project)throw new Error('The active project changed.');
      await api(`/api/projects/${entry.project}/entries/reveal`,{method:'POST',body:JSON.stringify({path:entry.document?'':entry.path,source_document:entry.owner,document:entry.document})});
    },create:(kind,entry)=>showCreateEntry(kind,{parent:entry.path,source_document:entry.owner}),
    directories:entry=>creationDirectories(projectTrees.get(entry.project)).filter(d=>d.source_document===entry.owner),
    change:async(entry,operation,destination)=>{
      if(project?.id!==entry.project)throw new Error('The active project changed.');
      await flush();if(draftView?.unsaved)await draftView.saveAll();
      if(textView?.unsaved||draftView?.unsaved)throw new Error('Save pending edits before changing files.');
      // Freeze/destroy source adapters before paths change so autosave cannot recreate old paths.
      await leaveDeskFile();deskView='project';renderProjects();renderProjectOverview();
      const result=await api(`/api/projects/${entry.project}/entries`,{method:'PATCH',body:JSON.stringify({path:entry.path,operation,destination:operation==='move'?destination:undefined,source_document:entry.owner,document:entry.document})});
      try{localStorage.removeItem('pdf-editor.open:'+project.folder);}catch{}
      await refresh();renderProjects();renderProjectOverview();
      message(operation==='delete'?`Deleted “${entry.name}”. Recovery copy: ${result.recovery_path}`:`Moved “${entry.name}” to “${result.destination}”.`);
    }
  });return explorerController;
}

/** List real creation destinations, preserving linked source ownership.
 * @param {object} tree Cached project tree. @param {string|null} owner Inherited paper.
 * @pre Server tree metadata is available. @post Tree remains unchanged; collections are excluded.
 * @return {object[]} Directory labels, paths and source identities. @throws {void} None.
 */
function creationDirectories(tree, owner=null){
  const result=[{label:'Project root',parent:'',source_document:null}];
  /** Visit branches without confusing paper collections with disk directories.
   * @param {object[]} entries Branches. @param {string|null} paper Review owner.
   * @param {string|null} source Linked root identity. @param {string} prefix Display prefix.
   * @pre Tree is finite. @post Real directories append to result. @return {void} Nothing.
   * @throws {void} None.
   */
  function visit(entries,paper,source,prefix){
    for(const entry of entries||[]){
      const nextPaper=entry.source_document||entry.document||paper;
      let nextSource=source,nextPrefix=prefix;
      if(entry.kind==='source'&&nextPaper){
        nextSource=nextPaper;nextPrefix=entry.name+' ('+nextPaper.slice(0,8)+')';
        result.push({label:nextPrefix,parent:'',source_document:nextSource});
      }else if(entry.kind==='folder'&&entry.path&&!entry.path.startsWith('library:')){
        result.push({label:(prefix?prefix+'/':'')+entry.path,parent:entry.path,source_document:source});
      }
      if(entry.children)visit(entry.children,nextPaper,nextSource,nextPrefix);
    }
  }
  visit(tree?.children,owner,null,'');
  return result;
}

/** Open the creation form with destinations and registered editable extensions.
 * @param {string} kind File or directory. @pre Active project and mounted shell.
 * @post Modal opens; no files or active editor buffers change.
 * @return {Promise<void>} Form readiness. @throws {Error} Tree refresh or missing project.
 */
async function showCreateEntry(kind,preferred=null){
  if(!project)throw new Error('Open a project first.');
  const id=project.id;
  await refreshTree();
  if(project?.id!==id)return;
  const dialog=document.getElementById('createEntryDialog');
  const form=document.getElementById('createEntryForm');
  const name=document.getElementById('entryName'), destination=document.getElementById('entryParent');
  const type=document.getElementById('entryType');
  const directories=creationDirectories(projectTrees.get(id));
  destination.replaceChildren();
  for(const [index,directory] of directories.entries()){
    const option=node('option',directory.label);option.value=String(index);destination.append(option);
  }
  if(preferred){const index=directories.findIndex(d=>d.parent===preferred.parent&&d.source_document===preferred.source_document);if(index>=0)destination.value=String(index);}
  type.replaceChildren();
  const custom=node('option','From filename extension');custom.value='';type.append(custom);
  for(const provider of globalThis.FileTypes.registry.list().filter(provider=>provider.capabilities.text)){
    for(const extension of provider.extensions){
      const option=node('option',provider.label+' ('+extension+')');option.value=extension;type.append(option);
    }
  }
  document.getElementById('entryTypeLabel').hidden=kind!=='file';
  type.hidden=kind!=='file';
  document.getElementById('createEntryTitle').textContent=kind==='file'?'New file':'Add directory';
  document.getElementById('entryNameLabel').textContent=kind==='file'?'Filename (including extension)':'Directory name';
  document.getElementById('entryError').textContent='';
  name.value='';name.placeholder=kind==='file'?'notes.tex':'sections';
  type.onchange=()=>{
    if(type.value){
      name.value=name.value.replace(/\.[^./\\]+$/,'')+type.value;name.focus();
      name.setSelectionRange(0,name.value.length-type.value.length);
    }
  };
  name.oninput=()=>{type.value=globalThis.FileTypes.registry.resolve(name.value)?.extensions.find(extension=>name.value.toLowerCase().endsWith(extension))||'';};
  form.onsubmit=event=>{
    event.preventDefault();
    action(async()=>{
      const submit=document.getElementById('createEntrySubmit');submit.disabled=true;
      try{
        if(project?.id!==id)throw new Error('The active project changed. Reopen the creation form.');
        const result=await api(`/api/projects/${id}/entries`,{method:'POST',body:JSON.stringify({kind,name:name.value,parent:directories[Number(destination.value)].parent,source_document:directories[Number(destination.value)].source_document})});
        dialog.close();
        await refreshTree();
        if(deskView==='project')renderProjectOverview();
        message(`${kind==='file'?'File':'Directory'} “${result.path}” created.`);
      }catch(error){document.getElementById('entryError').textContent=error.message;throw error;}finally{submit.disabled=false;}
    });
  };
  window.EditorPanes.open(dialog);name.focus();
}

/** Recursively render safe server tree entries. Pre: trusted structural fields,
 * untrusted names; post: names inserted as text and actions bound to exact files.
 * All editor switching passes through save checks in openTreeFile(). */
function appendTree(parent,entries,item,key,owner){
  for(const entry of entries){
    const documentId=entry.source_document||entry.document||owner;
    const branchKey=key+'/'+(entry.path||entry.document||entry.name);
    if(entry.children){
      const branch=node('details',null,'file-branch');
      branch.open=treeState[branchKey]??(entry.kind==='paper'||entry.kind==='source');
      const summary=node('summary');summary.append(navigationIcon('folder'),node('span',entry.name,'tree-folder-name'));summary.title=entry.path||entry.name;summary.setAttribute('data-tooltip-delay','1500');
      if(globalThis.ProjectExplorer&&((entry.kind==='folder'&&entry.path&&!entry.path.startsWith('library:'))||entry.kind==='source')){
        projectExplorer().bind(summary,{project:item.id,path:entry.path||'',name:entry.name,owner:owner||((entry.kind==='source')?documentId:null)||null,folder:true});
      }
      branch.append(summary);branch.ontoggle=()=>rememberBranch(branchKey,branch.open);
      const body=node('div',null,'file-children');
      appendTree(body,entry.children,item,branchKey,documentId);
      if(!entry.children.length)body.append(node('span','Empty folder','tree-empty'));
      branch.append(body);parent.append(branch);
    }else{
      const button=node('button',null,'tree-file');button.type='button';
      const type=entry.kind==='pdf'?'pdf':entry.type;
      button.append(fileBadge(type),node('span',entry.name,'file-name'));
      button.title=entry.path||entry.name;button.setAttribute('data-tooltip-delay','1500');
      const selected=project?.id===item.id&&(textView?textView.file===(entry.source_path||entry.path)&&textView.sourceDocument===(documentId||null):current?.id===(entry.review_document||documentId)&&(type==='pdf'?!draftView:draftView?.file===(entry.source_path||entry.path)));
      if(selected){button.classList.add('selected');button.setAttribute('aria-current','page');}
      globalThis.EditorTools.Tool.bind(button, { id: 'app.open-tree-file', label: 'Open ' + entry.name, showText: true, execute: () =>action(()=>openTreeFile(item,entry,documentId)) });
      if(globalThis.ProjectExplorer&&entry.kind==='file'&&entry.path){
        const row=node('div',null,'explorer-file-row');row.append(button);parent.append(row);
        // A locally scanned linked file still has a project-relative disk path.
        projectExplorer().bind(button,{project:item.id,path:entry.path,name:entry.name,owner:owner||null,folder:false});
      }else if(globalThis.ProjectExplorer&&entry.kind==='pdf'&&documentId){
        const row=node('div',null,'explorer-file-row');row.append(button);parent.append(row);
        projectExplorer().bind(button,{project:item.id,path:entry.path||entry.name,name:entry.name,owner:null,document:documentId,folder:false});
      }else parent.append(button);
    }
  }
}

/** Open a tree target in its full review tool. Pre: registered project/file;
 * post: PDF annotator or linked LaTeX workspace. Saves must succeed before leaving.
 * Unsupported source types report a message without replacing the active editor. */
async function openTreeFile(item,entry,owner){
  const provider=globalThis.FileTypes?.registry.resolve(entry.kind==='pdf'?'file.pdf':entry.name||entry.path||'file.'+entry.type);
  if(provider){
    importDestination={project:item.id,parent:(entry.source_path||entry.path||'').split('/').slice(0,-1).join('/'),source_document:entry.kind==='pdf'?null:owner||null};
    return provider.open({
    openPdf:()=>openPdfTreeFile(item,entry,owner),
    openSource:()=>openSourceTreeFile(item,entry,owner),
    openText:()=>openTextTreeFile(item,entry,owner),
    openSession:factory=>openTextTreeFile(item,entry,owner,factory,provider.id),
    });
  }
  throw new Error('This file type does not have an editor.');
}
/** Open PDF through the existing review implementation.
 * @param {object} item Project. @param {object} entry Tree file. @param {string} owner Source owner.
 * @pre PDF provider selected. @post Existing import/version/save guards apply.
 * @return {Promise<void>} Completion. @throws {Error} Navigation or save failure.
 */
async function openPdfTreeFile(item,entry,owner){
  if(project?.id!==item.id)await choose(item.folder,false);
  if(textView?.canPreviewProjectPdf){
    const view=textView, file=view.file, sourceOwner=view.sourceDocument;
    const doc=entry.kind==='pdf'?{id:entry.document}:await api(`/api/projects/${project.id}/open-file`,{method:'POST',body:JSON.stringify({path:entry.path,source_document:owner||undefined})});
    if(textView!==view||view.file!==file||view.sourceDocument!==sourceOwner)return;
    await view.previewProjectPdf(`/api/projects/${project.id}/documents/${doc.id}/original#page=1&kind=context`,entry.name);
    await refresh();return;
  }
  if(entry.kind==='pdf')await openDocument({id:entry.document},{review:true});
  else if(entry.type==='pdf'){
    await flush();if(draftView?.unsaved)await draftView.saveAll();
    const doc=await api(`/api/projects/${project.id}/open-file`,{method:'POST',body:JSON.stringify({path:entry.path,source_document:owner||undefined})});
    await refresh();await openDocument(doc,{review:true});
  }
}
/** Open standalone source directly or reuse its existing linked review workspace.
 * @param {object} item Project. @param {object} entry Source file. @param {string} owner Paper id.
 * @pre Source provider selected. @post Existing buffers and review semantics are retained.
 * @return {Promise<void>} Completion. @throws {Error} Source read, save or navigation failure.
 */
async function openSourceTreeFile(item,entry,owner){
    if(!owner)return openTextTreeFile(item,entry,null,options=>new Workspace({ ...options, sourceSession:new LatexSourceSession(options), colors, token, action, download:downloadSourceFile, onLinked:async result=>{
      await refresh();await openDocument(result.document);
      if(draftView){await draftView.openFile(result.file);if(result.view)draftView.setView(result.view);}
      rememberFile();renderProjects();
    }}),'standalone-source');
    if(project?.id!==item.id)await choose(item.folder,false);
    if(textView){await flush();await closeDraft();}
    if(current?.id!==owner||!draftView)await openDocument({id:owner});
    if(!draftView?.status?.linked)throw new Error('The linked LaTeX source is unavailable.');
    await draftView.openFile(entry.source_path||entry.path);rememberFile();renderProjects();
}
/** Open independently editable files through their registered provider.
 * @param {object} item Project. @param {object} entry File. @param {string|null} owner Source root owner.
 * @param {Function} createSession Editor adapter factory using public host options.
 * @param {string} kind Adapter identity used to reuse compatible hosts; optional mount runs after attachment.
 * @pre Text provider selected. @post Prior edits save before replacing the active view.
 * @return {Promise<void>} Completion. @throws {Error} Save/read failure, preserving active buffers.
 */
async function openTextTreeFile(item,entry,owner,createSession=options=>new TextWorkspace(options),kind='text'){
  if(project?.id!==item.id)await choose(item.folder,false);
  const file=entry.source_path||entry.path;
  if(textView&&independentEditorKind===kind){await textView.openFile(file,owner||null);document.getElementById('documentTitle').textContent=file;rememberFile();renderProjects();return;}
  let sourceRequest=0;
  const candidate=createSession({api,base:'/api/projects/'+project.id,message,capabilities:() => ({
    listProjectSources:async() => (await projectFileCatalog(item)).files,
    pdfReviewWriter:async pdfBase => {
      const base='/api/projects/'+item.id+'/documents';
      if(!(await api(base)).some(document=>pdfBase===base+'/'+document.id))return null;
      return async snapshot => (await api(pdfBase+'/annotations',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(snapshot)})).annotations;
    },
    openProjectSource:(target,showPdf,isActive) => {
      const request=++sourceRequest;
      return openNoteProjectSource(item,target,showPdf,() => request===sourceRequest&&isActive());
    },
    pdfSourceColors:colors,
  }),onFile:()=>{
    if(textView!==candidate)return;
    document.getElementById('documentTitle').textContent=candidate.file;rememberFile();renderProjects();
  }});
  if(!candidate?.root||!['openFile','saveAll','destroy','reconnect','refreshFromDisk'].every(method=>typeof candidate[method]==='function')){
    candidate?.destroy?.();throw new TypeError('Editor adapters require root, openFile, saveAll, destroy, reconnect and refreshFromDisk');
  }
  try{await candidate.openFile(file,owner||null);await flush();await closeDraft();await editor?.destroy();}
  catch(error){await candidate.destroy();throw error;}
  editor=null;current=null;textView=candidate;independentEditorKind=kind;deskView='file';sidebarMode='project';
  document.getElementById('links').replaceChildren();document.getElementById('documentControls').replaceChildren();
  document.getElementById('documentTitle').textContent=file;
  document.getElementById('viewer').replaceChildren(textView.root);rememberFile();renderProjects();
  await textView.mount?.({headerSlot:document.getElementById('links')});
}

/** List the current project's visible file leaves, including linked source roots.
 * @pre Project identity is captured by its text host. @post No files are opened or imported.
 * @throws {Error} Tree read failure. Related: Workspace files and note source tools.
 */
async function projectFileCatalog(item){
  const base='/api/projects/'+item.id, tree=await readProjectTree(item), files=[];
  /** Collect file leaves with an exact address and a human-readable tree label.
   * @pre Server tree entries. @post Folders contribute only their descendants.
   * @throws {void} None. Related: note project links and PDF revision resolution.
   */
  function collect(entries,owner=null,branch=[]){
    for(const entry of entries){
      const documentId=entry.source_document||entry.document||owner;
      const segments=[...branch,entry.name];
      if(entry.children){collect(entry.children,documentId,segments);continue;}
      if(!['file','pdf'].includes(entry.kind))continue;
      const target=entry.kind==='pdf'?{document:entry.document}:{path:entry.path,sourceDocument:owner};
      const pdf=entry.kind==='pdf'||entry.type==='pdf';
      files.push({target,entry,owner:documentId,pdf,label:segments.join(' / '),resolvePdf:pdf?async()=>{
        const doc=entry.document?{id:entry.document}:await api(base+'/open-file',{method:'POST',body:JSON.stringify({path:entry.path,source_document:owner||undefined})});
        return base+'/documents/'+doc.id;
      }:null});
    }
  }
  collect(tree.children);return {files,truncated:tree.truncated};
}

/** Open an exact tree file from a note link using the normal project handlers.
 * @pre Validated link target and active note. @post PDFs open beside the note, supported
 * files open in Workbench, and other files are revealed in Finder.
 * @throws {Error} Missing file, rejected navigation or unavailable Finder.
 */
async function openNoteProjectSource(item,target,showPdf,isActive){
  if(target.document)return showPdf('/api/projects/'+item.id+'/documents/'+target.document+'/original#page=1&kind=context');
  const {files}=await projectFileCatalog(item);
  const source=files.find(({target:entry})=>entry.path===target.path&&entry.sourceDocument===target.sourceDocument);
  if(!isActive())return;
  if(!source)throw new Error('Project file not found. Update the link if the file was moved or renamed.');
  if(source.pdf){
    const pdf=await source.resolvePdf();
    if(isActive())return showPdf(pdf+'/original#page=1&kind=context',source.entry.name);
    return;
  }
  return openProjectCatalogFile(item,source);
}

/** Open an authorized catalog entry through its registered file handler or Finder.
 * @pre Current project and a leaf from its tree. @post Existing navigation save guards apply.
 * @throws {Error} Missing file, rejected navigation or unavailable Finder.
 */
function openProjectCatalogFile(item,{entry,owner,target}){
  if(project?.id!==item.id)throw new Error('The active project changed.');
  if(entry.kind==='pdf'||globalThis.FileTypes.registry.resolve(entry.name))return openTreeFile(item,entry,owner);
  return api('/api/projects/'+item.id+'/entries/reveal',{method:'POST',body:JSON.stringify({path:target.path,source_document:target.sourceDocument||undefined})});
}

/** Show the same live workspace file links from every project file view.
 * @pre An active project. @post Searching reads only tree metadata, and selection
 * opens a file or previews a PDF beside an active note without editing its text.
 * @throws {Error} Tree read failure. Selection failures go through the app action.
 */
async function openWorkspaceFiles(){
  const item=project;
  if(!item)return;
  const {files,truncated}=await projectFileCatalog(item);
  if(project?.id!==item.id)return;
  const dialog=node('dialog',null,'workspace-file-picker');
  const title=node('h2','Workspace files'), label=node('label','Search files');
  const search=node('input'), list=node('ul',null,'workspace-file-results'), status=node('p',null,'hint');
  search.id='workspaceFileSearch';search.type='search';search.autocomplete='off';label.htmlFor=search.id;
  status.setAttribute('role','status');
  const actions=node('div',null,'dialog-actions'), close=node('button','Close');
  close.type='button';
  window.EditorTools.Tool.bind(close,{id:'app.close-workspace-files',label:'Close',showText:true,execute:()=>dialog.close()});
  actions.append(close);
  dialog.append(title,label,search,status,list,actions);
  const rows=files.map(file=>{
    const row=node('li'), button=node('button',file.label);
    button.type='button';
    window.EditorTools.Tool.bind(button,{id:'app.open-workspace-file',label:'Open '+file.label,showText:true,execute:()=>{
      dialog.close();
      return action(async()=>{
        if(project?.id!==item.id)return;
        if(file.pdf&&textView?.canPreviewProjectPdf){
          const view=textView, path=view.file, owner=view.sourceDocument;
          const pdf=await file.resolvePdf();
          if(textView===view&&view.file===path&&view.sourceDocument===owner)return view.previewProjectPdf(pdf+'/original#page=1&kind=context',file.entry.name);
          return;
        }
        return openProjectCatalogFile(item,file);
      });
    }});
    row.append(button);list.append(row);
    return {row,searchText:[file.label,file.target.path].filter(Boolean).join(' ').toLowerCase()};
  });
  /** Filter the current catalog in place. @pre Picker mounted or being built.
   * @post Matching rows stay in tree order and the result count is announced.
   * @throws {void} None.
   */
  function filterFiles(){
    const query=search.value.trim().toLowerCase(), terms=query.split(/\s+/);
    let count=0;
    for(const {row,searchText} of rows){
      row.hidden=!terms.every(term=>searchText.includes(term));
      if(!row.hidden)count++;
    }
    status.textContent=(count ? count+' '+(count===1?'file':'files') : query?'No matching files.':'No workspace files.')+
      (truncated?' Only the first 5,000 project entries are available.':'');
  }
  search.addEventListener('input',filterFiles);filterFiles();
  window.EditorPanes.open(dialog,{focus:search,disposable:true});
}

const colors = {
  highlight_colors: [{id:'yellow',label:'Yellow',hex:'#ffe066'},{id:'green',label:'Green',hex:'#8ce99a'},{id:'blue',label:'Blue',hex:'#74c0fc'},{id:'pink',label:'Pink',hex:'#faa2c1'}],
  pen_colors: [{label:'Black',hex:'#20252d'},{label:'Blue',hex:'#1971c2'},{label:'Red',hex:'#e03131'}], pen_widths:[1,2.5,5]
};
function node(tag, text, cls) { const e=document.createElement(tag); if(text)e.textContent=text; if(cls)e.className=cls; if(tag==='summary')globalThis.EditorTools.Tool.disclosure(e,text||'Expand or collapse section'); return e; }
/** Download a binary source archive with the latest project authorization.
 * @param {string} path Export route. @param {string} name Filename. @param {object} options Request.
 * @pre A workspace owns the action. @post Browser download starts; errors reach its Tool boundary.
 * @return {Promise<void>} Dispatch. @throws {Error} Build/transport failure.
 */
function downloadSourceFile(path,name,options){return window.SourceDownloads.download(path,name,options,token);}
async function api(path, options={}) {
  const res=await fetch(path,{...options,headers:{'X-PDF-Token':token,...options.headers}});
  const data=await res.json(); if(!res.ok){const e=new Error(data.error||res.statusText);e.status=res.status;e.matches=data.matches;throw e;} return data;
}
// Status line. Errors show in a red bar with a close button; the bar also clears when the next action starts.
function message(text, error=false) {
  const e=document.getElementById('message'); if(!e)return;
  e.classList.toggle('error',error);
  if(!error){e.textContent=text;return;}
  const close=document.createElement('button'); close.type='button'; close.className='message-close'; close.textContent='×';
  close.title='Dismiss'; close.setAttribute('aria-label','Dismiss error'); globalThis.EditorTools.Tool.bind(close, { id: 'app.dismiss-error', label: 'Dismiss error', showText: true, execute: () => clearError() });
  const span=document.createElement('span'); span.textContent=text;
  e.replaceChildren(span,close);
}
function clearError(){ const e=document.getElementById('message'); if(e?.classList.contains('error')){e.classList.remove('error');e.textContent='';} }
async function action(fn) {
  if(busy)return; busy=true; root.classList.add('busy'); clearError();
  const controls=[...root.querySelectorAll('#sidebarToggle, aside:not(.ws-review), #documentControls')];
  for(const control of controls)control.inert=true;
  try{await fn();}catch(e){message(e.message,true);}finally{busy=false;root.classList.remove('busy');for(const control of controls)control.inert=false;}
}
function endpoint(id=current.id) {return `/api/projects/${project.id}/documents/${id}`;}
async function flush() {if(textView?.unsaved)await textView.saveAll();if(editor && !(await editor.flush()))throw new Error('Annotations could not be saved. Keep this document open and retry.');}
/** Save source before leaving its workspace. Pre: idle navigation action;
 * post: saved buffers and destroyed workspace, or the live editor retained on error.
 * Freezing input prevents edits arriving after the final save snapshot. */
async function closeDraft(force=false){
  if(textView){
    const view=textView;view.root.inert=true;
    try{if(view.unsaved)await view.saveAll();if(view.unsaved)throw new Error('Text edits remain unsaved. Kept the editor open.');await view.destroy();textView=null;independentEditorKind=null;}
    finally{view.root.inert=false;}
  }
  if(!draftView)return;
  const view=draftView;
  view.root.inert=true;
  try{
    if(view.unsaved&&!force)await view.saveAll();
    if(view.unsaved&&!force)throw new Error('Source edits remain unsaved. Kept the workspace open.');
    await view.destroy();draftView=null;
  }finally{view.root.inert=false;}
}
// LaTeX workspace (source, PDF, comments). `status` is the draft status when already fetched.
async function openWorkspace(d,status){
  await flush(); await closeDraft();
  await editor?.destroy(); editor=null;
  document.getElementById('links').replaceChildren();
  await documentControls(d,true);
  draftView=new Workspace({api,download:downloadSourceFile,base:endpoint(d.id)+'/draft',doc:d,colors,token,headerSlot:document.getElementById('links'),
    author:(()=>{try{return localStorage.getItem('pdf-editor.author')||'Author';}catch{return 'Author';}})(),
    message,clearError,action,onFile:()=>{rememberFile();renderProjects();},onReview:()=>action(()=>openDocument(current,{review:true})),
    onPromoted:async(next,commit,warning)=>{await closeDraft(true);await refresh();await openDocument(next);message(`Saved the draft as V${next.number} (commit ${commit.slice(0,7)}, not pushed). Change history and resolved comments stay with V${next.number-1}.`+(warning?' '+warning:''),!!warning);}});
  document.getElementById('viewer').replaceChildren(draftView.root);
  await draftView.open(status);rememberFile();renderProjects();
  await draftView.mount({headerSlot:document.getElementById('links')});
}
async function choose(folder,restore=false) {
  await flush(); await closeDraft();
  const next=await api('/api/projects',{method:'POST',body:JSON.stringify({folder})});
  await editor?.destroy(); editor=null; current=null; project=next; documents=next.documents; folders=next.folders; selectedFolder='all'; showDeleted=false; cardVersions.clear();
  document.getElementById('deletedToggle').checked=false;
  document.getElementById('folder').value=next.folder;
  document.getElementById('projectPath').textContent=next.folder;
  document.getElementById('import').disabled=false;
  document.getElementById('newFolder').disabled=false;
  deskView='project';sidebarMode='project';root.classList.remove('sidebar-collapsed');
  document.getElementById('sidebarToggle').setAttribute('aria-expanded','true');
  projects=await api('/api/projects');expandedProjects.add(project.id);
  await refreshTree();
  if(document.getElementById('projectPicker').open)document.getElementById('projectPicker').close();
  empty(); library(); message('Project opened. Import files or select a document.');
  if(restore){
    let saved;try{saved=JSON.parse(localStorage.getItem('pdf-editor.open:'+project.folder)||'null');}catch{}
    if(saved?.text){await openTreeFile(project,{path:saved.file,name:saved.file},saved.source_document);}
    else if(saved&&documents.some(d=>d.id===saved.document)){
      await openDocument({id:saved.document},{review:saved.review});
      if(draftView&&saved.file&&draftView.status?.files?.includes(saved.file))await draftView.openFile(saved.file);
      renderProjects();
    }
  }
}
/** Render the appropriate landing view. Pre: shell; post: no stale file controls. */
function empty() {
  if(project&&deskView==='file')deskView='project';
  document.getElementById('links').replaceChildren();
  document.getElementById('documentControls').replaceChildren();
  if(project&&deskView==='project')renderProjectOverview();else renderDeskHome(deskView==='recent');
  renderProjects();
}

function library() {
  const list=document.getElementById('library'); list.replaceChildren();
  renderFolders();renderProjects();
  const visible=documents.filter(d=>selectedFolder==='all'||(d.folder_id||'unfiled')===selectedFolder);
  if(!visible.length)list.append(node('p',showDeleted?'No deleted documents.':'No PDFs here yet.','hint'));
  for(const d of visible){
    const row=node('div',null,'document-row');
    const shown=!showDeleted&&current?.paper_id===d.paper_id?current:d;
    const button=node(showDeleted?'div':'button',null,'document'+(current?.paper_id===d.paper_id?' selected':''));
    button.append(node('strong',paperName(d)),node('small',`V${shown.number} · ${showDeleted?'Deleted — files preserved':!shown.active?'Archived · Read only':shown.exported?(shown.export_stale?'PDF export needs updating':'Annotated PDF saved'):'Original imported'}`));
    if(selectedFolder==='all'&&d.folder_id)button.append(node('small',folderName(d.folder_id)));
    if(!showDeleted)globalThis.EditorTools.Tool.bind(button, { id: 'app.open-document', label: 'Open ' + paperName(shown), showText: true, execute: () =>action(()=>openDocument(shown)) });
    const control=node('button',showDeleted?'Restore':'Delete','document-action'+(showDeleted?'':' danger'));
    control.setAttribute('aria-label',`${showDeleted?'Restore':'Delete'} ${paperName(d)}`);
    globalThis.EditorTools.Tool.bind(control, { id: 'app.delete-or-restore', label: 'Delete or restore document', showText: true, execute: () =>action(()=>showDeleted?restoreDocument(d):deleteDocument(d)) });
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
    for(const v of versions)option(select,v.id,`V${v.number} · ${v.active?'Latest':'Archived'}`);
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
  await refreshTree();
  const updated=result.find(d=>d.id===current?.id);if(updated)current=updated;
  library();
  if(deskView==='project')renderProjectOverview();
}
// Reload button: pick up changes made on disk (library.json, annotations, LaTeX source,
// draft PDF) without a page reload. Keeps the project, folder filter and open paper.
// After a server restart the session token and project id change. Fetch the new ones and
// point the open viewer and workspace at them, so pending marks and source edits can still save.
async function resyncSession(){
  const config=await fetch('/api/config').then(r=>r.json());
  token=config.token;
  let id=project.id;
  try{await api(`/api/projects/${id}/folders`);}
  catch(e){
    if(e.status!==404)throw e;
    id=(await api('/api/projects',{method:'POST',body:JSON.stringify({folder:project.folder})})).id;
  }
  const from=`/api/projects/${project.id}/`, to=`/api/projects/${id}/`;
  if(id!==project.id){project={...project,id};cardVersions.clear();}
  if(editor){
    for(const k of ['pdfUrl','annUrl','exportUrl','openExportUrl'])if(typeof editor.o[k]==='string')editor.o[k]=editor.o[k].replace(from,to);
    editor.o.headers={...editor.o.headers,'X-PDF-Token':token};
  }
  if(draftView){draftView.o.base=draftView.o.base.replace(from,to);draftView.o.token=token;}
  textView?.reconnect('/api/projects/'+project.id);
}
async function reloadFromDisk(){
  if(!project)throw new Error('Open a project folder first.');
  await resyncSession();
  await flush();
  const id=project.id;
  let fresh;
  try{fresh=await api(`/api/projects/${id}/reload`,{method:'POST',body:'{}'});}
  catch(e){
    if(e.status===404&&e.message==='Route not found.')throw new Error('The editor server was started before Reload from disk existed. Restart it (python3 research_workbench.py in the research-workbench folder), then click ↻ again. This page and the open paper can stay open.');
    throw e;
  }
  if(project?.id!==id)return;
  if(selectedFolder!=='all'&&selectedFolder!=='unfiled'&&!fresh.folders.some(f=>f.id===selectedFolder))selectedFolder='all';
  await refresh();
  if(textView){await textView.refreshFromDisk();message('Reloaded from disk.');return;}
  if(!current){message('Reloaded from disk.');return;}
  const was=current;
  // When the latest version was open, follow the paper to its latest version now.
  const latest=fresh.documents.find(d=>d.paper_id===was.paper_id);
  if(was.active&&!latest){
    await closeDraft(); await editor?.destroy(); editor=null; current=null; empty(); library();
    message('Reloaded from disk. The open paper was deleted or moved there, so it was closed.');return;
  }
  const target=was.active?latest:was;
  if(draftView&&target.id===was.id){
    await draftView.refreshFromDisk();
    await documentControls(current,true);
    message('Reloaded from disk.');return;
  }
  const keep=editor?{ratio:editor.scroller.scrollTop/Math.max(1,editor.scroller.scrollHeight),scale:editor.scale}:null;
  const review=!draftView&&target.id===was.id;
  await openDocument(target,{review});
  if(editor&&keep){
    if(keep.scale!==null)editor.setScale(keep.scale);
    editor.scroller.scrollTop=keep.ratio*editor.scroller.scrollHeight;
  }
  message(target.id===was.id?'Reloaded from disk.':`Reloaded from disk. Opened V${target.number}, the latest version of this paper.`);
}
function confirmDelete(d){
  const dialog=document.getElementById('deleteDialog');
  document.getElementById('deleteDescription').textContent=`Remove “${paperName(d)}” from Documents? All its versions, original PDFs, annotated copies, and comments will be kept. You can restore it from Deleted documents.`;
  dialog.returnValue='cancel';
  return new Promise(resolve=>{
    dialog.addEventListener('close',()=>resolve(dialog.returnValue==='delete'),{once:true});
    window.EditorPanes.open(dialog);
  });
}
async function deleteDocument(d){
  if(!(await confirmDelete(d)))return;
  if(current?.paper_id===d.paper_id&&draftView){await closeDraft();await openDocument(current,{review:true});}
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
  const result=await new Promise(resolve=>{dialog.addEventListener('close',()=>resolve(dialog.returnValue),{once:true});window.EditorPanes.open(dialog);input.focus();});
  if(result!=='create')return;
  const folder=await api(`/api/projects/${project.id}/folders`,{method:'POST',body:JSON.stringify({name:input.value})});
  selectedFolder=folder.id;await refresh();
  if(current)await documentControls(current);
  message(`Folder “${folder.name}” created. Import files here or use Move to folder on an open paper.`);
}
/** Open saved versions in a drawer. Pre: current paper; post: history shown without changing buffers.
 * API errors propagate to action(); version navigation uses openDocument's existing save guard. */
async function showVersionHistory() {
  const paper=current;
  if(!paper)return;
  const versions=await api(endpoint(paper.id)+'/versions');
  if(current?.id!==paper.id)return;
  document.getElementById('versionHistoryDrawer')?.close();
  const dialog=node('dialog',null,'version-history-drawer');dialog.id='versionHistoryDrawer';
  dialog.setAttribute('aria-labelledby','versionHistoryTitle');
  const title=node('h2','Version history');title.id='versionHistoryTitle';
  const close=node('button','×');close.type='button';window.EditorTools.ToolInfo.apply(close,{label:'Close version history'});globalThis.EditorTools.Tool.bind(close, { id: 'app.close-history', label: 'Close version history', showText: true, execute: () =>dialog.close() });
  const heading=node('div',null,'version-history-heading');heading.append(title,close);dialog.append(heading);
  dialog.append(node('p',paperName(paper),'hint'));
  const workspace=draftView;
  if(workspace&&paper.active){
    const draft=node('section',null,'version-history-draft');draft.append(node('strong','Working draft'),node('p','Edits remain in the working draft until you save a version.','hint'));
    workspace.renderVersionAction();
    if(workspace.unsaved)draft.append(node('p','Save source edits with Cmd/Ctrl+S before saving a version.','hint'));
    draft.append(workspace.promoteBtn);dialog.append(draft);
  }
  const list=node('div',null,'version-history-list');
  for(const version of versions){
    const item=node('section',null,'version-history-entry');
    item.append(node('strong',`V${version.number}${version.active?' · Latest saved version':''}`),node('p',new Date(version.created*1000).toLocaleString(),'hint'));
    const same=version.id===paper.id;
    const open=node('button',same?(workspace?`Review saved V${version.number}`:'Currently open'):`Open V${version.number}`);
    open.disabled=same&&!workspace;
    globalThis.EditorTools.Tool.bind(open, { id: 'app.open-version', label: 'Open version ' + version.number, showText: true, execute: () =>{dialog.close();action(()=>openDocument(version,{review:same&&!!workspace}));} });item.append(open);list.append(item);
  }
  dialog.append(list);dialog.addEventListener('close',()=>dialog.remove(),{once:true});document.body.append(dialog);window.EditorPanes.open(dialog);close.focus();
}
/** Render document-level actions. Pre: active paper; post: management stays outside editing toolbars. */
async function documentControls(d,inWorkspace=false){
  if(current?.id!==d.id)return;
  const controls=document.getElementById('documentControls');controls.replaceChildren();
  const menu=node('details',null,'document-actions');
  const summary=node('summary','⋯');summary.setAttribute('aria-label','Document actions');summary.title='Document actions';
  const content=node('div',null,'document-actions-menu');
  const history=node('button','Version history');globalThis.EditorTools.Tool.bind(history, { id: 'app.version-history', label: 'Version history', showText: true, execute: () =>{menu.open=false;action(()=>showVersionHistory());} });content.append(history);
  const folderLabel=node('label'), move=node('select');move.setAttribute('aria-label','Move to folder');move.title='Folder';
  option(move,'','Unfiled');for(const f of folders)option(move,f.id,f.name);move.value=d.folder_id||'';
  move.onchange=()=>action(async()=>{
    try{const updated=await api(endpoint(d.id)+'/folder',{method:'PUT',body:JSON.stringify({folder_id:move.value||null})});current=updated;await refresh();message(`Paper and all versions moved to “${folderName(updated.folder_id)}”.`);}
    finally{move.value=current?.folder_id||'';}
  });
  folderLabel.append(node('span','Move to folder'),move);content.append(folderLabel);menu.append(summary,content);controls.append(menu);
  if(!d.active)controls.append(node('span','Archived version · PDF and comments preserved','version-notice'));
  else if(!inWorkspace){const ws=node('button','Source & PDF');ws.id='draftButton';ws.title='Edit and comment the LaTeX source next to the PDF. Nothing becomes a version until you save one.';globalThis.EditorTools.Tool.bind(ws, { id: 'app.open-workspace', label: 'Source and PDF', showText: true, execute: () =>action(()=>openWorkspace(current)) });controls.append(ws);}
}
async function openDocument(d,opts={}){
  await flush(); await closeDraft();
  // Fetch current metadata, since another tab may have imported a newer version.
  const versions=await api(endpoint(d.id)+'/versions');
  d=versions.find(v=>v.id===d.id);
  await editor?.destroy(); editor=null; current=d;
  deskView='file';sidebarMode='project';updateDeskChrome();
  const base=endpoint();
  document.getElementById('documentTitle').textContent=paperName(d);
  document.getElementById('documentTitle').title=paperName(d);
  const links=document.getElementById('links'); links.replaceChildren();
  // The latest version of a paper linked to its LaTeX source opens in the workspace.
  if(d.active&&!opts.review){
    let status=null;
    try{status=await api(base+'/draft');}catch{/* not linked or source unavailable: PDF review */}
    if(status?.linked){library();await documentControls(d,true);return openWorkspace(d,status);}
  }

  const exported=node('a','Open saved PDF');exported.href=base+'/annotated';exported.target='_blank';exported.rel='noopener';exported.hidden=!d.exported;exported.id='savedPDF';links.append(exported);
  editor=new PdfAnnotator({copyIntro:(list)=>reviewIntro(d,list),pdfUrl:base+'/original',annUrl:base+'/annotations',exportUrl:base+'/annotated',openExportUrl:base+'/annotated',colors,readOnly:!d.active,headers:{'X-PDF-Token':token},onSaved:()=>refresh().catch(e=>message(e.message,true)),onExport:()=>{exported.hidden=false;refresh().catch(e=>message(e.message,true));}});
  document.getElementById('viewer').replaceChildren(editor.root);
  library();await documentControls(d);await editor.open();rememberFile();
  message(d.active?'Marks and comments save automatically. Save PDF updates the shareable annotated copy.':'Viewing an archived version. Its PDF and comments are preserved. Open the latest version from Document actions → Version history to edit.');
}
// Instructions placed before "Copy all" marks, so the text can be handed to an AI assistant.
function reviewIntro(d,list){
  const pdf=d.version_storage?`${project.folder}/versions/${d.id}/original.pdf`:`${project.folder}/originals/${d.name}`;
  const n=list.reduce((s,h)=>s+h.comments.length,0);
  return [`# Review request: ${d.name} (V${d.number||1})`,'',
    '## Where things are',
    `- PDF: \`${pdf}\``,
    `- Review marks and comments (read-only, do not edit by hand): \`${project.folder}/.research-workbench/${d.id}.json\``,
    '- If the paper has a source (LaTeX, Word or other), find each passage there; the page numbers refer to this PDF.','',
    '## What to do',
    `There are ${list.length} mark(s) with ${n} comment(s) below, in reading order (page, then top to bottom).`,
    '1. **Address every comment.** Comments are the author\'s instructions. For each one, edit the source or propose wording. "Remove text" suggests deleting the passage. "Replace text" gives the new wording after "Replacement:". A highlight without words flags the passage; say what you think the concern is, or ask.',
    '2. **Check the review itself.** Do not accept a comment by default. Check it against the evidence (sources, data, numbers) and say where you disagree, and why.',
    '3. **Ask when unclear.** If a comment is ambiguous or you cannot tell what the author wants, do not guess. Ask a question, or ask about the thinking behind the comment, before you edit.',
    '4. **Do not change the PDF or the review data**, and do not commit or submit anything unless asked.',
    '5. **Report per item number:** what you changed, what you propose, or your question.'].join('\n');
}
async function duplicateChoice(name,matches){
  const dialog=document.getElementById('versionDialog'), select=document.getElementById('matchingPaper');
  document.getElementById('versionDescription').textContent=`“${name}” already exists. Add this to version control and keep this as the latest version? Older PDFs and their comments stay in version history. The new upload starts without editable marks or comments.`;
  select.replaceChildren();
  for(const d of matches)option(select,d.id,`${paperName(d)} · ${folderName(d.folder_id)} · V${d.number} · ${new Date(d.created*1000).toLocaleString()}`);
  select.parentElement.hidden=matches.length===1;
  dialog.returnValue='cancel';
  const choice=await new Promise(resolve=>{dialog.addEventListener('close',()=>resolve(dialog.returnValue),{once:true});window.EditorPanes.open(dialog);});
  return choice==='latest'?{version_of:select.value}:choice==='separate'?{separate:true}:null;
}
/** Import browser files directly into the selected disk directory.
 * @param {File[]} files Browser files, including PDFs and mixed types.
 * @param {object|null} destination Existing relative folder and optional linked-source owner.
 * @pre Active project; destination belongs to it. @post Files retain their names and placement;
 * the tree refreshes without creating PDF wrapper folders or switching the active editor.
 * @return {Promise<void>} Completion. @throws {Error} Size, read, conflict, destination or API failure.
 */
async function importFiles(files,destination=null){
  if(!project)throw new Error('Choose a project folder first.');
  const id=project.id;
  const target=destination||(importDestination?.project===id?importDestination:null)||{parent:'',source_document:null};
  if(target.project&&target.project!==id)throw new Error('The active project changed.');
  let imported=0;
  const active=editor;if(active)active.root.inert=true;
  try{
    for(const file of files){
      if(project?.id!==id)throw new Error('The active project changed.');
      if(file.size>200*1024*1024)throw new Error(`${file.name}: maximum size is 200 MB.`);
      message(`Importing ${file.name}…`);
      const encoded=await readImportFile(file);
      await api(`/api/projects/${id}/imports/file`,{method:'POST',body:JSON.stringify({name:file.name,data:encoded,parent:target.parent,source_document:target.source_document})});
      imported++;
      await refresh();
    }
    if(imported)message(`Imported ${imported} file(s) into “${target.parent||'Project root'}”.`);
  }finally{if(active)active.root.inert=false;}
}
/** Read file bytes for either import route.
 * @param {File} file Selected browser file.
 * @pre File is within the import size limit.
 * @post File contents are read without changing the original.
 * @return {Promise<string>} Base64 content for the authenticated import API.
 * @throws {Error} Browser read failure or cancellation; handled by action().
 */
function readImportFile(file){
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=()=>resolve(reader.result.split(',')[1]);
    reader.onerror=reader.onabort=()=>reject(new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}
/** Mount application navigation and its labeled icon definitions.
 * @param {void} none No arguments. @pre Root and tool metadata service are initialized.
 * @post Sidebar icons receive required labels, hover information and accessible names.
 * @return {void} Nothing. @throws {Error} DOM or missing label failures reach startup boundary.
 */
function shell(){
  root.innerHTML=`<div id="message" role="status" aria-live="polite">Choose a project folder to begin.</div><main><aside id="navigationSidebar" aria-label="Navigation"><div class="workspace-brand"><div><strong>Research Workbench</strong></div></div><div class="sidebar-mode" role="group" aria-label="Sidebar view"><button id="sidebarProjects" type="button" aria-pressed="true">Projects</button><button id="sidebarFiles" type="button" aria-pressed="false" disabled>Files</button></div><div class="sidebar-content"><div id="workspaceSidebar" aria-label="Workspace navigation"><button id="addProject" class="desk-button desk-primary">+ Add project</button><p class="desk-nav-label">Workspace</p><button id="workspaceHome" class="desk-nav-link selected">Project overview</button><button id="workspaceRecent" class="desk-nav-link">Recent files</button><p class="desk-nav-label">Projects</p><div id="workspaceProjects"></div></div><div id="documentSidebar" aria-label="Project files" hidden><div class="desk-project-context"><h2 id="activeProjectName"></h2></div><div class="desk-project-actions" role="group" aria-label="Project actions"><button id="projectOverview" type="button" title="Save pending edits and open the project overview" aria-label="Open project overview"></button><button id="import" type="button" title="Import files into this project" aria-label="Import files" disabled></button><button id="githubLink" type="button" title="Link a GitHub repository or push commits" aria-label="GitHub repository"></button></div><div class="library-heading"><h2>Files</h2><div class="file-create-actions"><button id="addDirectory" type="button"></button><button id="createFile" type="button"></button></div></div><div id="projectTree" aria-label="Project files"></div><input type="file" id="files" multiple hidden><details class="paper-management"><summary>Folders and versions</summary><p id="projectPath" class="project-path">No project selected</p><label class="deleted-toggle"><input type="checkbox" id="deletedToggle">Deleted documents</label><div class="paper-folders"><label for="paperFolder">Folders</label><div><select id="paperFolder" disabled aria-label="Folders"></select><button id="newFolder" disabled>New folder</button></div></div><div id="library"></div></details></div></div><div class="desk-nav-bottom"><label id="appearanceControl" class="desk-footer-icon desk-appearance" for="themeSelect"><select id="themeSelect" aria-label="Appearance" title="Appearance: System, Light or Dark"><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label><button id="integrationSettings" class="desk-footer-icon" type="button"></button><span id="localStorageStatus" class="desk-footer-icon desk-storage-status" tabindex="0" role="img"></span></div></aside><section class="editor"><div class="document-heading"><button id="sidebarToggle" aria-controls="navigationSidebar" aria-expanded="true" title="Hide documents"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></svg></button><button id="reloadDisk" type="button" title="Reload from disk: pick up changed files without reloading the page" aria-label="Reload from disk"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/></svg></button><h2 id="documentTitle">Research Workbench</h2><button id="workspaceFiles" type="button" aria-haspopup="dialog" hidden>Workspace files</button><div id="documentControls" class="document-controls"></div><nav id="links"></nav></div><div id="viewer"></div></section></main><dialog id="projectPicker" aria-labelledby="projectPickerTitle"><h2 id="projectPickerTitle">Add project</h2><p>Open an existing project folder or enter a new path to create one.</p><div class="folder-controls"><label for="folder">Project folder</label><div class="folder-row"><input id="folder" placeholder="/path/to/research-project" autocomplete="off"><button id="browse">Choose folder…</button><button id="open" class="primary">Open project</button></div></div><div class="dialog-actions"><button id="cancelProject">Cancel</button></div></dialog><dialog id="githubDialog" aria-labelledby="githubTitle"><h2 id="githubTitle">GitHub repository</h2><p>Push committed LaTeX source to this repository, then pull it into your linked Overleaf project.</p><label for="githubSource">LaTeX project</label><select id="githubSource"></select><label for="githubUrl">Repository URL</label><input id="githubUrl" placeholder="https://github.com/owner/repository" autocomplete="off" spellcheck="false"><label for="githubBranch">Target branch</label><input id="githubBranch" value="main" autocomplete="off" spellcheck="false"><p id="githubStatus" role="status"></p><p id="githubError" role="alert"></p><p class="hint">Uses this computer’s Git credentials. Only committed source is pushed; comments and editable review data stay local. Overleaf synchronization is manual and requires its GitHub integration.</p><div class="dialog-actions"><button id="githubClose">Close</button><button id="githubSave">Save link</button><button id="githubPush" class="primary" disabled>Push commits</button></div></dialog><dialog id="deleteDialog" aria-labelledby="deleteTitle" aria-describedby="deleteDescription"><form method="dialog"><h2 id="deleteTitle">Delete document?</h2><p id="deleteDescription"></p><div class="dialog-actions"><button value="cancel" autofocus>Cancel</button><button value="delete" class="danger">Delete document</button></div></form></dialog><dialog id="createEntryDialog" aria-labelledby="createEntryTitle"><form id="createEntryForm"><h2 id="createEntryTitle">New file</h2><label for="entryParent">Directory</label><select id="entryParent"></select><label id="entryTypeLabel" for="entryType">File type</label><select id="entryType"></select><label id="entryNameLabel" for="entryName">Filename (including extension)</label><input id="entryName" required maxlength="255" autocomplete="off" spellcheck="false"><p id="entryError" role="alert"></p><div class="dialog-actions"><button id="createEntryCancel" type="button">Cancel</button><button id="createEntrySubmit" type="submit" class="primary">Create</button></div></form></dialog><dialog id="folderDialog" aria-labelledby="folderTitle"><form method="dialog"><h2 id="folderTitle">New folder</h2><label for="folderName">Folder name</label><input id="folderName" required maxlength="100" autocomplete="off"><div class="dialog-actions"><button value="cancel" formnovalidate>Cancel</button><button value="create">Create folder</button></div></form></dialog><dialog id="versionDialog" aria-labelledby="versionTitle" aria-describedby="versionDescription"><form method="dialog"><h2 id="versionTitle">Add a new version?</h2><p id="versionDescription"></p><label>Existing paper<select id="matchingPaper" aria-label="Existing paper"></select></label><div class="dialog-actions"><button value="cancel" autofocus>Cancel</button><button value="separate">Keep as separate paper</button><button value="latest" class="primary">Add as latest version</button></div></form></dialog>`;
  globalThis.EditorTools.Tool.bind(document.getElementById('sidebarProjects'), { id: 'app.sidebar-projects', label: 'Show projects', showText: true, execute: () =>switchSidebar('workspace') });
  globalThis.EditorTools.Tool.bind(document.getElementById('sidebarFiles'), { id: 'app.sidebar-files', label: 'Show files', showText: true, execute: () =>action(()=>switchSidebar('project')) });
  for(const [id,icon,label,info] of [
    ['sidebarProjects','grid','Projects'], ['sidebarFiles','folder','Files'],
    ['addDirectory','folder-plus','Add directory'], ['createFile','file-plus','New file'],
    ['addProject','plus','Add project'], ['import','upload','Import files','Import files into this project'],
    ['workspaceHome','overview','Project overview'], ['workspaceRecent','clock','Recent files'],
    ['projectOverview','overview','Open project overview','Save pending edits and open the project overview'],
    ['githubLink','branch','GitHub repository','Link a GitHub repository or push commits'],
    ['appearanceControl','appearance','Appearance','Appearance: System, Light or Dark'],
    ['integrationSettings','settings','Settings'],
    ['localStorageStatus','storage','Saved on this computer'],
  ]){
    const button=document.getElementById(id);
    window.EditorTools.ToolInfo.apply(button,{label,info:info||label});
    button.setAttribute('data-tool-info',info||label);
    button.prepend(navigationIcon(icon));
  }
  for(const summary of root.querySelectorAll('summary'))globalThis.EditorTools.Tool.disclosure(summary,summary.textContent.trim()||'Expand or collapse section');
  document.getElementById('addProject').textContent='Add project';
  document.getElementById('addProject').prepend(navigationIcon('plus'));
  globalThis.EditorTools.Tool.bind(document.getElementById('githubLink'), { id: 'app.repository', label: 'GitHub repository', showText: true, execute: () =>action(openRepository) });
  globalThis.EditorTools.Tool.bind(document.getElementById('githubClose'), { id: 'app.close-repository', label: 'Close repository settings', showText: true, execute: () =>document.getElementById('githubDialog').close() });
  globalThis.EditorTools.Tool.bind(document.getElementById('addProject'), { id: 'app.add-project', label: 'Add project', showText: true, execute: () => addProject() });
  globalThis.EditorTools.Tool.bind(document.getElementById('cancelProject'), { id: 'app.cancel-project', label: 'Cancel project selection', showText: true, execute: () =>document.getElementById('projectPicker').close() });
  globalThis.EditorTools.Tool.bind(document.getElementById('workspaceHome'), { id: 'app.home', label: 'Project overview', showText: true, execute: () =>action(()=>showDeskHome()) });
  globalThis.EditorTools.Tool.bind(document.getElementById('workspaceRecent'), { id: 'app.recent', label: 'Recent files', showText: true, execute: () =>action(()=>showDeskHome(true)) });
  globalThis.EditorTools.Tool.bind(document.getElementById('projectOverview'), { id: 'app.project-overview', label: 'Open project overview', showText: true, execute: () =>action(showProjectOverview) });
  renderProjects();
  const sidebarToggle=document.getElementById('sidebarToggle');
  const setSidebarCollapsed=collapsed=>{
    root.classList.toggle('sidebar-collapsed',collapsed);
    document.getElementById('navigationSidebar').hidden=collapsed;
    sidebarToggle.setAttribute('aria-expanded',String(!collapsed));
    sidebarToggle.setAttribute('aria-label',collapsed?'Show sidebar':'Hide sidebar');
    sidebarToggle.title=collapsed?'Show sidebar':'Hide sidebar';
    try{localStorage.setItem('pdf-editor.sidebar-collapsed',String(collapsed));}catch{}
  };
  let collapsed=false;
  try{collapsed=localStorage.getItem('pdf-editor.sidebar-collapsed')==='true';}catch{}
  setSidebarCollapsed(collapsed);
  globalThis.EditorTools.Tool.bind(sidebarToggle, { id: 'app.toggle-sidebar', label: 'Toggle sidebar', showText: true, execute: () =>setSidebarCollapsed(!root.classList.contains('sidebar-collapsed')) });
  globalThis.EditorTools.Tool.bind(document.getElementById('integrationSettings'), { id: 'app.settings', label: 'Settings', showText: true, execute: () =>action(()=>window.openSettings()) });
  document.getElementById('themeSelect').value=THEMES.includes(theme)?theme:'system';
  document.getElementById('themeSelect').onchange=e=>setTheme(e.target.value);
  globalThis.EditorTools.Tool.bind(document.getElementById('workspaceFiles'), {id:'app.workspace-files',label:'Workspace files',showText:true,execute:()=>action(openWorkspaceFiles)});
  globalThis.EditorTools.Tool.bind(document.getElementById('reloadDisk'), { id: 'app.reload', label: 'Reload from disk', showText: true, execute: () =>action(reloadFromDisk) });
  globalThis.EditorTools.Tool.bind(document.getElementById('addDirectory'), {id:'app.add-directory',label:'Add directory',icon:'plus',execute:()=>action(()=>showCreateEntry('directory'))});
  globalThis.EditorTools.Tool.bind(document.getElementById('createFile'), {id:'app.create-file',label:'New file',icon:'plus',execute:()=>action(()=>showCreateEntry('file'))});
  globalThis.EditorTools.Tool.bind(document.getElementById('createEntryCancel'), {id:'app.cancel-create-entry',label:'Cancel',showText:true,execute:()=>document.getElementById('createEntryDialog').close()});
  globalThis.EditorTools.Tool.bind(document.getElementById('newFolder'), { id: 'app.new-folder', label: 'New folder', showText: true, execute: () =>action(newFolder) });
  document.getElementById('paperFolder').onchange=e=>action(async()=>{selectedFolder=e.target.value;library();});
  document.getElementById('deletedToggle').onchange=()=>action(async()=>{showDeleted=document.getElementById('deletedToggle').checked;await refresh();});
  globalThis.EditorTools.Tool.bind(document.getElementById('open'), { id: 'app.choose-project', label: 'Open project', showText: true, execute: () =>action(()=>choose(document.getElementById('folder').value)) });
  document.getElementById('folder').onkeydown=e=>{if(e.key==='Enter')globalThis.EditorTools.Tool.activate(document.getElementById('open'),e);};
  globalThis.EditorTools.Tool.bind(document.getElementById('browse'), { id: 'app.browse-project', label: 'Choose folder', showText: true, execute: () =>action(async()=>{const r=await api('/api/choose-folder',{method:'POST',body:'{}'});if(!r.cancelled)await choose(r.folder);}) });
  globalThis.EditorTools.Tool.bind(document.getElementById('import'), { id: 'app.import', label: 'Import files', showText: true, execute: () =>document.getElementById('files').click() });
  document.getElementById('files').onchange=e=>{const files=[...e.target.files];e.target.value='';action(()=>importFiles(files));};
  document.getElementById('documentSidebar').ondragover=e=>e.preventDefault();
  document.getElementById('documentSidebar').ondrop=e=>{e.preventDefault();if(e.dataTransfer.types.includes('application/x-research-workbench-entry'))return;const files=[...e.dataTransfer.files];if(files.length)action(()=>importFiles(files,{parent:'',source_document:null}));};
  empty();
}
/** Initialize the shell and restore the saved registry within one visible recovery boundary.
 * @param {void} none. @pre Tool runtime and document are loaded.
 * @post Saved projects populate the overview, or startup failure is shown in the status area.
 * Existing project files and saved registry entries are never changed during initialization.
 * @return {Promise<void>} Initialization. @throws {Error} None when status rendering is available.
 */
async function startWorkbench(){
  try{
    shell();
    const config=await api('/api/config');
    token=config.token;projects=config.projects||[];renderProjects();
    document.getElementById('folder').value=config.last_folder;renderDeskHome();
    if(location.hash)await action(openEditorLink);
  }catch(error){message(error.message,true);}
}
window.addEventListener('beforeunload',e=>{if(textView?.unsaved||draftView?.unsaved||editor?.dirty||editor?.savePromise||editor?.exporting||busy){e.preventDefault();e.returnValue='';}});
window.addEventListener('storage',e=>{if(e.key==='pdf-editor.theme'){theme=THEMES.includes(e.newValue)?e.newValue:'system';applyTheme(theme);const select=document.getElementById('themeSelect');if(select)select.value=theme;}});
window.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='s'){e.preventDefault();if(editor)window.EditorTools.registry.execute('pdf.actions','pdf.export',{owner:editor,run:action});}});
startWorkbench();

// Local plugin deep links select a project and exact revision without changing stored PDFs.
async function openEditorLink(){
  const params=new URLSearchParams(location.hash.slice(1));
  const folder=params.get('project'), id=params.get('document');
  if(!folder)return;
  if(!project||project.folder!==folder)await choose(folder,false);
  if(id){
    if(!/^[a-f0-9]{32}$/.test(id))throw new Error('Invalid document link.');
    showDeleted=false;selectedFolder='all';document.getElementById('deletedToggle').checked=false;
    await refresh();await openDocument({id});
  }else await refresh();
}
window.addEventListener('hashchange',()=>action(openEditorLink));
window.addEventListener('focus',()=>{if(project&&!busy)refresh().catch(e=>message(e.message,true));});

// Reflect local API writes in the open view. Requires an idle, saved editor; never
// interrupts a source edit or comment composer. Errors leave data intact and retry
// later (the existing Reload from disk control remains available after a restart).
let markupPolling=false, markupRevision=null, markupView=null;
async function refreshApiMarkup(){
  const view=draftView||editor;
  if(!view||!current||!project||busy||markupPolling||document.hidden)return;
  if(document.activeElement?.matches('input, textarea, [contenteditable="true"]'))return;
  if(draftView&&(draftView.unsaved||draftView.saving||draftView.hasPendingReviewEdits()))return;
  if(editor&&(editor.dirty||editor.savePromise||editor.exportPromise||!editor.pop.hidden))return;
  markupPolling=true;
  try{
    const scope=draftView?'draft':'pdf';
    const result=await api(endpoint()+'/markup/revision?scope='+scope);
    if(view!==(draftView||editor)||busy)return;
    if(markupView===view&&markupRevision===result.revision)return;
    if(draftView){
      if(draftView.unsaved||draftView.saving||draftView.hasPendingReviewEdits())return;
      await draftView.reload();
    }else await editor.refreshAnnotations();
    markupView=view;markupRevision=result.revision;
  }catch{/* Retry later without replacing unsaved work or a visible error message. */}
  finally{markupPolling=false;}
}
setInterval(refreshApiMarkup,2500);
