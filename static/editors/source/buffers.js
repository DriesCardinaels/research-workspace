/* Native source documents and revisions have one owner; callers receive public adapters/snapshots. */
'use strict';
(() => {
  class SourceBuffer {
    #document; #saved; #sha; #stale = false; #file; #view; #queue; #persist; #disposed = false;
    #anchors = new Set();
    /** Create one native buffer behind an immutable public editor adapter.
     * @param {object} snapshot Exact file/text/SHA response.
     * @param {object} dependencies Native document factory, mode, shared save queue and persistence callable.
     * @pre Snapshot came from the authorized source transport; factory preserves native newlines.
     * @post Independent document/history created; no native document or mutable metadata is exported.
     * @return {SourceBuffer} Source owner. @throws {Error} Invalid snapshot or document creation failure.
     */
    constructor(snapshot, { createDocument, mode, queue, persist }) {
      if (typeof snapshot?.file !== 'string' || typeof snapshot.text !== 'string') throw new TypeError('A source buffer needs file and text');
      this.#file = snapshot.file; this.#saved = snapshot.text; this.#sha = snapshot.sha;
      this.#queue = queue; this.#persist = persist;
      this.#document = createDocument(snapshot, mode);
      const methods = ['getValue', 'setValue', 'getCursor', 'setCursor', 'listSelections', 'setSelections',
        'indexFromPos', 'posFromIndex', 'getRange', 'replaceRange', 'changeGeneration', 'undo', 'redo', 'historySize', 'clearHistory'];
      const view = Object.fromEntries(methods.map(name => [name, (...args) => {
        if (this.#disposed) throw new Error('This source buffer is closed.');
        return this.#document[name](...args);
      }]));
      view.markText = (...args) => this.markText(...args);
      this.#view = Object.freeze(view);
    }
    /** Read source identity. @param {void} none. @pre Initialized. @post No changes.
     * @return {string} File path. @throws {void} None.
     */
    get file() { return this.#file; }
    /** Read the public editing adapter, never the native document.
     * @param {void} none. @pre Initialized. @post Private history/document remain encapsulated.
     * @return {object} Immutable method adapter. @throws {void} None.
     */
    get doc() { return this.#view; }
    /** Read accepted source text. @param {void} none. @pre Initialized. @post No changes.
     * @return {string} Last successful save/reload. @throws {void} None.
     */
    get saved() { return this.#saved; }
    /** Read accepted revision. @param {void} none. @pre Initialized. @post No changes.
     * @return {string} SHA revision. @throws {void} None.
     */
    get sha() { return this.#sha; }
    /** Read external-conflict state. @param {void} none. @pre Initialized. @post No changes.
     * @return {boolean} Whether disk changed during local edits. @throws {void} None.
     */
    get stale() { return this.#stale; }
    /** Read dirty state. @param {void} none. @pre Buffer open. @post No changes.
     * @return {boolean} Exact text differs from the accepted baseline. @throws {Error} Buffer closed.
     */
    get unsaved() { return this.#view.getValue() !== this.#saved; }
    /** Read detached content/revision metadata. @param {void} none. @pre Buffer open.
     * @post No native editor/history is exposed. @return {object} Immutable value snapshot.
     * @throws {Error} Buffer closed.
     */
    snapshot() { return Object.freeze({ file: this.#file, text: this.#view.getValue(), saved: this.#saved,
      sha: this.#sha, stale: this.#stale, unsaved: this.unsaved }); }
    /** Attach this buffer through the host-owned native editor.
     * @param {CodeMirror.Editor} editor Authorized editor adapter.
     * @pre Same editor runtime; buffer open. @post Native history/selection are retained across attachment.
     * @return {void} Nothing. @throws {Error} Closed buffer or native editor failure.
     */
    attach(editor) {
      if (this.#disposed) throw new Error('This source buffer is closed.');
      if (!this.isAttached(editor)) editor.swapDoc(this.#document);
    }
    /** Compare attachment without returning native document identity.
     * @param {CodeMirror.Editor} editor Host editor. @pre Initialized.
     * @post No changes. @return {boolean} Attached to this open buffer. @throws {Error} Editor read failure.
     */
    isAttached(editor) { return !this.#disposed && editor.getDoc() === this.#document; }
    /** Create a private native marker behind a minimal range handle.
     * @param {object} from,to Native positions. @param {object} options Marker behavior.
     * @pre Buffer open; positions valid. @post Native marker retained privately until clear/disposal.
     * @return {object} Frozen find/clear operations, without native marker/document internals.
     * @throws {Error} Invalid or closed buffer/editor failure.
     */
    markText(from, to, options) {
      if (this.#disposed) throw new Error('This source buffer is closed.');
      const mark = this.#document.markText(from, to, options);
      let active = true;
      const handle = Object.freeze({
        find: () => {
          if (!active || this.#disposed) return undefined;
          const range = mark.find();
          return range && { from: { ...range.from }, to: { ...range.to } };
        },
        clear: () => { if (active) { active = false; mark.clear(); this.#anchors.delete(handle); } },
      });
      this.#anchors.add(handle); return handle;
    }
    /** Persist through the shared revision-aware queue.
     * @param {void} none. @pre Authorized transport and buffer open.
     * @post Only an accepted response advances saved text/revision; in-flight edits stay dirty.
     * @return {Promise<object|null>} Accepted response or no-op. @throws {Error} Save/conflict/closed-buffer failure.
     */
    save() {
      return this.#queue.save(() => ({ text: this.#view.getValue(), saved: this.#saved, sha: this.#sha }),
        data => this.#persist(this.#file, data), (text, response) => {
          this.#saved = text; this.#sha = response.sha; this.#stale = false;
        });
    }
    /** Apply an external source response, preserving dirty work unless discard was explicit.
     * @param {object} response Exact text/revision. @param {object} options force permits explicit discard.
     * @pre Response belongs to this file; caller owns discard confirmation when forcing.
     * @post Clean text reloads with cursor retained; dirty buffers become stale, without content loss.
     * @return {string} unchanged, reloaded, stale, already-stale or closed. @throws {Error} Native editor failure.
     */
    reload(response, { force = false } = {}) {
      if (this.#disposed) return 'closed';
      if (!force && response.sha === this.#sha) return 'unchanged';
      if (!force && this.unsaved) {
        const state = this.#stale ? 'already-stale' : 'stale'; this.#stale = true; return state;
      }
      const cursor = this.#document.getCursor();
      this.#document.setValue(response.text);
      this.#document.setCursor(cursor);
      this.#saved = response.text; this.#sha = response.sha; this.#stale = false;
      return 'reloaded';
    }
    /** Release native source anchors and reject later editing calls.
     * @param {void} none. @pre May already be closed. @post No marker/native document is exposed or retained.
     * @return {void} Nothing. @throws {Error} Native marker cleanup failure.
     */
    dispose() {
      if (this.#disposed) return;
      for (const anchor of [...this.#anchors]) anchor.clear();
      this.#disposed = true; this.#document = null;
    }
  }

  class SourceBuffers {
    #buffers = new Map(); #reads = new Map(); #versions = new Map(); #closed = false;
    #read; #write; #create; #mode; #queue = new window.SourceSaveQueue();
    /** Own source documents, revisions and read/save lifetime for one workspace.
     * @param {object} options read(file), write(file,data), createDocument(snapshot,mode), modeFor(file).
     * @pre Dependencies are authorized transport/native editor adapters.
     * @post Empty private collection; no IO. @return {SourceBuffers} Collection. @throws {void} None.
     */
    constructor({ read, write, createDocument = (snapshot, mode) => CodeMirror.Doc(snapshot.text, mode, 0,
      /\r\n/.test(snapshot.text) ? '\r\n' : null), modeFor = () => 'stex' } = {}) {
      this.#read = read; this.#write = write; this.#create = createDocument; this.#mode = modeFor;
    }
    /** Read pending persistence. @param {void} none. @pre Initialized. @post No changes.
     * @return {Promise|null} Latest queued save. @throws {void} None.
     */
    get pending() { return this.#queue.pending; }
    /** Read collection dirty state. @param {void} none. @pre Open buffers.
     * @post No changes. @return {boolean} Any unsaved native buffer. @throws {Error} Native read failure.
     */
    get unsaved() { return [...this.#buffers.values()].some(buffer => buffer.unsaved); }
    /** Return independent handle-map membership, never mutable registry storage.
     * @param {void} none. @pre Initialized. @post Map mutations cannot affect owned buffers.
     * @return {Map<string,SourceBuffer>} Detached map of public buffer handles. @throws {void} None.
     */
    snapshotMap() { return new Map(this.#buffers); }
    /** Read a loaded public buffer handle. @param {string} file Source identity.
     * @pre Initialized. @post No changes. @return {SourceBuffer|undefined} Buffer. @throws {void} None.
     */
    get(file) { return this.#buffers.get(file); }
    /** Adopt an authorized exact source snapshot during composition/opening.
     * @param {object} snapshot File/text/SHA values. @param {object} options Optional trusted native document factory.
     * @pre File not already loaded; collection open; factory owns editor-adapter construction.
     * @post New independent native buffer registered. @return {SourceBuffer} Public adapter.
     * @throws {Error} Duplicate/closed collection or invalid/native snapshot.
     */
    adopt(snapshot, { createDocument = this.#create } = {}) {
      if (this.#closed) throw new Error('This source collection is closed.');
      if (this.#buffers.has(snapshot.file)) throw new Error('Source buffer already loaded: ' + snapshot.file);
      const buffer = new SourceBuffer(snapshot, { createDocument, mode: this.#mode(snapshot.file),
        queue: this.#queue, persist: (file, data) => this.#write(file, data) });
      this.#buffers.set(snapshot.file, buffer); return buffer;
    }
    /** Load a source once, coalescing duplicate reads and rejecting obsolete responses.
     * @param {string} file Authorized source identity. @pre Collection open.
     * @post Latest response registers once; closed/reopened files cannot receive an old read.
     * @return {Promise<SourceBuffer>} Public source handle. @throws {Error} Read, cancellation or native failure.
     */
    open(file) {
      if (this.#closed) return Promise.reject(new Error('This source collection is closed.'));
      if (this.#buffers.has(file)) return Promise.resolve(this.#buffers.get(file));
      if (this.#reads.has(file)) return this.#reads.get(file);
      const version = this.#versions.get(file) || 0;
      const pending = Promise.resolve().then(() => this.#read(file)).then(response => {
        if (this.#closed || (this.#versions.get(file) || 0) !== version) throw new Error('Source read was superseded.');
        return this.#buffers.get(file) || this.adopt({ ...response, file });
      }).finally(() => { if (this.#reads.get(file) === pending) this.#reads.delete(file); });
      this.#reads.set(file, pending); return pending;
    }
    /** Save one loaded buffer through its private revision owner.
     * @param {string} file Loaded identity. @pre Authorized persistence dependency.
     * @post Accepted revision advances; failed writes preserve local edits.
     * @return {Promise<object|null>} Response or no loaded/dirty work. @throws {Error} Save failure.
     */
    save(file) { return this.#buffers.get(file)?.save() || Promise.resolve(null); }
    /** Refresh one currently loaded buffer without resurrecting closed/replaced buffers.
     * @param {string} file Identity. @param {object} options Explicit discard policy.
     * @pre Caller owns discard confirmation. @post Late results affect only their original open buffer.
     * @return {Promise<string>} Reload state. @throws {Error} Read/native failure.
     */
    async refresh(file, options) {
      const buffer = this.#buffers.get(file);
      if (!buffer) return 'closed';
      // A read begun before an accepted write must never restore the older disk revision.
      if (this.pending) await this.pending;
      if (this.#closed || this.#buffers.get(file) !== buffer) return 'closed';
      const before = buffer.snapshot();
      const response = await this.#read(file);
      if (this.#closed || this.#buffers.get(file) !== buffer) return 'closed';
      const after = buffer.snapshot();
      if (this.pending || before.sha !== after.sha || before.saved !== after.saved) return 'superseded';
      // Explicit discard covers the text the caller saw, never typing made during the read.
      if (options?.force && before.text !== after.text) return 'superseded';
      return buffer.reload(response, options);
    }
    /** Close one buffer and invalidate outstanding reads of that identity.
     * @param {string} file Source identity. @pre Host saved or explicitly discarded local work.
     * @post Buffer/anchors released; unrelated documents/history stay intact.
     * @return {void} Nothing. @throws {Error} Native anchor cleanup failure.
     */
    close(file) {
      this.#versions.set(file, (this.#versions.get(file) || 0) + 1); this.#reads.delete(file);
      this.#buffers.get(file)?.dispose(); this.#buffers.delete(file);
    }
    /** Dispose all source ownership and invalidate unstarted/pending IO results.
     * @param {void} none. @pre Repeatable. @post No queued save or late read can register a buffer.
     * @return {void} Nothing. @throws {Error} Native cleanup failure.
     */
    dispose() {
      if (this.#closed) return;
      this.#closed = true; this.#queue.dispose(); this.#reads.clear();
      for (const file of [...this.#buffers.keys()]) this.close(file);
    }
  }
  window.SourceBuffers = Object.freeze({ SourceBuffer, SourceBuffers });
})();
