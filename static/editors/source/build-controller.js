/* Build concurrency and replay policy, independent of editor, DOM and transport. */
'use strict';
(() => {
  class BuildController {
    #pending = null; #target = null; #again = false; #disposed = false;
    #started; #finished;
    /** Own serial build execution and same-target replay signals.
     * @param {object} hooks onStarted() and onFinished({target,again}) callbacks.
     * @pre Hooks operate through the host's public state/render methods.
     * @post No task starts; state is private. @return {BuildController} Controller.
     * @throws {void} None.
     */
    constructor({ onStarted = () => {}, onFinished = () => {} } = {}) {
      this.#started = onStarted; this.#finished = onFinished;
    }
    /** Read the current execution promise. @param {void} none.
     * @pre Initialized. @post No mutation. @return {Promise|null} Pending task.
     * @throws {void} None.
     */
    get pending() { return this.#pending; }
    /** Read detached current target metadata. @param {void} none.
     * @pre Initialized. @post Target storage remains private. @return {object|null} Target snapshot.
     * @throws {void} None.
     */
    get target() { return this.#target && Object.freeze({ ...this.#target }); }
    /** Request one replay of the current target. @param {void} none.
     * @pre An execution may be active. @post Repeated requests coalesce; idle/disposed requests do nothing.
     * @return {void} Nothing. @throws {void} None.
     */
    queue() { if (this.#pending && !this.#disposed) this.#again = true; }
    /** Execute one build or join an existing build without changing its identity.
     * @param {object} target Immutable target metadata. @param {Function} operation Async build body.
     * @param {object} options queueWhenBusy controls coalesced replay behavior.
     * @pre Operation owns save/IO/presentation and reports meaningful failures to its caller.
     * @post One operation runs; state clears on success/failure; completion receives the original target.
     * @return {Promise} Task result. @throws {Error} Disposed controller; task/hook errors propagate.
     */
    run(target, operation, { queueWhenBusy = true } = {}) {
      if (this.#disposed) return Promise.reject(new Error('This build controller is closed.'));
      if (this.#pending) { if (queueWhenBusy) this.queue(); return this.#pending; }
      this.#target = Object.freeze({ ...target }); this.#again = false;
      const original = this.#target;
      let startupError = null;
      this.#pending = Promise.resolve().then(() => {
        if (startupError) throw startupError;
        if (this.#disposed) return;
        return operation();
      }).finally(() => {
        const again = this.#again;
        this.#again = false; this.#pending = null; this.#target = null;
        if (!this.#disposed) this.#finished({ target: original, again });
      });
      try { this.#started(); } catch (error) { startupError = error; }
      return this.#pending;
    }
    /** Stop new tasks and completion/replay hooks without discarding the active task promise.
     * @param {void} none. @pre May be active or already closed.
     * @post Running IO may finish, but no completion hook can update a disposed host.
     * @return {void} Nothing. @throws {void} None.
     */
    dispose() { this.#disposed = true; this.#again = false; }
  }
  window.SourceBuildController = BuildController;
})();
