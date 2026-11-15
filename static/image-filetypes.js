/* Read-only image preview adapter; adding formats uses filetype and backend provider registration. */
'use strict';
(function () {
  class ImageWorkspace {
    #base; #message; #onFile; #file; #sourceDocument = null; #image; #url;
    #stage; #status; #toolbar; #pendingUrls = new Set(); #scale = null; #destroyed = false; #run = 0; #request;
    /** Create a private image host implementing the public editor-session interface.
     * @param {object} options Project base, status callback and onFile callback.
     * @pre FileTypes/EditorTools are loaded. @post Empty host owns its toolbar and preview resources.
     * @return {ImageWorkspace} Adapter. @throws {Error} DOM or Tool initialization failure.
     */
    constructor({ base, message, onFile = () => {} }) {
      this.#base = base; this.#message = message; this.#onFile = onFile;
      this.root = document.createElement('section'); this.root.className = 'image-workspace';
      this.#stage = document.createElement('div'); this.#stage.className = 'image-stage';
      this.#status = document.createElement('div'); this.#status.className = 'text-status'; this.#status.setAttribute('role', 'status');
      this.#toolbar = window.EditorTools.registry.mount('image.view', this.#context(), 'Image preview tools');
      this.#toolbar.element.classList.add('text-tools');
      this.root.append(this.#toolbar.element, this.#stage, this.#status);
    }
    /** @pre Initialized. @post No changes. @return {boolean} Read-only previews are never dirty. @throws None. */
    get unsaved() { return false; }
    /** @pre Successful image load. @post No changes. @return {string|undefined} File identity. @throws None. */
    get file() { return this.#file; }
    /** @pre Initialized. @post No changes. @return {string|null} Authorized source-root identity. @throws None. */
    get sourceDocument() { return this.#sourceDocument; }
    /** Decode a candidate image before replacing the currently visible preview.
     * @param {string} file Relative image path. @param {string|null} sourceDocument Linked source root.
     * @pre Provider supports image preview. @post Success replaces the image; failures retain the prior preview.
     * Superseded requests and disposed hosts cannot publish late images; object URLs are released.
     * @return {Promise<void>} Decode/activation. @throws {Error} Read, format or decoding failure.
     */
    async openFile(file, sourceDocument = null) {
      if (this.#destroyed) throw new Error('This image preview is closed.');
      const provider = window.FileTypes.registry.resolve(file);
      if (!provider?.capabilities.image || !provider.mime?.startsWith('image/')) throw new Error('This file type has no image preview.');
      const run = ++this.#run; this.#request?.abort(); this.#request = new AbortController();
      for (const pending of this.#pendingUrls) URL.revokeObjectURL(pending);
      this.#pendingUrls.clear();
      let url;
      try {
        const query = new URLSearchParams({ path: file }); if (sourceDocument) query.set('source_document', sourceDocument);
        const response = await fetch(this.#base + '/image-file?' + query, { signal: this.#request.signal });
        if (!response.ok) { const error = await response.json(); throw new Error(error.error || 'Image could not be opened.'); }
        if (response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== provider.mime) throw new Error('Unsupported image preview response.');
        const blob = await response.blob();
        if (this.#destroyed || run !== this.#run) return;
        url = URL.createObjectURL(blob); this.#pendingUrls.add(url);
        const image = document.createElement('img'); image.alt = file.split('/').pop(); image.src = url;
        try { await image.decode(); } catch { throw new Error('Image could not be decoded. Check that the file is a valid ' + provider.label + ' image.'); }
        if (this.#destroyed || run !== this.#run) return;
        if (file !== this.#file || sourceDocument !== this.#sourceDocument) this.#scale = null;
        const previous = this.#url; this.#url = url; this.#pendingUrls.delete(url); url = null; this.#image = image;
        this.#file = file; this.#sourceDocument = sourceDocument;
        this.#stage.replaceChildren(image); if (previous) URL.revokeObjectURL(previous);
        this.#render(); this.#onFile();
      } catch (error) {
        if (!this.#destroyed && run === this.#run) throw error;
      } finally { if (url && this.#pendingUrls.delete(url)) URL.revokeObjectURL(url); }
    }
    /** @pre Read-only host. @post No writes. @return {Promise<void>} Completion. @throws None. */
    async saveAll() {}
    /** @param {object} options Optional host options. @pre Root is attached.
     * @post Current image layout is refreshed. @return {void} Nothing. @throws {Error} DOM failure.
     */
    mount(options = {}) { if (!this.#destroyed) this.#render(); }
    /** @param {string} base Renewed project route. @pre Same project.
     * @post Future reads use base; current image remains visible. @return {void} Nothing. @throws None.
     */
    reconnect(base) { this.#base = base; }
    /** @pre An image is open. @post Disk changes decode before replacing the preview.
     * @return {Promise<void>} Completion. @throws {Error} Read/decode failure; old preview retained.
     */
    async refreshFromDisk() { if (this.#file) await this.openFile(this.#file, this.#sourceDocument); }
    /** @pre Any state. @post Requests are invalidated and all owned URLs/Tools released.
     * @return {void} Nothing. @throws {Error} Tool disposal failure.
     */
    destroy() {
      if (this.#destroyed) return;
      this.#destroyed = true; ++this.#run; this.#request?.abort(); this.#toolbar.dispose();
      if (this.#url) URL.revokeObjectURL(this.#url); this.#url = null;
      for (const pending of this.#pendingUrls) URL.revokeObjectURL(pending); this.#pendingUrls.clear();
      this.#stage.replaceChildren(); this.#image = null;
    }
    /** @pre Host exists. @post No internal editor/image state is exposed.
     * @return {object} Narrow Tool operations and immutable mode data. @throws None.
     */
    #context() { return { ready: !!this.#image, fit: this.#scale === null, actual: this.#scale === 1,
      fitImage: () => this.#resize(null), actualSize: () => this.#resize(1),
      zoomIn: () => this.#zoom(1.25), zoomOut: () => this.#zoom(0.8),
      run: async command => { try { return await command(); } catch (error) { this.#message(error.message, true); } } }; }
    /** @param {number|null} scale Null fits the pane; a number specifies natural-size zoom.
     * @pre Image decoded. @post Only preview size changes. @return {void} Nothing. @throws {Error} DOM failure.
     */
    #resize(scale) { if (this.#image) { this.#scale = scale; this.#render(); } }
    /** @param {number} factor Relative zoom. @pre Image decoded.
     * @post Zoom stays within 5–800%. @return {void} Nothing. @throws {Error} Layout failure.
     */
    #zoom(factor) {
      if (!this.#image) return;
      const current = this.#scale ?? this.#image.getBoundingClientRect().width / this.#image.naturalWidth;
      this.#resize(Math.max(0.05, Math.min(8, current * factor)));
    }
    /** @pre Host exists. @post Native dimensions remain intact; controls/status reflect preview scale.
     * @return {void} Nothing. @throws {Error} DOM/Tool refresh failure.
     */
    #render() {
      if (this.#image) {
        const fit = this.#scale === null;
        Object.assign(this.#image.style, { maxWidth: fit ? '100%' : 'none', maxHeight: fit ? '100%' : 'none',
          width: fit ? 'auto' : this.#image.naturalWidth * this.#scale + 'px', height: fit ? 'auto' : this.#image.naturalHeight * this.#scale + 'px' });
        this.#status.textContent = `${this.#file} · ${this.#image.naturalWidth} × ${this.#image.naturalHeight} px · ${fit ? 'Fit' : Math.round(this.#scale * 100) + '%'} · Read only`;
      }
      this.#toolbar.refresh(this.#context());
    }
  }
  window.ImageWorkspace = ImageWorkspace;
  for (const tool of [
    { id: 'image.fit', label: 'Fit image', icon: 'fit', execute: ({ fitImage }) => fitImage(), state: ({ fit }) => ({ pressed: fit }) },
    { id: 'image.actual', label: 'Actual size', text: '100%', showText: true, execute: ({ actualSize }) => actualSize(), state: ({ actual }) => ({ pressed: actual }) },
    { id: 'image.zoom-out', label: 'Zoom out', icon: 'minus', execute: ({ zoomOut }) => zoomOut() },
    { id: 'image.zoom-in', label: 'Zoom in', icon: 'plus', execute: ({ zoomIn }) => zoomIn() },
  ]) window.EditorTools.registry.contribute('image.view', { ...tool, enabled: ({ ready }) => ready });
})();
