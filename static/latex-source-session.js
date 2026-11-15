/* Source transport for the existing LaTeX Workspace; this module owns no editor or layout. */
'use strict';
(function () {
  class LatexSourceSession {
    #api; #base; #selected; #status;
    /** Connect source persistence to the existing workspace request interface.
     * @param {object} options Authenticated api and project base route.
     * @pre Public project routes are available. @post No editor or document is created.
     * @return {LatexSourceSession} Source transport. @throws {void} None.
     */
    constructor({ api, base }) { this.#api = api; this.#base = base; }
    /** Read source metadata without compiling or requiring a PDF.
     * @param {string} file Project-relative source selection.
     * @pre File is LaTeX/BibTeX. @post Selection and metadata are cached.
     * @return {Promise<object>} Source workspace status. @throws {Error} Read or authorization failure.
     */
    async open(file) {
      const status = await this.#api(this.#base + '/latex/source?path=' + encodeURIComponent(file));
      this.#selected = file; this.#status = status; return status;
    }
    /** Translate only source-compatible workspace operations to public project routes.
     * @param {string} path Workspace operation. @param {object} options Request options.
     * @pre open() succeeded. @post Saves preserve SHA conflict checks and review guards.
     * @return {Promise<object>} Existing workspace payload. @throws {Error} Unsupported operation or IO failure.
     */
    async request(path, options = {}) {
      if (!path) return this.open(this.#selected);
      if (path === '/citations') return this.#api(this.#base + '/latex/citations?path=' + encodeURIComponent(this.#selected));
      if (path === '/file' || path.startsWith('/file?')) {
        const result = await this.#api(this.#base + '/text-file' + path.slice('/file'.length), options);
        return { ...result, notes: [], changes: [] };
      }
      throw new Error('This operation requires a compiled paper with a source review baseline.');
    }
    /** Compile through the shared backend and retain the last successful preview.
     * @param {string} main Project-relative main file.
     * @pre All buffers have been saved by Workspace. @post Failed builds retain the last preview.
     * @return {Promise<object>} Build result. @throws {Error} Transport/build setup failure.
     */
    async compile(main) {
      const result = await this.#api(this.#base + '/latex/compile', { method: 'POST', body: JSON.stringify({ path: main }) });
      if (result.ok) this.#status = { ...this.#status, document: result.document, draft_pdf: true };
      return result;
    }
    /** Export saved source through the current project session's public archive route.
     * @param {Function} download Authorized binary download transport.
     * @param {string} main Project-relative main file. @param {string} name Download filename.
     * @pre Workspace saved all buffers. @post Project source is unchanged.
     * @return {Promise<void>} Download dispatch. @throws {Error} Build/download failure.
     */
    exportArchive(download, main, name) {
      return download(this.#base + '/latex/archive', name, { method: 'POST', body: JSON.stringify({ path: main }) });
    }
    /** Supply the associated PDF URL to Workspace's existing PDF pane.
     * @param {void} none. @pre A successful build exists. @post No state changes.
     * @return {string|null} Authenticated preview route. @throws {void} None.
     */
    get previewUrl() { return this.#status?.document ? this.#base + '/documents/' + this.#status.document.id + '/source-preview' : null; }
    /** Renew the project session without replacing buffers or the existing editor.
     * @param {string} base Project route. @pre Same project. @post Future requests use base.
     * @return {void} Nothing. @throws {void} None.
     */
    reconnect(base) { this.#base = base; }
  }
  window.LatexSourceSession = LatexSourceSession;
})();
