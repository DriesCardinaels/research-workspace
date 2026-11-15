/* Revision-aware persistence shared by source review and independent text sessions. */
'use strict';
(() => {
  class SourceSaveQueue {
    #pending = null; #disposed = false;
    /** Read current persistence work. @param {void} none. @pre Initialized.
     * @post No mutation. @return {Promise|null} Latest queued operation. @throws {void} None.
     */
    get pending() { return this.#pending; }
    /** Serialize a save, taking its revision/text snapshot only when execution begins.
     * @param {Function} snapshot Read current {text,saved,sha} without exposing a native editor.
     * @param {Function} persist Save {text,sha}, returning the accepted response.
     * @param {Function} accept Receive saved text and response after successful publication.
     * @pre Callbacks use the same session identity; persist enforces optimistic revisions.
     * @post Failed saves retain dirty text/revision; waiting saves cannot overwrite newer snapshots.
     * @return {Promise<object|null>} Accepted response, or null when already saved.
     * @throws {Error} Closed queue or callback/persistence failure; dependent queued work rejects too.
     */
    save(snapshot, persist, accept) {
      if (this.#disposed) return Promise.reject(new Error('This save queue is closed.'));
      const execute = async () => {
        if (this.#disposed) throw new Error('This save queue is closed.');
        const { text, saved, sha } = snapshot();
        if (text === saved) return null;
        const response = await persist({ text, sha });
        accept(text, response);
        return response;
      };
      // Idle saves capture immediately; waiting saves capture only after their predecessor settles.
      const operation = this.#pending ? this.#pending.then(execute) : execute();
      const pending = operation.finally(() => { if (this.#pending === pending) this.#pending = null; });
      this.#pending = pending;
      return pending;
    }
    /** Prevent queued/new writes after disposal while allowing an active response to settle.
     * @param {void} none. @pre May be active or closed. @post Unstarted saves cannot perform IO.
     * @return {void} Nothing. @throws {void} None.
     */
    dispose() { this.#disposed = true; }
  }
  window.SourceSaveQueue = SourceSaveQueue;
})();
