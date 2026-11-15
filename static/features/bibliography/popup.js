/* Citation completion lifecycle; composed with editor, DOM and linked-metadata capabilities. */
'use strict';
(() => {
  const { citeContext, citeMatches } = window.BibliographyCitations;
  let sequence = 0;
  class CitationPopup {
    #run; #cm; #host; #node; #enabled; #entries; #disposed = false;
    #id = 'citation-popup-' + ++sequence;
    #listeners = []; #outside; #resize; #blurTimer;
    #citeSearch;
    #citeOptions;
    #citePopOpen;
    #citePop;
    #citeCtx;
    #citeIndex;
    #citeEntries;
    #citeLoadError;
    #citeLoading;
    #citeLoadRun = 0;
    #citeKeymap;
    #citeList;

    /** Mount citation completion on an editor without exposing its lifecycle state.
     * @param {object} options editor (CodeMirror 5 adapter), host (positioned element),
     * node (DOM factory), enabled (editable LaTeX predicate), entries (async linked metadata),
     * run (host error boundary for event callbacks).
     * @pre Capabilities belong to one editor/host and metadata is local to its project.
     * @post Listeners mounted; source unchanged; no metadata read until completion opens.
     * @return {CitationPopup} Controller. @throws {Error} Invalid capability or listener failure.
     */
    constructor({editor, host, node, enabled, entries, run = operation => operation()}) {
      this.#run = run;
      this.#cm = editor; this.#host = host;
      this.#node = (tag, attrs, ...children) => node(tag, Object.fromEntries(
        Object.entries(attrs || {}).map(([key, value]) => [key, key.startsWith('on')
          ? (...args) => run(() => { if (!this.#disposed) return value(...args); }) : value])), ...children);
      this.#enabled = enabled; this.#entries = entries;
      const bind = (event, handler) => {
        const callback = (...args) => run(() => { if (!this.#disposed) return handler(...args); });
        editor.on(event, callback); this.#listeners.push([event, callback]);
      };
      bind('changes', (_cm, changes) => {
        if (changes.some(c => ['+input', '*compose', 'paste'].includes(c.origin) || (c.origin === '+delete' && this.#citePopOpen))) this.update(true);
      });
      bind('cursorActivity', () => { if (this.#citePopOpen) this.update(); });
      bind('scroll', () => { if (this.#citePopOpen) this.update(); });
      bind('swapDoc', () => this.close());
      bind('blur', () => this.#blur());
      this.#outside = event => run(() => { if (!this.#citePop?.contains(event.target)) this.close(); });
      this.#resize = () => run(() => { if (this.#citePopOpen) this.update(); });
      document.addEventListener('pointerdown', this.#outside);
      window.addEventListener('resize', this.#resize);
    }
    /** Delay focus dismissal to allow focus transfer into the search input.
     * @param {void} none. @pre Mounted. @post Previous timer replaced.
     * @return {void} Nothing. @throws {void} None.
     */
    #blur() {
      clearTimeout(this.#blurTimer);
      this.#blurTimer = setTimeout(() => {
        this.#run(() => {
          if (!this.#disposed && !this.#cm.hasFocus() && !this.#citePop?.contains(document.activeElement)) this.close();
        });
      }, 150);
    }
    /** Open or refresh local citation search at the cursor.
     * @param {boolean} force Open even when completion is currently closed.
     * @pre Editable LaTeX cursor; public bibliography operations are available.
     * @post Search and completion use linked, current bibliography buffers; source stays unchanged.
     * @return {void} Nothing; asynchronous read errors appear inside the popup.
     * @throws {Error} DOM or editor setup failures propagate to the event boundary.
     */
    update(force = false) {
      if (this.#disposed) return;
      const cm = this.#cm;
      if (!cm || !this.#enabled() || cm.getOption?.('readOnly') || cm.somethingSelected()) return this.close();
      const cur = cm.getCursor();
      const ctx = citeContext(cm.getLine(cur.line), cur.ch);
      if (!ctx || (!force && !this.#citePopOpen)) return this.close();
      if (!this.#citePop) {
        this.#citeSearch = this.#node('input', { type: 'search', class: 'ws-cite-search', placeholder: 'Search bibkey, title, author or year',
          'aria-label': 'Search linked references', role: 'combobox', 'aria-autocomplete': 'list', 'aria-controls': this.#id + '-options', autocomplete: 'off',
          oninput: () => { this.#citeIndex = 0; this.#filter(); },
          onkeydown: event => {
            const commands = { ArrowUp: () => this.move(-1), ArrowDown: () => this.move(1), PageUp: () => this.move(-8), PageDown: () => this.move(8),
              Enter: () => this.accept(this.#citeIndex), Tab: () => this.accept(this.#citeIndex),
              Escape: () => { this.close(); this.#cm.focus(); } };
            if (commands[event.key]) { event.preventDefault(); event.stopPropagation(); commands[event.key](); }
          },
          onblur: () => this.#blur() });
        this.#citeOptions = this.#node('div', { class: 'ws-cite-options', id: this.#id + '-options', role: 'listbox', 'aria-label': 'Linked references' });
        this.#citePop = this.#node('div', { class: 'ws-cite-pop', 'aria-label': 'Citation search' }, this.#citeSearch, this.#citeOptions);
        this.#host.append(this.#citePop);
      }
      const same = this.#citeCtx && this.#citeCtx.query === ctx.query && this.#citeCtx.line === cur.line && this.#citeCtx.from === ctx.from;
      this.#citeCtx = { ...ctx, line: cur.line };
      if (document.activeElement !== this.#citeSearch) this.#citeSearch.value = ctx.query;
      if (!same) this.#citeIndex = 0;
      const at = cm.cursorCoords({ line: cur.line, ch: ctx.from }, 'local'), info = cm.getScrollInfo();
      const width = this.#host.clientWidth, top = at.bottom - info.top + 4;
      if (top < 0 || top > this.#host.clientHeight - 20) return this.close(); // the key scrolled out of view
      this.#citePop.style.left = Math.max(4, Math.min(width - Math.min(380, width - 8) - 4, (at.left - (info.left || 0)))) + 'px';
      this.#citePop.style.top = Math.max(0, Math.min(top, this.#host.clientHeight - 260)) + 'px';
      this.#citePop.hidden = false;
      if (!this.#citePopOpen) {
        this.#citePopOpen = true;
        this.#citeEntries = []; this.#citeLoadError = null; this.#citeLoading = true;
        const request = this.#citeLoadRun = (this.#citeLoadRun || 0) + 1;
        Promise.resolve().then(() => {
          if (this.#disposed || request !== this.#citeLoadRun) return [];
          return this.#entries();
        }).then(entries => {
          if (!this.#citePopOpen || request !== this.#citeLoadRun || this.#disposed) return;
          this.#citeEntries = entries; this.#citeLoading = false; this.#run(() => this.#filter());
        }).catch(error => {
          if (!this.#citePopOpen || request !== this.#citeLoadRun || this.#disposed) return;
          this.#citeLoadError = error.message; this.#citeLoading = false; this.#run(() => this.#filter());
        });
        this.#citeKeymap = {
          Up: () => this.move(-1), Down: () => this.move(1), PageUp: () => this.move(-8), PageDown: () => this.move(8),
          Enter: () => this.accept(this.#citeIndex), Tab: () => this.accept(this.#citeIndex), Esc: () => this.close(),
        };
        this.#citeKeymap = Object.fromEntries(Object.entries(this.#citeKeymap).map(([key, action]) =>
          [key, () => this.#run(action)]));
        cm.addKeyMap(this.#citeKeymap);
      }
      this.#filter();
    }
    /** Apply the search field to loaded citation entries.
     * @param {void} none No arguments. @pre Popup controls exist.
     * @post Matches and active option update without editing source or contacting a provider.
     * @return {void} Nothing. @throws {Error} Rendering failures propagate to the UI boundary.
     */
    #filter() {
      this.#citeList = citeMatches(this.#citeEntries || [], this.#citeSearch.value.trim());
      this.#citeIndex = Math.min(this.#citeIndex || 0, Math.max(0, this.#citeList.length - 1));
      this.#render();
    }
    /** Render the current completion state as text-only accessible options.
     * @param {void} none No arguments. @pre Popup controls and match list exist.
     * @post Options, active descendant and loading/error messages reflect current state.
     * @return {void} Nothing. @throws {Error} DOM failures propagate to the UI boundary.
     */
    #render() {
      const q = this.#citeSearch.value;
      this.#citeSearch.setAttribute('aria-expanded', String(!!this.#citeList.length));
      this.#citeSearch.setAttribute('aria-activedescendant', this.#citeList.length ? this.#id + '-option-' + this.#citeIndex : '');
      if (!this.#citeList.length) {
        this.#citeOptions.replaceChildren(this.#node('div', { class: 'ws-cite-none', role: 'status', text: this.#citeLoading ? 'Reading linked bibliography…' : this.#citeLoadError ||
          (this.#citeEntries.length ? `No linked reference matches “${q}”.` : 'No linked bibliography entries found.') }));
        return;
      }
      this.#citeOptions.replaceChildren(...this.#citeList.map((e, i) => this.#node('div', {
        id: this.#id + '-option-' + i, role: 'option', class: 'ws-cite-item' + (i === this.#citeIndex ? ' on' : ''), 'aria-selected': String(i === this.#citeIndex),
        onpointerdown: (ev) => { ev.preventDefault(); this.accept(i); } },
        this.#node('strong', { text: e.key }), this.#node('span', { text: [e.author, e.year].filter(Boolean).join(' ') + (e.title ? ' — ' + e.title : '') }))));
      this.#citeOptions.children[this.#citeIndex]?.scrollIntoView({ block: 'nearest' });
    }
    /** Move the active citation option within the visible matches.
     * @param {number} d Signed option offset. @pre Completion controls exist.
     * @post Active index is clamped and rendered; source is unchanged.
     * @return {void} Nothing. @throws {Error} Rendering failures propagate to the UI boundary.
     */
    move(d) {
      if (this.#disposed || !this.#citePopOpen || !this.#citeList?.length) return;
      this.#citeIndex = Math.max(0, Math.min(this.#citeList.length - 1, this.#citeIndex + d));
      this.#render();
    }
    /** Insert a chosen local bibkey at the active citation fragment.
     * @param {number} i Match index, defaulting to the active option. @pre Completion context still identifies the source cursor.
     * @post Key replaces only the current fragment; a missing brace is closed; editor regains focus.
     * @return {void} Nothing. @throws {Error} Editor mutation failures propagate to the UI boundary.
     */
    accept(i = this.#citeIndex) {
      const e = this.#citeList?.[i];
      if (!e || !this.#citePopOpen || !this.#enabled()) return this.close();
      const cursor = this.#cm.getCursor();
      const current = citeContext(this.#cm.getLine(cursor.line), cursor.ch);
      if (!current || cursor.line !== this.#citeCtx.line || current.from !== this.#citeCtx.from || current.to !== this.#citeCtx.to || current.query !== this.#citeCtx.query || this.#cm.somethingSelected() || this.#cm.getOption?.('readOnly')) return this.close();
      const { line, from, to } = this.#citeCtx;
      const suffix = this.#cm.getLine(line).slice(to).match(/^\s*[,}]/) ? '' : '}';
      this.close();
      this.#cm.replaceRange(e.key + suffix, { line, ch: from }, { line, ch: to }, '+cite');
      this.#cm.focus();
    }
    /** Dismiss citation completion and release its editor keyboard bindings.
     * @param {void} none No arguments. @pre None; repeated calls are safe.
     * @post Popup is hidden and its source context cleared; source remains unchanged.
     * @return {void} Nothing. @throws {Error} Editor keymap failures propagate to the UI boundary.
     */
    close() {
      ++this.#citeLoadRun;
      clearTimeout(this.#blurTimer);
      if (this.#citePop) this.#citePop.hidden = true;
      this.#citeSearch?.setAttribute('aria-expanded', 'false');
      this.#citeSearch?.setAttribute('aria-activedescendant', '');
      if (this.#citePopOpen) { this.#citePopOpen = false; this.#cm?.removeKeyMap(this.#citeKeymap); }
      this.#citeCtx = null;
    }

    /** Release all bindings, pending reads, timers and popup DOM permanently.
     * @param {void} none. @pre None; repeated calls safe.
     * @post Late reads ignored; editor unchanged; controller cannot reopen.
     * @return {void} Nothing. @throws {Error} DOM/editor cleanup failure.
     */
    dispose() {
      if (this.#disposed) return;
      this.close(); this.#disposed = true;
      for (const [event, callback] of this.#listeners) this.#cm.off(event, callback);
      this.#listeners = [];
      document.removeEventListener('pointerdown', this.#outside);
      window.removeEventListener('resize', this.#resize);
      this.#citePop?.remove();
    }
  }
  window.CitationPopup = CitationPopup;
})();
