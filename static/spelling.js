/* Local dictionary spelling and explicit corrections for prose. */
'use strict';
(() => {
  const languages = Object.freeze({'en-US':'US English','en-GB':'UK English',nl:'Nederlands',off:'Off'});
  const storageKey = 'research-workbench.spelling-language';
  const wordKey = 'research-workbench.spelling-word.';
  const normalizeWord = (word,language) => word.replace(/’/g,"'").normalize('NFC').toLocaleLowerCase(language);
  const blank = text => text.replace(/[^\n]/g,' ');
  /** Load bundled Hunspell data only when an enabled prose editor needs it.
   * @pre Language is a supported dictionary key. @post No remote request or document mutation.
   * @returns {Promise<object>} nspell checker. @throws {Error} Asset or parsing failure.
   */
  async function loadDictionary(language) {
    const [module, aff, dic] = await Promise.all([
      import('/static/vendor/spelling/checker.mjs'),
      fetch('/static/vendor/spelling/' + language + '/index.aff'),
      fetch('/static/vendor/spelling/' + language + '/index.dic'),
    ]);
    if (!aff.ok || !dic.ok) throw new Error('Dictionary could not be loaded');
    return module.default({aff:await aff.text(),dic:await dic.text()});
  }
  class Service {
    #language; #storage; #loader; #cache = new Map(); #listeners = new Set(); #checker; #status = 'idle'; #run = 0; #words = new Map(); #sessionWords = new Map();
    #storageChange = event => {
      if (event.storageArea && event.storageArea !== this.#storage) return;
      if (event.key === null || event.key?.startsWith(wordKey)) {
        // A manager may be browsing a locale other than the active editor's.
        this.#readWords(this.#language); this.#notify();
      }
    };
    /** Own one explicit preference and dictionary shared by all editor hosts.
     * @pre Optional storage and loader follow browser/nspell contracts.
     * @post Storage denial falls back to US English. @throws {void} None.
     */
    constructor({storage, loader = loadDictionary} = {}) {
      if (storage === undefined) { try { storage = globalThis.localStorage; } catch {} }
      this.#storage = storage; this.#loader = loader;
      let saved; try { saved = storage?.getItem(storageKey); } catch {}
      this.#language = Object.hasOwn(languages,saved) ? saved : 'en-US';
    }
    get language() { return this.#language; }
    get checker() { return this.#checker; }
    get status() { return this.#status; }
    /** Observe preference/readiness changes. @pre Callable listener.
     * @post Returns an unsubscribe operation. @throws {void} None.
     */
    subscribe(listener) {
      if (!this.#listeners.size) { this.#readWords(this.#language); window.addEventListener('storage',this.#storageChange); }
      this.#listeners.add(listener);
      return () => { this.#listeners.delete(listener); if (!this.#listeners.size) window.removeEventListener('storage',this.#storageChange); };
    }
    #notify() { for (const listener of this.#listeners) listener(); }
    #readWords(language) {
      const words = new Set(this.#sessionWords.get(language));
      const prefix = wordKey + language + '.';
      // Independent keys prevent concurrent tabs from overwriting each other's additions.
      try {
        for (let index = 0; index < this.#storage?.length; index++) {
          const key = this.#storage.key(index);
          if (!key?.startsWith(prefix) || this.#storage.getItem(key) !== '1') continue;
          try {
            const word = decodeURIComponent(key.slice(prefix.length));
            if (/^[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*$/u.test(word) && prefix + encodeURIComponent(normalizeWord(word,language)) === key) words.add(word);
          } catch {} // Ignore malformed saved entries without disabling spelling.
        }
      } catch {
        for (const word of this.#words.get(language) || []) words.add(word);
      } // Storage denial keeps already known and session words usable.
      this.#words.set(language,words);
      return words;
    }
    /** Accept a personal word only for the currently selected language.
     * @pre A prose word and current locale. @post All hosts refresh without source edits.
     * @returns {boolean} Whether accepted. @throws {void} None.
     */
    addWord(word, language = this.#language) {
      if (language !== this.#language || language === 'off' || !/^[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*$/u.test(word)) return false;
      const normalized = normalizeWord(word,language);
      this.#readWords(language).add(normalized);
      try {
        if (!this.#storage) throw new Error('Storage unavailable');
        this.#storage.setItem(wordKey + language + '.' + encodeURIComponent(normalized),'1');
      } catch {
        if (!this.#sessionWords.has(language)) this.#sessionWords.set(language,new Set());
        this.#sessionWords.get(language).add(normalized);
      }
      this.#notify(); return true;
    }
    /** Read a sorted snapshot of the personal dictionary without selecting it.
     * @param {string} language Supported dictionary locale, excluding Off.
     * @pre Locale exists. @post Stored additions/removals are reconciled; callers own the array.
     * @return {string[]} Personal words in locale order. @throws {TypeError} Invalid locale.
     */
    listWords(language = this.#language) {
      if (!Object.hasOwn(languages,language) || language === 'off') throw new TypeError('Unsupported dictionary language');
      return [...this.#readWords(language)].sort((a,b) => a.localeCompare(b,language));
    }
    /** Remove one personal word, including from an inactive dictionary.
     * @param {string} word Personal word. @param {string} language Its dictionary locale.
     * @pre Explicit user removal. @post Successful removal persists and refreshes every host.
     * @return {boolean} Whether deletion succeeded. @throws {void} Storage errors return false.
     */
    removeWord(word, language = this.#language) {
      if (!Object.hasOwn(languages,language) || language === 'off' || typeof word !== 'string') return false;
      const normalized = normalizeWord(word,language), key = wordKey + language + '.' + encodeURIComponent(normalized);
      try {
        if (this.#storage) {
          this.#storage.removeItem(key);
          if (this.#storage.getItem(key) !== null) return false;
        }
      } catch { return false; } // Keep the word visible when durable deletion cannot be confirmed.
      this.#sessionWords.get(language)?.delete(normalized);
      this.#readWords(language);
      this.#notify(); return true;
    }
    /** Check the current personal and bundled dictionaries without mutating either.
     * @pre Dictionary is ready. @returns {boolean} Accepted spelling. @throws {Error} Checker failure.
     */
    correct(word) {
      const words = this.#words.get(this.#language) || this.#readWords(this.#language);
      return words.has(normalizeWord(word,this.#language)) || this.#checker.correct(word.replace(/’/g,"'"));
    }
    /** Persist the selected dictionary or Off without touching source data.
     * @pre Supported key. @post Old async loads cannot restore a previous language.
     * @throws {TypeError} Unsupported language.
     */
    setLanguage(language) {
      if (!Object.hasOwn(languages,language)) throw new TypeError('Unsupported spelling language');
      this.#language = language; this.#checker = null; this.#status = 'idle'; ++this.#run;
      if (language !== 'off') this.#readWords(language);
      try { this.#storage?.setItem(storageKey,language); } catch {}
      this.#notify();
    }
    /** Start/reuse a local dictionary request; callers observe readiness by subscription.
     * @pre Enabled editor. @post Failures remain visible and a later language selection can retry.
     * @returns {Promise<void>} Settlement. @throws {void} Failures are reported as status.
     */
    async ensure() {
      if (this.#language === 'off' || this.#status !== 'idle') return;
      const language = this.#language, run = this.#run; this.#status = 'loading'; this.#notify();
      let pending = this.#cache.get(language);
      if (!pending) { pending = Promise.resolve().then(() => this.#loader(language)); this.#cache.set(language,pending); }
      try {
        const checker = await pending;
        if (run !== this.#run) return;
        this.#checker = checker; this.#status = 'ready';
      } catch {
        this.#cache.delete(language);
        if (run !== this.#run) return;
        this.#status = 'error';
      }
      this.#notify();
    }
  }
  /** Mask inline Markdown syntax using the already bundled parser.
   * @pre One line of prose outside fenced blocks. @post UTF-16 offsets remain stable.
   * @returns {string} Prose mask. @throws {Error} Parser failure.
   */
  function markdownInline(text) {
    if (!window.marked?.Lexer) return text.replace(/`[^`]*`|<[^>]*>|\]\([^)]*\)/g,blank);
    let offset = 0, result = '';
    for (const token of window.marked.Lexer.lexInline(text)) {
      const raw = token.raw;
      if (['text','escape'].includes(token.type)) result += raw;
      else if (['strong','em','del','link'].includes(token.type) && token.tokens?.length) {
        const contents = token.tokens.map(child => child.raw).join('');
        // Locate the parser's actual child source, including nested brackets/delimiters.
        const start = raw.indexOf(contents,1);
        result += start >= 0 ? blank(raw.slice(0,start)) + markdownInline(contents) + blank(raw.slice(start + contents.length)) : blank(raw);
      } else result += blank(raw);
      offset += raw.length;
    }
    return result + blank(text.slice(offset));
  }
  /** Build one cached block state at a time, skipping metadata, code and comments.
   * @pre Lines arrive in source order. @post State carries multiline delimiters only.
   * @returns {string} Coordinate-preserving prose mask. @throws {Error} Parser failure.
   */
  function markdownLine(text, state, line) {
    if (line === 0 && /^---\s*$/.test(text)) { state.frontmatter = true; return blank(text); }
    if (state.frontmatter) { if (/^(?:---|\.\.\.)\s*$/.test(text)) state.frontmatter = false; return blank(text); }
    const fence = text.match(/^ {0,3}(`{3,}|~{3,})/);
    if (state.fence) {
      if (fence && fence[1][0] === state.fence[0] && fence[1].length >= state.fence.length && !text.slice(fence[0].length).trim()) state.fence = null;
      return blank(text);
    }
    if (fence) { state.fence = fence[1]; return blank(text); }
    if (/^(?: {4}|\t)/.test(text) || /^ {0,3}\[[^\]]+\]:/.test(text)) return blank(text);
    let masked = '', cursor = 0;
    while (cursor < text.length) {
      if (state.comment) {
        const end = text.indexOf('-->',cursor);
        if (end < 0) { masked += blank(text.slice(cursor)); break; }
        masked += blank(text.slice(cursor,end + 3)); cursor = end + 3; state.comment = false;
      } else {
        const start = text.indexOf('<!--',cursor);
        if (start < 0) { masked += text.slice(cursor); break; }
        masked += text.slice(cursor,start); cursor = start; state.comment = true;
      }
    }
    return markdownInline(masked).replace(/(?:https?:\/\/|[\w.+-]+@)[^\s<>]+|\b[\w-]+(?:_[\w-]+)+\b|\$[^$]*\$/g,blank);
  }
  let closeActiveMenu;
  const samePosition = (a,b) => a.line === b.line && a.ch === b.ch;
  class Controller {
    #editor; #service; #file; #marks = []; #timer; #disposed = false; #states = [{}]; #latexLines; #unsubscribe; #change; #swap; #viewport; #preference; #contextmenu; #keydown; #closeMenu;
    /** Attach spelling to a host-owned CodeMirror without owning its buffer/history.
     * @pre File callback returns the current source identity. @post Only visible prose is decorated.
     * @throws {Error} Editor failure.
     */
    constructor(editor, {file = () => '', service = spelling} = {}) {
      this.#editor = editor; this.#service = service; this.#file = file;
      this.#change = () => { this.#states = [{}]; this.#latexLines = null; this.#clear(); this.#schedule(); };
      this.#swap = this.#change;
      this.#viewport = () => this.#schedule();
      this.#preference = () => { this.#clear(); this.#schedule(); };
      this.#contextmenu = (_cm,event) => this.#openMenu(event,false);
      this.#keydown = (_cm,event) => {
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) this.#openMenu(event,true);
      };
      for (const [event, handler] of [['changes',this.#change],['swapDoc',this.#swap],['viewportChange',this.#viewport],['contextmenu',this.#contextmenu],['keydown',this.#keydown]]) editor.on(event,handler);
      this.#unsubscribe = service.subscribe(this.#preference); this.#schedule();
    }
    #kind() { const extension = String(this.#file() || '').split('.').pop().toLowerCase(); return extension === 'tex' ? 'latex' : ['md','markdown'].includes(extension) ? 'markdown' : extension === 'txt' ? 'plain' : null; }
    #clear() { this.#closeMenu?.(); for (const mark of this.#marks) mark.clear(); this.#marks = []; }
    /** Offer the current dictionary's suggestions for an exact decorated word.
     * @param {Event} event Pointer or keyboard context-menu trigger.
     * @param {boolean} keyboard Use the caret rather than pointer coordinates.
     * @pre CodeMirror owns this event. @post Only spelling targets suppress the native menu.
     * @return {void} Nothing. @throws {Error} Dictionary or DOM failure.
     */
    #openMenu(event,keyboard) {
      const cm = this.#editor, service = this.#service;
      this.#closeMenu?.();
      if (this.#disposed || event.defaultPrevented || cm.getOption('readOnly') || !service.checker || service.language === 'off') return;
      // coordsChar snaps whitespace to nearby text. Require the actual underline as well.
      if (!keyboard && !event.target?.closest?.('.spelling-error')) return;
      const doc = cm.getDoc(), position = keyboard ? doc.getCursor() : cm.coordsChar({left:event.clientX,top:event.clientY},'window');
      const mark = this.#marks.find(item => {
        const range = item.find();
        return range && position.line === range.from.line && position.ch >= range.from.ch && position.ch <= range.to.ch;
      });
      if (!mark) return;
      const {from,to} = mark.find(), word = doc.getRange(from,to), file = this.#file(), language = service.language;
      const suggestions = [...new Set(service.checker.suggest(word.replace(/’/g,"'")))].slice(0,8);
      event.preventDefault(); event.stopPropagation();
      closeActiveMenu?.();
      const menu = document.createElement('div'), abort = new AbortController(), buttons = [];
      menu.className = 'explorer-menu spelling-menu'; menu.setAttribute('role','menu');
      menu.setAttribute('aria-label','Spelling suggestions for ' + word);
      const close = (focus = false) => {
        abort.abort(); for (const button of buttons) window.EditorTools.Tool.unbind(button);
        menu.remove(); this.#closeMenu = null;
        if (closeActiveMenu === close) closeActiveMenu = null;
        if (focus && !this.#disposed) cm.focus();
      };
      this.#closeMenu = close; closeActiveMenu = close;
      const validTarget = () => {
        const current = mark.find();
        return !this.#disposed && cm.getDoc() === doc && this.#file() === file && service.language === language
          && !cm.getOption('readOnly') && this.#marks.includes(mark) && current
          && samePosition(current.from,from) && samePosition(current.to,to) && doc.getRange(from,to) === word;
      };
      for (const suggestion of suggestions) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = suggestion;
        button.setAttribute('role','menuitem');
        window.EditorTools.Tool.bind(button,{id:'spelling.replace',label:suggestion,info:'Replace “' + word + '” with “' + suggestion + '”',showText:true,execute:() => {
          const valid = validTarget();
          close(true);
          // A separate origin keeps correction and adjacent typing as separate undo steps.
          if (valid) cm.replaceRange(suggestion,from,to,'spelling');
        }});
        buttons.push(button); menu.append(button);
      }
      if (!buttons.length) {
        const empty = document.createElement('div'); empty.className = 'spelling-menu-empty'; empty.textContent = 'No spelling suggestions'; menu.append(empty);
      }
      const add = document.createElement('button'); add.type = 'button'; add.textContent = 'Add to dictionary';
      add.setAttribute('role','menuitem');
      window.EditorTools.Tool.bind(add,{id:'spelling.add',label:'Add to dictionary',info:'Remember “' + word + '” in ' + languages[language],showText:true,execute:() => {
        const valid = validTarget(); close(true);
        if (valid) service.addWord(word,language);
      }});
      buttons.push(add); menu.append(add);
      document.body.append(menu);
      const anchor = keyboard ? cm.cursorCoords(position,'window') : {left:event.clientX,bottom:event.clientY};
      menu.style.left = Math.max(4,Math.min(anchor.left,window.innerWidth-menu.offsetWidth-8)) + 'px';
      menu.style.top = Math.max(4,Math.min(anchor.bottom,window.innerHeight-menu.offsetHeight-8)) + 'px';
      const options = {signal:abort.signal};
      document.addEventListener('pointerdown',e => { if (!menu.contains(e.target)) close(); },options);
      document.addEventListener('contextmenu',() => close(),{...options,capture:true});
      document.addEventListener('scroll',() => close(),{...options,capture:true});
      window.addEventListener('blur',() => close(),options);
      window.addEventListener('resize',() => close(),options);
      menu.addEventListener('focusout',e => { if (!menu.contains(e.relatedTarget)) close(); },options);
      menu.addEventListener('keydown',e => {
        if (e.key === 'Escape' || e.key === 'Tab') { if (e.key === 'Escape') e.preventDefault(); close(true); return; }
        if (['ArrowDown','ArrowUp','Home','End'].includes(e.key)) {
          e.preventDefault();
          const index = buttons.indexOf(document.activeElement);
          buttons[e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length-1 : (index + (e.key === 'ArrowDown' ? 1 : buttons.length-1)) % buttons.length]?.focus();
        }
      },options);
      buttons[0].focus();
    }
    #schedule() { clearTimeout(this.#timer); if (!this.#disposed) this.#timer = setTimeout(() => this.#paint(),250); }
    #paint() {
      if (this.#disposed) return;
      const kind = this.#kind(), cm = this.#editor, service = this.#service;
      this.#clear();
      if (!kind || service.language === 'off') return;
      if (!service.checker) { void service.ensure(); return; }
      const {from,to} = cm.getViewport(), doc = cm.getDoc();
      // Cache only block state. Dictionary calls and marks stay within the viewport.
      if (kind === 'markdown') for (let line = this.#states.length - 1; line < to; line++) {
        const state = {...this.#states[line]}; markdownLine(doc.getLine(line),state,line); this.#states[line + 1] = state;
      }
      if (kind === 'latex' && !this.#latexLines && window.WritingCheck) this.#latexLines = window.WritingCheck.proseMask(doc.getValue('\n'),{spelling:true}).split('\n');
      cm.operation(() => {
        for (let line = from; line < to; line++) {
          const text = doc.getLine(line); let mask;
          if (kind === 'markdown') mask = markdownLine(text,{...this.#states[line]},line);
          else if (kind === 'latex') {
            mask = this.#latexLines?.[line] || text;
            for (const token of cm.getLineTokens(line,true)) if (token.type) mask = mask.slice(0,token.start) + blank(mask.slice(token.start,token.end)) + mask.slice(token.end);
          } else mask = text;
          for (const word of mask.matchAll(/[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*/gu)) {
            const value = word[0];
            if (value.length < 2 || service.correct(value)) continue;
            this.#marks.push(doc.markText({line,ch:word.index},{line,ch:word.index + value.length},{className:'spelling-error',attributes:{title:'Possible spelling mistake (' + languages[service.language] + ')'}}));
          }
        }
      });
    }
    /** Remove listeners and decorations, including marks attached to a previous document.
     * @pre May be called repeatedly. @post Delayed work cannot paint again. @throws {void} None.
     */
    dispose() {
      this.#disposed = true; clearTimeout(this.#timer); this.#unsubscribe(); this.#clear();
      for (const [event,handler] of [['changes',this.#change],['swapDoc',this.#swap],['viewportChange',this.#viewport],['contextmenu',this.#contextmenu],['keydown',this.#keydown]]) this.#editor.off(event,handler);
    }
  }
  /** Mount personal words inline without changing the selected spelling language.
   * @param {HTMLElement} host Writing settings. @param {object} options Optional service.
   * @pre Tool runtime is mounted. @post Returned disposer releases controls and subscription.
   * @return {Function} Cleanup. @throws {Error} DOM initialization failures.
   */
  function mountDictionary(host,{service = spelling} = {}) {
    const section = document.createElement('section'); section.className = 'settings-card settings-dictionary';
    const heading = document.createElement('h3'); heading.textContent = 'Personal dictionary';
    const label = document.createElement('label'); label.textContent = 'Dictionary language'; label.htmlFor = 'settingsDictionaryLanguage';
    const select = document.createElement('select'); select.id = 'settingsDictionaryLanguage'; select.setAttribute('aria-label','Dictionary language');
    for (const [value,name] of Object.entries(languages)) if (value !== 'off') {
      const option = document.createElement('option'); option.value = value; option.textContent = name; select.append(option);
    }
    select.value = service.language === 'off' ? 'en-US' : service.language;
    const status = document.createElement('p'); status.setAttribute('role','status');
    const error = document.createElement('p'); error.setAttribute('role','alert'); error.className = 'pane-error';
    const list = document.createElement('ul'); list.className = 'spelling-word-list'; list.setAttribute('aria-label','Added words');
    const header = document.createElement('div'),control = document.createElement('div'); header.className = 'settings-dictionary-header'; control.className = 'settings-dictionary-language';
    control.append(label,select); header.append(heading,control); section.append(header,status,error,list); host.append(section);
    let buttons = [], unsubscribe = () => {};
    const render = () => {
      for (const button of buttons) window.EditorTools.Tool.unbind(button);
      buttons = []; list.replaceChildren();
      const language = select.value, words = service.listWords(language);
      status.textContent = words.length ? words.length + (words.length === 1 ? ' added word' : ' added words') : 'No added words for ' + languages[language] + '.';
      list.hidden = !words.length;
      words.forEach((word,index) => {
        const row = document.createElement('li'), text = document.createElement('span'), remove = document.createElement('button');
        text.textContent = word; text.lang = language; remove.type = 'button'; remove.textContent = 'Remove';
        window.EditorTools.Tool.bind(remove,{id:'spelling.remove-word',label:'Remove “' + word + '” from ' + languages[language],info:'Check “' + word + '” again in ' + languages[language],showText:true,execute:() => {
          error.textContent = '';
          if (!service.removeWord(word,language)) { error.textContent = 'Could not remove “' + word + '”. Check that browser storage is available and try again.'; return; }
          // Service notification rebuilds the list; retain a useful keyboard position.
          (buttons[Math.min(index,buttons.length-1)] || select).focus();
        }});
        buttons.push(remove); row.append(text,remove); list.append(row);
      });
    };
    select.addEventListener('change',() => { error.textContent = ''; render(); });
    const cleanup = () => { unsubscribe(); for (const button of buttons) window.EditorTools.Tool.unbind(button); };
    try { render(); unsubscribe = service.subscribe(render); }
    catch (failure) { cleanup(); section.remove(); throw failure; }
    return cleanup;
  }
  const spelling = new Service();
  window.Spelling = Object.freeze({languages,Service,mountDictionary,attach:(editor,options) => new Controller(editor,options),service:spelling});
})();
