/* Review composition/selection state. No DOM, editor or persistence implementation is retained. */
'use strict';
(() => {
  const copy = value => value == null ? null : JSON.parse(JSON.stringify(value));
  const freeze = value => {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
  };
  class ReviewState {
    #selected = null; #note = null; #replies = new Map(); #revision = 0; #closed = false;
    #tab = 'comments'; #resolved = false; #accepted = false; #open = true;
    /** Read detached selection. @param {void} none. @pre Initialized. @post No storage exposed.
     * @return {object|null} Immutable selection. @throws {void} None.
     */
    get selected() { return freeze(copy(this.#selected)); }
    /** Select an item through value metadata. @param {object|null} value Item type/ID.
     * @pre Trusted UI operation. @post Selection is copied. @return {void} Nothing. @throws {void} None.
     */
    set selected(value) { if (!this.#closed) this.#selected = copy(value); }
    /** Read active tab. @param {void} none. @pre Initialized. @post No changes.
     * @return {string} Tab ID. @throws {void} None.
     */
    get tab() { return this.#tab; }
    /** Select a registered tab identity. @param {string} value Nonblank ID.
     * @pre Registration is checked by presentation. @post ID retained. @return {void} Nothing.
     * @throws {TypeError} Blank/non-string identity.
     */
    set tab(value) {
      if (typeof value !== 'string' || !value.trim()) throw new TypeError('Review tabs need a name');
      if (!this.#closed) this.#tab = value;
    }
    /** Read resolved visibility. @param {void} none. @pre Initialized. @post No changes.
     * @return {boolean} Visibility. @throws {void} None.
     */
    get resolved() { return this.#resolved; }
    /** Change resolved visibility. @param {boolean} value Visibility. @pre Initialized.
     * @post Preference updated. @return {void} Nothing. @throws {void} None.
     */
    set resolved(value) { if (!this.#closed) this.#resolved = !!value; }
    /** Read accepted-change visibility. @param {void} none. @pre Initialized. @post No changes.
     * @return {boolean} Visibility. @throws {void} None.
     */
    get accepted() { return this.#accepted; }
    /** Change accepted visibility. @param {boolean} value Visibility. @pre Initialized.
     * @post Preference updated. @return {void} Nothing. @throws {void} None.
     */
    set accepted(value) { if (!this.#closed) this.#accepted = !!value; }
    /** Read panel visibility. @param {void} none. @pre Initialized. @post No changes.
     * @return {boolean} Visibility. @throws {void} None.
     */
    get open() { return this.#open; }
    /** Change panel visibility. @param {boolean} value Visibility. @pre Initialized.
     * @post Preference updated. @return {void} Nothing. @throws {void} None.
     */
    set open(value) { if (!this.#closed) this.#open = !!value; }
    /** Read a detached in-progress comment. @param {void} none. @pre Initialized.
     * @post No mutable composition storage exposed. @return {object|null} Immutable values.
     * @throws {void} None.
     */
    get note() { return freeze(copy(this.#note)); }
    /** Read composition revision. @param {void} none. @pre Initialized. @post No changes.
     * @return {number} Revision token. @throws {void} None.
     */
    get revision() { return this.#revision; }
    /** Begin or cancel a composition using detached values. @param {object|null} value Anchor/draft.
     * @pre Trusted source target. @post A new revision is issued. @return {void} Nothing.
     * @throws {Error} Nonserializable metadata.
     */
    begin(value) { if (!this.#closed) { this.#note = copy(value); this.#revision++; } }
    /** Update composition text. @param {string} text Current textarea content.
     * @pre Composition may be open. @post Revision advances; late closed-editor events do nothing.
     * @return {void} Nothing. @throws {TypeError} Non-string text.
     */
    setNoteDraft(text) {
      if (typeof text !== 'string') throw new TypeError('Comment drafts must be text');
      if (!this.#closed && this.#note) { this.#note.draft = text; this.#revision++; }
    }
    /** Clear only the composition that actually completed submission.
     * @param {number} revision Captured token. @pre Request completed successfully.
     * @post Newer edits/compositions remain. @return {boolean} Whether cleared. @throws {void} None.
     */
    completeNote(revision) {
      if (this.#closed || revision !== this.#revision) return false;
      this.begin(null); return true;
    }
    /** Read a reply value. @param {string} key Thread identity. @pre Initialized.
     * @post No changes. @return {string} Draft or empty string. @throws {void} None.
     */
    reply(key) { return this.#replies.get(key) || ''; }
    /** Update one reply. @param {string} key Thread identity. @param {string} text Draft.
     * @pre Strings supplied. @post Other threads remain intact. @return {void} Nothing.
     * @throws {TypeError} Invalid key/text.
     */
    setReply(key, text) {
      if (typeof key !== 'string' || typeof text !== 'string') throw new TypeError('Replies require a key and text');
      if (!this.#closed) this.#replies.set(key, text);
    }
    /** Clear a successfully submitted reply only when it has not changed during IO.
     * @param {string} key Thread. @param {string} expected Submitted text.
     * @pre Request succeeded. @post Newer typing is retained. @return {boolean} Cleared.
     * @throws {void} None.
     */
    completeReply(key, expected) {
      if (this.#closed || this.reply(key) !== expected) return false;
      return this.#replies.delete(key);
    }
    /** Read detached legacy reply membership. @param {void} none. @pre Initialized.
     * @post Map mutation cannot change the model. @return {Map} Copy. @throws {void} None.
     */
    replies() { return new Map(this.#replies); }
    /** Check whether polling would disturb user composition. @param {void} none.
     * @pre Initialized. @post No changes. @return {boolean} In-progress comment or reply.
     * @throws {void} None.
     */
    get pending() { return !!this.#note || [...this.#replies.values()].some(Boolean); }
    /** Discard owned transient UI state when the host closes. @param {void} none.
     * @pre Explicit host disposal. @post Late events cannot recreate drafts/selection.
     * @return {void} Nothing. @throws {void} None.
     */
    dispose() { this.#closed = true; this.#note = this.#selected = null; this.#replies.clear(); this.#revision++; }
  }
  window.ReviewState = ReviewState;
})();
