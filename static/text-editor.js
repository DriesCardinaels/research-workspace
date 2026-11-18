/* Independent UTF-8 editing; this module never compiles or creates paper versions. */
'use strict';
(function () {
  class TextSession {
    #doc; #saved; #sha; #persist; #saveQueue = new window.SourceSaveQueue(); #file;
    /** Own one buffer and its optimistic save revision.
     * @param {object} snapshot Exact file/text/SHA response.
     * @param {Function} persist Save operation returning the accepted SHA.
     * @param {string|null} mode CodeMirror mode.
     * @pre Snapshot is read successfully. @post Independent undo history is created.
     * @return {TextSession} Session. @throws {Error} Editor initialization failure.
     */
    constructor(snapshot, persist, mode = null) {
      this.#file = snapshot.file; this.#saved = snapshot.text; this.#sha = snapshot.sha; this.#persist = persist;
      this.#doc = CodeMirror.Doc(snapshot.text, mode, 0, /\r\n/.test(snapshot.text) ? '\r\n' : null);
    }
    /** Read stable identity. @param {void} none. @pre Initialized.
     * @post No changes. @return {string} Relative path. @throws {void} None.
     */
    get file() { return this.#file; }
    /** Read dirty state. @param {void} none. @pre Initialized.
     * @post No changes. @return {boolean} Unsaved changes. @throws {void} None.
     */
    get unsaved() { return this.#doc.getValue() !== this.#saved; }
    /** Attach the buffer through the editor adapter, preserving history and selections.
     * @param {CodeMirror} editor Host-owned editor. @pre Same CodeMirror runtime.
     * @post Editor displays this buffer. @return {void} Nothing. @throws {Error} Editor failure.
     */
    attach(editor) { if (editor.getDoc() !== this.#doc) editor.swapDoc(this.#doc); }
    /** Read immutable history availability. @param {void} none. @pre Initialized.
     * @post No changes. @return {object} History counts. @throws {void} None.
     */
    history() { return Object.freeze({ ...this.#doc.historySize() }); }
    /** Undo one editor change. @param {void} none. @pre Editable session.
     * @post Native history and selections update. @return {void} Nothing. @throws {Error} Editor failure.
     */
    undo() { this.#doc.undo(); }
    /** Redo one editor change. @param {void} none. @pre Editable session.
     * @post Native history and selections update. @return {void} Nothing. @throws {Error} Editor failure.
     */
    redo() { this.#doc.redo(); }
    /** Read text through the public session interface. @param {void} none. @pre Initialized.
     * @post No changes. @return {string} Exact content. @throws {void} None.
     */
    getText() { return this.#doc.getValue(); }
    /** Read selected text without exposing editor storage. @param {void} none.
     * @pre Initialized. @post No changes. @return {string} Selection. @throws {void} None.
     */
    getSelection() { return this.#doc.getSelection(); }
    /** Replace selected text as one native history operation.
     * @param {string} text Literal replacement. @pre Editable session.
     * @post Selection is replaced; dirty state follows the buffer.
     * @return {void} Nothing. @throws {TypeError|Error} Invalid text or editor failure.
     */
    replaceSelection(text) { if (typeof text !== 'string') throw new TypeError('Selection replacement must be text'); this.#doc.replaceSelection(text, 'around', 'format-selection'); }
    /** Replace a verified UTF-16 range for a note annotation action.
     * @pre Offsets identify the expected text in this session.
     * @post One undoable edit; stale annotations leave the buffer unchanged.
     * @throws {Error|TypeError} Stale range or invalid arguments. Related: notes comments.
     */
    replaceTextRange(start, end, text, expected) {
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > this.getText().length || typeof text !== 'string') throw new TypeError('Invalid text range');
      if (this.getText().slice(start, end) !== expected) throw new Error('This comment changed. Reopen comments before editing.');
      this.#doc.replaceRange(text, this.#doc.posFromIndex(start), this.#doc.posFromIndex(end), 'note-annotation');
    }
    /** Transform complete selected lines, or the cursor line, as one native edit.
     * @param {Function} transform Receives each complete line and returns replacement text.
     * @pre Editable session; callback returns a string for every line.
     * @post Native newlines and undo history are preserved; replaced lines remain selected.
     * @return {void} Nothing. @throws {TypeError|Error} Invalid callback/result or editor failure.
     * Used by block formatting without exposing the native document to Tools.
     */
    transformLines(transform) {
      if (typeof transform !== 'function') throw new TypeError('Line transformation must be callable');
      const from = this.#doc.getCursor('from'), to = this.#doc.getCursor('to');
      const last = to.line > from.line && to.ch === 0 ? to.line - 1 : to.line;
      const start = { line: from.line, ch: 0 }, end = { line: last, ch: this.#doc.getLine(last).length };
      const newline = this.#doc.lineSeparator() || '\n';
      const replacement = this.#doc.getRange(start, end).split(/\r?\n/).map(line => {
        const result = transform(line); if (typeof result !== 'string') throw new TypeError('Line transformation must return text'); return result;
      }).join(newline);
      const index = this.#doc.indexFromPos(start);
      this.#doc.replaceRange(replacement, start, end, 'format-lines');
      this.#doc.setSelection(start, this.#doc.posFromIndex(index + replacement.length));
    }
    /** Save a snapshot, retaining edits made while the request was pending.
     * @param {void} none. @pre Persist operation enforces SHA conflicts.
     * @post Accepted snapshot becomes saved; rejected saves retain buffer and revision.
     * @return {Promise<void>} Completion. @throws {Error} Save/conflict failure; host reports it.
     */
    async save() {
      await this.#saveQueue.save(
        () => ({ text: this.#doc.getValue(), saved: this.#saved, sha: this.#sha }),
        value => this.#persist(value),
        (text, response) => { this.#saved = text; this.#sha = response.sha; });
    }
    /** Release queued writes while retaining already running IO until settlement.
     * @param {void} none. @pre Session may be active. @post No unstarted save can publish.
     * @return {void} Nothing. @throws {void} None.
     */
    dispose() { this.#saveQueue.dispose(); }
    /** Accept an external revision only when local work is saved.
     * @param {object} snapshot Exact text and SHA for this file.
     * @pre No pending save or unsaved edit. @post Revision updates; changed text resets obsolete history.
     * @return {void} Nothing. @throws {Error} Dirty session or identity mismatch.
     */
    reload(snapshot) {
      if (this.unsaved || this.#saveQueue.pending || snapshot.file !== this.file) throw new Error('Save local text changes before reloading');
      if (snapshot.text !== this.#saved) { this.#doc.setValue(snapshot.text); this.#doc.clearHistory(); }
      this.#saved = snapshot.text; this.#sha = snapshot.sha;
    }
  }
  class TextWorkspace {
    #api; #base; #message; #onFile; #sessions = new Map(); #active; #editor; #tabs; #status; #tools; #mounts = []; #abort = new AbortController(); #destroyed = false; #openRun = 0; #capabilities; #content; #preview;
    #sourcePane; #previewPane; #previewTitle; #headerTools; #viewSwitch; #divider; #dragging = false; #ratio = .5; #writingView;
    /** Create a generic editor host with filetype-owned toolbar contributions.
     * @param {object} options Authenticated api, project base and message callback.
     * @pre FileTypes and EditorTools are loaded. @post Empty host owns its editor lifecycle.
     * @return {TextWorkspace} Host. @throws {Error} DOM/editor failures.
     */
    constructor({ api, base, message, onFile = () => {}, capabilities = () => ({}) }) {
      this.#api = api; this.#base = base; this.#message = message; this.#onFile = onFile; this.#capabilities = capabilities;
      this.root = document.createElement('section'); this.root.className = 'text-workspace ws';
      this.#headerTools = document.createElement('div'); this.#headerTools.className = 'ws-header-tools text-header-tools'; this.#headerTools.hidden = true;
      this.#viewSwitch = document.createElement('div'); this.#viewSwitch.className = 'ws-view';
      this.#viewSwitch.setAttribute('role', 'group'); this.#viewSwitch.setAttribute('aria-label', 'Layout');
      for (const [mode, label, info] of [['edit', 'Source', 'Show raw source'], ['split', 'Both', 'Show source and preview side by side'], ['preview', 'Preview', 'Show rendered document']]) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.dataset.view = mode;
        window.EditorTools.Tool.bind(button, { id: 'text.view.' + mode, label, info, showText: true, execute: () => this.setPreviewMode(mode) }, { run: command => this.#run(command) });
        this.#viewSwitch.append(button);
      }
      this.#headerTools.append(this.#viewSwitch);
      this.#tabs = document.createElement('div'); this.#tabs.className = 'text-tabs ws-file-strip'; this.#tabs.setAttribute('role', 'tablist');
      this.#tools = document.createElement('div'); this.#tools.className = 'text-tools ws-left-top';
      const editor = document.createElement('div'); editor.className = 'text-editor';
      this.#status = document.createElement('footer'); this.#status.className = 'text-status ws-statusbar'; this.#status.setAttribute('role', 'status');
      this.#content = document.createElement('div'); this.#content.className = 'text-content ws-main';
      this.#sourcePane = document.createElement('section'); this.#sourcePane.className = 'text-source-pane ws-source-column'; this.#sourcePane.setAttribute('aria-label', 'Source editor');
      this.#sourcePane.append(this.#tabs, this.#tools, editor);
      this.#previewPane = document.createElement('section'); this.#previewPane.className = 'text-preview-pane ws-right'; this.#previewPane.setAttribute('aria-label', 'Rendered preview');
      this.#previewTitle = document.createElement('div'); this.#previewTitle.className = 'ws-preview-header'; this.#previewTitle.textContent = 'Document preview';
      this.#previewPane.append(this.#previewTitle);
      this.#divider = document.createElement('div'); this.#divider.className = 'text-divider ws-split'; this.#divider.tabIndex = 0;
      for (const [name, value] of Object.entries({ role: 'separator', 'aria-label': 'Resize source and preview', 'aria-orientation': 'vertical', 'aria-valuemin': '25', 'aria-valuemax': '75', 'aria-valuenow': '50' })) this.#divider.setAttribute(name, value);
      this.#divider.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
        event.preventDefault(); this.setSplitRatio(event.key === 'Home' ? .5 : this.#ratio + (event.key === 'ArrowLeft' ? -.05 : .05));
      }, { signal: this.#abort.signal });
      this.#divider.addEventListener('pointerdown', event => { if (event.button !== 0) return; event.preventDefault(); this.#dragging = true; this.#divider.setPointerCapture(event.pointerId); }, { signal: this.#abort.signal });
      this.#divider.addEventListener('pointermove', event => { if (!this.#dragging) return; const rect = this.#content.getBoundingClientRect(); if (rect.width) this.setSplitRatio((event.clientX - rect.left) / rect.width); }, { signal: this.#abort.signal });
      for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) this.#divider.addEventListener(name, () => { this.#dragging = false; }, { signal: this.#abort.signal });
      this.#content.append(this.#sourcePane, this.#divider, this.#previewPane);
      this.root.append(this.#headerTools, this.#content, this.#status);
      this.#editor = CodeMirror(editor, { value: '', lineNumbers: true, lineWrapping: true, mode: null });
      this.#editor.on('change', () => this.#refresh());
      this.#editor.on('cursorActivity', () => this.#refresh());
    }
    /** Measure the generic editor after navigation attaches its root.
     * @param {object} options Optional headerSlot for shared document-level layout controls.
     * @pre Root is attached to the visible viewer. @post CodeMirror paints at the visible size.
     * Buffers and histories are retained. @return {Promise<void>} First visible frame.
     * @throws {Error} Measurement failures reach the navigation boundary.
     */
    async mount(options = {}) {
      if (this.#destroyed) return;
      if (options.headerSlot) options.headerSlot.replaceChildren(this.#headerTools);
      await new Promise((resolve, reject) => {
        let finished = false;
        const measure = () => {
          if (finished) return; finished = true; clearTimeout(fallback);
          try { if (!this.#destroyed) this.#editor.refresh(); resolve(); }
          catch (error) { reject(error); }
        };
        // Native webviews can suspend animation frames while their window is inactive.
        const fallback = setTimeout(measure,100); requestAnimationFrame(measure);
      });
      if (!this.#destroyed) await this.#writingView?.mount?.();
    }

    /** Read all-buffer dirty state. @param {void} none. @pre Host exists.
     * @post No changes. @return {boolean} Any unsaved file. @throws {void} None.
     */
    get unsaved() { return [...this.#sessions.values()].some(entry => entry.session.unsaved); }
    /** Read active path. @param {void} none. @pre Host exists.
     * @post No changes. @return {string|undefined} Path. @throws {void} None.
     */
    get file() { return this.#active?.session.file; }
    /** Read the authorized source root identity. @param {void} none.
     * @pre Host exists. @post No changes. @return {string|null} Paper id or project root.
     * @throws {void} None.
     */
    get sourceDocument() { return this.#active?.sourceDocument || null; }
    /** Activate a cached buffer or load one without replacing the active file on read failure.
     * @param {string} file Relative path. @param {string|null} sourceDocument Authorized source root.
     * @pre Provider supports independent editing. @post Per-file histories and dirty buffers survive switches.
     * @return {Promise<void>} Activation. @throws {Error} Unsupported type or read failure.
     */
    async openFile(file, sourceDocument = null) {
      const run = ++this.#openRun;
      const provider = window.FileTypes.registry.resolve(file);
      if (!provider?.capabilities.text) throw new Error('This file type has no text editor');
      const key = JSON.stringify([sourceDocument, file]);
      let entry = this.#sessions.get(key);
      if (!entry) {
        const query = new URLSearchParams({ path: file }); if (sourceDocument) query.set('source_document', sourceDocument);
        const snapshot = await this.#api(this.#base + '/text-file?' + query);
        if (this.#destroyed) return;
        entry = { key, provider, sourceDocument, session: new TextSession(snapshot, update => this.#api(this.#base + '/text-file', { method: 'PUT', body: JSON.stringify({ ...update, path: file, source_document: sourceDocument }) }), provider.mode || null) };
        this.#sessions.set(key, entry);
      }
      if (run !== this.#openRun) return;
      if (this.#active) this.#active.writingMode = this.#writingView?.mode;
      this.#writingView?.dispose(); this.#writingView = null;
      this.#preview?.dispose(); this.#preview = null;
      this.#active = entry; entry.session.attach(this.#editor);
      this.#writingView = window.TextEditorViews?.get(provider.id)?.(this.#editor, entry.writingMode, this.#context());
      this.#preview = window.TextPreviews.get(provider.id)?.({
        file, openFile: path => this.#run(() => this.openFile(path, sourceDocument)), imageURL: path => {
          const query = new URLSearchParams({ path }); if (sourceDocument) query.set('source_document', sourceDocument);
          return this.#base + '/image-file?' + query;
        },
      });
      if (this.#preview) this.#previewPane.append(this.#preview.element);
      this.#previewTitle.textContent = this.#preview?.label || 'Document preview';
      this.#content.dataset.view = this.#preview ? (entry.view || 'split') : 'edit';
      for (const mount of this.#mounts) mount.dispose();
      this.#tools.replaceChildren();
      this.#mounts = (provider.standaloneToolbarAreas || provider.toolbarAreas).map(area => window.EditorTools.registry.mount(area, this.#context(), provider.label + ' tools'));
      for (const mount of this.#mounts) this.#tools.append(mount.element);
      this.#refresh(); this.#editor.refresh(); this.#editor.focus(); this.#onFile();
      if (this.root.isConnected) await this.#writingView?.mount?.();
    }
    /** Save every dirty buffer. @param {void} none. @pre Host is active.
     * @post Successful buffers are saved; failures preserve all remaining edits.
     * @return {Promise<void>} Completion. @throws {Error} First save failure.
     */
    async saveAll() { for (const { session } of this.#sessions.values()) await session.save(); this.#refresh(); }
    /** Reconnect the same buffers after a server session refresh.
     * @param {string} base Current authenticated project route.
     * @pre Same project root. @post Future reads/saves use the renewed route.
     * @return {void} Nothing. @throws {TypeError} Invalid route.
     */
    reconnect(base) { if (typeof base !== 'string' || !base.startsWith('/api/projects/')) throw new TypeError('Choose a project route'); this.#base = base; }
    /** Reload saved buffers without replacing local edits on failure.
     * @param {void} none. @pre Caller has saved local work.
     * @post External revisions are reflected; all controls are restored on failure.
     * @return {Promise<void>} Completion. @throws {Error} Read failure or unsaved changes.
     */
    async refreshFromDisk() {
      if (this.unsaved) throw new Error('Save text changes before reloading');
      this.root.inert = true;
      try {
        const snapshots = await Promise.all([...this.#sessions.values()].map(async entry => {
          const query = new URLSearchParams({ path: entry.session.file }); if (entry.sourceDocument) query.set('source_document', entry.sourceDocument);
          return [entry.session, await this.#api(this.#base + '/text-file?' + query)];
        }));
        for (const [session, snapshot] of snapshots) session.reload(snapshot);
        this.#refresh();
      } finally { this.root.inert = false; }
    }
    /** Supply narrow capabilities to Tools. @param {void} none. @pre Active file.
     * @post No mutation. @return {object} Current session and recovery interface. @throws {void} None.
     */
    #context() { return { ...this.#capabilities(), session: this.#active?.session, writingView: this.#writingView, message: (text, error = false) => this.#message(text, error), unsaved: this.unsaved, saveAll: () => this.saveAll(), fileType: this.#active?.provider.id, keyTarget: this.root, view: 'source', previewMode: this.#content.dataset.view, setPreviewMode: mode => this.setPreviewMode(mode), openSidePreview:(id,factory,target) => this.openSidePreview(id,factory,target), run: command => this.#run(command) }; }
    /** Report whether the current buffer can host a project PDF beside it.
     * @pre Text workspace exists. @post No editor changes. @throws {void} None.
     */
    get canPreviewProjectPdf() { return !!(this.#writingView && window.NoteSources && window.NotePdfPreview); }
    /** Show a workspace PDF using the existing note preview.
     * @pre Active note and validated project PDF URL. @post Text and history stay intact.
     * @throws {Error} Unsupported preview or PDF load failure. Related: openSidePreview.
     */
    previewProjectPdf(href, name) {
      if (!this.canPreviewProjectPdf) throw new Error('The active file cannot preview a PDF.');
      return window.NoteSources.preview(href,this.#context(),undefined,name);
    }
    /** Mount a filetype-owned side preview in the shared resizable workspace.
     * @pre Factory supplies element/update/show/dispose; active note owns the request.
     * @post Existing buffer/history remain; repeated opens reuse the same preview.
     * @throws {Error} Preview or rendering failure leaves the source editor intact.
     */
    async openSidePreview(id, factory, target) {
      if (this.#destroyed) return;
      const entry = this.#active;
      if (this.#preview?.id !== id) {
        const candidate = factory();
        if (!candidate?.element || !['update','show','dispose'].every(method=>typeof candidate[method]==='function')) throw new TypeError('Side previews need element, update, show and dispose');
        this.#preview?.dispose(); this.#preview = candidate; this.#previewPane.append(candidate.element);
      }
      const preview = this.#preview;
      this.#previewTitle.textContent = preview.label || 'Document preview';
      this.#content.dataset.view = entry.view = 'split'; this.#refresh(); this.#editor.refresh();
      await new Promise(resolve=>{ const fallback = setTimeout(resolve,100); requestAnimationFrame(()=>{clearTimeout(fallback);resolve();}); });
      if (this.#destroyed || entry !== this.#active || preview !== this.#preview) return;
      await preview.show(target);
    }
    /** Switch a contributed preview without replacing its native buffer.
     * @param {string} mode edit, split or preview. @pre Active preview provider.
     * @post Per-file mode is retained; editor history and dirty state are preserved.
     * @return {void} Nothing. @throws {Error} Unsupported mode or missing preview.
     */
    setPreviewMode(mode) {
      if (!this.#preview || !['edit', 'split', 'preview'].includes(mode)) throw new Error('Choose an available preview mode');
      this.#active.view = mode; this.#content.dataset.view = mode; this.#refresh(); this.#editor.refresh();
      if (mode !== 'preview') this.#editor.focus();
    }
    /** Resize the shared source/preview columns. @param {number} ratio Source fraction.
     * @pre Finite ratio. @post Ratio is confined to 25–75%; native buffers survive.
     * @return {void} Nothing. @throws {TypeError} Nonfinite ratio.
     */
    setSplitRatio(ratio) {
      if (!Number.isFinite(ratio)) throw new TypeError('Split ratio must be finite');
      this.#ratio = Math.min(.75, Math.max(.25, ratio));
      this.#content.style.setProperty('--text-source-ratio', this.#ratio + 'fr');
      this.#content.style.setProperty('--text-preview-ratio', (1 - this.#ratio) + 'fr');
      this.#divider.setAttribute('aria-valuenow', String(Math.round(this.#ratio * 100))); this.#editor.refresh();
    }
    /** Refresh contributed Tool state after an external capability changes.
     * @param {void} none No arguments. @pre Host exists.
     * @post Controls retain identity and reflect current capabilities.
     * @return {void} Nothing. @throws {Error} Contribution refresh failure.
     */
    refreshTools() { this.#refresh(); }
    /** Report failures at the interaction seam. @param {Function} command User action.
     * @pre Host exists. @post Errors are visible and buffers retained.
     * @return {Promise<*>} Result. @throws {void} None when reporting is available.
     */
    async #run(command) { try { const result = await command(); this.#refresh(); return result; } catch (error) { this.#message(error.message, true); this.#refresh(); } }
    /** Refresh toolbar state and file tabs without recreating toolbar controls.
     * @param {void} none. @pre Editor exists. @post Dirty indicators and Tool states reflect buffers.
     * @return {void} Nothing. @throws {Error} Tool refresh failure.
     */
    #refresh() {
      if (this.#destroyed) return;
      const mode = this.#content.dataset.view;
      this.#sourcePane.hidden = !!this.#preview && mode === 'preview';
      this.#previewPane.hidden = !this.#preview || mode === 'edit';
      this.#divider.hidden = !this.#preview || mode !== 'split';
      this.#headerTools.hidden = !this.#preview;
      this.root.classList.toggle('text-has-preview', !!this.#preview);
      for (const button of this.#viewSwitch.children) { button.textContent = this.#preview?.viewLabels?.[button.dataset.view] || {edit:'Source',split:'Both',preview:'Preview'}[button.dataset.view]; button.setAttribute('aria-label',button.textContent); button.classList.toggle('on', button.dataset.view === mode); button.setAttribute('aria-pressed', String(button.dataset.view === mode)); }
      if (this.#preview && this.#content.dataset.view !== 'edit') this.#preview.update(this.#active.session.getText());
      for (const mount of this.#mounts) mount.refresh(this.#context());
      this.#tabs.replaceChildren();
      for (const entry of this.#sessions.values()) {
        const tab = document.createElement('button'); tab.type = 'button'; tab.textContent = entry.session.file + (entry.session.unsaved ? ' •' : '');
        tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(entry === this.#active));
        window.EditorTools.Tool.bind(tab, { id: 'text.open-tab', label: 'Open ' + entry.session.file, showText: true,
          execute: () => this.openFile(entry.session.file, entry.sourceDocument) }, { run: command => this.#run(command) }); this.#tabs.append(tab);
      }
      this.#status.textContent = this.unsaved ? 'Unsaved changes · Ctrl/Cmd+S to save' : 'All changes saved';
    }
    /** Release toolbar contributions and editor references after the caller saves.
     * @param {void} none. @pre Caller has preserved unsaved work.
     * @post Host listeners and DOM are removed. @return {void} Nothing. @throws {void} None.
     */
    destroy() { this.#destroyed = true; this.#abort.abort(); this.#writingView?.dispose(); this.#preview?.dispose(); this.#preview = null; for (const mount of this.#mounts) mount.dispose(); this.#mounts = []; for (const button of this.#viewSwitch.children) window.EditorTools.Tool.unbind(button); this.#headerTools.remove(); for (const entry of this.#sessions.values()) entry.session.dispose(); this.#sessions.clear(); this.#active = null; this.#editor.getWrapperElement().remove(); this.root.remove(); }
  }
  const registry = window.EditorTools.registry;
  registry.contribute('text.actions', { id: 'text.save', label: 'Save files', info: 'Save all open text files', icon: 'save', shortcut: 'Ctrl/Cmd+S', enabled: ({ unsaved }) => !!unsaved, execute: ({ saveAll }) => saveAll() });
  registry.contribute('text.actions', { id: 'text.undo', label: 'Undo', icon: 'undo', enabled: ({ session }) => !!session?.history().undo, execute: ({ session }) => session.undo() });
  registry.contribute('text.actions', { id: 'text.redo', label: 'Redo', icon: 'redo', enabled: ({ session }) => !!session?.history().redo, execute: ({ session }) => session.redo() });
  window.TextSession = TextSession; window.TextWorkspace = TextWorkspace;
  const views = new Map();
  window.TextEditorViews = Object.freeze({
    /** Register an editable presentation factory for a filetype.
     * @pre Unique id and callable factory. @post Future hosts can attach the view.
     * @throws {TypeError} Invalid registration. Related: TextWorkspace.openFile.
     */
    register(id, factory) { if (!id || typeof factory !== 'function' || views.has(id)) throw new TypeError('Editor view requires a unique filetype and factory'); views.set(id, factory); },
    /** Resolve a presentation. @pre Registry exists. @post No mutation.
     * @returns {Function|undefined} Factory. @throws {void} None.
     */
    get(id) { return views.get(id); },
  });
  const previews = new Map();
  window.TextPreviews = Object.freeze({
    /** Register a trusted filetype preview factory. @param {string} id Catalog ID.
     * @param {Function} factory Returns element/update(text)/dispose(). @pre Unique ID.
     * @post Future hosts can compose this preview. @return {void} Nothing. @throws {TypeError} Invalid registration.
     */
    register(id, factory) { if (!id || typeof factory !== 'function' || previews.has(id)) throw new TypeError('Preview requires a unique filetype and factory'); previews.set(id, factory); },
    /** Resolve a preview factory. @param {string} id Filetype ID. @pre Registry loaded.
     * @post No changes. @return {Function|undefined} Factory. @throws {void} None.
     */
    get(id) { return previews.get(id); },
  });
})();
