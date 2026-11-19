/* Bibliography review uses the editor's unsaved text. OpenAlex results never rewrite it. */
'use strict';
(() => {
  // Tokenize BibTeX independently of TeX commands. Pre: CodeMirror 5 loaded;
  // post: fields and values receive syntax colors without changing source text.
  CodeMirror.defineMode('bibtex', () => ({
    startState: () => ({depth:0,quoted:false}),
    token(stream,state) {
      if(stream.eatSpace())return null;
      if(state.quoted){while(!stream.eol()){const c=stream.next();if(c==='\\'){stream.next();continue;}if(c==='"'){state.quoted=false;break;}}return 'string';}
      if(stream.match(/^@[A-Za-z]+/))return 'keyword';
      if(stream.match(/^[A-Za-z][\w-]*(?=\s*=)/))return 'attribute';
      const c=stream.next();if(c==='"'){state.quoted=true;return 'string';}
      if(c==='{'){state.depth++;return 'bracket';}if(c==='}'){state.depth--;return 'bracket';}
      if(c==='%'&&state.depth===0){stream.skipToEnd();return 'comment';}
      stream.eatWhile(/[^{}",=\s]/);return state.depth>1?'string':null;
    }
  }));
  /** Map unavailable integration routes to a concrete recovery step. */
  function errorText(e) {return e.status===404?'Restart the editor server to enable bibliography editing and OpenAlex settings.':e.message;}
  /** Create text-only DOM. Pre: text attributes; post: no provider HTML interpreted. */
  function el(tag, text) { const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n; }
  let dialogNumber=0;
  /** Build a compact modal. Pre: app loaded; post: labeled dialog with a fixed close action.
   * Closing disposes the modal; callers own its content and asynchronous operations. */
  function modal(title) {
    const d=el('dialog');d.className='bibliography-dialog';
    const header=el('header'),identity=el('div'),badge=el('span','OA'),heading=el('h2',title),close=el('button','Close');
    header.className='bibliography-header';identity.className='bibliography-identity';badge.className='bibliography-provider';
    heading.id='bibliography-title-'+(++dialogNumber);d.setAttribute('aria-labelledby',heading.id);
    identity.append(badge,heading);close.type='button';close.className='bibliography-close';globalThis.EditorTools.Tool.bind(close, { id: 'bibliography.close', label: 'Close dialog', showText: true, execute: () =>d.close() });header.append(identity,close);d.append(header);
    d.addEventListener('close',()=>d.remove(),{once:true});document.body.append(d);return d;
  }
  /** Mount an optional private key form independently of other Settings sections.
   * @param {HTMLElement} d Integration settings host. @pre Authenticated app and Tool runtime.
   * @post Requests never return the key; failed saves retain the draft for correction.
   * @return {object} Readiness promise and control disposer. @throws {Error} DOM setup failures.
   */
  window.mountIntegrationSettings=function(d) {
    const state=el('span','Checking…'), feedback=el('p'), label=el('label','API key'), input=el('input');
    input.type='password';input.autocomplete='new-password';input.id='openalexKey';label.htmlFor=input.id;
    const hint=el('p','Add an optional API key for higher search limits.');
    const link=el('a','Get a key');link.href='https://openalex.org/settings/api';link.target='_blank';link.rel='noopener noreferrer';
    const save=el('button','Save key'), clear=el('button','Remove key');clear.hidden=true;
    const update=async()=>{const s=await api('/api/settings/openalex');state.textContent=s.configured?'Key configured':'No key configured';clear.hidden=!s.configured;};
    const write=async(key)=>{save.disabled=clear.disabled=true;feedback.textContent='';try{await api('/api/settings/openalex',{method:'PUT',body:JSON.stringify({api_key:key})});input.value='';await update();}catch(e){feedback.textContent=errorText(e);}finally{save.disabled=clear.disabled=false;}};
    globalThis.EditorTools.Tool.bind(save, { id: 'bibliography.save-key', label: 'Save OpenAlex key', showText: true, execute: () =>{if(!input.value.trim()){feedback.textContent='Enter a key to save.';return;}write(input.value);} });globalThis.EditorTools.Tool.bind(clear, { id: 'bibliography.remove-key', label: 'Remove OpenAlex key', showText: true, execute: () =>write('') });
    const integration=el('section'),header=el('div'),fieldHeader=el('div'),field=el('div');
    integration.className='settings-card settings-integration';header.className='settings-card-header';fieldHeader.className='settings-field-header';field.className='settings-key-field';
    save.className='primary';state.className='settings-key-status';state.setAttribute('role','status');feedback.setAttribute('role','alert');feedback.className='pane-error';
    header.append(el('h3','OpenAlex'),state);fieldHeader.append(label,link);field.append(input,save);integration.append(header,hint,fieldHeader,field,feedback,clear);d.append(integration);
    const ready=update().catch(e=>{state.textContent='Status unavailable';feedback.textContent=errorText(e);});
    return {ready,dispose(){for(const button of [save,clear]) globalThis.EditorTools.Tool.unbind(button);}};
  };
  /** Check linked bibliography entries using current editor buffers.
   * @param {Workspace} workspace Public bibliography and source-buffer operations.
   * @pre Workspace is linked; bibliography discovery and parsing APIs are available.
   * @post Local autocomplete never contacts OpenAlex; explicit checks never save source.
   * @return {Promise<void>} Resolves once the dialog has loaded or displayed its error.
   * @throws {Error} DOM setup failures; request errors are displayed at this UI boundary.
   */
  window.openBibliography=async function(workspace) {
    const d=modal('Reference check'),files=el('select'),refs=el('select'),query=el('input');
    const check=el('button','Check reference'),status=el('p'),results=el('div');
    const panel=el('section'),controls=el('div'),actions=el('div'),matches=el('div');
    const footer=el('p','This dialog searches only your linked entries and contacts OpenAlex when you press Check reference. The bibliography editor also runs background checks when Auto OpenAlex is enabled.');
    panel.className='bibliography-panel';controls.className='bibliography-fields';actions.className='bibliography-entry-actions';
    check.className='bibliography-primary';status.className='bibliography-status';results.className='bibliography-results';footer.className='bibliography-footnote';
    matches.className='bibliography-suggestions';matches.setAttribute('role','listbox');matches.id='bibliography-matches-'+dialogNumber;
    files.setAttribute('aria-label','Bibliography file');refs.setAttribute('aria-label','Reference');status.setAttribute('role','status');
    query.setAttribute('aria-label','Search linked references');query.placeholder='Search bibkey, title, author or year';query.type='search';query.autocomplete='off';
    query.setAttribute('role','combobox');query.setAttribute('aria-autocomplete','list');query.setAttribute('aria-controls',matches.id);
    check.type='button';check.disabled=true;
    /** Label a form control.
     * @param {string} title Field label. @param {HTMLElement} control Form control.
     * @pre Control exists. @post Control gains a visible label. @return {HTMLElement} Label.
     * @throws {Error} DOM failures propagate to the dialog boundary.
     */
    const field=(title,control)=>{const label=el('label',title);label.append(control);return label;};
    controls.append(field('Bibliography file',files),field('Reference',refs));
    actions.append(el('span','Compare title, authors, year and publication.'),check);
    panel.append(controls,field('Find a linked reference',query),matches,actions);
    d.append(panel,status,results,footer);window.EditorPanes.open(d,{focus:query});
    let entries=[],generation=0,lookupGeneration=0,lookupBusy=false,index=0,filtered=[];
    /** Filter local entries and expose keyboard selection.
     * @param {void} none No arguments. @pre Entries loaded. @post Suggestions and check state update.
     * @return {void} Nothing. @throws {Error} Invalid entry data propagates to the owning event boundary.
     */
    const suggest=()=>{
      filtered=window.Workspace.citeMatches(entries,query.value.trim());index=Math.min(index,Math.max(0,filtered.length-1));
      matches.replaceChildren(...filtered.map((entry,i)=>{
        const option=el('button',entry.key+' — '+[entry.title,entry.author,entry.year].filter(Boolean).join(' · '));
        option.type='button';option.id=matches.id+'-'+i;option.setAttribute('role','option');option.setAttribute('aria-selected',String(i===index));
        globalThis.EditorTools.Tool.bind(option, { id: 'bibliography.choose-entry', label: 'Select reference ' + entry.key, showText: true, execute: () =>{if(lookupBusy)return;refs.value=entry.key;query.value=entry.key;index=0;suggest();} });return option;
      }));
      query.setAttribute('aria-expanded',String(filtered.length>0));query.setAttribute('aria-activedescendant',filtered.length?matches.id+'-'+index:'');
      refs.value=filtered[index]?.key||'';check.disabled=lookupBusy||!refs.value;
      if(!filtered.length&&!lookupBusy)status.textContent=entries.length?'No linked references match this search.':'No references found in this file.';
      else if(!lookupBusy)status.textContent=entries.length+' references · Current editor text';
    };
    /** Load selected bibliography through public operations.
     * @param {void} none No arguments. @pre Dialog open. @post Current entries replace old suggestions.
     * @return {Promise<void>} Completion. @throws {Error} Request failures are shown here.
     */
    const load=async()=>{
      const run=++generation;++lookupGeneration;entries=[];refs.replaceChildren();results.replaceChildren();matches.replaceChildren();check.disabled=true;query.disabled=true;
      query.setAttribute('aria-expanded','false');query.setAttribute('aria-activedescendant','');
      status.textContent='Reading bibliography…';
      try{
        if(!files.value){status.textContent='No bibliography file is linked to this paper.';return;}
        const data=await workspace.bibliographyEntries(files.value);
        if(run!==generation||!d.open)return;
        entries=data;
        for(const entry of entries){const option=el('option',entry.key+' — '+(entry.title||'Untitled'));option.value=entry.key;refs.append(option);}
        query.disabled=false;query.value='';index=0;suggest();
      }catch(error){if(run===generation&&d.open)status.textContent=errorText(error);}
    };
    /** Render provider text and comparisons. Pre: API work records; post: safe DOM, no source changes. */
    const render=data=>{
      results.replaceChildren();
      status.textContent=data.works.length?(data.lookup==='doi'?'DOI match · Verify the intended work':'Search results · Verify the intended work'):'No matching work found. The reference may still be correct.';
      for(const work of data.works){
        const card=el('section'),heading=el('div'),title=el('h3',work.title),meta=el('p',[work.authors.join(', '),work.year,work.venue].filter(Boolean).join(' · '));
        card.className='bibliography-result';heading.className='bibliography-result-heading';heading.append(title);card.append(heading,meta);
        if(work.url){const link=el('a','OpenAlex record ↗');link.href=work.url;link.target='_blank';link.rel='noopener noreferrer';heading.append(link);}
        if(work.comparison){
          const scroll=el('div'),table=el('table'),head=el('tr');scroll.className='bibliography-comparison';
          for(const label of ['Field','Your bibliography','OpenAlex','Check'])head.append(el('th',label));table.append(head);
          for(const comparison of work.comparison){
            const row=el('tr');for(const value of [comparison.field,comparison.local||'—',comparison.openalex||'—'])row.append(el('td',value));
            const cell=el('td'),badge=el('span',comparison.status);badge.className='bibliography-match';badge.setAttribute('data-status',comparison.status);cell.append(badge);row.append(cell);table.append(row);
          }
          scroll.append(table);card.append(scroll);
        }
        results.append(card);
      }
    };
    /** Compare only a selected local entry with OpenAlex.
     * @param {void} none No arguments. @pre Selected linked entry and open dialog.
     * @post Current buffer is compared without edits; controls recover after failure.
     * @return {Promise<void>} Completion. @throws {Error} Request errors are shown here.
     */
    const run=async()=>{
      if(lookupBusy||!entries.some(entry=>entry.key===refs.value))return;
      const request=++lookupGeneration;lookupBusy=true;
      check.disabled=files.disabled=refs.disabled=query.disabled=true;
      status.textContent='Checking reference with OpenAlex…';results.replaceChildren();
      try{
        const buffer=await workspace.ensureFile(files.value);
        const data=await api('/api/openalex/check',{method:'POST',body:JSON.stringify({text:buffer.doc.getValue(),key:refs.value})});
        if(request===lookupGeneration&&d.open)render(data);
      }catch(error){if(request===lookupGeneration&&d.open)status.textContent=errorText(error);}
      finally{if(request===lookupGeneration){lookupBusy=false;check.disabled=!refs.value;files.disabled=refs.disabled=query.disabled=false;}}
    };
    files.onchange=()=>load();refs.onchange=()=>{query.value=refs.value;suggest();results.replaceChildren();};globalThis.EditorTools.Tool.bind(check, { id: 'bibliography.check-reference', label: 'Check reference', showText: true, execute: () =>run() });
    query.oninput=()=>{index=0;results.replaceChildren();suggest();};
    query.onkeydown=event=>{
      if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();index=Math.max(0,Math.min(filtered.length-1,index+(event.key==='ArrowDown'?1:-1)));suggest();}
      if(event.key==='Enter'&&filtered[index]){event.preventDefault();query.value=filtered[index].key;suggest();}
    };
    try{
      const names=await workspace.bibliographyFiles();
      if(!d.open)return;
      for(const name of names){const option=el('option',name);option.value=name;files.append(option);}
      if(names.length)files.value=names.includes(workspace.file)?workspace.file:names[0];
      await load();
    }catch(error){if(d.open)status.textContent=errorText(error);}
  };
})();
