/* Browser-local appearance preferences. Palette data is independent of shell/editor code. */
'use strict';
(() => {
  const key='pdf-editor.color-scheme',lightKey='pdf-editor.light-color-scheme';
  // Published palette sources and semantic adaptations are documented in static/README.md.
  const palettes=Object.freeze({
    'one-dark':{label:'One Dark (default)',base:'#282c34',mantle:'#21252b',surface:'#3e4451',text:'#abb2bf',muted:'#abb2bf',red:'#e06c75',green:'#98c379',yellow:'#e5c07b',blue:'#61afef',mauve:'#c678dd',teal:'#56b6c2'},
    mocha:{label:'Catppuccin Mocha',base:'#1e1e2e',mantle:'#181825',surface:'#45475a',text:'#cdd6f4',muted:'#a6adc8',red:'#f38ba8',green:'#a6e3a1',yellow:'#f9e2af',blue:'#89b4fa',mauve:'#cba6f7',teal:'#94e2d5'},
    macchiato:{label:'Catppuccin Macchiato',base:'#24273a',mantle:'#1e2030',surface:'#494d64',text:'#cad3f5',muted:'#a5adcb',red:'#ed8796',green:'#a6da95',yellow:'#eed49f',blue:'#8aadf4',mauve:'#c6a0f6',teal:'#8bd5ca'},
    frappe:{label:'Catppuccin Frappé',base:'#303446',mantle:'#292c3c',surface:'#51576d',text:'#c6d0f5',muted:'#a5adce',red:'#e78284',green:'#a6d189',yellow:'#e5c890',blue:'#8caaee',mauve:'#ca9ee6',teal:'#81c8be'},
    dracula:{label:'Dracula',base:'#282a36',mantle:'#21222c',surface:'#44475a',text:'#f8f8f2',muted:'#a1aace',red:'#ff5555',green:'#50fa7b',yellow:'#f1fa8c',blue:'#bd93f9',mauve:'#ff79c6',teal:'#8be9fd'},
    nord:{label:'Nord',base:'#2e3440',mantle:'#3b4252',surface:'#4c566a',text:'#eceff4',muted:'#d8dee9',red:'#bf616a',green:'#a3be8c',yellow:'#ebcb8b',blue:'#88c0d0',mauve:'#b48ead',teal:'#8fbcbb'},
    'tokyo-night':{label:'Tokyo Night',base:'#1a1b26',mantle:'#15161e',surface:'#414868',text:'#c0caf5',muted:'#a9b1d6',red:'#f7768e',green:'#9ece6a',yellow:'#e0af68',blue:'#7aa2f7',mauve:'#bb9af7',teal:'#7dcfff'},
    'solarized-dark':{label:'Solarized Dark',base:'#002b36',mantle:'#073642',surface:'#586e75',text:'#93a1a1',muted:'#839496',red:'#dc322f',green:'#859900',yellow:'#b58900',blue:'#268bd2',mauve:'#6c71c4',teal:'#2aa198'},
  });
  const latte={label:'Catppuccin Latte',base:'#eff1f5',mantle:'#e6e9ef',surface:'#bcc0cc',text:'#4c4f69',muted:'#6c6f85',red:'#d20f39',green:'#40a02b',yellow:'#df8e1d',blue:'#1e66f5',mauve:'#8839ef',teal:'#179299'};
  const lightPalettes=Object.freeze({
    latte:{...latte,label:'Catppuccin Latte (default)',build:'#28751d',syntaxYellow:'#8f580a'},
    'nord-light':{label:'Nord Light',base:'#eceff4',mantle:'#e5e9f0',surface:'#b4bdcc',text:'#2e3440',muted:'#4c566a',red:'#a0444e',green:'#496b32',yellow:'#8a6714',blue:'#44678e',mauve:'#875b80',teal:'#397575'},
    'tokyo-day':{label:'Tokyo Night Day',base:'#e1e2e7',mantle:'#d0d5e3',surface:'#a1a6c5',text:'#3760bf',muted:'#52639b',red:'#f52a65',green:'#587539',yellow:'#8c6c3e',blue:'#2e7de9',mauve:'#9854f1',teal:'#007197'},
    'solarized-light':{label:'Solarized Light',base:'#fdf6e3',mantle:'#eee8d5',surface:'#93a1a1',text:'#586e75',muted:'#657b83',red:'#dc322f',green:'#657500',yellow:'#896700',blue:'#2176b5',mauve:'#6c71c4',teal:'#16817b'},
  });
  const system=globalThis.matchMedia('(prefers-color-scheme: dark)');
  const views=new Set();
  /** Read a browser preference safely.
   * @param {string} name Storage key. @param {string} fallback Default value.
   * @pre Browser runtime. @post No mutation. @return {string} Stored value or fallback.
   * @throws None; storage denial uses the fallback.
   */
  function read(name,fallback){try{return localStorage.getItem(name)||fallback;}catch{return fallback;}}
  let scheme=read(key,'one-dark'),lightScheme=read(lightKey,'latte'),mode=read('pdf-editor.theme','dark');
  if(!Object.hasOwn(palettes,scheme))scheme='one-dark';
  if(!Object.hasOwn(lightPalettes,lightScheme))lightScheme='latte';
  /** Apply resolved colors to every consumer of semantic CSS tokens.
   * @param {string} value System, dark or light. @pre Document root exists.
   * @post Native controls, syntax, file icons and mounted settings agree with appearance.
   * @return {void} Nothing. @throws DOM errors propagate to the owning UI boundary.
   */
  function apply(value){
    mode=['system','dark','light'].includes(value)?value:'system';
    const light=mode==='light'||(mode==='system'&&!system.matches),p=light?lightPalettes[lightScheme]:palettes[scheme];
    const root=document.documentElement;
    root.dataset.theme=light?'light':'dark';root.dataset.colorScheme=light?lightScheme:scheme;
    root.style.colorScheme=light?'light':'dark';
    const mix=(color,weight)=>`color-mix(in srgb, ${color} ${weight}%, ${p.base})`;
    const tokens={bg:p.mantle,panel:p.base,ink:p.text,muted:p.muted,line:p.surface,accent:p.blue,bad:p.red,
      'desk-tint':mix(p.blue,18),'desk-soft':mix(p.text,7),'button-ink':light?'#ffffff':p.mantle,
      build:p.build||p.green,'build-hover':mix(p.build||p.green,85),'build-ink':light?'#ffffff':p.mantle,
      'syntax-red':p.red,'syntax-green':p.green,'syntax-yellow':p.syntaxYellow||p.yellow,'syntax-blue':p.blue,'syntax-purple':p.mauve,'syntax-teal':p.teal,
      'file-pdf':p.red,'file-tex':p.blue,'file-bib':p.mauve,'file-image':p.teal,'file-style':p.syntaxYellow||p.yellow,'file-text':p.text,'file-folder':p.syntaxYellow||p.yellow};
    for(const [name,color] of Object.entries(tokens))root.style.setProperty('--'+name,color);
    const footer=document.getElementById('themeSelect');if(footer)footer.value=mode;
    for(const view of views){if(!view.section.isConnected){views.delete(view);continue;}view.mode.value=mode;
      view.label.textContent=light?'Light color scheme':'Dark color scheme';
      view.scheme.replaceChildren();
      for(const [id,palette] of Object.entries(light?lightPalettes:palettes)){const option=document.createElement('option');option.value=id;option.textContent=palette.label;view.scheme.append(option);}
      view.scheme.value=light?lightScheme:scheme;view.preview.replaceChildren();
      for(const color of [p.base,p.red,p.green,p.yellow,p.blue,p.mauve,p.teal,p.text]){const swatch=document.createElement('span');swatch.style.background=color;view.preview.append(swatch);}
      view.preview.setAttribute('aria-label',p.label+' palette');}
  }
  /** Remember a palette for its appearance and refresh the active mode.
   * @param {string} value Registered palette ID. @pre None.
   * @post Light/dark choices persist separately; invalid IDs reset the active appearance.
   * @return {void} Nothing. @throws DOM errors; storage denial retains the session choice.
   */
  function select(value){
    const light=mode==='light'||(mode==='system'&&!system.matches);
    const targetLight=Object.hasOwn(lightPalettes,value)||(!Object.hasOwn(palettes,value)&&light);
    let name,choice;
    if(targetLight){lightScheme=Object.hasOwn(lightPalettes,value)?value:'latte';name=lightKey;choice=lightScheme;}
    else{scheme=Object.hasOwn(palettes,value)?value:'one-dark';name=key;choice=scheme;}
    try{localStorage.setItem(name,choice);}catch{}apply(mode);
  }
  /** Mount reusable appearance controls in Settings, independent of integration requests.
   * @param {HTMLElement} host Settings container. @pre Shell setTheme action is available.
   * @post Labeled native selects and a palette preview are appended; changes apply immediately.
   * @return {HTMLElement} Section. @throws DOM errors propagate to Settings.
   */
  function mount(host){
    const section=document.createElement('section');section.className='appearance-settings';
    const title=document.createElement('h3');title.textContent='Appearance';section.append(title);
    /** Build a labeled native select.
     * @param {string} id Control ID. @param {string} labelText Visible label.
     * @param {Array} options Value/label pairs. @pre Section exists.
     * @post Control is appended. @return {HTMLSelectElement} Select. @throws DOM errors.
     */
    const control=(id,labelText,options)=>{const label=document.createElement('label'),select=document.createElement('select');label.htmlFor=id;label.textContent=labelText;select.id=id;
      for(const [value,text] of options){const option=document.createElement('option');option.value=value;option.textContent=text;select.append(option);}section.append(label,select);return select;};
    const appearance=control('settingsAppearance','Mode',[['system','System'],['dark','Dark'],['light','Light']]);
    const colors=control('settingsColorScheme','Color scheme',[]),colorLabel=section.children[section.children.length-2];
    const hint=document.createElement('p');hint.textContent='Choose a color scheme for the active mode. Light and dark choices are remembered separately. System mode follows your device. Changes are saved automatically in this browser.';
    const preview=document.createElement('div');preview.className='appearance-preview';preview.setAttribute('role','img');section.append(hint,preview);host.append(section);
    appearance.addEventListener('change',()=>globalThis.setTheme(appearance.value));colors.addEventListener('change',()=>select(colors.value));
    views.add({section,mode:appearance,scheme:colors,label:colorLabel,preview});apply(mode);return section;
  }
  system.addEventListener('change',()=>{if(mode==='system')apply(mode);});
  globalThis.addEventListener('storage',event=>{
    if([key,lightKey,'pdf-editor.theme',null].includes(event.key)){
      scheme=read(key,'one-dark');lightScheme=read(lightKey,'latte');
      if(!Object.hasOwn(palettes,scheme))scheme='one-dark';
      if(!Object.hasOwn(lightPalettes,lightScheme))lightScheme='latte';
      apply(read('pdf-editor.theme','dark'));
    }
  });
  globalThis.WorkbenchAppearance=Object.freeze({apply,select,mount});apply(mode);
})();
