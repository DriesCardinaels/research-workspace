/* LaTeX workspace: source on the left, PDF on the right, review panel beside the source.
 * Comments are anchored in the LaTeX source and drawn in both views from the same record.
 * Changes against the version's commit are marked in both views too. Nothing becomes a
 * version until "Save as V…".
 */
'use strict';
(function () {
  const { latexWords, sourceRange, selectionWords, pageWords, findSpan, pickOccurrence, floatOutsideCaption } = window.DraftMatch;

  // Older copy command: works inside a click where the async clipboard API is refused.
  function execCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.cssText = 'position:fixed;opacity:0;left:-9999px';
    const prev = document.activeElement;
    document.body.append(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove(); prev?.focus?.();
    return ok;
  }
  /** Build workspace DOM with default hover labels for named interactive controls.
   * @param {string} tag HTML tag. @param {object} attrs Attributes and event handlers.
   * @param {...Node|string} children Child content.
   * @pre Document exists; icon controls supply aria-label metadata.
   * @post Independent node has content, handlers and shared label metadata.
   * @return {HTMLElement} Detached node. @throws {Error} DOM or invalid metadata failures.
   */
  function h(tag, attrs, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'tool' || k === 'submitTool') continue;
      if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) e.append(c);
    if (attrs?.submitTool) window.EditorTools.Tool.submit(e, null, attrs.submitTool);
    if (attrs?.tool) window.EditorTools.Tool.bind(e, attrs.tool);
    else if (tag === 'summary') window.EditorTools.Tool.disclosure(e, attrs?.text || 'Expand or collapse section');
    else if (tag === 'button' && attrs?.popovertarget) window.EditorTools.Tool.popover(e, attrs.popovertarget, attrs['aria-label'] || attrs.title);
    if (['button', 'summary'].includes(tag) && attrs?.['aria-label'] && window.EditorTools)
      window.EditorTools.ToolInfo.apply(e, { label: attrs['aria-label'], info: attrs.title || attrs['aria-label'] }, true);
    return e;
  }
  let compileMenuId = 0;
  const NO_SYNC = 'Hide images is on: this PDF has no figures, so source and PDF positions do not match. Turn off Hide images to go between them.';
  // "5 figure, 1 teaserfigure" → readable text for the Hide images tooltip.
  function removedText(removed) {
    const parts = Object.entries(removed || {}).map(([env, n]) => `${n} × ${env}`);
    return parts.length ? `Removed: ${parts.join(', ')}.` : 'No figure floats found.';
  }
  const KIND = {
    replaced: { label: 'Replaced', color: 'blue' },
    added: { label: 'Added', color: 'green' },
    removed: { label: 'Removed', color: 'pink' },
  };
  const short = (s, n = 220) => { s = (s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
  const when = (t) => new Date(typeof t === 'number' ? t * 1000 : t).toLocaleString();
  const base = (f) => f.split('/').pop();
  // The server counts code points; JavaScript strings and CodeMirror count UTF-16 units.
  const cpToUnits = (text, cp) => { let i = 0, n = 0; for (const ch of text) { if (n === cp) return i; i += ch.length; n++; } return i; };
  const unitsToCp = (text, u) => [...text.slice(0, u)].length;
  // Formatting commands for the source editor. Each wraps the selection (or inserts an empty
  // pair at the cursor) and unwraps text that is already wrapped. `join` replaces the spaces
  // before the command: '~' ties a citation or reference to the previous word, '' attaches a footnote.
  const IS_MAC = /Mac|iPhone|iPad/.test(typeof navigator === 'undefined' ? '' : navigator.platform || '');
  const keyHint = (k) => (IS_MAC ? '⌘' + k.replace('Alt-', '⌥') : 'Ctrl+' + k.replace('Alt-', 'Alt+'));
  const ICONS = window.EditorTools ? Object.fromEntries(Object.entries({
    bold:'bold', emph:'italic', code:'code', quote:'quote', cite:'citation', ref:'link',
    footnote:'footnote', note:'comment', more:'more', comment:'commentLines',
    refresh:'refresh', chevronDown:'chevronDown', close:'close', pin:'pin',
  }).map(([key, name]) => [key, window.EditorTools.icons.markup(name)])) : {};
  const WRAPS = {
    bold: { name: 'Bold', open: '\\textbf{', close: '}', label: 'Bold', key: 'B', group: 'text' },
    emph: { name: 'Emphasis', open: '\\emph{', close: '}', label: 'Emphasis (italic)', key: 'I', group: 'text' },
    code: { name: 'Monospace', open: '\\texttt{', close: '}', label: 'Monospace', group: 'text' },
    quote: { name: 'Quotes', open: '``', close: "''", label: 'Quotation marks', group: 'text' },
    cite: { name: 'Citation', open: '\\cite{', close: '}', label: 'Citation: the selection is the cite key', key: 'Alt-K', join: '~', group: 'link' },
    ref: { name: 'Reference', open: '\\ref{', close: '}', label: 'Cross-reference: the selection is the label', join: '~', group: 'link' },
    footnote: { name: 'Footnote', open: '\\footnote{', close: '}', label: 'Footnote: the selection becomes the footnote text', join: '', group: 'link' },
  };
  // Composition root: new formatting commands register independently of the renderer.
  if (window.EditorTools) {
    for (const [id, definition] of Object.entries(WRAPS)) window.EditorTools.sourceCommands.register({
      id, name: definition.name, label: `${definition.label} — ${definition.join || ''}${definition.open}…${definition.close}`,
      icon: ICONS[id], group: definition.group, key: definition.key, execute: workspace => workspace.wrap(id),
    });
    window.EditorTools.sourceCommands.register({ id: 'comment', name: 'Comment out %',
      label: 'Comment out the selected lines with %, or uncomment them', icon: ICONS.comment,
      group: 'lines', key: '/', execute: workspace => workspace.toggleComment() });
  }
  // Pure edit on the whole text: returns the range to replace, its new text and the new selection.
  function wrapEdit(text, s, e, w) {
    const { open, close } = w;
    if (w.join && text[s] === w.join && text.startsWith(open, s + 1)) s += 1; // selection "~\cite{…}"
    const sel = text.slice(s, e);
    // Unwrap: the selection is "\cmd{…}" or sits right inside one.
    let outer = null;
    if (sel.startsWith(open) && sel.endsWith(close) && sel.length >= open.length + close.length) outer = [s, e];
    else if (text.slice(Math.max(0, s - open.length), s) === open && text.startsWith(close, e)) outer = [s - open.length, e + close.length];
    if (outer) {
      let [a, b] = outer, lead = '';
      const inner = text.slice(a + open.length, b - close.length);
      if (w.join !== undefined) {
        if (w.join && text[a - 1] === w.join) a -= 1;
        // Give the text its space back unless one is already there.
        if (a > 0 && !/\s/.test(text[a - 1])) lead = ' ';
      }
      return { from: a, to: b, insert: lead + inner, selFrom: a + lead.length, selTo: a + lead.length + inner.length };
    }
    // Wrap: leave surrounding spaces of the selection outside the command.
    while (s < e && /\s/.test(text[s])) s++;
    while (e > s && /\s/.test(text[e - 1])) e--;
    let from = s, lead = '';
    if (w.join !== undefined) {
      let k = s;
      while (k > 0 && (text[k - 1] === ' ' || text[k - 1] === '\t')) k--;
      if (k > 0 && text[k - 1] !== '\n') { from = k; lead = text[k - 1] === w.join ? '' : w.join; }
    }
    const body = text.slice(s, e);
    const start = from + lead.length + open.length;
    return { from, to: e, insert: lead + open + body + close, selFrom: start, selTo: start + body.length };
  }
  // Comment out the selected lines with "% ", or uncomment them when all are comments.
  function commentEdit(text, s, e) {
    const from = text.lastIndexOf('\n', s - 1) + 1;
    if (e > s && text[e - 1] === '\n') e -= 1; // a selection ending at a line start leaves that line alone
    let to = text.indexOf('\n', e); if (to < 0) to = text.length;
    const lines = text.slice(from, to).split('\n');
    const used = lines.filter((l) => l.trim());
    const off = used.length > 0 && used.every((l) => /^\s*%/.test(l));
    const out = lines.map((l) => (off ? l.replace(/^(\s*)% ?/, '$1') : l.trim() ? l.replace(/^(\s*)/, '$1% ') : l)).join('\n');
    return { from, to, insert: out, selFrom: from, selTo: from + out.length };
  }
  const { stripComments, normalizedSource, nativeOffset, textOffset } = window.SourceText;
  const { citeUses, citeContext, citeMatches } = window.BibliographyCitations;
  const { combinedSource, projectionRange, projectionSpans, applyProjectionEdit } = window.SourceProjection;
  const store = {
    get(k, d) { try { return localStorage.getItem('pdf-editor.ws.' + k) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem('pdf-editor.ws.' + k, String(v)); } catch { /* private mode */ } },
  };

  const sourceBuffers = new WeakMap();
  const buildControllers = new WeakMap();
  /** Compose build hooks without exposing workspace/editor storage to the controller.
   * @param {Workspace} owner Public host operations.
   * @pre SourceBuildController loaded. @post One private controller is reused for this host.
   * @return {SourceBuildController} Host-owned controller. @throws {Error} Initialization failure.
   */
  function buildsFor(owner) {
    let controller = buildControllers.get(owner);
    if (!controller) {
      controller = new window.SourceBuildController({ onStarted: () => owner.renderBuild(),
        onFinished: ({ target, again }) => owner.finishBuild(target, again) });
      buildControllers.set(owner, controller);
    }
    return controller;
  }
  /** Compose native-buffer ownership through authorized read/write capabilities.
   * @param {Workspace} owner Host identity. @pre SourceBuffers runtime loaded.
   * @post One private collection retained. @return {SourceBuffers} Collection.
   * @throws {Error} Invalid construction dependency.
   */
  function buffersFor(owner) {
    let buffers = sourceBuffers.get(owner);
    if (!buffers) {
      buffers = owner.o?.sourceBuffers || new window.SourceBuffers.SourceBuffers({
        read: file => owner.api('/file?path=' + encodeURIComponent(file)),
        write: (file, data) => owner.api('/file', { method: 'PUT', body: JSON.stringify({ path: file, ...data }) }),
        modeFor: file => window.FileTypes?.registry.resolve(file)?.mode || (file.endsWith('.bib') ? 'bibtex' : 'stex'),
      });
      sourceBuffers.set(owner, buffers);
    }
    return buffers;
  }
  const reviewStates = new WeakMap(), reviewCards = new WeakMap();
  /** Resolve the public review-state model for one host.
   * @param {Workspace} owner Host identity. @pre ReviewState loaded.
   * @post Model retained privately. @return {ReviewState} Model. @throws {Error} Initialization failure.
   */
  function reviewFor(owner) {
    let state=reviewStates.get(owner);
    if (!state) { state=owner.o?.reviewState || new window.ReviewState(); reviewStates.set(owner,state); }
    return state;
  }
  /** Compose review rendering with semantic capabilities instead of a workspace object.
   * @param {Workspace} owner Public host operations. @pre ReviewCards loaded.
   * @post One replaceable adapter retained. @return {ReviewCards} Adapter. @throws {Error} Invalid factory.
   */
  function cardsFor(owner) {
    let cards=reviewCards.get(owner);
    if (!cards) {
      const options={state:reviewFor(owner),node:h,short,when,kinds:KIND,actions:{
        run: operation => owner.destroyed ? undefined : owner.o.action(operation),
        author: () => owner.o.author || 'Author',
        request: (path, options) => owner.api(path, options),
        reload: () => owner.destroyed ? undefined : owner.reload(),
        render: () => owner.destroyed ? undefined : owner.renderReview(),
        placeMarks: () => owner.destroyed ? undefined : owner.placeMarks(),
        submitNote: text => owner.submitNote(text),
        copyText: (text, button) => owner.copyText(text, button),
        copyThreadButton: item => owner.copyThreadButton(item),
        select: (...args) => owner.select(...args),
        bufferSnapshot: file => owner.files.get(file)?.snapshot(),
        reloadFile: file => owner.reloadFile(file), compile: () => owner.compile(),
      }};
      cards=owner.o?.reviewCardsFactory ? owner.o.reviewCardsFactory(options) : new window.ReviewCards(options);
      reviewCards.set(owner,cards);
    }
    return cards;
  }
  const reviewPanels = new WeakMap();
  /** Compose independently registered review tabs and their host capabilities.
   * @param {Workspace} owner Host identity. @pre ReviewPanels runtime loaded.
   * @post One private presentation adapter retained. @return {ReviewPanel} Adapter.
   * @throws {Error} Invalid contribution or adapter factory.
   */
  function panelFor(owner) {
    let panel=reviewPanels.get(owner);
    if (!panel) {
      const options={state:reviewFor(owner), node:h, cards:cardsFor(owner),
        tabs:owner.o?.reviewTabs || window.ReviewPanels.builtInTabs(), actions:{
          selectTab: id => {
            owner.reviewTab=id;
            if (id === 'writing') owner.runWriting(); else owner.clearWriting();
            owner.renderReview();
          },
          visibilityChanged: () => { owner.applyMarks(); owner.renderReview(); owner.placeMarks(); },
          copy: button => owner.o.action(() => owner.copyForLlm(button)),
          warning: () => owner.citeWarning(), writing: body => owner.writingPanel(body),
        }};
      panel=owner.o?.reviewPanelFactory ? owner.o.reviewPanelFactory(options) : new window.ReviewPanels.ReviewPanel(options);
      reviewPanels.set(owner,panel);
    }
    return panel;
  }
  const citationPopups = new WeakMap();
  /** Compose completion from narrow editor and linked bibliography capabilities.
   * @param {Workspace} owner Mounted host. @pre Editor and host exist.
   * @post One private controller reused. @return {CitationPopup} Controller.
   * @throws {Error} Construction failure.
   */
  function citationPopupFor(owner) {
    let popup = citationPopups.get(owner);
    if (!popup) {
      popup = new window.CitationPopup({ editor: owner.cm, host: owner.editorHost, node: h,
        enabled: () => !owner.destroyed && owner.isLatexSource(),
        entries: () => owner.bibliographyEntries(), run: operation => {
          try { return operation(); } catch (error) { return owner.run(() => { throw error; }); }
        } });
      citationPopups.set(owner, popup);
    }
    return popup;
  }
  const bibliographyToolStates = new WeakMap();
  class Workspace {
    /** Calculate a formatting edit using a public command identifier.
     * @param {string} text Source text to transform.
     * @param {number} from Selection start in UTF-16 code units.
     * @param {number} to Selection end in UTF-16 code units.
     * @param {string} kind Registered built-in formatting identifier.
     * @pre Selection offsets identify an ordered range within text.
     * @post Source and private command definitions remain unchanged.
     * @return {object} Replacement and resulting selection offsets.
     * @throws {Error} Unknown formatting identifier.
     */
    static formatEdit(text, from, to, kind) {
      if (!Object.hasOwn(WRAPS, kind)) throw new Error('Unknown formatting command: ' + kind);
      return wrapEdit(text, from, to, WRAPS[kind]);
    }
    constructor(o) {
      this.#sourceSession = o.sourceSession || null;
      this.o = o; // {api, base, doc, colors, token, author, message, action, onPromoted, onReview}
      this.root = h('div', { class: 'ws' });
      this.tabs = [];
      this.paperTexts = new Map();
      this.paperRun = 0;
      this.file = null;
      this.selected = null; // {type: 'note' | 'change', id}
      this.reviewTab = 'comments';
      this.showResolved = false;
      this.showAccepted = false;
      this.reviewOpen = store.get('review', 'true') === 'true';
      this.newNote = null;
      this.cmMarks = [];
      this.sourceAnchors = new Map(); // invisible native-file markers survive presentation changes
      this.wMarks = []; // writing marks in the source (only while the Writing tab is open)
      this.wResult = null;
      const defaults = window.WritingCheck ? WritingCheck.RULES.filter((r) => r.on).map((r) => r.id).join(',') : '';
      this.wOn = new Set(store.get('wrules', defaults).split(',').filter(Boolean));
      this.marks = [];
      this.marksRun = 0;
      this.previewFailed = null;
      this.destroyed = false;
      this.lastBuild = null;
      // Hide images: off when the workspace opens. noFig = last figure-free build ({ok, pages, removed, …}).
      this.hideImages = false;
      this.noFig = null;
      this.noFigBuilding = false;
      this.noFigRun = 0;
      this.pagesWithFigures = null; // page count of the draft PDF (with figures)
      this.activeFilePreview = null;
      this.pdfMode = 'draft'; // 'draft', 'no-figures' or 'active-file': which PDF the pane shows
      this.history = []; // undo entries for PDF tool actions: {label, undo, redo}
      this.future = [];
      this.pendingMark = null;
    }
    /** Read current build execution without exposing controller storage.
     * @param {void} none. @pre Workspace exists. @post No mutation.
     * @return {Promise|null} In-flight build. @throws {void} None.
     */
    get compiling() { return buildControllers.get(this)?.pending || null; }
    /** Read current build target. @param {void} none. @pre Workspace exists.
     * @post Detached immutable metadata returned. @return {object|null} Target.
     * @throws {void} None.
     */
    get buildTarget() { return buildControllers.get(this)?.target || null; }
    /** Read pending persistence without exposing the native buffer/revision store.
     * @param {void} none. @pre Workspace exists. @post No mutation.
     * @return {Promise|null} Queued save. @throws {void} None.
     */
    get saving() { return sourceBuffers.get(this)?.pending || null; }
    /** Read legacy buffer-map membership as a detached snapshot of public adapters.
     * @param {void} none. @pre Workspace initialized. @post Native documents and map storage remain private.
     * @return {Map} Snapshot; mutating it cannot add/remove a workspace buffer. @throws {Error} Initialization failure.
     */
    get files() { return buffersFor(this).snapshotMap(); }
    /** Obtain the source owner through its public operations, without native documents/map storage.
     * @param {void} none. @pre Workspace initialized.
     * @post No mutation. @return {SourceBuffers} Buffer service. @throws {Error} Initialization failure.
     */
    getSourceBuffers() { return buffersFor(this); }
    /** Read review state through its public value interface. @param {void} none.
     * @pre Model available. @post No mutable storage exposed. @return {*} Current value. @throws {Error} Model failure.
     */
    get selected() { return reviewFor(this).selected; }
    /** Change review state through a semantic model operation. @param {*} value New value.
     * @pre Trusted UI action. @post Model updated. @return {void} Nothing. @throws {Error} Invalid value.
     */
    set selected(value) { reviewFor(this).selected=value; }
    /** Read review state through its public value interface. @param {void} none.
     * @pre Model available. @post No mutable storage exposed. @return {*} Current value. @throws {Error} Model failure.
     */
    get reviewTab() { return reviewFor(this).tab; }
    /** Change review state through a semantic model operation. @param {*} value New value.
     * @pre Trusted UI action. @post Model updated. @return {void} Nothing. @throws {Error} Invalid value.
     */
    set reviewTab(value) { reviewFor(this).tab=value; }
    /** Read review state through its public value interface. @param {void} none.
     * @pre Model available. @post No mutable storage exposed. @return {*} Current value. @throws {Error} Model failure.
     */
    get showResolved() { return reviewFor(this).resolved; }
    /** Change review state through a semantic model operation. @param {*} value New value.
     * @pre Trusted UI action. @post Model updated. @return {void} Nothing. @throws {Error} Invalid value.
     */
    set showResolved(value) { reviewFor(this).resolved=value; }
    /** Read review state through its public value interface. @param {void} none.
     * @pre Model available. @post No mutable storage exposed. @return {*} Current value. @throws {Error} Model failure.
     */
    get showAccepted() { return reviewFor(this).accepted; }
    /** Change review state through a semantic model operation. @param {*} value New value.
     * @pre Trusted UI action. @post Model updated. @return {void} Nothing. @throws {Error} Invalid value.
     */
    set showAccepted(value) { reviewFor(this).accepted=value; }
    /** Read review state through its public value interface. @param {void} none.
     * @pre Model available. @post No mutable storage exposed. @return {*} Current value. @throws {Error} Model failure.
     */
    get reviewOpen() { return reviewFor(this).open; }
    /** Change review state through a semantic model operation. @param {*} value New value.
     * @pre Trusted UI action. @post Model updated. @return {void} Nothing. @throws {Error} Invalid value.
     */
    set reviewOpen(value) { reviewFor(this).open=value; }
    /** Read an immutable composition snapshot. @param {void} none. @pre Model available.
     * @post No draft storage exposed. @return {object|null} Values. @throws {Error} Model failure.
     */
    get newNote() { return reviewFor(this).note; }
    /** Begin/cancel composition. @param {object|null} value Source target and draft.
     * @pre Trusted UI action. @post Model copies values. @return {void} Nothing. @throws {Error} Invalid values.
     */
    set newNote(value) { reviewFor(this).begin(value); }
    /** Read detached legacy reply membership. @param {void} none. @pre Model available.
     * @post Map mutation cannot change drafts. @return {Map} Snapshot. @throws {Error} Model failure.
     */
    get replyDrafts() { return reviewFor(this).replies(); }
    /** Check pending composition before external polling. @param {void} none. @pre Model available.
     * @post No editor/reply-map internals exposed. @return {boolean} Unsaved review work. @throws {Error} Model failure.
     */
    hasPendingReviewEdits() { return reviewFor(this).pending; }
    #sourceSession;
    api(path, opts) { return this.#sourceSession ? this.#sourceSession.request(path, opts) : this.o.api(this.o.base + path, opts); }
    /** Identify the independent source root for project navigation.
     * @param {void} none. @pre Workspace exists. @post No state changes.
     * @return {null} Project-relative source identity. @throws {void} None.
     */
    get sourceDocument() { return null; }
    /** Renew source transport after the project session changes.
     * @param {string} base Project API route. @pre Same project root.
     * @post Source buffers and histories survive. @return {void} Nothing. @throws {void} None.
     */
    reconnect(base) { this.#sourceSession?.reconnect(base); }

    say(text, err) { if (!this.destroyed) this.o.message(text, err); }
    get unsaved() { return buffersFor(this).unsaved; }
    get entire() { return this.sourceMode?.value === 'entire'; }
    get sourceLabel() { return this.entire ? 'Entire paper' : this.file; }

    /** Attach shared controls and measure the visible workspace on its first frame.
     * @param {object} options Optional headerSlot for document-level layout Tools.
     * @pre The caller has attached root to the visible viewer after saving the prior editor.
     * @post Existing source/PDF panes are measured; layout controls occupy the shared header.
     * No buffers, selection, undo history or document state are replaced.
     * @return {Promise<void>} Resolves after layout; safe if the workspace closes meanwhile.
     * @throws {Error} Header or layout failures propagate to the navigation boundary.
     */
    async mount({ headerSlot = this.o.headerSlot } = {}) {
      if (this.destroyed) return;
      if (headerSlot && this.headerTools) {
        this.o.headerSlot = headerSlot;
        headerSlot.replaceChildren(this.headerTools);
      }
      await new Promise((resolve, reject) => requestAnimationFrame(() => {
        try {
          if (!this.destroyed) { this.layout(); this.pdf?.relayout(); }
          resolve();
        } catch (error) { reject(error); }
      }));
    }

    // Open a linked workspace and restore its source view after loading the first file.
    // Requires API/status and shell controls; leaves editable buffers intact. API/build errors
    // propagate to the caller. setSourceMode loads all backing buffers for the paper view.
    async open(status) {
      this.status = status || await this.api('');
      if (!this.status.linked && !this.status.source_only) return this.renderLink();
      this.renderShell();
      const first = this.status.selected || (this.status.files.includes(this.status.main) ? this.status.main : this.status.files[0]);
      if (first) await this.openFile(first);
      await this.refreshPaper();
      await this.setSourceMode('files');
      this.loadCitations();
      this.readingOrder().then((o) => { this.fileOrder = o; }).catch(() => {});
      if (this.status.draft_pdf) await this.loadPdf();
      else if (!this.status.source_only) await this.compile();
    }

    async destroy() {
      this.destroyed = true;
      this.spelling?.dispose();
      citationPopups.get(this)?.dispose();
      buildControllers.get(this)?.dispose();
      sourceBuffers.get(this)?.dispose();
      reviewStates.get(this)?.dispose();
      for (const toolbar of [...(this.toolbars || []), ...this.#fileToolbars]) toolbar.dispose?.();
      this.#fileToolbars = [];
      this.bibDiagnostics?.dispose();
      this.clearBibliographyDiagnostics();
      this.closeTabMenu();
      clearTimeout(this.paperTimer);
      clearTimeout(this.liveTimer);
      this.formatObs?.disconnect();
      this.cleanupCompileMenu?.();
      if (this.compileMenu?.matches(':popover-open')) this.compileMenu.hidePopover();
      if (this.onOutside) document.removeEventListener('pointerdown', this.onOutside);
      await this.pdf?.destroy();
      this.pdf = null;
    }

    // ------------------------------------------------------------ link form
    renderLink() {
      const s = this.status;
      const root = h('input', { id: 'draftRoot', value: s.root || '..', autocomplete: 'off' });
      const main = h('input', { id: 'draftMain', value: s.main || 'main.tex', autocomplete: 'off' });
      const commit = h('input', { id: 'draftCommit', value: s.source_commit || '', placeholder: 'e.g. c1e375f', autocomplete: 'off' });
      const form = h('form', { class: 'draft-link', submitTool: { id: 'workspace.link-source', label: 'Link source', showText: true, execute: () => this.o.action(async () => {
        const status = await this.api('/link', { method: 'POST', body: JSON.stringify({ root: root.value, main: main.value, commit: commit.value }) });
        this.say('LaTeX source linked. Edits are compared with the commit of V' + status.base_number + '.');
        await this.open(status);
      }) } },
        h('h3', { text: 'Link the LaTeX source' }),
        s.error ? h('p', { class: 'draft-error', text: s.error }) : null,
        h('p', { text: `The workspace compares the working tree with the commit that V${s.base_number} was built from. Versions saved from the workspace record their commit automatically.` }),
        h('label', { for: 'draftRoot', text: 'Source folder (absolute, or relative to the review library)' }), root,
        h('label', { for: 'draftMain', text: 'Main file' }), main,
        h('label', { for: 'draftCommit', text: `Commit of V${s.base_number}` }), commit,
        h('div', { class: 'dialog-actions' }, h('button', { type: 'button', tool: { id: 'workspace.cancel-link', label: 'Cancel linking', showText: true, execute: () => this.o.onReview() }, text: 'Cancel' }), h('button', { class: 'primary', text: 'Link source' })));
      this.root.replaceChildren(form);
      root.focus();
    }

    // ------------------------------------------------------------ layout
    /** Build the compile action's native overflow menu.
     * @param {void} none No arguments.
     * @pre Recompile button and shared icon catalog are initialized.
     * @post One joined control and its keyboard-accessible top-layer menu are created.
     * @return {HTMLElement} Compile controls retained across PDF reloads.
     * @throws {Error} DOM initialization failure; workspace mounting handles it.
     */
    compileOptions() {
      const id = `ws-compile-options-${++compileMenuId}`;
      this.activeCompileBtn = h('button', { type: 'button', text: 'Compile active file',
        tool: { id: 'workspace.compile-active', label: 'Compile active file', showText: true, execute: () => { this.compileMenu.hidePopover(); this.o.action(() => this.compileActiveFile()); }  }});
      // A native popover enters the top layer, escaping the horizontally scrolling header.
      // Its native invoker handles keyboard activation, Escape, outside clicks and focus return.
      this.compileMenu = h('div', { id, class: 'ws-compile-options', popover: 'auto' }, this.activeCompileBtn);
      const chevron = h('span', { class: 'ws-compile-chevron', 'aria-hidden': 'true' });
      chevron.innerHTML = ICONS.chevronDown;
      this.compileArrow = h('button', { type: 'button', class: 'ws-recompile ws-compile-arrow',
        title: 'More compile options', 'aria-label': 'More compile options', 'aria-expanded': 'false',
        'aria-controls': id, popovertarget: id }, chevron);
      const position = () => {
        if (!this.compileMenu.matches(':popover-open')) return;
        const anchor = controls.getBoundingClientRect();
        this.compileMenu.style.width = `${Math.min(anchor.width, window.innerWidth - 16)}px`;
        const menu = this.compileMenu.getBoundingClientRect();
        this.compileMenu.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - menu.width - 8))}px`;
        this.compileMenu.style.top = `${Math.max(8, Math.min(anchor.bottom - 1, window.innerHeight - menu.height - 8))}px`;
      };
      this.cleanupCompileMenu = () => {
        window.removeEventListener('resize', position);
        document.removeEventListener('scroll', position, true);
      };
      this.compileMenu.addEventListener('beforetoggle', (e) => {
        this.compileArrow.setAttribute('aria-expanded', String(e.newState === 'open'));
        controls.setAttribute('data-open', String(e.newState === 'open'));
        if (e.newState === 'closed') this.cleanupCompileMenu();
      });
      this.compileMenu.addEventListener('toggle', () => {
        if (!this.compileMenu.matches(':popover-open')) return;
        position();
        window.addEventListener('resize', position);
        document.addEventListener('scroll', position, true);
        if (this.compileArrow.matches(':focus-visible')) this.activeCompileBtn.focus();
      });
      const controls = h('div', { class: 'ws-compile-controls' }, this.recompileBtn, this.compileArrow, this.compileMenu);
      return controls;
    }

    /** Compose view-owned pane bars from registered tools.
     * @param {void} none No arguments.
     * @pre Workspace controls, file tabs and status bar are initialized.
     * @post Review controls are mounted in the footer, build controls in the stable PDF header,
     * and source tools beneath the file strip. Controls survive PDF reloads and view switches.
     * @return {HTMLElement} Source header containing file tabs and source tools only.
     * @throws {Error|TypeError} Tool registration, creation or capability failures propagate to open().
     */
    createPaneBars() {
      const context = { owner: this, view: this.view, publicContext: this.getToolCapabilities(), keyTarget: this.root };
      this.toolbars = [
        window.EditorTools.registry.mount('workspace.actions', context, 'Comments and changes'),
        window.EditorTools.registry.mount('workspace.build', context, 'Build PDF'),
        window.EditorTools.registry.mount('workspace.source', context, 'Source tools'),
      ];
      const [actions, build, source] = this.toolbars;
      source.element.classList.add('ws-source-tools');
      this.formatObs?.observe(source.element);
      build.element.classList.add('ws-pdf-build');
      actions.element.classList.add('ws-review-actions');
      this.statusBar.prepend(actions.element);
      this.previewHeader = h('div', { class: 'ws-preview-header' },
        h('span', { class: 'ws-preview-title', text: 'PDF preview' }), build.element);
      this.#fileToolHost = h('div', { class: 'ws-file-tools' });
      source.element.append(this.#fileToolHost);
      this.refreshFileToolbars();
      return h('div', { class: 'ws-source-header' },
        h('div', { class: 'ws-file-strip' }, this.tabBar),
        h('div', { class: 'ws-left-top' }, source.element));
    }
    #fileToolHost;
    #fileToolbars = [];
    #fileToolType;
    /** Compose additional filetype-owned toolbars without changing the shell.
     * @param {void} none No arguments. @pre Source header is initialized.
     * @post Current provider's contributions are mounted; previous contributions are disposed.
     * @return {void} Nothing. @throws {Error} Provider/tool creation or refresh failure.
     */
    refreshFileToolbars() {
      if (!this.#fileToolHost) return;
      const provider = window.FileTypes?.registry.resolve(this.entire ? this.status?.main : this.file || this.status?.main);
      const context = { owner: this, view: this.view, fileType: provider?.id, publicContext: this.getToolCapabilities(), keyTarget: this.root };
      if (provider?.id !== this.#fileToolType) {
        for (const toolbar of this.#fileToolbars) toolbar.dispose();
        this.#fileToolHost.replaceChildren();
        this.#fileToolbars = (provider?.toolbarAreas || []).filter(area => area !== 'workspace.source').map(area => window.EditorTools.registry.mount(area, context, provider.label + ' tools'));
        for (const toolbar of this.#fileToolbars) this.#fileToolHost.append(toolbar.element);
        this.#fileToolType = provider?.id;
      }
      for (const toolbar of this.#fileToolbars) toolbar.refresh(context);
    }

    renderShell() {
      this.tabBar = h('div', { class: 'ws-tabs', role: 'tablist', 'aria-label': 'Open files' });
      this.filePick = h('select', { class: 'ws-files', 'aria-label': 'Open a file', title: 'Open a file', onchange: () => {
        const f = this.filePick.value; this.filePick.value = '';
        if (f) this.o.action(() => this.openFile(f));
      } });
      const recompileIcon = h('span', { class: 'ws-recompile-icon', 'aria-hidden': 'true' });
      recompileIcon.innerHTML = ICONS.refresh;
      this.recompileBtn = h('button', { class: 'ws-recompile', 'aria-label': 'Recompile', title: 'Save all files and recompile (⌘/Ctrl+Enter)', tool: { id: 'workspace.compile', label: 'Recompile', showText: true, execute: () => this.compile()  }},
        recompileIcon, this.recompileLabel = h('span', { text: 'Recompile' }));
      this.compileControls = this.compileOptions();
      this.buildInfo = h('button', { class: 'ws-build', 'aria-live': 'polite', title: 'Show the build log', tool: { id: 'workspace.toggle-log', label: 'Show build log', showText: true, execute: () => this.toggleLog()  }});
      // Live: save and recompile after a pause in typing. Never commits.
      this.live = store.get('live', 'true') === 'true';
      const liveBox = h('input', { type: 'checkbox', checked: this.live || null, onchange: (e) => { this.live = e.target.checked; store.set('live', this.live); this.renderBuild(); if (this.live) this.scheduleLive(); } });
      this.liveToggle = h('label', { class: 'ws-live', title: 'Save and recompile automatically about 2 seconds after you stop typing. Nothing is committed.' }, liveBox, ' Live');
      this.promoteBtn = h('button', { class: 'ws-promote', tool: { id: 'workspace.save-version', label: 'Save as version', showText: true, execute: ({ event: event }) => { event.currentTarget.closest('dialog')?.close(); this.o.action(() => this.promote()); }  }});
      this.reviewBtn = h('button', { class: 'ws-toggle' + (this.reviewOpen ? ' on' : ''), 'aria-pressed': String(this.reviewOpen), title: 'Show or hide comments and changes',
        tool: { id: 'workspace.toggle-comments', label: 'Comments', showText: true, execute: () => { this.reviewOpen = !this.reviewOpen; store.set('review', this.reviewOpen); if (this.reviewOpen && this.view === 'pdf') this.setView('both'); this.layout(); }  }});
      // Changes: show or hide the change marks in the source and on the PDF, to read without them. The list is unaffected.
      this.showChanges = store.get('changes', 'true') === 'true';
      this.changesBtn = h('button', { class: 'ws-toggle' + (this.showChanges ? ' on' : ''), 'aria-pressed': String(this.showChanges), text: 'Changes',
        title: 'Show or hide the change marks in the source and on the PDF (the Changes list stays)',
        tool: { id: 'workspace.toggle-changes', label: 'Changes', showText: true, execute: () => {
          this.showChanges = !this.showChanges; store.set('changes', this.showChanges);
          this.changesBtn.classList.toggle('on', this.showChanges); this.changesBtn.setAttribute('aria-pressed', String(this.showChanges));
          this.applyMarks(); this.placeMarks();
        }  }});
      // Which panes show: source, PDF or both side by side.
      this.view = this.status.source_only ? 'both' : (['both', 'source', 'pdf'].includes(store.get('view', 'both')) ? store.get('view', 'both') : 'both');
      const viewBtn = (v, label, title) => h('button', { 'data-view': v, title, text: label, tool: { id: 'workspace.change-view', label: label, showText: true, execute: () => this.setView(v)  }});
      this.viewSwitch = h('div', { class: 'ws-view', role: 'group', 'aria-label': 'Layout' },
        viewBtn('source', 'Source', 'Show only the LaTeX source'), viewBtn('both', 'Both', 'Show source and PDF side by side'), viewBtn('pdf', 'PDF', 'Show only the PDF'));
      // The document header selects views; each pane owns its commands.
      // Word count of the open file, or of the selection (updateWordCount).
      this.headerCount = h('span', { class: 'ws-wordcount', role: 'status' });
      this.headerTools = h('div', { class: 'ws-header-tools' }, this.viewSwitch);
      this.saveStatus = h('span', { class: 'ws-save-status', role: 'status', text: 'All changes saved' });
      this.pdfStatus = h('span', { class: 'ws-pdf-status' });
      this.statusBar = h('footer', { class: 'ws-statusbar' }, this.saveStatus, this.headerCount, this.pdfStatus, this.buildInfo, this.liveToggle);
      this.sourceMode = h('button', { type: 'button', class: 'ws-source-mode ws-toggle', value: 'files',
        text: 'Entire paper', 'aria-pressed': 'false',
        title: 'Edit the entire paper with inputs expanded, linked comments and whole-paper writing scores',
        tool: { id: 'workspace.source-mode', label: 'Entire paper', showText: true, execute: () => this.o.action(() => this.setSourceMode(this.entire ? 'files' : 'entire'))  }});
      this.formatControls = this.formatBar();
      this.commentBtn = this.commentButton();
      this.referencesBtn = h('button', { class: 'ws-tool ws-references', 'aria-label': 'Reference check', title: 'Check a linked bibliography entry against OpenAlex', tool: { id: 'workspace.references', label: 'Reference check', showText: true, execute: () => this.o.action(() => window.openBibliography(this))  }});
      this.referencesBtn.innerHTML = ICONS.cite + '<span class="ws-references-label">Reference check</span>';
      const sourceHeader = this.createPaneBars();

      this.editorHost = h('div', { class: 'ws-editor' });
      this.editorHost.addEventListener('pointerdown', (e) => { if (this.srcComment && !this.srcComment.contains(e.target)) this.srcComment.hidden = true; });
      this.review = h('aside', { class: 'ws-review', 'aria-label': 'Comments and changes' });
      this.sourceColumn = h('div', { class: 'ws-source-column' }, sourceHeader, this.editorHost);
      this.leftBody = h('div', { class: 'ws-left-body' }, this.sourceColumn, this.review);
      this.left = h('div', { class: 'ws-left' }, this.leftBody);
      this.split = h('div', { class: 'ws-split', role: 'separator', 'aria-orientation': 'vertical', title: 'Drag to resize' },
        h('button', { class: 'ws-sync', title: 'Show the cursor position in the PDF', 'aria-label': 'Go to PDF location', tool: { id: 'workspace.source-to-pdf', label: 'Go to PDF location', showText: true, execute: () => this.o.action(() => this.sourceToPdf()) }, text: '→' }),
        h('button', { class: 'ws-sync', title: 'Show the PDF position (selection or page center) in the source', 'aria-label': 'Go to source location', tool: { id: 'workspace.pdf-to-source', label: 'Go to source location', showText: true, execute: () => this.o.action(() => this.pdfToSource()) }, text: '←' }));
      this.pdfPane = h('div', { class: 'ws-pdf' }, h('div', { class: 'empty', text: 'No PDF yet. Click Recompile.' }));
      this.noFigBar = this.noFigControls();
      this.log = h('div', { class: 'ws-log', hidden: true });
      this.right = h('div', { class: 'ws-right' }, this.previewHeader, this.pdfPane);
      // Source: the same selection menu as on the PDF (highlight colors, Remove, Replace, Comment).
      const menuBtn = (attrs, act) => h('button', { ...attrs, onpointerdown: (e) => e.preventDefault(),
        tool: { id: 'workspace.selection-action', label: attrs['aria-label'] || attrs.title || attrs.text || 'Mark selected text', showText: true, execute: () => { this.srcComment.hidden = true; this.o.action(act); }  }});
      this.srcComment = h('div', { class: 'pdfa-selmenu ws-src-menu', hidden: true, role: 'toolbar', 'aria-label': 'Mark the selected text' },
        h('span', { class: 'pdfa-selhint', text: 'Highlight as' }),
        ...(this.o.colors?.highlight_colors || []).map((c) => menuBtn({ class: 'pdfa-swatch hl', title: c.label, 'aria-label': `Highlight ${c.label}`, style: `--c:${c.hex}` },
          () => this.markFromSource({ type: 'highlight', color: c.id }))),
        menuBtn({ class: 'pdfa-btn pdfa-remove-text', text: 'Remove text', title: 'Mark the selected text as a suggested removal' },
          () => this.markFromSource({ type: 'strikethrough' })),
        menuBtn({ class: 'pdfa-btn', text: 'Replace text', title: 'Strike through the selected text and enter a replacement' },
          () => this.commentFromSource({ type: 'strikethrough', intent: 'replace' })),
        menuBtn({ class: 'pdfa-btn', text: '💬 Comment', title: 'Highlight in the current color and add a comment (⌘/Ctrl+Alt+M)' },
          () => this.commentFromSource()));
      this.main = h('div', { class: 'ws-main' }, this.left, this.split, this.right);
      this.root.replaceChildren(this.main, this.statusBar, this.log);
      // Detached candidates keep controls locally until mount() commits navigation.
      this.root.prepend(this.headerTools);
      this.bindSplit();

      const saveSource = new window.EditorTools.Tool({ id: 'workspace.save-source', label: 'Save source', showText: true, execute: () => this.run(() => this.save()) });
      const completeCitation = new window.EditorTools.Tool({ id: 'workspace.complete-citation', label: 'Search linked citations', showText: true, execute: () => this.updateCitePop(true) });
      this.cm = CodeMirror(this.editorHost, {
        mode: 'stex', lineNumbers: true, lineWrapping: true, gutters: ['ws-gutter', 'CodeMirror-linenumbers'],
        viewportMargin: 30, spellcheck: false, inputStyle: 'contenteditable',
        extraKeys: {
          'Cmd-S': () => saveSource.invoke(), 'Ctrl-S': () => saveSource.invoke(),
          'Cmd-Enter': () => window.EditorTools.Tool.activate(this.recompileBtn), 'Ctrl-Enter': () => window.EditorTools.Tool.activate(this.recompileBtn),
          'Cmd-Alt-M': () => window.EditorTools.Tool.activate(this.commentBtn), 'Ctrl-Alt-M': () => window.EditorTools.Tool.activate(this.commentBtn),
          ...Object.fromEntries(window.EditorTools.sourceCommands.list().filter(command => command.key).flatMap(command =>
            ['Cmd-', 'Ctrl-'].map(prefix => [prefix + command.key, () => this.runToolbarCommand(() => window.EditorTools.sourceCommands.execute(command.id, this))]))),
          'Ctrl-Space': () => completeCitation.invoke(),
          'Shift-Alt-F': () => window.EditorTools.registry.execute('workspace.source', 'source.format-file', { owner: this }),
        },
      });
      this.spelling = window.Spelling?.attach(this.cm, {file:() => this.entire ? 'paper.tex' : this.file});
      this.editorHost.append(this.srcComment);
      this.entireInfo = h('div', { class: 'ws-entire-info', role: 'status', hidden: true });
      this.left.insertBefore(this.entireInfo, this.leftBody);
      this.cm.on('beforeChange', (_cm, change) => this.checkPaperEdit(change));
      this.cm.on('change', (_cm, change) => this.applyPaperEdit(change));
      this.cm.on('changes', () => {
        if (this.projecting) return;
        this.pendingPaperSource = null;
        this.renderTabs(); this.scheduleLive(); this.scheduleWriting(); this.scheduleCiteMarks(); this.schedulePaper();
        this.bibDiagnostics?.schedule();
      });
      citationPopupFor(this);
      this.cm.on('scroll', () => { this.srcComment.hidden = true; });
      this.editorHost.addEventListener('mouseup', () => setTimeout(() => this.placeSrcComment(), 0));
      this.editorHost.addEventListener('keyup', (e) => { if (e.shiftKey) this.placeSrcComment(); });
      this.cm.on('cursorActivity', () => { this.onCursor(); this.updateWordCount(); });
      this.cm.on('gutterClick', (cm, line, gutter) => {
        if (gutter !== 'ws-gutter') return;
        const mark = this.cmMarks.find((m) => m.wsItem?.type === 'note' && (m.find()?.from || m.find())?.line === line);
        if (mark) this.select('note', mark.wsItem.id, { source: false, pdf: true });
      });
      this.bibDiagnostics?.dispose();
      this.bibDiagnostics = window.BibliographyDiagnostics ? new window.BibliographyDiagnostics(this) : null;
      if (this.status.source_only) {
        this.reviewOpen = false;
        for (const control of [this.reviewBtn, this.changesBtn, this.commentBtn, ...this.split.querySelectorAll('button')]) {
          control.disabled = true;
          control.title = 'Available after compilation links a source review baseline.';
        }
      }
      this.layout();
      this.renderTop();
      this.renderReview();
    }

    layout() {
      const ratio = Math.min(0.75, Math.max(0.25, +store.get('split', 0.5)));
      const v = this.view;
      if (v === 'source' && this.compileMenu?.matches(':popover-open')) this.compileMenu.hidePopover();
      this.left.hidden = v === 'pdf';
      this.split.hidden = v !== 'both';
      this.right.hidden = v === 'source';
      this.main.style.gridTemplateColumns = v === 'both' ? `minmax(0, ${ratio}fr) 22px minmax(0, ${1 - ratio}fr)` : 'minmax(0, 1fr)';
      for (const b of this.viewSwitch.children) { b.classList.toggle('on', b.dataset.view === v); b.setAttribute('aria-pressed', String(b.dataset.view === v)); }
      if (this.headerCount) this.headerCount.hidden = v === 'pdf';
      for (const toolbar of this.toolbars || []) toolbar.refresh({ owner: this, view: v, publicContext: this.getToolCapabilities() });
      this.refreshFileToolbars();
      this.leftBody.classList.toggle('with-review', this.reviewOpen);
      this.reviewBtn.classList.toggle('on', this.reviewOpen);
      this.reviewBtn.setAttribute('aria-pressed', String(this.reviewOpen));
      this.cm?.refresh();
      if (this.cm) { if (this.writingActive()) this.runWriting(); else this.clearWriting(); }
      this.fitFormat?.();
    }

    setView(v) {
      if (!['source', 'both', 'pdf'].includes(v) || v === this.view) return;
      this.view = v; store.set('view', v);
      if (v === 'pdf' && this.srcComment) this.srcComment.hidden = true;
      this.layout();
      if (v !== 'source') requestAnimationFrame(() => this.pdf?.relayout());
    }

    bindSplit() {
      this.split.addEventListener('pointerdown', (e) => {
        if (e.target.closest('button')) return;
        e.preventDefault();
        const box = this.main.getBoundingClientRect();
        const move = (ev) => { store.set('split', Math.min(0.75, Math.max(0.25, (ev.clientX - box.left) / box.width))); this.layout(); };
        const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); this.pdf?.relayout(); };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      });
    }

    renderTop() {
      const nOpen = this.visibleNotes(false).length;
      this.reviewBtn.textContent = `Comments · ${nOpen}`;
      const nCite = this.citeProblems().length;
      if (nCite) this.reviewBtn.append(h('span', { class: 'ws-review-warn', text: ` ⚠ ${nCite}` }));
      this.reviewBtn.title = nCite ? `Show or hide comments and changes. ${nCite} citation problem(s): empty \\cite{} or keys not in ${this.bibName()}.` : 'Show or hide comments and changes';
      this.renderVersionAction();
      this.filePick.replaceChildren(h('option', { value: '', text: 'Files…' }), ...this.status.files.map((f) => h('option', { value: f, text: f })));
      this.renderBuild();
      this.renderTabs();
    }

    /** Refresh the version drawer's shared action. Pre: workspace status; post: current label and guards.
     * Reuses one control so pending saves/builds update it even while the drawer is open. */
    renderVersionAction() {
      if (!this.promoteBtn) return;
      const changed = !!this.status.changes?.length;
      this.promoteBtn.textContent = `Save as V${this.status.base_number + 1}…`;
      this.promoteBtn.disabled = !!this.status.source_only || !!this.buildTarget || this.unsaved || !changed;
      this.promoteBtn.title = this.unsaved ? 'Save source edits first (Cmd/Ctrl+S)'
        : changed ? 'Commit changed source files, build the commit and save the next version'
        : `No changes against V${this.status.base_number} yet`;
    }

    renderBuild() {
      if (!this.recompileBtn) return;
      const busy = !!this.buildTarget;
      const b = this.lastBuild || this.status.builds?.[this.status.builds.length - 1];
      this.recompileBtn.disabled = busy;
      this.recompileBtn.setAttribute('aria-busy', String(busy));
      if (this.recompileLabel) this.recompileLabel.textContent = busy ? 'Recompiling…' : 'Recompile';
      if (this.compileArrow) this.compileArrow.disabled = busy || !!this.status.source_only;
      this.renderVersionAction();
      if (this.previewReturnBtn) this.previewReturnBtn.disabled = busy;
      if (this.noFigBtn) this.noFigBtn.disabled = busy || !!this.status.source_only;
      if (this.activeCompileBtn) {
        this.activeCompileBtn.disabled = busy || !!this.status.source_only || !this.file?.endsWith('.tex') || this.sourceMode?.value === 'entire';
        this.activeCompileBtn.title = this.file ? `Build ${this.file} as a standalone document` : 'Open a .tex file first';
      }
      this.recompileBtn.classList.toggle('running', busy);
      this.renderPreviewStatus();
      if (busy) {
        this.buildInfo.textContent = `Compiling ${this.buildTarget.file || 'paper'}…`;
        this.buildInfo.className = 'ws-build'; return;
      }
      if (!b) { this.buildInfo.textContent = ''; return; }
      const n = b.errors?.length || 0;
      this.buildInfo.className = 'ws-build' + (b.ok ? '' : ' err');
      this.buildInfo.textContent = b.ok ? `${b.file ? 'Preview compiled' : 'Compiled'} ${new Date(b.at * 1000).toLocaleTimeString()}` : `${n || 'Build'} error${n === 1 ? '' : 's'}`;
    }

    renderPreviewStatus() {
      if (!this.previewInfo || !this.activeFilePreview) return;
      const file = this.activeFilePreview.file;
      const state = this.buildTarget?.file === file ? 'Recompiling…'
        : this.previewFailed?.file === file ? 'Update failed · showing previous PDF'
        : this.live ? 'Live preview' : 'Compile active file to refresh';
      this.previewInfo.textContent = `${file} · ${state}`;
    }

    /** Refresh the source file strip and dependent toolbar state.
     * @param {void} none No arguments.
     * @pre Source buffers and tab names are initialized.
     * @post Tabs retain opening order; pin/close controls and save/format state refresh.
     * @return {void} Nothing; an unmounted tab strip is ignored.
     * @throws {Error} Icon or DOM failures propagate to the owning workspace operation.
     */
    renderTabs() {
      if (!this.tabBar) return;
      const ordered = this.tabs;
      this.tabBar.replaceChildren(...ordered.map((f) => {
        const entry = this.files.get(f);
        const dirty = entry && entry.doc.getValue() !== entry.saved;
        const pinned = this.isTabPinned(f);
        const pin = h('button', { class: 'ws-tab-pin', 'aria-label': (pinned ? 'Unpin ' : 'Pin ') + f,
          'aria-pressed': String(pinned), title: pinned ? 'Unpin tab' : 'Pin tab',
          tool: { id: 'workspace.pin-tab', label: 'Pin or unpin tab', showText: true, execute: () => this.setTabPinned(f, !pinned)  }});
        pin.innerHTML = ICONS.pin;
        const close = h('button', { class: 'ws-tab-close', 'aria-label': 'Close ' + f, tool: { id: 'workspace.close-tab', label: 'Close source file', showText: true, execute: () => this.run(() => this.closeTab(f))  }});
        close.innerHTML = ICONS.close;
        return h('div', { class: 'ws-tab' + (f === this.file ? ' on' : '') + (pinned ? ' pinned' : ''), role: 'tab', 'aria-selected': String(f === this.file), title: f,
          oncontextmenu: e => { e.preventDefault(); this.run(() => this.openTabMenu(f, e.clientX, e.clientY)); },
          onkeydown: e => {
            if (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) return;
            e.preventDefault(); const box = e.currentTarget.getBoundingClientRect();
            this.run(() => this.openTabMenu(f, box.left, box.bottom));
          } },
          h('button', { class: 'ws-tab-name', text: base(f) + (entry?.stale ? ' ⚠' : dirty ? ' •' : ''), title: entry?.stale ? 'Changed on disk while you have unsaved edits' : f,
            tool: { id: 'workspace.open-tab', label: 'Open ' + f, showText: true, execute: () => this.o.action(() => this.openFile(f))  }}),
          pinned ? pin : close);
      }));
      this.renderVersionAction();
      if (this.saveStatus) this.saveStatus.textContent = this.unsaved ? 'Unsaved source changes' : 'All changes saved';
      for (const toolbar of this.toolbars || []) toolbar.refresh({ owner: this, view: this.view, publicContext: this.getToolCapabilities() });
      this.refreshFileToolbars();
      this.fitFormat?.(); // tabs changed: refit the formatting toolbar
    }

    #pinnedTabs = new Set();
    #tabMenu = null;
    #tabMenuOutside = null;

    /** Read open tabs without exposing mutable storage.
     * @param {void} none No arguments. @pre Workspace initialized.
     * @post Internal tab order is unchanged. @return {string[]} Independent ordered snapshot.
     * @throws {void} None.
     */
    getOpenTabs() { return [...this.tabs]; }

    /** Check whether closing a source tab would discard edits.
     * @param {string} file Source path. @pre File is open.
     * @post State unchanged. @return {boolean} True if no unsaved edits exist.
     * @throws {Error} Buffer read failure.
     */
    isTabSaved(file) {
      const entry = this.files.get(file);
      return !entry || entry.doc.getValue() === entry.saved;
    }

    /** Dismiss the owned tab menu and remove its DOM.
     * @param {void} none No arguments. @pre None.
     * @post No owned tab menu remains. @return {void} Nothing.
     * @throws {Error} DOM removal failure.
     */
    closeTabMenu() {
      const menu = this.#tabMenu; this.#tabMenu = null;
      if (this.#tabMenuOutside) document.removeEventListener('pointerdown', this.#tabMenuOutside, true);
      this.#tabMenuOutside = null;
      if (!menu) return;
      if (menu.matches(':popover-open')) menu.hidePopover();
      menu.remove();
    }

    /** Open registered tab actions in the top layer at a pointer or keyboard anchor.
     * @param {string} file Clicked tab path. @param {number} x Viewport horizontal anchor.
     * @param {number} y Viewport vertical anchor.
     * @pre Tab is open; tool registry and browser popovers are available.
     * @post One viewport-contained menu opens without activating or moving the clicked tab.
     * @return {void} Nothing. @throws {Error} Invalid tab or DOM failure; event boundary reports it.
     */
    openTabMenu(file, x, y) {
      if (!this.tabs.includes(file)) throw new Error('Cannot open menu for a closed tab: ' + file);
      this.closeTabMenu();
      // Own dismissal so a browser's context-menu/light-dismiss sequence cannot
      // remove a menu item between its pointerdown and click events.
      const menu = h('div', { class: 'ws-tab-menu', popover: 'manual', role: 'menu', 'aria-label': 'Tab actions for ' + file });
      const tools = window.EditorTools.registry.mount('workspace.tabs', { owner: this, file, dismiss: () => this.closeTabMenu() }, 'Tab actions');
      menu.append(tools.element);
      menu.addEventListener('keydown', e => {
        const items = [...menu.querySelectorAll('button:not(:disabled)')];
        const index = items.indexOf(document.activeElement);
        let next;
        if (e.key === 'ArrowDown') next = (index + 1) % items.length;
        else if (e.key === 'ArrowUp') next = (index - 1 + items.length) % items.length;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = items.length - 1;
        else if (e.key === 'Escape') { e.preventDefault(); this.closeTabMenu(); return; }
        else if (e.key === 'Tab') { this.closeTabMenu(); return; }
        if (next !== undefined) { e.preventDefault(); items[next]?.focus(); }
      });
      menu.addEventListener('toggle', () => {
        if (menu.matches(':popover-open')) return;
        if (this.#tabMenu === menu) this.closeTabMenu(); else menu.remove();
      });
      this.root.append(menu); this.#tabMenu = menu; menu.showPopover();
      this.#tabMenuOutside = e => { if (!menu.contains(e.target)) this.closeTabMenu(); };
      document.addEventListener('pointerdown', this.#tabMenuOutside, true);
      const box = menu.getBoundingClientRect();
      menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - box.width - 8))}px`;
      menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - box.height - 8))}px`;
      menu.querySelector('button:not(:disabled)')?.focus();
    }

    /** Read a tab's close protection.
     * @param {string} file Workspace-relative file path.
     * @pre Workspace instance is initialized.
     * @post No state changes.
     * @return {boolean} Whether the tab is pinned.
     * @throws {void} None.
     */
    isTabPinned(file) { return this.#pinnedTabs.has(file); }

    /** Pin or unpin an open tab without changing its position or activation.
     * @param {string} file Workspace-relative open file path.
     * @param {boolean} pinned Desired close protection.
     * @pre File is open in this workspace.
     * @post Close protection changes and the strip refreshes; tab order is unchanged.
     * @return {void} No value.
     * @throws {Error} File is not open; DOM failures propagate to the caller.
     */
    setTabPinned(file, pinned) {
      if (!this.tabs.includes(file)) throw new Error('Cannot pin a closed tab: ' + file);
      if (pinned) this.#pinnedTabs.add(file); else this.#pinnedTabs.delete(file);
      this.renderTabs();
    }

    /** Close an unpinned tab, confirming disposal of unsaved edits.
     * @param {string} f Workspace-relative file path.
     * @pre Workspace source buffers are initialized.
     * @post Pinned tabs remain open; closing the active tab activates a neighbor without reordering.
     * @return {Promise<boolean>} Whether a tab was closed; canceled or protected closes leave state unchanged.
     * @throws {Error} Buffer or render failures propagate to the owning action.
     */
    closeTab(f) {
      return this.closeTabs([f]);
    }

    /** Close a snapshot of tabs as one operation, confirming unsaved edits before mutation.
     * @param {string[]} files Paths to close. @param {object} options includePinned explicitly closes pinned tabs.
     * @pre Source buffers and editor exist; paths may include stale entries.
     * @post Eligible tabs close in one batch; remaining order and buffers stay intact.
     * Closing all file tabs leaves an empty read-only editor. Combined source buffers remain owned.
     * @return {Promise<boolean>} True if tabs closed, false for cancellation or an empty selection.
     * @throws {Error} Buffer, render or next-file loading failures propagate to the action boundary.
     */
    async closeTabs(files, { includePinned = false } = {}) {
      if (this.saving) await this.saving;
      const selected = new Set(files);
      const closing = this.tabs.filter(f => selected.has(f) && (includePinned || !this.isTabPinned(f)));
      if (!closing.length) return false;
      const dirty = this.entire ? [] : closing.filter(f => !this.isTabSaved(f));
      if (dirty.length && !confirm(`Close without saving edits to:\n${dirty.join('\n')}?`)) return false;
      const previous = [...this.tabs], index = previous.indexOf(this.file), activeClosing = closing.includes(this.file);
      this.tabs = this.tabs.filter(f => !closing.includes(f));
      for (const f of closing) {
        this.#pinnedTabs.delete(f);
        if (this.entire) continue;
        const entry = this.files.get(f);
        if (entry) this.paperTexts.set(f, Promise.resolve(entry.saved));
        buffersFor(this).close(f);
      }
      if (!this.entire && activeClosing) {
        this.file = null;
        const next = previous.slice(index + 1).find(f => this.tabs.includes(f))
          || previous.slice(0, index).reverse().find(f => this.tabs.includes(f));
        if (next) await this.openFile(next);
        else if (this.cm) {
          this.closeCitePop();
          this.cm.swapDoc(CodeMirror.Doc('', 'stex'));
          this.cm.setOption('readOnly', true);
        }
      }
      if (!this.entire) this.schedulePaper?.();
      this.bibDiagnostics?.schedule();
      this.renderTabs();
      return true;
    }

    // ------------------------------------------------------------ source
    async openFile(file, range) {
      if (!file) return;
      if (this.#sourceSession && !this.cm) {
        await this.open(await this.#sourceSession.open(file));
        return;
      }
      if (this.#sourceSession && this.status.selected !== file) {
        const fresh = await this.#sourceSession.open(file);
        const changed = fresh.main !== this.status.main;
        if (changed) await this.saveAll();
        this.status = { ...fresh, builds: changed ? fresh.builds : this.status.builds };
        if (changed) {
          await this.pdf?.destroy(); this.pdf = null;
          this.pdfPane.replaceChildren(h('div', { class: 'empty', text: 'No PDF yet. Click Recompile.' }));
          if (fresh.draft_pdf) await this.loadPdf();
          await this.loadCitations();
        }
      }
      if (this.entire || this.sourceMode?.disabled) await this.setSourceMode('files');
      const entry = await this.ensureFile(file);
      if (!this.tabs.includes(file)) this.tabs.push(file);
      this.cm.setOption('readOnly', false);
      if (!entry.isAttached(this.cm)) { entry.attach(this.cm); this.file = file; }
      this.applyMarks();
      this.renderTabs();
      this.refreshCiteMarks();
      this.renderBuild();
      if (this.writingActive()) { this.runWriting(); this.renderReview(); }
      this.updateWordCount();
      if (range) this.reveal(range.start, range.end, range.codePoints);
      this.o.onFile?.(file);
      this.bibDiagnostics?.schedule();
    }

    // Load an editable source buffer without opening a tab. Requires a linked file path;
    // preserves native newlines and existing dirty buffers. Read errors propagate to the caller.
    async ensureFile(file) { return buffersFor(this).open(file); }

    async setSourceMode(mode) {
      mode = mode === 'entire' ? 'entire' : 'files';
      const run = this.modeRun = (this.modeRun || 0) + 1;
      if (mode === 'entire') {
        this.sourceMode.disabled = true;
        try { while (!await this.refreshPaper(true)) { if (this.destroyed || run !== this.modeRun) return; } }
        finally { this.sourceMode.disabled = false; }
        if (this.destroyed || run !== this.modeRun) return;
        if (!this.paperSource) return;
        this.updatePaperDoc();
      }
      this.sourceMode.value = mode;
      store.set('sourceMode', mode);
      const entire = mode === 'entire';
      this.sourceMode.classList.toggle('on', entire);
      this.sourceMode.setAttribute('aria-pressed', String(entire));
      this.sourceMode.title = entire ? 'Return to editing individual source files'
        : 'Edit the entire paper with inputs expanded, linked comments and whole-paper writing scores';
      this.entireInfo.hidden = !entire;
      if (entire) { if (this.paperDoc && this.cm.getDoc() !== this.paperDoc) this.cm.swapDoc(this.paperDoc); }
      else this.files.get(this.file)?.attach(this.cm);
      this.left.classList.toggle('ws-entire', entire);
      this.srcComment.hidden = true;
      this.closeCitePop();
      this.wCount = null; this.wResult = null;
      this.cm.refresh();
      this.applyMarks(); this.refreshCiteMarks();
      this.bibDiagnostics?.schedule();
      if (this.writingActive()) this.runWriting(); else this.clearWriting();
      this.renderReview();
      this.updateWordCount();
      this.fitFormat?.();
      this.renderBuild();
    }

    schedulePaper() {
      clearTimeout(this.paperTimer);
      ++this.paperRun; // invalidate an analysis that was started before this edit
      this.paperTimer = setTimeout(() => this.refreshPaper(), 250);
    }

    async refreshPaper(load = false) {
      if (!this.status?.main) return;
      const run = ++this.paperRun;
      const result = await combinedSource(this.status.main, this.status.files, async (file) => {
        const entry = load || this.entire ? await this.ensureFile(file) : this.files.get(file);
        if (entry) return entry.doc.getValue();
        if (!this.paperTexts.has(file)) this.paperTexts.set(file, this.api('/file?path=' + encodeURIComponent(file)).then((r) => r.text).catch((error) => { this.paperTexts.delete(file); throw error; }));
        return this.paperTexts.get(file);
      });
      if (this.destroyed || run !== this.paperRun) return;
      this.paperSource = result;
      this.paperCount = window.WritingCheck ? WritingCheck.countWords(WritingCheck.wordMask(result.text)) : null;
      if (this.entireInfo) this.entireInfo.textContent = 'Entire paper · Edits save to their original files.' + (result.warnings.length ? ' ' + result.warnings.join('; ') : '');
      if (this.entire) {
        this.updatePaperDoc(); this.applyMarks();
        if (this.writingActive()) { this.runWriting(); this.renderWritingBody(); }
      }
      this.updateWordCount();
      return result;
    }

    // Install a fresh projection only when its text changed outside the paper editor.
    // Requires paperSource. Ordinary edits already updated the map and keep native undo/redo;
    // external/structural changes rebuild this derived doc and clear its stale undo history.
    updatePaperDoc() {
      if (!this.paperDoc) this.paperDoc = CodeMirror.Doc(this.paperSource.text, 'stex');
      else if (this.paperDoc.getValue() !== this.paperSource.text) {
        const cursor = this.paperDoc.getCursor(), scroll = this.entire ? this.cm.getScrollInfo() : null;
        this.projecting = true;
        try { this.paperDoc.setValue(this.paperSource.text); this.paperDoc.clearHistory(); this.paperDoc.setCursor(cursor); }
        finally { this.projecting = false; }
        if (scroll) this.cm.scrollTo(scroll.left, scroll.top);
      }
    }

    // Reject edits with no unambiguous backing span before CodeMirror mutates anything.
    // Called by beforeChange; synthetic separators and repeated inputs are navigable but
    // edited through their file tab. Accepted edits, including undo/redo, use applyPaperEdit.
    checkPaperEdit(change) {
      if (this.projecting || !this.entire) return;
      try {
        const model = this.pendingPaperSource || this.paperSource;
        const edit = applyProjectionEdit(model, textOffset(model.text, change.from), textOffset(model.text, change.to), change.text.join('\n'));
        if (this.files.get(edit.file)?.doc.getValue() !== this.paperSource.sources.get(edit.file))
          throw new Error('The source is refreshing. Try this edit again when it finishes.');
        this.pendingPaperSource = edit.model;
        (this.paperEdits ||= []).push(edit);
      } catch (error) { change.cancel(); this.say(error.message, true); }
    }

    // Mirror one accepted CodeMirror change to its backing document immediately.
    // Requires checkPaperEdit to have validated the range. Never writes disk; save/saveAll
    // retain SHA conflict checks. Updating the map synchronously makes rapid edits safe.
    applyPaperEdit(change) {
      if (this.projecting || !this.entire) return;
      const edit = this.paperEdits?.shift();
      if (!edit) return;
      const entry = this.files.get(edit.file);
      entry.doc.replaceRange(edit.insert, entry.doc.posFromIndex(edit.start), entry.doc.posFromIndex(edit.end), '+paper');
      this.paperSource = edit.model;
      if (!this.paperEdits.length) this.pendingPaperSource = null;
      ++this.paperRun;
    }

    // Translate native file offsets to visible ranges, including repeated inputs.
    // Requires a loaded file; returns [] when the passage is omitted from the current view.
    displayRanges(file, start, end) {
      if (!this.entire) return file === this.file ? [{ start, end }] : [];
      const text = this.files.get(file)?.doc.getValue();
      if (text === undefined) return [];
      return projectionSpans(this.paperSource, file, normalizedSource(text.slice(0, start)).length, normalizedSource(text.slice(0, end)).length);
    }

    // Navigate to a native source range without leaving the combined view when visible.
    // Requires a linked file; falls back to its tab for omitted text. Read errors propagate.
    async revealSource(file, start, end, codePoints = true, focus = false) {
      const entry = await this.ensureFile(file), text = entry.doc.getValue();
      const a = codePoints ? cpToUnits(text, start) : start, b = codePoints ? cpToUnits(text, end) : end;
      const ranges = this.displayRanges(file, a, b);
      if (this.entire && ranges.length) return this.reveal(ranges[0].start, ranges[0].end, false, focus);
      await this.openFile(file);
      this.reveal(a, b, false, focus);
    }

    // Select a range in the open file and scroll it into the upper third.
    reveal(start, end, codePoints = true, focus = false) {
      const text = this.cm.getValue();
      const a = codePoints ? cpToUnits(text, start) : start;
      const b = codePoints ? cpToUnits(text, end) : end;
      const from = this.cm.posFromIndex(a), to = this.cm.posFromIndex(b);
      this.cm.setSelection(from, to, { scroll: false });
      const y = this.cm.charCoords(from, 'local').top;
      this.cm.scrollTo(null, Math.max(0, y - this.cm.getScrollInfo().clientHeight / 3));
      // Focus only for explicit "go to source" actions: with the PDF tools active, keys must not type into the source.
      if (focus) this.cm.focus();
    }

    async save(file) {
      if (file === undefined && this.entire) return this.saveAll();
      file ??= this.file;
      const entry = this.files.get(file);
      if (!entry) return;
      this.formatFile(file, { automatic: true });
      const r = await buffersFor(this).save(file);
      if (!r || this.destroyed) return;
      // Offsets of comments and changes now refer to the saved text.
      this.status.notes = r.notes; this.status.changes = r.changes;
      this.renderTop(); this.applyMarks(); this.renderReview();
      this.loadCitations();
    }

    async saveAll() {
      for (const f of [...this.files.keys()]) await this.save(f);
    }

    placeSrcComment() {
      if (this.status.source_only) { this.srcComment.hidden = true; return; }
      if (!this.cm.somethingSelected() || !this.cm.getSelection().trim()) { this.srcComment.hidden = true; return; }
      const end = this.cm.cursorCoords(this.cm.getCursor('to'), 'local');
      const info = this.cm.getScrollInfo();
      const host = this.editorHost.getBoundingClientRect();
      const w = this.srcComment.offsetWidth || 380;
      const x = Math.max(4, Math.min(host.width - w - 6, end.left - w / 2));
      const y = end.bottom - info.top + 6;
      if (y < 0 || y > host.height - 30) { this.srcComment.hidden = true; return; }
      this.srcComment.style.left = x + 'px';
      this.srcComment.style.top = y + 'px';
      this.srcComment.hidden = false;
    }

    onCursor() {
      if (this.srcComment && !this.cm.somethingSelected()) this.srcComment.hidden = true;
      if (this.applyingMarks) return;
      const pos = this.cm.getCursor();
      const hit = this.cm.findMarksAt(pos).map((m) => m.wsItem).find(Boolean);
      if (hit && (this.selected?.type !== hit.type || this.selected?.id !== hit.id)) this.select(hit.type, hit.id, { source: false, pdf: true });
    }

    // Accepted changes leave the list (and the source and PDF marks) unless "Show accepted" is on.
    visibleChanges(includeAccepted = this.showAccepted) {
      return (this.status.changes || []).filter((c) => includeAccepted || c.status !== 'accepted');
    }
    // Changes drawn in the source and on the PDF: none while the Changes toggle is off.
    markedChanges() {
      return this.showChanges ? this.visibleChanges() : [];
    }
    visibleNotes(includeResolved = this.showResolved) {
      return (this.status.notes || []).filter((n) => includeResolved || n.status === 'open');
    }

    // Maintain invisible anchors in native file buffers so unsaved edits move comments even
    // while another view is active. Requires status and loaded buffers; new server anchors
    // are installed only on a matching saved buffer. Removed records release their markers.
    syncSourceAnchors() {
      const records = [...(this.status.notes || []).filter((n) => n.anchor !== 'lost').map((n) => ({ ...n, key: `note-${n.id}` })),
        ...(this.status.changes || []).map((c) => ({ ...c, key: `change-${c.id}`, start: c.new_start, end: c.new_end }))];
      const keys = new Set(records.map((r) => r.key));
      for (const [key, anchor] of this.sourceAnchors) if (!keys.has(key)) { anchor.mark.clear(); this.sourceAnchors.delete(key); }
      for (const r of records) {
        const entry = this.files.get(r.file);
        if (!entry) continue;
        const anchor = this.sourceAnchors.get(r.key), signature = `${entry.sha}:${r.start}:${r.end}`;
        if (anchor?.doc === entry.doc && (anchor.signature === signature || entry.doc.getValue() !== entry.saved)) continue;
        if (entry.doc.getValue() !== entry.saved) continue;
        anchor?.mark.clear();
        const from = entry.doc.posFromIndex(cpToUnits(entry.saved, r.start)), to = entry.doc.posFromIndex(cpToUnits(entry.saved, r.end));
        this.sourceAnchors.set(r.key, { doc: entry.doc, signature, file: r.file,
          mark: entry.doc.markText(from, to, { clearWhenEmpty: false }) });
      }
    }

    // Draw comments/changes in the active editor using the current native-file anchors.
    // Requires loaded source buffers. Ranges are remapped across every visible input;
    // syncSourceAnchors keeps unsaved offsets accurate when switching source presentations.
    applyMarks() {
      if (!this.cm || !this.file) return;
      this.syncSourceAnchors();
      const doc = this.cm.getDoc();
      for (const mark of this.cmMarks) mark.clear();
      this.cmMarks = [];
      this.cm.clearGutter('ws-gutter');
      this.applyingMarks = true;
      const mark = (file, type, id, start, end, cls, label) => {
        const entry = this.files.get(file);
        const anchor = this.sourceAnchors.get(`${type}-${id}`)?.mark.find();
        if (!entry || !anchor) return;
        const a = entry.doc.indexFromPos(anchor.from), b = entry.doc.indexFromPos(anchor.to);
        const isSel = this.selected?.type === type && this.selected.id === id;
        for (const range of this.displayRanges(file, a, b)) {
          const from = this.cm.posFromIndex(range.start), to = this.cm.posFromIndex(range.end);
          const m = range.end > range.start ? this.cm.markText(from, to, { className: cls + (isSel ? ' sel' : ''), attributes: { title: label } })
            : this.cm.setBookmark(from, { widget: h('span', { class: cls + ' ws-caret' + (isSel ? ' sel' : ''), title: label, text: '▾' }) });
          m.wsItem = { type, id }; m.doc = doc; m.file = file;
          this.cmMarks.push(m);
        }
      };
      try {
        for (const c of this.markedChanges())
          mark(c.file, 'change', c.id, c.new_start, c.new_end, 'ws-chg ws-chg-' + c.kind, c.kind === 'added' ? 'Added' : `${KIND[c.kind].label}: ${short(c.old, 200)}`);
        for (const n of this.visibleNotes()) {
          if (n.anchor === 'lost') continue;
          const st = n.style;
          const cls = 'ws-note' + (st?.type === 'strikethrough' ? ' ws-strike' + (st.intent === 'replace' ? ' ws-replace' : '') : st?.color ? ' ws-hl-' + st.color : '') + (n.status === 'resolved' ? ' resolved' : '');
          mark(n.file, 'note', n.id, n.start, n.end, cls, short(n.comments[0]?.text || (st?.type === 'strikethrough' ? 'Suggested removal' : 'Highlight'), 200));
        }
        for (const m of this.cmMarks) {
          if (m.wsItem.type !== 'note') continue;
          const pos = m.find();
          if (pos) this.cm.setGutterMarker((pos.from || pos).line, 'ws-gutter', h('span', { class: 'ws-gutter-note', title: 'Comment', text: '💬' }));
        }
      } finally { this.applyingMarks = false; }
    }

    // ------------------------------------------------------------ comments
    // Map display offsets to one native source passage. Requires an active editor;
    // throws for generated separators or ranges spanning source files, before any write.
    sourceLocation(from, to = from) {
      if (!this.entire) return { file: this.file, start: from, end: to };
      const target = projectionRange(this.paperSource, from, to);
      if (!target) throw new Error('Select a passage within one source file, without a file separator.');
      const text = this.files.get(target.file).doc.getValue();
      return { file: target.file, start: nativeOffset(text, target.start), end: nativeOffset(text, target.end) };
    }

    // Save a mapped passage before anchoring a comment in server code-point offsets.
    // Requires display offsets into the current document. Rejects a concurrently changed
    // passage or a failed save; comment creation never uses combined-document offsets.
    async targetAt(from, to) {
      const target = this.sourceLocation(from, to);
      const entry = this.files.get(target.file), selected = entry.doc.getValue().slice(target.start, target.end);
      await this.save(target.file);
      if (entry.doc.getValue() !== entry.saved || entry.saved.slice(target.start, target.end) !== selected)
        throw new Error('The source changed while saving. Select the passage again.');
      return { file: target.file, start: unitsToCp(entry.saved, target.start), end: unitsToCp(entry.saved, target.end), quote: selected, origin: 'source' };
    }

    // Resolve the current selection to its original file. Requires a nonempty selection;
    // targetAt handles saving and conflict errors for both source presentations.
    async sourceTarget() {
      if (!this.file) throw new Error('Open a file first.');
      const doc = this.cm.getDoc();
      if (!doc.somethingSelected()) throw new Error('Select the text you want to mark.');
      return this.targetAt(doc.indexFromPos(doc.getCursor('from')), doc.indexFromPos(doc.getCursor('to')));
    }

    // Comment (default: highlight in the PDF toolbar's current color) or replacement: opens the form.
    async commentFromSource(style = { type: 'highlight', color: this.pdf?.hlColor || 'yellow' }) {
      this.startNote({ ...(await this.sourceTarget()), style });
    }

    // Plain highlight or suggested removal, stored right away like the PDF tools do.
    async markFromSource(style) {
      const target = await this.sourceTarget();
      const note = await this.api('/notes', { method: 'POST', body: JSON.stringify({ ...target, style, text: '', author: this.o.author || 'Author' }) });
      this.remember(style.type === 'strikethrough' ? 'removal' : 'highlight', note.id);
      await this.reload();
    }

    // PDF text (rects + text) -> source range in code points. Saves the file first if needed.
    async mapPdfText(got) {
      const r = got.rects[0];
      const where = await this.api(`/synctex/edit?page=${r.p}&x=${(r.x + 2).toFixed(2)}&y=${(r.y + r.h / 2).toFixed(2)}`);
      if (this.entire) await this.ensureFile(where.file); else await this.openFile(where.file);
      if (this.files.get(where.file).doc.getValue() !== this.files.get(where.file).saved) {
        await this.save(where.file);
        this.say(`Saved ${where.file} first, so the comment can be anchored.`);
      }
      const text = this.files.get(where.file).saved;
      const lines = text.split('\n');
      const near = lines.slice(0, where.line - 1).reduce((n, l) => n + l.length + 1, 0);
      const range = sourceRange(text, near, selectionWords(got.text), got.context || [])
        || sourceRange(text, near, selectionWords(got.text, false), got.context || []); // a real hyphenated word
      if (!range) throw new Error(`Could not find “${short(got.text, 60)}” in ${where.file}. Select it in the source instead.`);
      await this.revealSource(where.file, range.start, range.end, false);
      return { file: where.file, start: unitsToCp(text, range.start), end: unitsToCp(text, range.end), quote: text.slice(range.start, range.end), origin: 'pdf' };
    }

    // ------------------------------------------------------------ PDF tools (linked)
    run(fn) { this.o.clearError?.(); return Promise.resolve().then(fn).catch((e) => { this.say(e.message, true); this.placeMarks(); }); }

    styleOf(h) {
      return h.type === 'strikethrough' ? { type: 'strikethrough', ...(h.intent === 'replace' ? { intent: 'replace' } : {}) } : { type: 'highlight', color: h.color };
    }

    // A text tool made a mark. Replace text and "Comment" open a form right away (same tick);
    // a plain highlight or removal is stored as a comment without words.
    onToolMark(h) {
      this.pendingMark = h;
      queueMicrotask(() => {
        if (this.pendingMark !== h) return;
        this.pendingMark = null;
        this.run(async () => {
          const target = await this.mapPdfText(h);
          const note = await this.api('/notes', { method: 'POST', body: JSON.stringify({ ...target, style: this.styleOf(h), text: '', author: this.o.author || 'Author' }) });
          this.remember(`${h.type === 'strikethrough' ? 'removal' : 'highlight'}`, note.id);
          await this.reload();
        });
      });
    }

    toolNoteForm(h) {
      this.pendingMark = null;
      this.run(async () => {
        const target = await this.mapPdfText(h);
        this.startNote({ ...target, style: this.styleOf(h) });
      });
    }

    remember(label, noteId) {
      this.history.push({ label, undo: () => this.noteStatus(noteId, 'deleted'), redo: () => this.noteStatus(noteId, 'open') });
      this.future = [];
      this.pdf?.renderBar();
    }

    async noteStatus(id, status) { await this.api(`/notes/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) }); }
    async strokeStatus(id, status) { await this.api(`/strokes/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) }); }

    async step(from, to, dir) {
      const entry = from.pop();
      if (!entry) return;
      try { await entry[dir](); } catch (e) { from.push(entry); throw e; }
      to.push(entry);
      await this.reload();
      this.say(`${dir === 'undo' ? 'Undid' : 'Redid'} ${entry.label}.`);
      this.pdf?.renderBar();
    }

    onToolRemove(kind, item) {
      const [type, id] = item.id.split(/-(.+)/);
      if (type === 'change') {
        if (Date.now() - (this.changeWarned || 0) > 3000) this.say('Tracked changes cannot be erased. Use Revert in Changes.', true);
        this.changeWarned = Date.now();
        return false;
      }
      if (type === 'note') {
        const note = (this.status.notes || []).find((n) => n.id === id);
        if (note?.comments.length > 1 && !confirm(`Erase this comment and its ${note.comments.length - 1} repl${note.comments.length === 2 ? 'y' : 'ies'}? Undo brings it back.`)) return false;
        const prev = note?.status || 'open';
        this.run(async () => {
          await this.noteStatus(id, 'deleted');
          this.history.push({ label: 'erase', undo: () => this.noteStatus(id, prev), redo: () => this.noteStatus(id, 'deleted') });
          this.future = [];
          await this.reload();
        });
        return true;
      }
      if (type === 'stroke') {
        this.run(async () => {
          await this.strokeStatus(id, 'deleted');
          this.history.push({ label: 'erase', undo: () => this.strokeStatus(id, 'open'), redo: () => this.strokeStatus(id, 'deleted') });
          this.future = [];
          await this.reload();
        });
        return true;
      }
      return true; // a mark that was never stored
    }

    // A pen stroke is anchored to the printed words nearest its first point (like comment marks),
    // so after a recompile it moves with that text.
    async onToolStroke(s) {
      const [x, y] = s.points[0];
      let anchor = null;
      const pd = (await this.pageData())[s.page - 1];
      if (pd?.words.length) {
        let best = -1, bestD = Infinity;
        pd.words.forEach((w, i) => {
          const [r] = this.rectsFor(pd, i, i);
          const dx = Math.max(r.x - x, 0, x - (r.x + r.w)), dy = Math.max(r.y - y, 0, y - (r.y + r.h));
          const d = Math.hypot(dx, dy * 1.5);
          if (d < bestD) { bestD = d; best = i; }
        });
        if (best >= 0 && bestD < 60) {
          const [r] = this.rectsFor(pd, best, best);
          const cut = (w) => w.w.slice(0, 60);
          anchor = { words: pd.words.slice(best, best + 5).map(cut), context: pd.words.slice(Math.max(0, best - 6), best).map(cut), dx: x - r.x, dy: y - r.y };
        }
      }
      const item = await this.api('/strokes', { method: 'POST', body: JSON.stringify({ page: s.page, color: s.color, width: s.width, points: s.points, anchor }) });
      this.history.push({ label: 'pen stroke', undo: () => this.strokeStatus(item.id, 'deleted'), redo: () => this.strokeStatus(item.id, 'open') });
      this.future = [];
      await this.reload();
    }

    startNote(n) {
      this.newNote = n;
      if (this.view === 'pdf') this.setView('both'); // the comment form sits beside the source
      if (!this.reviewOpen) { this.reviewOpen = true; store.set('review', true); this.layout(); }
      this.reviewTab = 'comments';
      this.clearWriting();
      this.renderReview();
      this.review.querySelector('.ws-new textarea')?.focus();
    }

    async submitNote(text) {
      const revision=reviewFor(this).revision;
      const n = this.newNote;
      const words = n.style?.intent === 'replace' ? 'Replacement: ' + text.trim() : text;
      const { draft, ...fields } = n;
      const note = await this.api('/notes', { method: 'POST', body: JSON.stringify({ ...fields, text: words, author: this.o.author || 'Author' }) });
      if (this.destroyed) return;
      reviewFor(this).completeNote(revision);
      this.remember(n.style?.intent === 'replace' ? 'replacement' : 'comment', note.id);
      await this.reload();
      this.select('note', note.id, { source: false, pdf: true });
    }

    // ------------------------------------------------------------ writing (fixed rules, see writing.js)
    writingActive() { return !!window.WritingCheck && this.reviewOpen && this.reviewTab === 'writing' && this.view !== 'pdf' && !!this.file; }

    scheduleWriting() {
      if (!this.writingActive()) return;
      clearTimeout(this.wTimer);
      this.wTimer = setTimeout(() => { if (this.writingActive()) { this.runWriting(); this.renderWritingBody(); } }, 400);
    }

    clearWriting() {
      for (const m of this.wMarks) m.clear();
      this.wMarks = [];
    }

    // Analyze the active editor text, including unsaved edits; in paper mode this is the
    // complete expanded prose, so scores use its total words/syllables/sentences rather than
    // averaging section scores. Requires WritingCheck; marks remain in display coordinates.
    runWriting() {
      this.clearWriting();
      if (!this.writingActive()) return;
      const text = this.cm.getValue();
      const res = WritingCheck.analyze(text);
      const ignored = new Set((this.status.writing_ignores || []).map((x) => x.key));
      const rules = new Map(WritingCheck.RULES.map((r) => [r.id, r]));
      for (const m of res.marks) {
        m.key = WritingCheck.fingerprint(m.rule, res.sentences[m.sentence]?.text || m.text);
        m.file = this.entire ? projectionRange(this.paperSource, m.start)?.file : this.file;
      }
      res.ignored = res.marks.filter((m) => ignored.has(m.key));
      res.marks = res.marks.filter((m) => !ignored.has(m.key));
      res.file = this.sourceLabel;
      this.wResult = res;
      for (const m of res.marks) {
        if (!this.wOn.has(m.rule) || m.end <= m.start) continue;
        const r = rules.get(m.rule);
        const cm = this.cm.markText(this.cm.posFromIndex(m.start), this.cm.posFromIndex(m.end), {
          className: `ws-w ws-w-${m.rule}${r.kind === 'sentence' ? ' ws-w-sentence' : ''}${r.possible ? ' ws-w-possible' : ''}${this.isWFocus(m) ? ' ws-w-focus' : ''}`,
          attributes: { title: `${r.label}${m.hint ? ' · ' + m.hint : ''}: ${r.why}` },
        });
        this.wMarks.push(cm);
      }
    }

    isWFocus(m) { return this.wFocus?.key === m.key && this.wFocus.rule === m.rule; }

    // Pick a mark in the list: emphasize it in the source and select its text.
    focusWriting(m) {
      this.wFocus = { key: m.key, rule: m.rule };
      this.runWriting();
      this.renderWritingBody();
      this.reveal(m.start, m.end, false);
    }

    writingPanel(body) {
      if (!this.wResult || this.wResult.file !== this.sourceLabel) this.runWriting();
      const res = this.wResult;
      const box = h('div', { class: 'ws-w-panel' });
      body.append(box);
      this.wBody = box;
      this.renderWritingBody(true);
    }

    renderWritingBody(building = false) {
      const box = this.wBody, res = this.wResult;
      if (!box || !res || (!building && !box.isConnected)) return;
      const rules = WritingCheck.RULES;
      const parts = [];
      const sc = res.scores;
      this.wCountEl = h('span', { class: 'ws-w-count', 'aria-live': 'polite' });
      parts.push(h('div', { class: 'ws-w-file' }, h('span', { class: 'ws-w-name', text: this.sourceLabel }), this.wCountEl));
      if (this.entire && this.paperSource?.warnings.length) parts.push(h('p', { class: 'draft-error', text: 'Scores cover the available source only. ' + this.paperSource.warnings.join('; ') }));
      if (sc) {
        const stat = (label, value, title) => h('div', { class: 'ws-w-stat', title }, h('b', { text: value }), h('span', { text: label }));
        parts.push(h('div', { class: 'ws-w-scores' },
          stat('Reading ease', sc.fre.toFixed(0), 'Flesch Reading Ease: higher is easier. Harvard suggests 60–70 for adult readers; technical terms push research prose lower, so compare sections and track change.'),
          stat('Grade', sc.fkGrade.toFixed(1), 'Flesch–Kincaid grade level: years of schooling needed. Lower is easier.'),
          stat('Words/sentence', sc.wordsPerSentence.toFixed(1), `${sc.sentences} sentences, ${sc.words} words. ${sc.long} over 25 words.`)));
      }
      const count = (id) => res.marks.filter((m) => m.rule === id).length;
      const chips = h('div', { class: 'ws-w-chips', role: 'group', 'aria-label': 'Checks to show' });
      for (const r of rules) {
        const on = this.wOn.has(r.id), n = count(r.id);
        chips.append(h('button', { class: 'ws-w-chip ws-w-c-' + r.id + (on ? ' on' : ''), 'aria-pressed': String(on), title: r.why,
          tool: { id: 'workspace.writing-rule', label: 'Toggle writing rule', showText: true, execute: () => { on ? this.wOn.delete(r.id) : this.wOn.add(r.id); store.set('wrules', [...this.wOn].join(',')); this.runWriting(); this.renderWritingBody(); }  }},
          h('i', { 'aria-hidden': 'true' }), `${r.label}${r.possible ? '?' : ''} `, h('span', { class: 'ws-w-n', text: String(n) })));
      }
      parts.push(chips);
      const shown = res.marks.filter((m) => this.wOn.has(m.rule));
      const list = h('div', { class: 'ws-w-list' });
      if (!this.wOn.size) list.append(h('p', { class: 'hint', text: 'Choose a check above to see its marks.' }));
      else if (!shown.length) list.append(h('p', { class: 'hint', text: `No marks for these checks in ${this.entire ? 'the paper' : 'this file'}.` }));
      const byId = new Map(rules.map((r) => [r.id, r]));
      for (const m of shown.slice(0, this.wShowAll ? shown.length : 40)) {
        const r = byId.get(m.rule);
        const row = h('div', { class: 'ws-w-item' + (this.isWFocus(m) ? ' on' : ''), tabindex: '0', title: r.why,
          tool: { id: 'workspace.focus-writing', label: 'Show writing issue', showText: true, execute: ({ event: e }) => { if (!e.target.closest('button')) this.focusWriting(m); } },
          onkeydown: (e) => { if (e.key === 'Enter') this.focusWriting(m); } },
          h('i', { class: 'ws-w-dot ws-w-c-' + m.rule, 'aria-hidden': 'true' }),
          h('div', { class: 'ws-w-what' }, h('span', { class: 'ws-w-label', text: r.label + (m.hint ? ' · ' + m.hint : '') }),
            h('span', { class: 'ws-w-snip', text: short(m.text.replace(/\\[a-zA-Z]+\*?(\[[^\]]*\])?(\{[^}]*\})?/g, (x) => /cite/.test(x) ? x : ''), r.kind === 'sentence' ? 90 : 60) })),
          h('div', { class: 'ws-w-acts' },
            h('button', { text: 'Ignore', title: 'Hide this mark for this sentence. It comes back if the sentence changes.', tool: { id: 'workspace.ignore-writing', label: 'Ignore writing issue', showText: true, execute: () => this.o.action(() => this.ignoreWriting(m, true))  }}),
            h('button', { text: 'Comment', title: 'Turn this into a comment on the passage', tool: { id: 'workspace.comment-writing', label: 'Comment on writing issue', showText: true, execute: () => this.o.action(() => this.commentWriting(m))  }})));
        list.append(row);
      }
      if (!this.wShowAll && shown.length > 40) list.append(h('button', { class: 'ws-w-more', text: `Show all ${shown.length}`, tool: { id: 'workspace.show-writing', label: 'Show all writing issues', showText: true, execute: () => { this.wShowAll = true; this.renderWritingBody(); }  }}));
      parts.push(list);
      if (res.ignored.length) {
        const det = h('details', { class: 'ws-w-ignored' }, h('summary', { text: `Ignored in ${this.entire ? 'the paper' : 'this file'} (${res.ignored.length})` }));
        for (const m of res.ignored) det.append(h('div', { class: 'ws-w-item' }, h('i', { class: 'ws-w-dot ws-w-c-' + m.rule }),
          h('div', { class: 'ws-w-what' }, h('span', { class: 'ws-w-label', text: byId.get(m.rule).label }), h('span', { class: 'ws-w-snip', text: short(m.text, 60) })),
          h('div', { class: 'ws-w-acts' }, h('button', { text: 'Restore', tool: { id: 'workspace.restore-writing', label: 'Restore writing issue', showText: true, execute: () => this.o.action(() => this.ignoreWriting(m, false))  }}))));
        parts.push(det);
      }
      parts.push(h('p', { class: 'ws-w-note', text: 'Fixed rules from the writing guide: the same text always gives the same marks. Marks ending in “?” are possible issues. Scores are within about 1–2% of textstat.' }));
      box.replaceChildren(...parts);
      this.updateWordCount();
    }

    // Written words in the open file, or in the selection when there is one (writing.js countWords).
    // Shown in the page header always, and in the Writing tab while it is open.
    updateWordCount() {
      if (!window.WritingCheck || !this.cm || !this.file) return;
      const gen = this.cm.changeGeneration();
      if (this.wCount?.gen !== gen || this.wCount.file !== this.sourceLabel) {
        const mask = this.file.endsWith('.bib') ? '' : WritingCheck.wordMask(this.cm.getValue());
        this.wCount = { gen, file: this.sourceLabel, mask, total: WritingCheck.countWords(mask) };
      }
      const { mask, total } = this.wCount;
      const ranges = this.cm.listSelections().filter((r) => !r.empty());
      let sel = null;
      if (ranges.length) {
        sel = 0;
        for (const r of ranges) sel += WritingCheck.countWords(mask, this.cm.indexFromPos(r.from()), this.cm.indexFromPos(r.to()));
      }
      const fmt = (n) => n.toLocaleString('en-US');
      const rule = 'Written words only: running text and footnotes. Headings, captions, commands, references, math and comments do not count.';
      const title = sel === null ? `${fmt(total)} words in ${this.sourceLabel}. Select a passage to count it. ${rule}`
        : `${fmt(sel)} of ${fmt(total)} words in ${this.sourceLabel} selected. ${rule}`;
      if (this.headerCount) {
        const paperCount = this.entire ? total : this.paperCount;
        const paper = paperCount == null ? 'Paper: counting…' : `Paper: ${this.paperSource?.warnings.length ? '≈ ' : ''}${fmt(paperCount)} words`;
        this.headerCount.textContent = this.entire ? `${paper}${sel === null ? '' : ` · ${fmt(sel)} selected`}` : `${sel === null ? `${fmt(total)} words` : `${fmt(sel)} of ${fmt(total)}`} · ${paper}`;
        this.headerCount.title = title + ' Paper count follows literal input/include/subfile commands from the main file and includes unsaved edits. ' + (this.paperSource?.warnings.join('; ') || '');
        this.headerCount.classList.toggle('sel', sel !== null);
      }
      const el = this.wCountEl;
      if (el && this.writingActive()) { // the panel may not be in the page yet while it is built
        el.textContent = sel === null ? `${fmt(total)} words` : `${fmt(sel)} of ${fmt(total)} words`;
        el.title = title;
        el.classList.toggle('sel', sel !== null);
      }
    }

    async ignoreWriting(m, ignored) {
      const sentence = this.wResult?.sentences[m.sentence]?.text || m.text;
      const r = await this.api('/writing/ignores', { method: 'POST', body: JSON.stringify({ key: m.key, rule: m.rule, file: m.file || this.file, text: sentence, ignored }) });
      this.status.writing_ignores = r.writing_ignores;
      this.runWriting();
      this.renderWritingBody();
    }

    // A writing mark becomes an ordinary comment on its passage, prefilled with the rule.
    async commentWriting(m) {
      const r = WritingCheck.RULES.find((x) => x.id === m.rule);
      const target = await this.targetAt(m.start, m.end);
      this.startNote({ ...target, draft: `${r.label}${m.hint ? ' (' + m.hint + ')' : ''}: ${r.why}` });
    }

    /** Render registered review tabs using detached source/review metadata.
     * @param {void} none. @pre Review host and contribution runtime initialized.
     * @post Panel replaced without exposing native buffers or transport state.
     * @return {void} Nothing. @throws {Error} Contribution/rendering failure.
     */
    renderReview() {
      panelFor(this).render(this.review, {
        notes: this.visibleNotes(), changes: this.visibleChanges(),
        openNotes: this.visibleNotes(false).length, openChanges: this.visibleChanges(false).length,
        resolved: (this.status.notes || []).filter(n => n.status === 'resolved').length,
        accepted: this.status.changes.filter(c => c.status === 'accepted').length,
        totalChanges: this.status.changes.length, base: this.status.base_number,
        inactive: this.status.inactive || [], problems: this.status.problems || [],
        writing: !!window.WritingCheck,
      });
    }

    // Files in reading order: the main file, then \input/\include targets in the order they appear.
    async readingOrder() {
      const order = [], seen = new Set();
      const visit = async (file, depth) => {
        if (seen.has(file) || depth > 20) return;
        seen.add(file);
        let text;
        try { text = this.files.get(file)?.doc.getValue() ?? (await this.api('/file?path=' + encodeURIComponent(file))).text; } catch { return; }
        order.push(file);
        const code = text.split(/\r?\n/).map((l) => l.replace(/(^|[^\\])%.*$/, '$1')).join('\n');
        for (const m of code.matchAll(/\\(?:input|include|subfile)\s*\{([^}]+)\}/g)) {
          let f = m[1].trim().replace(/^\.\//, '');
          if (!/\.[a-z]+$/i.test(f)) f += '.tex';
          await visit(f, depth + 1);
        }
      };
      await visit(this.status.main, 0);
      for (const f of [...(this.status.files || [])].sort()) if (!seen.has(f)) order.push(f);
      return order;
    }

    // Everything a reviewer (person or AI assistant) needs, as Markdown on the clipboard.
    // The clipboard call happens right at the click (browsers allow it only then); the text follows when ready.
    async copyForLlm(btn) {
      const ok = (r) => { this.say(r.done); window.copiedFeedback?.(btn); };
      if (!this.unsaved && this.fileOrder) {
        const r = this.llmTextNow(); // no awaits before the clipboard call
        try { await navigator.clipboard.writeText(r.text); ok(r); }
        catch { if (execCopy(r.text)) ok(r); else this.showCopy(r.text, r.done, btn); }
        return;
      }
      const job = this.llmText();
      job.catch(() => {}); // reported below
      try {
        if (window.ClipboardItem && navigator.clipboard?.write) {
          await navigator.clipboard.write([new ClipboardItem({ 'text/plain': job.then((r) => new Blob([r.text], { type: 'text/plain' })) })]);
        } else await navigator.clipboard.writeText((await job).text);
        const r = await job;
        ok(r);
      } catch (e) {
        const r = await job; // a failure to build the text is the real error
        try { await navigator.clipboard.writeText(r.text); ok(r); }
        catch { if (execCopy(r.text)) ok(r); else this.showCopy(r.text, r.done, btn); }
      }
    }

    async llmText() {
      if (this.unsaved) await this.saveAll();
      await this.reload();
      this.fileOrder = await this.readingOrder();
      return this.llmTextNow();
    }

    llmTextNow() {
      const st = this.status, order = this.fileOrder || [st.main];
      const rank = (f) => { const i = order.indexOf(f); return i < 0 ? order.length : i; };
      const items = [
        ...(st.notes || []).filter((n) => n.status === 'open').map((n) => ({ n, file: n.file, pos: n.anchor === 'lost' ? Infinity : n.start, line: n.line })),
        ...(st.changes || []).filter((c) => c.status !== 'accepted').map((c) => ({ c, file: c.file, pos: c.new_start, line: c.line })),
      ].sort((a, b) => rank(a.file) - rank(b.file) || a.pos - b.pos || a.line - b.line);
      const nNotes = items.filter((x) => x.n).length, nChanges = items.length - nNotes;
      const citeBad = this.citeProblems();
      if (!items.length && !citeBad.length) throw new Error('There are no open comments or changes to copy. Accepted changes and resolved comments are left out.');
      const api = `${location.origin}${this.o.base}`;
      const out = [];
      out.push(`# Review request: ${this.o.doc.name || 'paper'} (draft after V${st.base_number})`, '',
        '## Where things are',
        `- LaTeX source folder: \`${st.root}\``,
        `- Main file: \`${st.main}\` (file paths below are relative to the source folder)`,
        `- Draft PDF (latest build): \`${st.draft_pdf_path}\``,
        `- Base: V${st.base_number}, built from commit \`${st.source_commit}\`. Current HEAD: \`${st.head}\`. The edits below are uncommitted changes in the working tree.`,
        `- Review data (read-only, do not edit by hand): \`${st.state_file}\``, '',
        '## What to do',
        `There are ${nNotes} open comment(s) and ${nChanges} tracked change(s) below, in reading order (the order of the text in the paper). Line numbers refer to the files as saved now.`,
        '1. **Address every comment.** Comments are the author\'s instructions. For each one, edit the LaTeX source or propose wording. A "Remove text" mark suggests deleting the passage. A "Replace text" mark gives the new wording after "Replacement:". A highlight without words flags the passage; say what you think the concern is, or ask.',
        '2. **Check every change.** Changes are the author\'s own edits since the last version. Check each one: claims against their sources, citation keys against the .bib, numbers against the scripts that produce them, terminology and writing. Propose fixes; do not silently rewrite the author\'s text.',
        '3. **Check the review itself.** Do not accept a comment or change by default. Say where you disagree, and why, with evidence.',
        '4. **Ask when unclear.** If a comment is ambiguous or you cannot tell what the author wants, do not guess. Ask a question, or ask about the thinking behind the comment, before you edit.',
        '5. **Do not commit, push or create a version.** The author saves versions in the editor.',
        `6. **Report per item** (by its number and id): what you changed, what you propose, or your question. If the editor is running, you can reply to an item directly: \`POST ${api}/notes/<id>/comments\` or \`POST ${api}/changes/<id>/comments\` with JSON \`{"text": "...", "author": "Claude"}\` and header \`X-PDF-Token\` from \`GET ${location.origin}/api/config\`.`, '',
        '## Items');
      items.forEach((it, i) => out.push('', this.reviewItemText(it, i + 1)));
      if (citeBad.length) {
        out.push('', '## Citation problems',
          `These \\cite keys are empty or not in ${this.bibName()}. Do not invent a key, entry or source: find and read the source and add its entry with a DOI or URL, or leave a \`% TODO-CITE\` and say so.`);
        for (const p of citeBad) out.push(`- ${p.key ? `\`${p.key}\`` : 'empty `\\cite{}`'} · ${p.file}:${p.line}`);
      }
      const resolved = (st.notes || []).filter((n) => n.status === 'resolved').length;
      const accepted = (st.changes || []).filter((c) => c.status === 'accepted').length;
      const left = [resolved && `${resolved} resolved comment(s)`, accepted && `${accepted} accepted change(s)`].filter(Boolean);
      if (left.length) out.push('', `(${left.join(' and ')} are not included.)`);
      const text = out.join('\n') + '\n';
      this.lastCopy = text;
      return { text, done: `Copied ${nNotes} comment(s), ${nChanges} change(s)${citeBad.length ? ` and ${citeBad.length} citation problem(s)` : ''} in reading order. Paste them into your AI assistant.` };
    }

    reviewItemText(it, number = 1) {
      const pageOf = (id) => this.marks?.find((m) => m.id === id)?.page;
      const quote = (t) => (t || '').trim().split(/\r?\n/).map((l) => '> ' + l).join('\n') || '> (empty)';
      const thread = (cs) => cs?.length ? cs.map((c) => `- ${c.author || 'Author'}: ${c.text.trim().replace(/\n/g, '\n  ')}`).join('\n') : '- (no words: only the mark)';
      const kindOf = (n) => n.style?.intent === 'replace' ? 'Replace text (suggested replacement)'
        : n.style?.type === 'strikethrough' ? 'Remove text (suggested removal)'
        : n.style?.color ? `Highlight (${n.style.color})` : 'Comment';
      const out = [];
      if (it.n) {
        const n = it.n, page = pageOf('note-' + n.id);
        const where = n.anchor === 'lost' ? `${n.file} (position lost: the passage was deleted)` : `${n.file}:${n.line}${page ? `, PDF page ${page}` : ''}`;
        out.push('', `### ${number}. ${kindOf(n)} · comment id \`${n.id}\` · ${where}`);
        if (n.carried_from) out.push(`Carried over from the review of V${n.carried_from}.`);
        out.push('Passage:', quote(n.current ?? n.quote));
        if (n.anchor === 'edited' && n.current !== n.quote) out.push('The passage was edited after the comment. When commented, it read:', quote(n.quote));
        out.push('Comment thread:', thread(n.comments));
      } else {
        const c = it.c, page = pageOf('change-' + c.id);
        const label = { replaced: 'Replaced', added: 'Added', removed: 'Removed' }[c.kind] || c.kind;
        out.push('', `### ${number}. Change: ${label} · change id \`${c.id}\` · ${c.file}:${c.line}${page ? `, PDF page ${page}` : ''}`);
        if (c.kind !== 'added') out.push('Before:', quote(c.old));
        if (c.kind !== 'removed') out.push(c.kind === 'added' ? 'Added text:' : 'After:', quote(c.new));
        if (c.comments?.length) out.push('Comment thread:', thread(c.comments));
      }
      return out.join('\n').trim();
    }

    async copyText(text, btn, done = 'Copied comment.') {
      try { await navigator.clipboard.writeText(text); }
      catch { if (!execCopy(text)) { this.showCopy(text, done, btn); return; } }
      this.say(done); window.copiedFeedback?.(btn);
    }

    copyThreadButton(it) {
      return h('button', { class: 'ws-copy-thread', text: 'Copy thread', title: 'Copy this item with its file location, passage and comments',
        tool: { id: 'workspace.copy-thread', label: 'Copy thread', showText: true, execute: ({ event: ev }) => this.o.action(() => this.copyText(
          `Source folder: \`${this.status.root}\`\n\n` + this.reviewItemText(it) + '\n', ev.currentTarget, 'Copied thread with context.'))  }});
    }

    /** Open a selectable clipboard fallback through the shared native pane lifecycle.
     * @param {string} text Exact clipboard text. @param {string} done Success status.
     * @param {HTMLElement} btn Invoking control for copy feedback.
     * @pre Clipboard automation failed; the pane runtime is loaded.
     * @post A labeled modal owns focus; closing removes it and restores the previous focus.
     * @return {void} Nothing. @throws {Error} Dialog initialization failure.
     */
    showCopy(text, done, btn) {
      const box = h('textarea', { class: 'ws-copy-text', readonly: true, 'aria-label': 'Review request text' });
      box.value = text;
      const close = new window.EditorTools.Tool({ id: 'workspace.close-copy', label: 'Close copy dialog', showText: true, execute: () => dlg.close() });
      const dlg = h('dialog', { class: 'ws-copy-dlg', 'aria-label': 'Copy for LLM' },
        h('h2', { text: 'Copy for LLM' }),
        h('p', { text: 'The browser did not allow copying automatically. Click Copy, or select the text yourself.' }), box,
        h('div', { class: 'ws-copy-actions dialog-actions' },
          h('button', { text: 'Close', tool: close}),
          h('button', { class: 'primary', text: 'Copy', tool: { id: 'workspace.copy-fallback', label: 'Copy text', showText: true, execute: async () => {
            box.select();
            try { await navigator.clipboard.writeText(text); } catch { document.execCommand('copy'); }
            this.say(done); close.invoke(); window.copiedFeedback?.(btn);
          }  }})));
      window.EditorPanes.open(dlg, { focus: box, disposable: true });
      box.focus(); box.select(); box.scrollTop = 0;
    }

    sorted(list) { return [...list].sort((a, b) => a.file.localeCompare(b.file) || a.start - b.start); }

    /** Render comment composition through the configured review adapter.
     * @param {void} none. @pre Review initialized. @post Detached form returned.
     * @return {HTMLElement} Form. @throws {Error} Presentation failure.
     */
    newNoteForm() { return cardsFor(this).newNoteForm(); }
    /** Render a comment thread. @param {object[]} comments Exact message values.
     * @pre Review initialized. @post No source mutation. @return {HTMLElement} Thread.
     * @throws {Error} Presentation failure.
     */
    thread(comments) { return cardsFor(this).thread(comments); }
    /** Render thread reply controls. @param {string} key Identity. @param {Function} send Semantic submit action.
     * @pre Review initialized. @post New typing survives older submissions. @return {Array} Editor/action.
     * @throws {Error} Presentation failure.
     */
    replyBox(key, send) { return cardsFor(this).replyBox(key, send); }
    /** Render one source note. @param {object} note Detached note.
     * @pre Review initialized. @post No mutation. @return {HTMLElement} Card. @throws {Error} Presentation failure.
     */
    noteCard(note) { return cardsFor(this).noteCard(note); }
    /** Render a tracked change. @param {object} change Detached change. @param {boolean} inactive Historical flag.
     * @pre Review initialized. @post No mutation. @return {HTMLElement} Card. @throws {Error} Presentation failure.
     */
    changeCard(change, inactive = false) { return cardsFor(this).changeCard(change, inactive); }


    // Select a comment or change in all three places: review panel, source, PDF.
    select(type, id, { source = true, pdf = true } = {}) {
      this.selected = { type, id };
      const item = type === 'note' ? (this.status.notes || []).find((n) => n.id === id) : this.status.changes.find((c) => c.id === id);
      if (!item) return;
      if (type === 'note' && item.status === 'resolved' && !this.showResolved) this.showResolved = true;
      if (type === 'change' && item.status === 'accepted' && !this.showAccepted) this.showAccepted = true;
      this.reviewTab = type === 'note' ? 'comments' : 'changes';
      this.renderReview();
      const go = async () => {
        if (source) {
          await this.ensureFile(item.file);
          const start = type === 'note' ? item.start : item.new_start, end = type === 'note' ? item.end : item.new_end;
          this.applyMarks();
          const anchor = this.sourceAnchors.get(`${type}-${id}`)?.mark.find(), entry = this.files.get(item.file);
          if (anchor) await this.revealSource(item.file, entry.doc.indexFromPos(anchor.from), entry.doc.indexFromPos(anchor.to), false);
          else if (entry.doc.getValue() === entry.saved) await this.revealSource(item.file, start, end);
        } else this.applyMarks();
        if (pdf && this.pdf && this.pdfMode === 'draft') {
          const m = this.marks.find((x) => x.id === `${type}-${id}`);
          this.pdf.flash(m ? m.id : null);
          if (m) this.pdf.scrollToRect(m.rects[0].p, m.rects[0].y);
        }
      };
      go().catch((e) => this.say(e.message, true));
    }

    // Files changed on disk (another editor, an AI tool): reload clean tabs, flag tabs with unsaved edits.
    async syncFiles() {
      for (const [file] of this.files) {
        const scroll = file === this.file ? this.cm.getScrollInfo() : null;
        const state = await buffersFor(this).refresh(file).catch(() => 'unavailable');
        if (this.destroyed) return;
        if (state === 'reloaded') {
          if (scroll) this.cm.scrollTo(scroll.left, scroll.top);
          this.say(`${file} changed on disk and was reloaded.`);
        } else if (state === 'stale') {
          this.say(`${file} changed on disk while you have unsaved edits. Copy your text, then close and reopen the tab.`, true);
        }
      }
      this.paperTexts.clear();
      await this.refreshPaper();
      this.renderTabs();
    }

    async reload() {
      const builds = this.status.builds;
      const fresh = await this.api('');
      this.status = { ...fresh, builds };
      await this.syncFiles();
      this.srcTexts = new Map();
      if (this.destroyed) return;
      this.renderTop();
      this.applyMarks();
      this.renderReview();
      this.readingOrder().then((o) => { this.fileOrder = o; }).catch(() => {});
      await this.loadCitations();
      await this.placeMarks();
    }

    // "Comment" in the source bar: adds a comment to the selection.
    commentButton() {
      const b = h('button', { type: 'button', class: 'ws-tool ws-comment-btn', title: `Comment on the selected text (${keyHint('Alt-M')})`,
        'aria-label': 'Comment on the selected text', tool: { id: 'workspace.comment-selection', label: 'Comment on selected text', showText: true, execute: () => this.o.action(() => this.commentFromSource())  }});
      b.innerHTML = ICONS.note;
      b.append(h('span', { class: 'ws-comment-label', text: 'Comment' }));
      return b;
    }

    // ------------------------------------------------------------ citations
    /** Obtain a detached snapshot for bibliography diagnostic providers.
     * @param {void} none No arguments. @pre Workspace has been initialized.
     * @post Editor internals remain private; source and scope are copied as strings.
     * @return {object} Scope and active bibliography file/text, or null file for other views.
     * @throws {Error} Editor read failure.
     */
    getBibliographySnapshot() {
      const file = this.isBibliographySource() ? this.file : null;
      return {scope: this.o.base || '', file, text: file ? this.files.get(file)?.doc.getValue() || '' : ''};
    }
    /** Request local parsing or provider diagnostics through authenticated app transport.
     * @param {string} path Bibliography entries or OpenAlex diagnosis endpoint.
     * @param {object} data Source text and optional entry key.
     * @pre Controller supplies one of the supported endpoints.
     * @post No editor/source mutation. @return {Promise<object>} Parsed or compared metadata.
     * @throws {Error} Invalid route, transport, authentication or provider failure.
     */
    requestBibliographyDiagnostics(path, data) {
      if (!['/api/bibliography/entries', '/api/openalex/diagnose'].includes(path)) throw new Error('Unsupported bibliography diagnostics endpoint');
      return this.o.api(path, {method: 'POST', body: JSON.stringify(data)});
    }
    /** Remove only bibliography-owned marks and inline widgets.
     * @param {void} none No arguments. @pre None; repeat calls are safe.
     * @post Review/comment/citation decorations remain owned by their existing tools.
     * @return {void} Nothing. @throws {Error} CodeMirror decoration cleanup failure.
     */
    clearBibliographyDiagnostics() {
      for (const decoration of this.bibDecorations || []) decoration.clear();
      this.bibDecorations = [];
    }
    /** Display source warnings with entry-specific suppression and retry controls.
     * @param {object} snapshot Immutable file/text used to calculate ranges.
     * @param {object[]} warnings Unsuppressed diagnostics with code-point ranges.
     * @param {object} state Counts, service status and public controller callbacks.
     * @pre Source shell is mounted; ranges were produced by the local parser.
     * @post Only the current bibliography receives marks/widgets; source is unchanged.
     * @return {void} Nothing. @throws {Error} CodeMirror or DOM rendering failure.
     */
    renderBibliographyDiagnostics(snapshot, warnings, state) {
      if (!this.cm || this.destroyed) return;
      const current = this.getBibliographySnapshot();
      if (snapshot.file !== current.file || snapshot.text !== current.text) return;
      this.clearBibliographyDiagnostics();
      bibliographyToolStates.set(this, { snapshot, warnings: [...warnings], state });
      this.refreshFileToolbars?.();
      if (!snapshot.file) return;
      const groups = new Map();
      for (const warning of warnings) {
        const from = this.cm.posFromIndex(cpToUnits(snapshot.text, warning.start));
        const to = this.cm.posFromIndex(cpToUnits(snapshot.text, warning.end));
        this.bibDecorations.push(this.cm.markText(from, to, {className: 'ws-bib-warning', attributes: {title: warning.message}}));
        const row = h('div', {class: 'ws-bib-inline-warning'}, h('span', {text: warning.message}),
          h('button', {type: 'button', text: 'Suppress', title: `Suppress ${warning.code} for ${warning.key} in this file`,
            tool: { id: 'workspace.suppress-warning', label: 'Suppress ' + warning.code + ' for ' + warning.key, showText: true, execute: () => this.runToolbarCommand(() => this.runBibliographyOperation('suppress', warning)) }}));
        if (/^https:\/\/openalex\.org\/W\d+$/.test(warning.url || '')) row.append(h('a', {href: warning.url,
          target: '_blank', rel: 'noopener noreferrer', title: 'Review the matched OpenAlex work', text: 'OpenAlex'}));
        if (!groups.has(from.line)) groups.set(from.line, h('div', {class: 'ws-bib-inline-warnings'}));
        groups.get(from.line).append(row);
      }
      for (const [line, widget] of groups) this.bibDecorations.push(this.cm.addLineWidget(line, widget, {coverGutter: false, noHScroll: true}));
    }

    /** Read immutable diagnostics state for bibliography Tools.
     * @param {void} none No arguments. @pre Workspace exists.
     * @post No controller/editor internals escape. @return {object} Counts and service status.
     * @throws {void} None under normal operation.
     */
    getBibliographyToolState() {
      const entry = bibliographyToolStates.get(this);
      const current = this.getBibliographySnapshot();
      if (!entry || entry.snapshot.file !== current.file || entry.snapshot.text !== current.text)
        return Object.freeze({ warnings: 0, automatic: true, suppressed: 0, pending: !!current.file, problem: '' });
      return Object.freeze({ warnings: entry.warnings.length, automatic: entry.state.automatic,
        suppressed: entry.state.suppressed || 0, pending: !!entry.state.pending, checked: entry.state.checked || 0,
        problem: [entry.state.error, entry.state.storageError].filter(Boolean).join(' ') });
    }
    /** Execute a controller operation against the current file only.
     * @param {string} operation recheck, automatic, restore or suppress.
     * @param {*} value Optional boolean or warning identity.
     * @pre Current bibliography snapshot matches the published diagnostics.
     * @post Controller applies its own caching, persistence and stale-result guards.
     * @return {*} Controller result. @throws {Error} Stale file or unsupported operation.
     */
    runBibliographyOperation(operation, value) {
      const entry = bibliographyToolStates.get(this), current = this.getBibliographySnapshot();
      if (!entry || !current.file || entry.snapshot.file !== current.file || entry.snapshot.text !== current.text)
        throw new Error('Bibliography diagnostics are updating. Retry after the current file is checked.');
      const operations = { recheck: entry.state.onRecheck, automatic: entry.state.onAutomatic,
        restore: entry.state.onRestore, suppress: entry.state.onSuppress };
      if (typeof operations[operation] !== 'function') throw new Error('Unknown bibliography operation');
      return operations[operation](value);
    }
    /** Reveal the first unsuppressed diagnostic in the active source.
     * @param {void} none No arguments. @pre Diagnostics refer to current source.
     * @post Selection and scroll move to the warning; source is unchanged.
     * @return {*} Navigation result. @throws {Error} Navigation failure.
     */
    focusBibliographyWarning() {
      const entry = bibliographyToolStates.get(this), warning = entry?.warnings[0];
      if (!warning || entry.snapshot.file !== this.file) return;
      return this.revealSource(this.file, warning.start, warning.end, true, true);
    }

    /** Read the bibliography paths linked to this paper.
     * @param {void} none No arguments.
     * @pre Linked workspace API is available.
     * @post No source is changed; server fallback rules apply when no declaration exists.
     * @return {Promise<string[]>} A copy of the linked bibliography paths.
     * @throws {Error} Citation discovery or transport failure; UI callers report it.
     */
    async bibliographyFiles() {
      const citations = this.cites && !this.cites.error ? this.cites : await this.api('/citations');
      if (citations.error) throw new Error(citations.error);
      return [...citations.bib_files];
    }
    /** Parse current linked bibliography buffers for local search and completion.
     * @param {string|null} file Optional linked bibliography to restrict the results.
     * @pre Linked workspace and bibliography parser API are available.
     * @post Unsaved buffers are preserved; no source is saved and no provider is contacted.
     * @return {Promise<object[]>} Parsed entries with their bibliography path.
     * @throws {Error} Unlinked file, file read or parser request failure.
     */
    async bibliographyEntries(file = null) {
      const names = await this.bibliographyFiles();
      if (file && !names.includes(file)) throw new Error('This bibliography is not linked to the paper.');
      const groups = await Promise.all((file ? [file] : names).map(async name => {
        const buffer = await this.ensureFile(name);
        const data = await this.o.api('/api/bibliography/entries', { method: 'POST', body: JSON.stringify({ text: buffer.doc.getValue() }) });
        return data.entries.map(entry => ({ ...entry, bib: name }));
      }));
      return groups.flat().sort((a, b) => a.key.localeCompare(b.key));
    }
    // Bib entries (for completion) and cite problems in saved files, from the server.
    async loadCitations() {
      try { this.cites = await this.api('/citations'); }
      catch (e) { this.cites = { error: e.message, entries: [], problems: [], bib_files: [], missing_bib: [], duplicates: [] }; }
      if (this.destroyed) return;
      this.citeKeySet = new Set(this.cites.entries.map((e) => e.key));
      this.citeSig = null;
      this.refreshCiteMarks();
    }
    bibName() { const b = this.cites?.bib_files || []; return b.length ? b.join(', ') : 'any .bib file'; }
    scheduleCiteMarks() { clearTimeout(this.citeTimer); this.citeTimer = setTimeout(() => this.refreshCiteMarks(), 300); }
    // Underline empty or unknown keys in the open file, from its current text (unsaved edits included).
    refreshCiteMarks() {
      if (!this.cm || !this.cites || this.destroyed) return;
      for (const m of this.citeMarks || []) m.clear();
      this.citeMarks = [];
      this.liveCiteProblems = [];
      if (!this.cites.error && this.file) {
        const text = this.cm.getValue();
        this.liveCiteProblems = citeUses(text).filter((u) => !u.key || !this.citeKeySet.has(u.key)).flatMap((u) => {
          let location;
          try { location = this.sourceLocation(u.start, u.end); } catch { return []; }
          const source = this.files.get(location.file)?.doc.getValue() || text;
          return [{ ...u, ...location, displayStart: u.start, displayEnd: u.end,
            line: source.slice(0, location.start).split('\n').length, kind: u.key ? 'unknown' : 'empty', units: true }];
        });
        for (const p of this.liveCiteProblems) {
          this.citeMarks.push(this.cm.markText(this.cm.posFromIndex(p.displayStart), this.cm.posFromIndex(p.displayEnd), { className: 'ws-cite-bad',
            attributes: { title: p.kind === 'empty' ? 'Empty citation: add a key' : `“${p.key}” is not in ${this.bibName()}` } }));
        }
      }
      const sig = JSON.stringify([this.cites.error, this.citeProblems().map((p) => `${p.file}:${p.line}:${p.key}`)]);
      if (sig !== this.citeSig) { this.citeSig = sig; this.renderTop(); this.renderReview(); }
    }
    // All cite problems: the server's list for saved files, the live scan for the open file.
    citeProblems() {
      if (!this.cites || this.cites.error) return [];
      const order = this.fileOrder || [this.status?.main];
      const rank = (f) => { const i = order.indexOf(f); return i < 0 ? order.length : i; };
      const visible = new Set(this.entire ? (this.paperSource?.segments || []).map((s) => s.file).filter(Boolean) : [this.file]);
      const live = [...new Map((this.liveCiteProblems || []).map((p) => [`${p.file}:${p.start}:${p.key}`, p])).values()];
      return [...(this.cites.problems || []).filter((p) => !visible.has(p.file)), ...live]
        .sort((a, b) => rank(a.file) - rank(b.file) || a.file.localeCompare(b.file) || a.start - b.start);
    }
    // Warning block at the top of the review panel (every tab).
    citeWarning() {
      const c = this.cites;
      if (!c) return null;
      if (c.error) return h('div', { class: 'ws-cite-warn' }, h('strong', { text: '⚠ The citation check could not run' }), h('p', { text: c.error }));
      const bad = this.citeProblems(), notes = [];
      if (!c.bib_files.length) notes.push('No .bib file found: add \\bibliography{…} to the main file, or a .bib file to the source folder.');
      if (c.missing_bib.length) notes.push(`Named but not found: ${c.missing_bib.join(', ')}.`);
      if (c.duplicates.length) notes.push(`Keys defined more than once: ${c.duplicates.join(', ')}.`);
      if (!bad.length && !notes.length) return null;
      const list = h('ul');
      for (const p of bad) {
        list.append(h('li', null, h('button', { type: 'button', title: 'Show in the source',
          tool: { id: 'workspace.reveal-citation', label: 'Show citation issue', showText: true, execute: () => this.o.action(async () => { await this.revealSource(p.file, p.start, p.end, !p.units, true); })  }},
          h('code', { text: p.key || '\\cite{}' }), h('span', { text: `${p.key ? '' : 'empty · '}${p.file}:${p.line}` }))));
      }
      return h('div', { class: 'ws-cite-warn', role: 'alert' },
        h('strong', { text: bad.length ? `⚠ ${bad.length} citation problem${bad.length === 1 ? '' : 's'}` : '⚠ Bibliography' }),
        bad.length ? h('p', { text: `Empty \\cite{} or keys not in ${this.bibName()}. Check the source; do not invent an entry.` }) : null,
        bad.length ? list : null, ...notes.map((t) => h('p', { text: t })));
    }
    /** Open/refresh completion through its public controller.
     * @param {boolean} force Allow opening. @pre Editor mounted.
     * @post Controller updates popup only. @return {void} Nothing. @throws {Error} UI failure.
     */
    updateCitePop(force = false) { if (this.cm && !this.destroyed) citationPopupFor(this).update(force); }
    /** Dismiss completion through its public controller.
     * @param {void} none. @pre None. @post Pending completion invalidated.
     * @return {void} Nothing. @throws {Error} Editor cleanup failure.
     */
    closeCitePop() { citationPopups.get(this)?.close(); }

    /** Obtain an initialized control through the toolbar interface.
     * @param {string} id Stable control identifier.
     * @pre Workspace controls have been built.
     * @post Workspace storage is unchanged; the existing DOM node is returned.
     * @return {HTMLElement} Requested control, never a copy of internal state.
     * @throws {Error} Unknown or uninitialized control.
     */
    getToolbarControl(id) {
      const controls = { compileControls: this.compileControls, reviewBtn: this.reviewBtn, changesBtn: this.changesBtn,
        formatControls: this.formatControls, commentBtn: this.commentBtn, referencesBtn: this.referencesBtn };
      if (!controls[id]) throw new Error('Unknown or uninitialized workspace control: ' + id);
      return controls[id];
    }
    /** Supply narrow capabilities to standard contributed Tools.
     * @param {void} none No arguments. @pre Workspace exists; editing methods enforce readiness.
     * @post No mutable workspace/editor storage is exposed; operations resolve the active buffer.
     * @return {object} Frozen filetype, editor and optional compile capabilities.
     * @throws {Error} Registry resolution failure.
     */
    getToolCapabilities() {
      const provider = window.FileTypes?.registry.resolve(this.entire ? this.status?.main : this.file || this.status?.main);
      const editor = Object.freeze({
        getSelection: () => this.cm?.getSelection() || '',
        editSelection: transform => this.editSelection(transform),
        save: () => this.saveAll(),
        format: () => this.formatFile(),
      });
      return Object.freeze({ editor, fileType: provider?.id, view: this.view,
        downloadSource: this.o.download ? () => this.downloadSourceArchive() : undefined,
        sourceExportBusy: this.#exportingSource, buildBusy: !!this.buildTarget,
        compile: provider?.capabilities.compile ? () => this.compile() : undefined });
    }
    #exportingSource = false;
    /** Save open files and export a source/PDF snapshot without changing project structure.
     * @param {void} none. @pre Source workspace and public download transport are available.
     * @post One archive is downloaded; source paths, Git and review history are preserved.
     * Editing is paused during the snapshot request; failures retain local buffers.
     * @return {Promise<void>} Completion. @throws {Error} Save, compile or download failure.
     */
    async downloadSourceArchive() {
      if (this.#exportingSource || this.compiling) throw new Error('Wait for the current build or download to finish.');
      if (!this.o.download) throw new Error('Source ZIP downloads are unavailable.');
      const inert = this.root.inert;
      this.#exportingSource = true; this.root.inert = true; this.renderTabs();
      try {
        await this.saveAll();
        if (this.unsaved) throw new Error('Save all source changes before downloading.');
        if (this.destroyed) return;
        const name = (this.status.main.split('/').pop().replace(/\.tex$/i, '') || 'project') + '-source.zip';
        if (this.#sourceSession) await this.#sourceSession.exportArchive(this.o.download, this.status.main, name);
        else await this.o.download(this.o.base + '/archive', name, { method: 'POST', body: '{}' });
        this.say('Downloaded source ZIP with compiled PDF.');
      } finally {
        this.#exportingSource = false; this.root.inert = inert;
        if (!this.destroyed) this.renderTabs();
      }
    }

    /** Report whether source commands apply to the active buffer.
     * @param {void} none No arguments.
     * @pre Workspace source state is initialized.
     * @post No state changes.
     * @return {boolean} True for LaTeX and combined paper source.
     * @throws {Error} None under normal operation.
     */
    isLatexSource() { return !this.file || this.entire || (window.FileTypes ? !!window.FileTypes.registry.resolve(this.file)?.capabilities.latex : this.file.endsWith('.tex')); }
    /** Report whether bibliography tools apply to the active buffer.
     * @param {void} none No arguments.
     * @pre Workspace source state is initialized.
     * @post No state changes.
     * @return {boolean} True only for an individual BibTeX source.
     * @throws {Error} None under normal operation.
     */
    isBibliographySource() { return !this.entire && (window.FileTypes ? !!window.FileTypes.registry.resolve(this.file)?.capabilities.bibliography : /\.bib$/i.test(this.file || '')); }
    /** Check for a layout formatter through the file provider interface.
     * @param {void} none No arguments. @pre Workspace is initialized.
     * @post No state changes. @return {boolean} Whether the active file can be formatted.
     * @throws {Error} None under normal operation.
     */
    canFormatFile() { return !this.entire && !!window.SourceFormatting?.formatters.supports(this.file); }
    /** Apply file layout as one undoable edit; save() invokes the same provider.
     * @param {string} file Loaded source path; defaults to the active file.
     * @param {object} options automatic skips incomplete syntax so drafts can still be saved.
     * @pre File buffer is loaded; explicit formatting targets an individual source file.
     * @post Changed layout enters existing dirty tracking; selection and scroll are retained.
     * @return {boolean} Whether the buffer changed.
     * @throws {SyntaxError|Error} Explicit formatting or editor failures; UI boundary reports them.
     */
    formatFile(file = this.file, { automatic = false } = {}) {
      if ((!automatic && this.entire) || !window.SourceFormatting?.formatters.supports(file)) return false;
      const entry = this.files.get(file);
      if (!entry) return false;
      const doc = entry.doc, before = doc.getValue();
      let after;
      try { after = window.SourceFormatting.formatters.format(file, before); }
      catch (error) { if (automatic && error instanceof SyntaxError) return false; throw error; }
      if (before === after) return false;
      // Keep selections after removed fields attached to the surviving suffix.
      const oldContent = before.replace(/\s/g, ''), newContent = after.replace(/\s/g, '');
      let sharedStart = 0, sharedEnd = 0;
      while (sharedStart < Math.min(oldContent.length, newContent.length) && oldContent[sharedStart] === newContent[sharedStart]) sharedStart++;
      while (sharedEnd < Math.min(oldContent.length, newContent.length) - sharedStart
        && oldContent.at(-sharedEnd - 1) === newContent.at(-sharedEnd - 1)) sharedEnd++;
      const selections = doc.listSelections().map(selection => Object.fromEntries(['anchor', 'head'].map(key => {
        const index = doc.indexFromPos(selection[key]);
        let remaining = before.slice(0, index).replace(/\s/g, '').length, offset = 0;
        if (oldContent !== newContent && remaining > sharedStart) {
          remaining = remaining >= oldContent.length - sharedEnd
            ? newContent.length - (oldContent.length - remaining) : sharedStart;
        }
        while (offset < after.length && remaining > 0) { if (!/\s/.test(after[offset])) remaining--; offset++; }
        return [key, offset];
      })));
      const scroll = this.file === file && !this.entire ? this.cm.getScrollInfo() : null;
      // Keep common edges outside the edit to preserve marks and history where possible.
      let from = 0, oldEnd = before.length, newEnd = after.length;
      while (from < oldEnd && from < newEnd && before[from] === after[from]) from++;
      while (oldEnd > from && newEnd > from && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd--; }
      doc.changeGeneration(true); // isolate formatting from typing and previous formatting edits
      doc.replaceRange(after.slice(from, newEnd), doc.posFromIndex(from), doc.posFromIndex(oldEnd), 'format-file');
      doc.changeGeneration(true);
      doc.setSelections(selections.map(selection => ({ anchor: doc.posFromIndex(selection.anchor), head: doc.posFromIndex(selection.head) })), undefined, { scroll: false });
      if (scroll) this.cm.scrollTo(scroll.left, scroll.top);
      return true;
    }
    /** Handle a toolbar interaction at its user-facing recovery point.
     * @param {Function} command Synchronous or asynchronous operation using public methods.
     * @pre Workspace status reporting is mounted.
     * @post Failures are displayed once; command exceptions do not escape the event handler.
     * @return {Promise<*>} Result, or undefined after a reported failure.
     * @throws {Error} None if status reporting is available.
     */
    async runToolbarCommand(command) {
      try { return await command(); }
      catch (error) { this.say(error.message, true); }
    }
    /** Read selected LaTeX without exposing the editor instance.
     * @param {void} none No arguments.
     * @pre An editable LaTeX buffer is active.
     * @post Buffer and selection remain unchanged.
     * @return {string} Selected source text, or an empty string at the cursor.
     * @throws {Error} Source is unavailable or read-only.
     */
    getSourceSelection() {
      if (!this.cm || this.cm.getOption('readOnly') || !this.isLatexSource()) throw new Error('Select an editable LaTeX source first');
      return this.cm.getSelection();
    }
    /** Insert a table as one normal source edit, including combined-source projection.
     * @param {object} options Table dimensions, alignment, literal caption and label; see LatexTable.edit.
     * @pre An editable LaTeX buffer is active and LatexTable is loaded.
     * @post Selection is replaced, first cell selected; save, live compile and undo use existing editor hooks.
     * @return {void} No return value.
     * @throws {Error|TypeError|RangeError} Unavailable source or invalid table; validation precedes mutation.
     */
    insertTable(options = {}) {
      this.getSourceSelection();
      this.editSelection((text, from, to) => window.LatexTable.edit(text, from, to, options));
    }

    /** Render registered source commands with responsive overflow.
     * @param {void} none No arguments.
     * @pre Source command registry is populated before mounting.
     * @post Buttons, overflow menu and resize observer are mounted; commands use runToolbarCommand.
     * @return {HTMLElement} Formatting toolbar wrapper.
     * @throws {Error} Registry or DOM initialization failure; workspace mounting handles it.
     */
    formatBar() {
      const button = (kind, label, hint, tool = null) => {
        const b = h('button', { type: 'button', class: 'ws-fmt', title: hint ? `${label} (${hint})` : label, 'aria-label': label,
          onpointerdown: (e) => e.preventDefault(), tool });
        b.innerHTML = kind;
        return b;
      };
      const tools = [], items = [];
      let group = null;
      const add = (icon, name, label, hint, id, grp) => {
        if (group && grp !== group) items.push(h('span', { class: 'ws-fmt-sep', 'aria-hidden': 'true' }));
        group = grp;
        const el = button(icon, label, hint);
        window.EditorTools.sourceCommands.bind(id, el, this);
        tools.push({ icon, name, hint, id, el });
        items.push(el);
      };
      for (const command of window.EditorTools.sourceCommands.list()) {
        add(command.icon, command.name, command.label, command.key && keyHint(command.key),
          command.id, command.group);
      }
      const bar = h('div', { class: 'ws-format', role: 'toolbar', 'aria-label': 'Format the selected text' }, items);
      // Buttons that do not fit move into the "more" menu, with their names and shortcuts.
      const menu = h('div', { class: 'ws-fmt-menu', role: 'menu', hidden: true });
      const more = button(ICONS.more, 'More formatting', '', { id: 'workspace.more-formatting', label: 'More formatting', showText: true, execute: () => {
        menu.hidden = !menu.hidden; more.setAttribute('aria-expanded', String(!menu.hidden));
      } });
      more.classList.add('ws-fmt-more'); more.setAttribute('aria-haspopup', 'menu'); more.setAttribute('aria-expanded', 'false');
      const closeMenu = () => { menu.hidden = true; more.setAttribute('aria-expanded', 'false'); };
      this.onOutside = (e) => { if (!wrap.contains(e.target)) closeMenu(); };
      document.addEventListener('pointerdown', this.onOutside);
      menu.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeMenu(); this.cm?.focus(); } });
      const box = h('div', { class: 'ws-format-box' }, bar, more, menu);
      const wrap = h('div', { class: 'ws-format-wrap' }, box);
      // The wrap takes the bar's leftover width; show as many buttons as fit in it.
      const width = (el) => { const cs = getComputedStyle(el); return el.offsetWidth + parseFloat(cs.marginLeft) + parseFloat(cs.marginRight); };
      let fitted = -1;
      const fit = () => {
        const available = wrap.parentElement?.parentElement?.clientWidth || wrap.clientWidth;
        if (!wrap.isConnected || !available || available === fitted) return;
        fitted = available;
        for (const el of items) el.hidden = false;
        more.hidden = false;
        const gap = parseFloat(getComputedStyle(bar).columnGap) || 0;
        const cs = getComputedStyle(box);
        const avail = wrap.clientWidth - (box.offsetWidth - box.clientWidth) - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        const sizes = items.map((el) => width(el) + gap);
        const total = sizes.reduce((x, y) => x + y, 0) - gap;
        const hidden = [];
        if (total <= avail) more.hidden = true;
        else {
          let used = total + width(more);
          for (let i = items.length - 1; i >= 0 && used > avail; i--) {
            items[i].hidden = true; used -= sizes[i];
            const t = tools.find((x) => x.el === items[i]);
            if (t) hidden.unshift(t);
          }
          for (let i = items.length - 1; i >= 0 && (items[i].hidden || items[i].classList.contains('ws-fmt-sep')); i--) items[i].hidden = true;
        }
        if (more.hidden) closeMenu();
        menu.replaceChildren(...hidden.map((t) => {
          const b = h('button', { type: 'button', role: 'menuitem', class: 'ws-fmt-item', onpointerdown: (e) => e.preventDefault() });
          window.EditorTools.sourceCommands.bind(t.id, b, this, closeMenu);
          b.innerHTML = t.icon;
          b.append(h('span', { text: t.name }), h('kbd', { text: t.hint || '' }));
          return b;
        }));
      };
      this.fitFormat = fit;
      this.formatObs = new ResizeObserver(() => fit());
      this.formatObs.observe(wrap);
      return wrap;
    }

    /** Apply a validated pure edit to the active source selection.
     * @param {Function} fn Pure (text, from, to) function returning replacement and selection offsets.
     * @pre An editable editor is active; the function returns a valid source edit.
     * @post Replacement and selection change form one undoable editor operation; normal change hooks run.
     * @return {void} No return value; unavailable/read-only editors are unchanged.
     * @throws {Error} Edit generation or editor operation failure, propagated to the interaction boundary.
     */
    editSelection(fn) {
      const cm = this.cm;
      if (!cm || cm.getOption('readOnly')) return;
      const text = cm.getValue();
      const s = cm.indexFromPos(cm.getCursor('from')), e = cm.indexFromPos(cm.getCursor('to'));
      const r = fn(text, s, e);
      cm.operation(() => {
        cm.replaceRange(r.insert, cm.posFromIndex(r.from), cm.posFromIndex(r.to), '+format');
        cm.setSelection(cm.posFromIndex(r.selFrom), cm.posFromIndex(r.selTo));
      });
      cm.focus();
    }
    /** Toggle one supported LaTeX wrapper.
     * @param {string} kind Registered built-in wrapper identifier.
     * @pre Active source supports LaTeX editing.
     * @post Selection is wrapped/unwrapped; empty citations open completion.
     * @return {void} No return value.
     * @throws {Error} Unknown wrapper or edit failure.
     */
    wrap(kind) {
      if (!Object.hasOwn(WRAPS, kind)) throw new Error('Unknown LaTeX format: ' + kind);
      this.editSelection((text, s, e) => Workspace.formatEdit(text, s, e, kind));
      if (kind === 'cite' && !this.cm.somethingSelected()) this.updateCitePop(true);
    }
    /** Toggle LaTeX comments on selected lines.
     * @param {void} none No arguments.
     * @pre An editable source buffer is active.
     * @post Comment prefixes are toggled in one undoable edit.
     * @return {void} No return value.
     * @throws {Error} Edit failure, propagated to the interaction boundary.
     */
    toggleComment() { this.editSelection(commentEdit); }

    // Reload button: re-read the draft, source files and draft PDF from disk, keeping
    // open tabs, cursor and scroll. Files with unsaved edits are flagged, not replaced.
    async refreshFromDisk() {
      if ((!this.status?.linked && !this.status?.source_only) || !this.cm) return this.open();
      await this.reload();
      if (this.destroyed) return;
      if (this.status.draft_pdf) await this.loadPdf();
    }

    async reloadFile(file) { await buffersFor(this).refresh(file, { force: true }); }

    // ------------------------------------------------------------ Hide images
    // The working tree built a second time without figure, figure* and teaserfigure (whole floats, with
    // their captions), in a temporary folder on the server. While on, the pane shows that PDF read-only and
    // every build (Live or Recompile) makes both. Sources, the draft PDF, comments and versions are untouched.
    noFigControls() {
      this.noFigBtn = h('button', { class: 'pdfa-btn ws-nofig-btn', 'aria-pressed': 'false', text: 'Hide images',
        title: 'Show the paper without its figures (figure, figure*, teaser; tables stay) and its page count',
        tool: { id: 'workspace.hide-images', label: 'Hide images', showText: true, execute: () => this.o.action(() => this.setHideImages(!this.hideImages))  }});
      this.noFigInfo = h('span', { class: 'ws-nofig-info', role: 'status', hidden: true });
      return [this.noFigBtn, this.noFigInfo];
    }

    renderNoFig() {
      if (!this.noFigBtn) return;
      const on = this.hideImages, r = this.noFig, info = this.noFigInfo;
      this.noFigBtn.classList.toggle('on', on);
      this.noFigBtn.setAttribute('aria-pressed', String(on));
      info.hidden = !on;
      info.title = '';
      if (!on) return info.replaceChildren();
      const withFig = this.pagesWithFigures ? ` · ${this.pagesWithFigures} with` : '';
      if (!r) return info.replaceChildren('Building without figures…');
      if (!r.ok) return info.replaceChildren(h('span', { class: 'err', text: 'Build without figures failed' }), ' ',
        h('button', { class: 'ws-linkish', text: 'Log', tool: { id: 'workspace.nofig-log', label: 'Show build errors', showText: true, execute: () => this.renderLog({ ...r, label: 'Build without figures: errors' }, true)  }}));
      info.replaceChildren(`${r.pages ?? '?'} pages without figures${withFig}${this.noFigBuilding ? ' · updating…' : ''}`);
      info.title = `${removedText(r.removed)} Tables stay. Built ${new Date(r.at * 1000).toLocaleTimeString()} in a temporary folder; the sources, the draft PDF and versions are not changed.`;
    }

    async setHideImages(on) {
      this.hideImages = on;
      this.noFig = null;
      this.renderNoFig();
      if (on) await this.buildNoFigures();
      if (!this.destroyed && this.hideImages === on) await this.loadPdf();
    }

    // Build the files on disk without figures. Errors are kept in this.noFig (shown next to the button), not thrown.
    async buildNoFigures() {
      const run = ++this.noFigRun;
      this.noFigBuilding = true;
      this.renderNoFig();
      let r;
      try { r = await this.api('/no-figures', { method: 'POST', body: '{}' }); }
      catch (e) { r = { ok: false, errors: [e.message], log: e.message, at: Date.now() / 1000 }; }
      if (run !== this.noFigRun || this.destroyed) return null;
      this.noFigBuilding = false;
      if (this.hideImages) {
        this.noFig = r;
        if (!r.ok) this.say('Build without figures failed. Click Log next to Hide images.', true);
      }
      this.renderNoFig();
      return r;
    }

    // ------------------------------------------------------------ build and PDF
    scheduleLive() {
      clearTimeout(this.liveTimer);
      if (!this.live || !this.unsaved || this.destroyed) return;
      this.liveTimer = setTimeout(() => {
        if (this.destroyed || !this.live) return;
        if (this.compiling) { buildsFor(this).queue(); return; }
        this.compile({ live: true });
      }, 2000);
    }

    finishBuild(target, again = false) {
      if (this.destroyed) return;
      this.renderBuild();
      // Replay belongs to the completed target, never the currently selected source tab.
      if (again) setTimeout(() => {
        if (this.destroyed) return;
        return target.file ? this.compileActiveFile({ file: target.file, live: true })
          : this.compile({ live: true, paper: true });
      }, 0);
      else if (this.live && this.unsaved) this.scheduleLive();
    }

    async compileActiveFile({ live = false, file = this.file } = {}) {
      if (this.compiling) { if (live) buildsFor(this).queue(); return this.compiling; }
      if (!file || (!live && this.sourceMode?.value === 'entire')) return;
      clearTimeout(this.liveTimer);
      const target = { file };
      return buildsFor(this).run(target, async () => {
        try {
          await this.saveAll();
          const r = await this.api('/compile-active', { method: 'POST', body: JSON.stringify({ path: file }) });
          if (this.destroyed) return;
          this.lastBuild = { ...r, file, label: `Active file: ${file}` };
          this.renderLog(this.lastBuild, !live);
          if (!r.ok) {
            this.previewFailed = { file };
            this.say(`Could not compile ${file}. The previous PDF is still shown. See the build log.`, true); return;
          }
          this.previewFailed = null;
          this.activeFilePreview = r;
          await this.loadPdf();
          this.say(`Previewed ${file} in ${r.seconds}s. Recompile returns to the paper.`);
        } catch (e) {
          this.previewFailed = { file };
          this.lastBuild = { ok: false, file, errors: [e.message], log: e.message, label: `Active file: ${file}` };
          this.renderLog(this.lastBuild, !live);
          this.say(`${e.message} The previous PDF is still shown.`, true);
        }
      });
    }

    /** Build source-only documents using the existing editor and PDF pane.
     * @param {boolean} live Whether a background rebuild requested compilation.
     * @pre Source transport is configured and buffers are editable.
     * @post Saves precede compilation; errors retain buffers and the last PDF.
     * Successful Git linkage enters normal review; other builds reuse this split workspace.
     * @return {Promise<void>} Completion. @throws {Error} Failures reach the existing build boundary.
     */
    async #compileSource(live) {
      if (this.compiling) { buildsFor(this).queue(); return this.compiling; }
      clearTimeout(this.liveTimer);
      const target = { file: null };
      // Publication can switch source saves to review routes; freeze edits until that transition completes.
      const previousInert = this.root.inert; this.root.inert = true;
      return buildsFor(this).run(target, async () => {
        try {
          await this.saveAll();
          if (this.unsaved) throw new Error('Save all source changes before compiling.');
          const result = await this.#sourceSession.compile(this.status.main);
          if (this.destroyed) return;
          this.lastBuild = result; this.renderLog(result, !live);
          if (!result.ok) { this.say('Build failed. Source and the previous PDF remain available.', true); return; }
          if (result.linked) {
            const prefix = result.main?.slice(0, result.main.lastIndexOf('/') + 1) || '';
            const file = this.file?.startsWith(prefix) ? this.file.slice(prefix.length) : result.file;
            await this.o.onLinked({ ...result, file, view: this.view }); return;
          }
          this.status = await this.api('');
          if (this.destroyed) return;
          this.renderTop();
          await this.loadPdf();
          await this.loadCitations();
          this.say('PDF compiled and linked to this source.');
        } catch (error) {
          if (this.destroyed) return;
          this.lastBuild = { ok: false, errors: [error.message], log: error.message };
          this.renderLog(this.lastBuild, !live); this.say(error.message, true);
        } finally { this.root.inert = previousInert; }
      });
    }

    async compile({ live = false, paper = false } = {}) {
      if (this.#sourceSession) return this.#compileSource(live);
      if (live && !paper && this.activeFilePreview && !this.compiling) return this.compileActiveFile({ live: true, file: this.activeFilePreview.file });
      if (this.compiling) { buildsFor(this).queue(); return this.compiling; }
      clearTimeout(this.liveTimer);
      const target = { file: null };
      return buildsFor(this).run(target, async () => {
        try {
          await this.saveAll();
          // Hide images on: build the same files without figures at the same time (never throws).
          const noFig = this.hideImages ? this.buildNoFigures() : null;
          const r = await this.api('/compile', { method: 'POST', body: '{}' });
          if (this.destroyed) return;
          this.lastBuild = r;
          if (r.ok && r.pages) { this.pagesWithFigures = r.pages; this.renderNoFig(); }
          this.renderLog(r, !live);
          if (!r.ok) { this.say(`Build failed${live ? ' (live)' : ''}. Click the error count for the log.`, true); return; }
          const builds = this.status.builds;
          const fresh = await this.api('');
          await this.syncFiles();
          if (this.destroyed) return;
          this.status = { ...fresh, builds };
          this.renderTop(); this.applyMarks(); this.renderReview();
          if (noFig) await noFig;
          if (!live || paper) this.activeFilePreview = null;
          await this.loadPdf();
          await this.loadCitations();
          if (this.destroyed) return;
          const bad = this.citeProblems();
          const keys = [...new Set(bad.map((p) => p.key || 'empty \\cite{}'))];
          this.say(`Compiled in ${r.seconds}s · ${this.status.changes.length} change(s) and ${this.visibleNotes(false).length} open comment(s). Not a version yet.`
            + (bad.length ? ` ⚠ ${bad.length} citation problem(s), not in ${this.bibName()}: ${keys.slice(0, 4).join(', ')}${keys.length > 4 ? ', …' : ''}. See Review.` : ''), bad.length > 0);
        } catch (e) {
          this.lastBuild = { ok: false, errors: [e.message], log: e.message };
          this.renderLog(this.lastBuild, !live);
          this.say(e.message, true);
        }
      });
    }

    renderLog(r, open = true) {
      const items = (r.errors || []).map((line) => {
        const m = line.match(/^(?:\.\/)?(.+?\.tex):(\d+):\s*(.*)$/);
        return h('li', null, m ? h('button', { class: 'ws-linkish', text: `${m[1]}:${m[2]}`, tool: { id: 'workspace.log-location', label: 'Open error location', showText: true, execute: () => this.o.action(async () => {
          await this.openFile(m[1]); const pos = { line: +m[2] - 1, ch: 0 }; this.cm.setCursor(pos); this.cm.scrollIntoView(pos, 120); this.cm.focus();
        })  }}) : null, ' ', m ? m[3] : line);
      });
      this.log.replaceChildren(h('div', { class: 'ws-log-head' }, h('strong', { text: r.label || (r.ok ? 'Build log' : 'Build errors') }), h('button', { text: 'Close', tool: { id: 'workspace.close-log', label: 'Close build log', showText: true, execute: () => this.toggleLog(false)  }})),
        items.length ? h('ul', null, items) : null, h('pre', { text: r.log }));
      if (!r.ok && open) this.toggleLog(true);
      if (r.ok) this.toggleLog(false);
    }
    /** Toggle build output. Pre: log host exists; post: visible output has a close action in every view.
     * Restores saved build output on first use without triggering compilation. */
    toggleLog(show) {
      const visible = show === undefined ? this.log.hidden : !!show;
      if (visible && !this.log.firstChild) {
        const build = this.lastBuild || this.status.builds?.[this.status.builds.length - 1];
        this.renderLog(build || { ok: true, log: 'No build output has been recorded yet.' }, false);
      }
      this.log.hidden = !visible;
    }

    async loadPdf() {
      const keep = this.pdf ? { ratio: this.pdf.scroller.scrollTop / Math.max(1, this.pdf.scroller.scrollHeight), scale: this.pdf.scale } : null;
      await this.pdf?.destroy();
      const active = this.activeFilePreview;
      const noFig = !active && !!(this.hideImages && this.noFig?.ok);
      this.pdfMode = active ? 'active-file' : noFig ? 'no-figures' : 'draft';
      // Workspace-owned chrome stays mounted while PDF renderers are replaced.
      const chrome = { statusSlot: this.pdfStatus, showTitle: false };
      // Without figures the PDF is read-only: comments, changes and SyncTeX refer to the draft PDF.
      if (this.#sourceSession) this.pdf = new PdfAnnotator({
        ...chrome, pdfUrl: this.#sourceSession.previewUrl + '?t=' + Date.now(),
        annUrl: 'data:application/json,' + encodeURIComponent('{"version":1,"highlights":[],"strokes":[]}'),
        colors: this.o.colors, headers: { 'X-PDF-Token': this.o.token },
        readOnly: true, readOnlyLabel: 'Compiled PDF preview', bareBar: true, alignBars: false,
      });
      else if (active) this.pdf = new PdfAnnotator({
        ...chrome,
        pdfUrl: this.o.base + '/active-file/pdf?path=' + encodeURIComponent(active.file) + '&t=' + active.at,
        annUrl: 'data:application/json,' + encodeURIComponent('{"version":1,"highlights":[],"strokes":[]}'),
        colors: this.o.colors, readOnly: true, readOnlyLabel: `Active file: ${active.file} · read only`, bareBar: true, alignBars: false,
        headers: { 'X-PDF-Token': this.o.token }, barExtra: [this.previewInfo = h('span', { 'aria-live': 'polite', text: active.file, title: 'Live rebuilds this file after edits. Recompile builds the full paper.' }),
          this.previewReturnBtn = h('button', { class: 'pdfa-btn', text: 'Show paper', tool: { id: 'workspace.show-paper', label: 'Show paper', showText: true, execute: () => this.o.action(async () => {
            this.activeFilePreview = null; this.previewFailed = null; await this.loadPdf();
          })  }})],
      });
      else if (noFig) this.pdf = new PdfAnnotator({
        ...chrome,
        pdfUrl: this.o.base + '/no-figures/pdf?t=' + Date.now(),
        annUrl: 'data:application/json,' + encodeURIComponent('{"version":1,"highlights":[],"strokes":[]}'),
        colors: this.o.colors, readOnly: true, readOnlyLabel: 'Without figures · read only', bareBar: true, alignBars: false,
        headers: { 'X-PDF-Token': this.o.token }, barExtra: this.noFigBar,
      });
      else this.pdf = new PdfAnnotator({
        ...chrome,
        pdfUrl: this.o.base + '/pdf?t=' + Date.now(),
        annUrl: 'data:application/json,' + encodeURIComponent('{"version":1,"highlights":[],"strokes":[]}'),
        colors: this.o.colors, readOnly: false, bareBar: true, onCopyAll: (b) => this.o.action(() => this.copyForLlm(b)), alignBars: false, headers: { 'X-PDF-Token': this.o.token },
        barExtra: this.noFigBar,
        delegate: {
          mark: (h) => this.onToolMark(h),
          stroke: (s) => this.run(() => this.onToolStroke(s)),
          remove: (kind, item) => this.onToolRemove(kind, item),
          undo: () => this.run(() => this.step(this.history, this.future, 'undo')),
          redo: () => this.run(() => this.step(this.future, this.history, 'redo')),
          canUndo: () => this.history.length > 0, canRedo: () => this.future.length > 0,
        },
        onMarkClick: (m) => {
          if (this.pendingMark?.id === m.id) return this.toolNoteForm(m);
          const [type, id] = m.id.split(/-(.+)/);
          if (type === 'note' || type === 'change') this.select(type, id, { source: true, pdf: false });
        },
        onPagePoint: (page, x, y) => this.o.action(() => this.fromPdfPoint(page, x, y, true)),
      });
      if (this.destroyed) { await this.pdf.destroy(); this.pdf = null; return; }
      this.pdfPane.replaceChildren(this.pdf.root);
      this.pdf.root.title = this.#sourceSession ? 'Compiled PDF linked to this source.' : active ? `Standalone preview of ${active.file}. Live rebuilds this file after edits. Choose Show paper to return.` : noFig ? 'The paper without its figures, to see the page count. Turn off Hide images to comment.' : 'Double-click to open the source here. Select text to comment.';
      await this.pdf.open();
      if (this.destroyed) return;
      if (keep) {
        if (keep.scale !== null) this.pdf.setScale(keep.scale);
        this.pdf.scroller.scrollTop = keep.ratio * this.pdf.scroller.scrollHeight;
      }
      if (!active && !noFig && this.pdf.pages.length) this.pagesWithFigures = this.pdf.pages.length;
      this.renderNoFig();
      this.renderBuild();
      this.pageText = null;
      this.hints = new Map();
      this.srcTexts = new Map();
      await this.placeMarks();
    }

    async fromPdfPoint(page, x, y, useWord) {
      if (this.view === 'pdf') this.setView('both'); // double-click on the PDF opens its source
      const sel = window.getSelection();
      const word = useWord ? (sel?.toString() || '').trim() : '';
      const around = latexWords(sel?.anchorNode?.textContent || '');
      const where = await this.api(`/synctex/edit?page=${page}&x=${x.toFixed(2)}&y=${y.toFixed(2)}`);
      if (this.entire) await this.ensureFile(where.file); else await this.openFile(where.file);
      const entry = this.files.get(where.file);
      const text = entry.doc.getValue();
      const lines = text.split('\n');
      let start = lines.slice(0, where.line - 1).reduce((n, l) => n + l.length + 1, 0);
      let end = start;
      if (word && entry.doc.getValue() === entry.saved) {
        const i = pickOccurrence(lines[where.line - 1] || '', word, around);
        if (i >= 0) { start += i; end = start + word.length; }
      }
      await this.revealSource(where.file, start, end, false, true);
      this.say(`${where.file}, line ${where.line}${word ? ` · “${word}”` : ''}.`);
    }

    async pdfToSource() {
      if (this.pdfMode === 'active-file') throw new Error('This is a standalone file preview. Choose Show paper to use source/PDF navigation.');
      if (this.pdfMode === 'no-figures') throw new Error(NO_SYNC);
      if (!this.pdf?.pages?.length) throw new Error('No PDF yet.');
      const got = this.pdf.selectionRects();
      if (got) { const r = got.rects[0]; return this.fromPdfPoint(r.p, r.x + 2, r.y + r.h / 2, false); }
      const box = this.pdf.scroller.getBoundingClientRect();
      const hit = this.pdf.pageAt(box.left + box.width / 2, box.top + box.height / 2);
      if (!hit) throw new Error('Scroll the PDF to a page first.');
      const s = this.pdf.lastScale;
      return this.fromPdfPoint(hit.p.num, (box.left + box.width / 2 - hit.r.left) / s, (box.top + box.height / 2 - hit.r.top) / s, false);
    }

    async sourceToPdf() {
      if (this.pdfMode === 'active-file') throw new Error('This is a standalone file preview. Choose Show paper to use source/PDF navigation.');
      if (this.pdfMode === 'no-figures') throw new Error(NO_SYNC);
      if (!this.file || !this.pdf) throw new Error('No PDF yet.');
      const target = this.sourceLocation(this.cm.indexFromPos(this.cm.getCursor()));
      const text = this.files.get(target.file).doc.getValue();
      const line = text.slice(0, target.start).split('\n').length;
      const boxes = await this.api(`/synctex/view?path=${encodeURIComponent(target.file)}&line=${line}`);
      if (!boxes.length) throw new Error('That line has no position in the PDF. Recompile first.');
      this.pdf.scrollToRect(boxes[0].page, boxes[0].y);
    }

    async pageData() {
      if (this.pageText && this.pageTextFor === this.pdf) return this.pageText;
      const pdf = this.pdf, pdfjs = pdf.pdfjs;
      const data = await Promise.all(pdf.pages.map(async (p) => {
        const tc = await p.page.getTextContent();
        const items = tc.items.filter((i) => typeof i.str === 'string');
        return { p, items, words: pageWords(items), util: pdfjs.Util };
      }));
      if (pdf === this.pdf) { this.pageText = data; this.pageTextFor = pdf; } // never cache text of a replaced PDF
      return data;
    }

    // SyncTeX positions per build: cached, so reloads do not start one process per mark again.
    hint(file, line) {
      const key = file + ':' + line;
      if (!this.hints.has(key)) this.hints.set(key, this.api(`/synctex/view?path=${encodeURIComponent(file)}&line=${line}`).catch(() => []));
      return this.hints.get(key);
    }

    rectsFor(pd, from, to) {
      const rects = [];
      for (let i = from; i <= to; i++) {
        for (const part of pd.words[i].parts) {
          const item = pd.items[part.item];
          const tx = pd.util.transform(pd.p.base.transform, item.transform);
          const fh = Math.hypot(tx[2], tx[3]);
          const len = Math.max(1, item.str.length);
          const x = tx[4] + item.width * (part.start / len), w = item.width * ((part.end - part.start) / len);
          const r = { p: pd.p.num, x, y: tx[5] - fh * 0.85, w, h: fh * 1.1 };
          const last = rects[rects.length - 1];
          if (last && Math.abs(last.y - r.y) < fh * 0.4 && r.x >= last.x - 1 && r.x - (last.x + last.w) < fh * 2.5) last.w = r.x + r.w - last.x;
          else rects.push(r);
        }
      }
      return rects;
    }

    // First line of a float's caption on the PDF, from "Fig. N." (or "Table N"), or null.
    captionRects(pages, order, caption) {
      const target = latexWords(caption.text).slice(0, 6);
      if (!target.length) return null;
      for (const num of order) {
        const pd = pages[num - 1];
        if (!pd) continue;
        const span = findSpan(pd.words, target, []);
        if (!span || span.from === undefined) continue;
        let from = span.from;
        for (let k = 1; k <= 2 && from - k >= 0; k++) if (['fig', 'figure', 'table', 'tab'].includes(pd.words[from - k].w)) { from -= k; break; }
        const all = this.rectsFor(pd, from, Math.min(pd.words.length - 1, from + 40));
        const line = all.filter((r) => Math.abs(r.y - all[0].y) < all[0].h * 0.5);
        if (line.length) return line;
      }
      return null;
    }

    // Saved text of a source file: the open tab's, or fetched once per build.
    async sourceText(file) {
      const entry = this.files.get(file);
      if (entry) return entry.saved;
      this.srcTexts = this.srcTexts || new Map();
      if (!this.srcTexts.has(file)) this.srcTexts.set(file, this.api('/file?path=' + encodeURIComponent(file)).then((d) => d.text).catch(() => null));
      return this.srcTexts.get(file);
    }

    // Draw comments and changes on the PDF by finding their text on the page SyncTeX names.
    async placeMarks() {
      if (this.#sourceSession || !this.pdf?.pages?.length || this.pdfMode !== 'draft') return;
      const run = ++this.marksRun, pdf = this.pdf;
      const changeItems = [
        ...this.markedChanges().map((c) => ({ id: 'change-' + c.id, file: c.file, line: c.line, text: c.new, before: c.before, src: [c.new_start, c.new_end], color: (KIND[c.kind] || KIND.replaced).color,
          note: (c.kind === 'replaced' ? 'Replaced: ' + short(c.old, 600) : c.kind === 'removed' ? 'Removed: ' + short(c.old, 600) : 'Added') + (c.status === 'accepted' ? '\nAccepted' : '') })),
        ...this.visibleNotes().filter((n) => n.anchor !== 'lost').map((n) => ({ id: 'note-' + n.id, file: n.file, line: n.line, text: n.current ?? n.quote, before: n.before, src: [n.start, n.end],
          color: n.style?.color || 'yellow', type: n.style?.type || 'highlight', intent: n.style?.intent,
          note: n.comments.map((c) => `${c.author}: ${c.text}`).join('\n—\n') })),
      ];
      // Comments before changes: the eraser takes the first mark under the pointer.
      const items = [...changeItems.filter((x) => x.id.startsWith('note-')), ...changeItems.filter((x) => x.id.startsWith('change-'))];
      const pages = await this.pageData();
      const hints = await Promise.all(items.map((it) => this.hint(it.file, it.line)));
      // A change in a figure or table outside its caption text (the image, \Description, layout) has
      // no words in the PDF; it is shown on the caption's first line instead of SyncTeX's whole-float box.
      const texts = new Map(await Promise.all([...new Set(items.map((it) => it.file))].map(async (f) => [f, await this.sourceText(f)])));
      const floatOf = (it) => {
        const text = texts.get(it.file);
        if (!text || !it.src || it.src[0] == null) return null;
        const a = cpToUnits(text, it.src[0]), b = cpToUnits(text, it.src[1] ?? it.src[0]);
        const f = floatOutsideCaption(text, a, b);
        // Inside: nothing but comments and blank space outside the float (a figure file's header comments).
        const rest = text.slice(a, Math.max(a, f?.start ?? a)) + text.slice(Math.min(b, f?.end ?? b), b);
        return f && { caption: f.caption, inside: !stripComments(rest).trim() };
      };
      // Text inside a LaTeX comment prints nothing. Its words must not be matched elsewhere, and SyncTeX
      // names the next box instead, which can be a whole float (taller than the page, starting above it).
      const stripped = new Map([...texts].map(([f, t]) => [f, t == null ? null : stripComments(t)]));
      const inComment = (it) => {
        const text = texts.get(it.file), clean = stripped.get(it.file);
        if (!text || !it.src || it.src[0] == null) return false;
        const a = cpToUnits(text, it.src[0]), b = cpToUnits(text, it.src[1] ?? it.src[0]);
        const lineStart = text.lastIndexOf('\n', a - 1) + 1;
        const opened = clean.slice(lineStart, a) !== text.slice(lineStart, a) || text[a] === '%';
        return opened && !clean.slice(a, b).trim();
      };
      // SyncTeX boxes are only a position: clip them to the page, and show a box taller than
      // three lines (a float, a display) as a short bar at its top-left corner.
      const fitBox = (b) => {
        const base = pages[b.page - 1]?.p.base;
        if (!base) return null;
        const bar = b.h > 40 || b.w > base.width;
        const y = Math.min(Math.max(0, b.y), base.height - 12), x = Math.min(Math.max(0, b.x), base.width - 3);
        if (bar) return { p: b.page, x, y, w: 3, h: 12 };
        const w = Math.min(b.w, base.width - x), h = Math.min(b.h, base.height - y);
        return w > 0 && h > 0 ? { p: b.page, x, y, w, h } : null;
      };
      if (run !== this.marksRun || pdf !== this.pdf || this.destroyed) return;
      const marks = [];
      items.forEach((it, n) => {
        const target = latexWords(it.text), context = latexWords(it.before || '');
        const hint = hints[n];
        const order = [...new Set([...hint.map((b) => b.page), ...pages.map((pd) => pd.p.num)])];
        let rects = null, approximate = false, onCaption = false, commented = false;
        const float = floatOf(it);
        if (float?.caption && float.inside && it.id.startsWith('change-')) { rects = this.captionRects(pages, order, float.caption); onCaption = !!rects; }
        if (!rects && inComment(it)) {
          // Shown as a bar where the next printed text starts; nothing else is searched.
          commented = true;
          const b = hint.length ? fitBox(hint[0]) : null;
          rects = b ? [{ ...b, w: 3, h: Math.min(b.h, 12) }] : [];
        }
        for (const num of rects ? [] : order) {
          const pd = pages[num - 1];
          if (!pd) continue;
          const span = findSpan(pd.words, target, context);
          if (!span) continue;
          if (span.at !== undefined) { const [r] = this.rectsFor(pd, span.at, span.at); rects = [{ ...r, x: r.x + r.w, w: 3 }]; }
          else rects = this.rectsFor(pd, span.from, span.to);
          approximate = !!span.approximate;
          break;
        }
        if (!rects && float?.caption) { rects = this.captionRects(pages, order, float.caption); onCaption = !!rects; }
        if (!rects && hint.length) { rects = hint.slice(0, 2).map(fitBox).filter(Boolean); approximate = true; }
        if (!rects?.length) return;
        const words = it.note + (onCaption ? '\n(In the figure or table itself: shown on its caption.)' : commented ? '\n(In a LaTeX comment, not printed: shown where the next text starts.)' : approximate ? '\n(position approximate)' : '');
        marks.push({ id: it.id, type: it.type || 'highlight', ...(it.intent ? { intent: it.intent } : {}), color: it.color, page: rects[0].p, rects, text: short(it.text, 600),
          comments: words.trim() ? [{ text: words }] : [] });
      });
      const strokes = await this.placeStrokes(run);
      if (run !== this.marksRun || pdf !== this.pdf || this.destroyed) return;
      this.marks = marks;
      this.pdf.setMarks(marks, strokes);
      if (this.selected) this.pdf.flash(`${this.selected.type}-${this.selected.id}`);
    }

    // Pen strokes follow their anchor words; strokes without an anchor stay where they were drawn.
    async placeStrokes(run) {
      const pages = await this.pageData();
      const out = [];
      for (const s of this.status.strokes || []) {
        let page = s.page, dx = 0, dy = 0;
        const a = s.anchor;
        if (Array.isArray(a?.words) && a.words.length) { // anchors from other formats are ignored
          const order = [s.page, ...pages.map((pd) => pd.p.num).filter((n) => n !== s.page)];
          for (const num of order) {
            const pd = pages[num - 1];
            const span = pd && findSpan(pd.words, a.words, a.context || []);
            if (!span || span.from === undefined) continue;
            const [r] = this.rectsFor(pd, span.from, span.from);
            page = num; dx = r.x + a.dx - s.points[0][0]; dy = r.y + a.dy - s.points[0][1];
            break;
          }
        }
        out.push({ id: 'stroke-' + s.id, page, color: s.color, width: s.width, points: s.points.map(([x, y]) => [x + dx, y + dy]) });
      }
      return run === this.marksRun ? out : undefined;
    }

    // ------------------------------------------------------------ promotion
    async promote() {
      if (this.buildTarget) throw new Error('Wait for compilation to finish before saving a version.');
      if (this.unsaved) throw new Error('Save your edits first (⌘/Ctrl+S).');
      await this.reload();
      const c = this.status.changes;
      if (!c.length) throw new Error('There are no changes to save.');
      const open = c.filter((x) => x.status !== 'accepted').length;
      const notes = this.visibleNotes(false).length;
      const files = [...new Set(c.map((x) => x.file))].join(', ');
      const ok = confirm(`Save the draft as V${this.status.base_number + 1}?\n\n` +
        `• Commits ${c.length} change(s) in ${files} to git on the current branch (only these files).\n` +
        `• Builds the PDF from that commit and imports it as V${this.status.base_number + 1}. If anything fails, nothing is committed.\n` +
        `• Change history, resolved comments and pen strokes stay with V${this.status.base_number}.` +
        (notes ? `\n• ${notes} open comment(s) continue in the new draft.` : '') +
        (open ? `\n\n${open} change(s) are not accepted yet.` : '') + '\n\nNothing is pushed.');
      if (!ok) return;
      this.say('Committing and building the new version…');
      this.root.inert = true;
      let r;
      try { r = await this.api('/promote', { method: 'POST', body: '{}' }); }
      finally { this.root.inert = false; }
      await this.o.onPromoted(r.document, r.commit, r.warning);
    }
  }
  // Public, pure source operations shared by integrations and tests.
  Object.assign(Workspace, { commentEdit, citeUses, citeContext, citeMatches, combinedSource, projectionRange, projectionSpans, applyProjectionEdit });
  window.Workspace = Workspace;
})();
