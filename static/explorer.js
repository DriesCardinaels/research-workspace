/* Disk explorer actions. Uses browser DOM and the application's public save/API boundary. */
'use strict';
globalThis.ProjectExplorer = class ProjectExplorer {
  #hooks; #drag = null; #menu = null;
  /** @param {object} hooks API, save guards, refresh, creation and error boundary.
   * @pre Mounted shell. @post Reusable controller; no filesystem effects.
   * @return {ProjectExplorer} Controller. @throws {void} None.
   */
  constructor(hooks){this.#hooks=hooks;}
  /** @param {HTMLElement} row Target row. @param {object} entry Exact disk identity.
   * @pre Real disk entry or authorized root. @post Context menu, keyboard and drag handlers installed.
   * @return {void} Nothing. @throws {void} None; actions use the injected error boundary.
   */
  bind(row,entry){
    row.oncontextmenu=event=>{event.preventDefault();event.stopPropagation();this.openMenu(entry,event.clientX,event.clientY);};
    row.onkeydown=event=>{
      if(event.key==='ContextMenu'||(event.shiftKey&&event.key==='F10')){
        event.preventDefault();const r=row.getBoundingClientRect();this.openMenu(entry,r.left,r.bottom);
      }else if(entry.path&&['F2','Delete'].includes(event.key)){
        event.preventDefault();event.stopPropagation();this.#hooks.action(()=>this.edit(entry,event.key==='F2'?'rename':'delete'));
      }
    };
    if(entry.path){
      row.draggable=true;
      row.ondragstart=event=>{
        event.stopPropagation();this.#drag=entry;event.dataTransfer.effectAllowed='move';
        event.dataTransfer.setData('application/x-research-workbench-entry',JSON.stringify(entry));
        row.classList.add('explorer-dragging');
      };
      row.ondragend=()=>{this.#drag=null;row.classList.remove('explorer-dragging');document.querySelectorAll('.explorer-drop').forEach(n=>n.classList.remove('explorer-drop'));};
    }
    if(entry.path||entry.folder||entry.document){
      const more=document.createElement('button');more.type='button';more.className='explorer-more';more.textContent='⋯';
      globalThis.EditorTools.Tool.bind(more,{id:'explorer.actions',label:'Actions for '+entry.name,showText:true,execute:({event})=>{event?.preventDefault();event?.stopPropagation();const r=more.getBoundingClientRect();this.openMenu(entry,r.left,r.bottom);}});
      if(row.tagName==='BUTTON')row.parentElement.append(more);else row.append(more);
    }
    if(entry.folder){
      row.addEventListener('click',()=>this.#hooks.select?.(entry));
      row.ondragover=event=>{
        if(!this.#drag){
          if(!this.#hooks.import||!Array.from(event.dataTransfer.types||[]).includes('Files'))return;
          event.preventDefault();event.stopPropagation();event.dataTransfer.dropEffect='copy';row.classList.add('explorer-drop');return;
        }
        event.preventDefault();event.stopPropagation();
        const valid=this.canDrop(this.#drag,entry);event.dataTransfer.dropEffect=valid?'move':'none';row.classList.toggle('explorer-drop',valid);
      };
      row.ondragleave=event=>{if(!row.contains(event.relatedTarget))row.classList.remove('explorer-drop');};
      row.ondrop=event=>{
        if(!this.#drag){
          const files=Array.from(event.dataTransfer.files||[]);
          if(!files.length||!this.#hooks.import)return;
          event.preventDefault();event.stopPropagation();row.classList.remove('explorer-drop');
          this.#hooks.action(()=>this.#hooks.import(entry,files));return;
        }
        event.preventDefault();event.stopPropagation();row.classList.remove('explorer-drop');
        const source=this.#drag;this.#drag=null;
        if(this.canDrop(source,entry))this.#hooks.action(()=>this.change(source,'move',(entry.path?entry.path+'/':'')+source.name));
      };
    }
  }
  /** @param {object} source,target Disk entries.
   * @pre Trusted local drag state. @post No effects; rejects cycles and cross-root transfers.
   * @return {boolean} Move validity. @throws {void} None.
   */
  canDrop(source,target){
    return source.project===target.project&&source.owner===target.owner&&source.path!==target.path
      &&(!source.folder||!target.path.startsWith(source.path+'/'))
      &&source.path!==(target.path?target.path+'/':'')+source.name;
  }
  /** @param {object} entry Target. @param {number} x,y Viewport coordinates.
   * @pre User invoked actions. @post Accessible menu opens and closes on outside click/Escape.
   * @return {void} Nothing. @throws {void} Action errors are surfaced by application boundary.
   */
  openMenu(entry,x,y){
    this.#menu?.();
    const menu=document.createElement('div');menu.className='explorer-menu';menu.setAttribute('role','menu');
    const abort=new AbortController(),origin=document.activeElement;
    const close=()=>{abort.abort();menu.remove();this.#menu=null;origin?.focus();};this.#menu=close;
    const actions=[];
    if(entry.folder)actions.push(['New File…',()=>this.#hooks.create('file',entry)],['New Folder…',()=>this.#hooks.create('directory',entry)]);
    if(entry.folder&&this.#hooks.import)actions.push(['Import Files…',()=>this.#hooks.import(entry)]);
    actions.push(['Show in Finder',()=>this.#hooks.reveal(entry)]);
    if(entry.path)actions.push(['Rename…',()=>this.edit(entry,'rename')],['Move to Folder…',()=>this.edit(entry,'move')],
      ['Copy Relative Path',()=>navigator.clipboard.writeText(entry.path)],['Delete…',()=>this.edit(entry,'delete')]);
    for(const [label,execute] of actions){
      const button=document.createElement('button');button.type='button';button.textContent=label;button.setAttribute('role','menuitem');
      if(label==='Delete…')button.className='danger';
      globalThis.EditorTools.Tool.bind(button,{id:'explorer.'+label,label,showText:true,execute:()=>{close();this.#hooks.action(execute);}});menu.append(button);
    }
    document.body.append(menu);menu.style.left=Math.max(4,Math.min(x,innerWidth-menu.offsetWidth-8))+'px';menu.style.top=Math.max(4,Math.min(y,innerHeight-menu.offsetHeight-8))+'px';
    document.addEventListener('pointerdown',event=>{if(!menu.contains(event.target))close();},{signal:abort.signal});
    menu.onkeydown=event=>{
      const buttons=[...menu.querySelectorAll('button')],index=buttons.indexOf(document.activeElement);
      if(event.key==='Escape'){event.preventDefault();close();}
      if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){
        event.preventDefault();buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowDown'?1:buttons.length-1))%buttons.length]?.focus();
      }
    };menu.querySelector('button')?.focus();
  }
  /** @param {object} entry Entry identity. @param {string} mode rename/move/delete.
   * @pre Explicit action. @post Modal collects a reviewed destination or confirms recoverable deletion.
   * @return {Promise<void>} Dialog readiness. @throws {void} Submit errors remain visible.
   */
  async edit(entry,mode){
    const dialog=window.EditorPanes.open('explorer.'+mode,{entry,explorer:this,directories:()=>this.#hooks.directories(entry)});
    if(mode==='rename'){
      const input=dialog.querySelector('input');
      input.setSelectionRange(0,!entry.folder&&entry.name.lastIndexOf('.')>0?entry.name.lastIndexOf('.'):entry.name.length);
    }
  }
  /** @param {object} entry Disk identity. @param {string} operation,destination Mutation.
   * @pre User action; source belongs to active project. @post Saved buffers precede disk mutation and tree refresh.
   * @return {Promise<void>} Completion. @throws {Error} Save, HTTP or refresh failure.
   */
  async change(entry,operation,destination){
    await this.#hooks.change(entry,operation,destination);
  }
};

/** Build file-action panes behind stable action names; replacements leave buttons unchanged.
 * @param {object} context Entry identity, explorer's public operations and directory accessor.
 * @pre Entry belongs to the current project. @post No disk changes until explicit submission.
 * @return {object} Disposable form descriptor. @throws {Error} Invalid pane definition or DOM failure.
 */
for(const mode of ['rename','move','delete'])window.EditorPanes.register('explorer.'+mode,({entry,explorer,directories})=>{
  const verb={rename:'Rename',move:'Move',delete:'Delete'}[mode];
  const fields=mode==='delete'?[]:mode==='rename'?[{name:'destination',label:'File or folder name',value:entry.name,required:true,maxLength:255,
    hint:entry.folder?'Use a descriptive folder name.':'The file extension determines how this file opens.'}]:[{name:'destination',label:'Destination folder',options:directories()
    .filter(directory=>explorer.canDrop(entry,{...entry,path:directory.parent,folder:true}))
    .map(directory=>({value:directory.parent,label:directory.label})),hint:'Choose a folder within this project.'}];
  return window.EditorPanes.form({title:verb+' “'+entry.name+'”',
    description:mode==='delete'?'This removes the item and all its contents from the project. A recovery copy is retained on disk.':
      mode==='rename'?'Choose a clear name for this item.':'Move this item and its contents to another folder.',
    fields,submitLabel:verb,danger:mode==='delete',onSubmit:async values=>{
      const parent=mode==='rename'?entry.path.split('/').slice(0,-1).join('/'):values.destination;
      const destination=(parent?parent+'/':'')+(mode==='rename'?values.destination:entry.name);
      await explorer.change(entry,mode==='delete'?'delete':'move',destination);
    }});
});
