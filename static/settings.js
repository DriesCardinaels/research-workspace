/* Settings owns category navigation; each feature owns its controls and persistence. */
'use strict';
(() => {
  let lastSection = 'appearance', activeDialog;
  const sections = [['appearance','Appearance'],['writing','Writing'],['integrations','Integrations']];
  const el = (tag,text) => {const node=document.createElement(tag);if(text!==undefined)node.textContent=text;return node;};
  /** Open categorized settings through the shared native modal lifecycle.
   * @param {object} options Optional spelling service for a host or test.
   * @pre Appearance, spelling, integration and pane modules are loaded.
   * @post Sections retain drafts during navigation; close releases feature listeners.
   * @return {HTMLDialogElement} Active dialog. @throws {Error} DOM initialization errors.
   */
  function open({service=window.Spelling.service} = {}) {
    if(activeDialog?.open)return activeDialog;
    const dialog=el('dialog');dialog.className='workbench-settings';
    const header=el('header'),title=el('h2','Settings'),close=el('button','Close');
    header.className='settings-header';title.id='settingsTitle';dialog.setAttribute('aria-labelledby',title.id);
    close.type='button';header.append(title,close);
    const layout=el('div'),nav=el('div'),content=el('div'),tabs=[],panels=[];
    layout.className='settings-layout';nav.className='settings-nav';content.className='settings-content';
    nav.setAttribute('role','tablist');nav.setAttribute('aria-label','Settings categories');
    const cleanup=[];
    const narrow=window.matchMedia?.('(max-width: 640px)');
    const syncOrientation=()=>nav.setAttribute('aria-orientation',narrow?.matches?'horizontal':'vertical');
    syncOrientation();
    if(narrow?.addEventListener){narrow.addEventListener('change',syncOrientation);cleanup.push(()=>narrow.removeEventListener('change',syncOrientation));}
    const selectSection=index=>{
      lastSection=sections[index][0];
      tabs.forEach((tab,i)=>{tab.setAttribute('aria-selected',String(i===index));tab.tabIndex=i===index?0:-1;panels[i].hidden=i!==index;});
    };
    sections.forEach(([id,label],index)=>{
      const tab=el('button',label),panel=el('div');tab.type='button';tab.id='settingsTab-'+id;panel.id='settingsPanel-'+id;
      tab.setAttribute('data-tooltip','off');tab.setAttribute('role','tab');tab.setAttribute('aria-controls',panel.id);panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby',tab.id);
      panel.tabIndex=0;panel.className='settings-panel';
      window.EditorTools.Tool.bind(tab,{id:'settings.'+id,label,info:'Open '+label.toLowerCase()+' settings',showText:true,execute:()=>selectSection(index)});
      tab.addEventListener('keydown',event=>{
        let next;
        const horizontal=nav.getAttribute('aria-orientation')==='horizontal';
        if(event.key===(horizontal?'ArrowRight':'ArrowDown'))next=(index+1)%sections.length;
        else if(event.key===(horizontal?'ArrowLeft':'ArrowUp'))next=(index+sections.length-1)%sections.length;
        else if(event.key==='Home')next=0;
        else if(event.key==='End')next=sections.length-1;
        if(next!==undefined){event.preventDefault();window.EditorTools.Tool.activate(tabs[next],event);tabs[next].focus();}
      });
      tabs.push(tab);panels.push(panel);nav.append(tab);content.append(panel);
    });
    layout.append(nav,content);dialog.append(header,layout);
    window.EditorTools.Tool.bind(close,{id:'settings.close',label:'Close settings',showText:true,execute:()=>dialog.close()});
    const dispose=()=>{for(const fn of cleanup)fn();for(const button of [...tabs,close])window.EditorTools.Tool.unbind(button);if(activeDialog===dialog)activeDialog=undefined;};
    dialog.addEventListener('close',dispose,{once:true});
    document.body.append(dialog);
    try {
      const appearance=window.WorkbenchAppearance?.mount(panels[0]);
      if(appearance)cleanup.push(()=>window.WorkbenchAppearance.unmount?.(appearance));
      const writing=panels[1],spell=el('section'),heading=el('h3','Spell check'),label=el('label','Language'),language=el('select');
      spell.className='settings-card';
      label.htmlFor='settingsSpellingLanguage';language.id='settingsSpellingLanguage';language.setAttribute('aria-label','Spell-check language');
      for(const value of ['off','en-US','en-GB','nl']){const option=el('option',window.Spelling.languages[value]);option.value=value;language.append(option);}
      const row=el('div'),status=el('p');row.className='settings-spelling-row';row.append(label,language);status.setAttribute('role','status');
      spell.append(heading,row,status);writing.append(spell);
      const sync=()=>{language.value=service.language;status.textContent=service.status==='error'?'Spelling unavailable. Choose a language to retry.':service.status==='loading'?'Loading dictionary…':'';};
      language.addEventListener('change',()=>service.setLanguage(language.value));sync();cleanup.push(service.subscribe(sync));
      cleanup.push(window.Spelling.mountDictionary(writing,{service}));
      cleanup.push(window.mountIntegrationSettings(panels[2]).dispose);
      const index=sections.findIndex(([id])=>id===lastSection);selectSection(index);
      activeDialog=dialog;window.EditorPanes.open(dialog,{focus:tabs[index],disposable:true});
      return dialog;
    } catch(error){dispose();dialog.remove();throw error;}
  }
  window.openSettings=open;
})();
