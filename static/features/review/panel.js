/* Registered review tabs. Contributions receive values and explicit UI capabilities. */
'use strict';
(() => {
  const immutable = value => {
    const result = JSON.parse(JSON.stringify(value));
    const freeze = item => {
      if (item && typeof item === 'object') { Object.values(item).forEach(freeze); Object.freeze(item); }
      return item;
    };
    return freeze(result);
  };
  class ReviewTabRegistry {
    #tabs = new Map();
    /** Register one review contribution in display order.
     * @param {object} tab Stable id, label(snapshot), render(body,context), optional available(snapshot).
     * @pre Trusted executable contribution; unique nonblank identity.
     * @post Definition copied and frozen; existing registrations unchanged.
     * @return {ReviewTabRegistry} This registry. @throws {TypeError} Invalid/duplicate definition.
     */
    register(tab) {
      if (typeof tab?.id !== 'string' || !tab.id.trim() || this.#tabs.has(tab.id) ||
          typeof tab.label !== 'function' || typeof tab.render !== 'function' ||
          (tab.available !== undefined && typeof tab.available !== 'function')) throw new TypeError('Invalid or duplicate review tab');
      this.#tabs.set(tab.id, Object.freeze({ ...tab })); return this;
    }
    /** Read available contribution definitions without exposing registry membership.
     * @param {object} snapshot Immutable display metadata. @pre Contributions registered.
     * @post Registry remains unchanged. @return {object[]} Frozen ordered definitions.
     * @throws {Error} Availability predicate failure.
     */
    available(snapshot) { return Object.freeze([...this.#tabs.values()].filter(tab => !tab.available || tab.available(snapshot))); }
  }
  /** Compose the built-in comments, tracked changes and writing tabs.
   * @param {void} none. @pre Runtime loaded. @post Independent registry created; no IO.
   * @return {ReviewTabRegistry} Extensible registry. @throws {TypeError} Invalid built-in definition.
   */
  function builtInTabs() {
    return new ReviewTabRegistry().register({
      id: 'comments', label: snapshot => `Comments (${snapshot.openNotes})`,
      /** Render this tab through public review capabilities.
       * @param {HTMLElement} body Tab container. @param {object} context Immutable values and operations.
       * @pre Host owns source state and IO. @post Tab controls appended; source unchanged.
       * @return {void} Nothing. @throws {Error} DOM/card rendering failure.
       */
      render(body, { snapshot: s, state, cards, actions, node: h }) {
        if (state.note) body.append(cards.newNoteForm());
        if (s.resolved) body.append(h('label', { class: 'ws-check' }, h('input', {
          type: 'checkbox', checked: state.resolved || null,
          onchange: e => { state.resolved = e.target.checked; actions.visibilityChanged(); },
        }), ` Show resolved (${s.resolved})`));
        if (!s.notes.length && !state.note) body.append(h('p', { class: 'hint', text: 'Select text in the source or the PDF, then click 💬 Comment next to the selection. A comment shows in both.' }));
        const notes = [...s.notes].sort((a, b) => a.file.localeCompare(b.file) || a.start - b.start);
        for (const note of notes) body.append(cards.noteCard(note));
      },
    }).register({
      id: 'changes', label: snapshot => `Changes (${snapshot.openChanges})`,
      /** Render this tab through public review capabilities.
       * @param {HTMLElement} body Tab container. @param {object} context Immutable values and operations.
       * @pre Host owns source state and IO. @post Tab controls appended; source unchanged.
       * @return {void} Nothing. @throws {Error} DOM/card rendering failure.
       */
      render(body, { snapshot: s, state, cards, actions, node: h }) {
        if (s.accepted) body.append(h('label', { class: 'ws-check' }, h('input', {
          type: 'checkbox', checked: state.accepted || null,
          onchange: e => { state.accepted = e.target.checked; actions.visibilityChanged(); },
        }), ` Show accepted (${s.accepted})`));
        if (!s.totalChanges) body.append(h('p', { class: 'hint', text: `No changes against V${s.base} yet.` }));
        else if (!s.changes.length) body.append(h('p', { class: 'hint', text: 'All changes are accepted.' }));
        for (const change of s.changes) body.append(cards.changeCard(change));
        if (s.inactive.length) {
          const details = h('details', { class: 'draft-inactive' }, h('summary', { text: `Undone and reverted (${s.inactive.length})` }));
          for (const change of s.inactive) details.append(cards.changeCard(change, true));
          body.append(details);
        }
      },
    }).register({
      id: 'writing', label: () => 'Writing', available: snapshot => snapshot.writing,
      render: (body, { actions }) => actions.writing(body),
    });
  }
  class ReviewPanel {
    #state; #tabs; #cards; #actions; #node;
    /** Compose review rendering without source buffers or a workspace reference.
     * @param {object} options Public state, tabs, cards, node factory and semantic UI actions.
     * @pre Registry includes at least one available tab when rendered.
     * @post Dependencies retained; no DOM mutation or IO. @return {ReviewPanel} Presentation adapter.
     * @throws {void} None.
     */
    constructor({ state, tabs, cards, actions, node }) {
      this.#state = state; this.#tabs = tabs; this.#cards = cards; this.#actions = Object.freeze({ ...actions }); this.#node = node;
    }
    /** Render the current tab using immutable display values.
     * @param {HTMLElement} target Review container. @param {object} values Detached review metadata.
     * @pre Trusted registered renderers; target belongs to the host.
     * @post Header/body replace prior controls; selected card scrolled into view; unavailable selection falls back.
     * @return {void} Nothing. @throws {Error} Empty registry, invalid metadata or contribution/DOM failure.
     */
    render(target, values) {
      const snapshot = immutable(values), tabs = this.#tabs.available(snapshot), h = this.#node;
      if (!tabs.length) throw new Error('No available review tabs');
      const active = tabs.find(tab => tab.id === this.#state.tab) || tabs[0];
      this.#state.tab = active.id;
      const head = h('div', { class: 'ws-review-head' }, ...tabs.map(tab => h('button', {
        role: 'tab', 'aria-selected': String(tab.id === active.id), class: tab.id === active.id ? 'on' : '', text: tab.label(snapshot),
        tool: { id: 'workspace.review-tab', label: 'Change review panel', showText: true, execute: () => this.#actions.selectTab(tab.id) },
      })), h('span', { class: 'ws-grow' }), h('button', {
        class: 'ws-copy-llm', title: 'Copy all for an AI assistant: open comments and changes in reading order, with file locations and instructions',
        'aria-label': 'Copy all for an AI assistant',
        tool: { id: 'workspace.copy-review', label: 'Copy review for an AI assistant', showText: true, execute: ({ event }) => this.#actions.copy(event.currentTarget) },
      }));
      head.lastChild.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M9 8h11v13H9z M15 8V3H4v13h5"/></svg>';
      const body = h('div', { class: 'ws-review-body' }), warning = this.#actions.warning();
      if (warning) body.append(warning);
      for (const problem of snapshot.problems) body.append(h('p', { class: 'draft-error', text: `${problem.file}: ${problem.error}` }));
      active.render(body, Object.freeze({ snapshot, state: this.#state, cards: this.#cards, actions: this.#actions, node: h }));
      target.replaceChildren(head, body);
      const selected = this.#state.selected;
      if (selected) body.querySelector(`[data-key="${selected.type}-${selected.id}"]`)?.scrollIntoView({ block: 'nearest' });
    }
  }
  window.ReviewPanels = Object.freeze({ ReviewTabRegistry, ReviewPanel, builtInTabs });
})();
