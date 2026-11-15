/* Review cards and composition controls; no native editor, buffer map or source transport state. */
'use strict';
(() => {
  class ReviewCards {
    #state; #actions; #node; #short; #when; #kinds;
    /** Compose replaceable review presentation around semantic host actions.
     * @param {object} options Private-state public interface, action capabilities and UI formatting functions.
     * @pre Actions own authentication, mutation, recovery and source/PDF navigation.
     * @post No document state is read or changed. @return {ReviewCards} Presentation adapter.
     * @throws {void} None.
     */
    constructor({ state, actions, node, short, when, kinds }) {
      this.#state=state; this.#actions=actions; this.#node=node; this.#short=short; this.#when=when; this.#kinds=kinds;
    }
    /** Create the current comment/replacement form.
     * @param {*} values No explicit arguments; reads detached composition values.
     * @pre Trusted source/review snapshots and action capabilities.
     * @post Detached controls created; source remains unchanged until explicit action execution.
     * @return {*} DOM node or reply editor/action pair. @throws {Error} DOM/metadata failure; actions own recovery.
     */
    newNoteForm() {
      const replace = this.#state.note.style?.intent === 'replace';
      const box = this.#node('textarea', { rows: 3, placeholder: replace ? 'Replacement text…' : 'Add your comment…', 'aria-label': replace ? 'Replacement text' : 'New comment' });
      box.value = this.#state.note.draft || '';
      box.addEventListener('input', () => { this.#state.setNoteDraft(box.value); });
      const send = new window.EditorTools.Tool({ id: 'workspace.submit-note', label: 'Save comment', showText: true, execute: () => this.#actions.run(async () => { if (box.value.trim()) await this.#actions.submitNote(box.value); }) });
      box.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); send.invoke(); } });
      return this.#node('article', { class: 'ws-card ws-new sel' },
        this.#node('header', null, this.#node('span', { class: 'ws-where', text: `${this.#state.note.file} · from the ${this.#state.note.origin === 'pdf' ? 'PDF' : 'source'}` }),
          replace ? this.#node('span', { class: 'ws-badge warn', text: 'replace' }) : null),
        this.#node('blockquote', { text: this.#short(this.#state.note.quote, 300) }), box,
        this.#node('div', { class: 'ws-buttons' },
          this.#node('button', { text: 'Cancel', tool: { id: 'workspace.cancel-note', label: 'Cancel comment', showText: true, execute: () => { this.#state.begin(null); this.#actions.render(); this.#actions.placeMarks(); }  }}),
          this.#node('button', { class: 'primary', text: replace ? 'Suggest' : 'Comment', tool: send})));
    }

    /** Render exact messages and per-message copy actions.
     * @param {*} values comments
     * @pre Trusted source/review snapshots and action capabilities.
     * @post Detached controls created; source remains unchanged until explicit action execution.
     * @return {*} DOM node or reply editor/action pair. @throws {Error} DOM/metadata failure; actions own recovery.
     */
    thread(comments) {
      return this.#node('div', { class: 'ws-thread' }, comments.map((cm) => this.#node('div', { class: 'ws-comment' + (cm.author === 'Claude' ? ' ai' : '') },
        this.#node('div', { class: 'ws-comment-head' }, this.#node('strong', { text: cm.author }), ' ', this.#node('small', { text: this.#when(cm.created_at) }),
          this.#node('button', { class: 'ws-copy-comment', text: 'Copy', title: 'Copy this comment only', 'aria-label': 'Copy comment',
            tool: { id: 'workspace.copy-comment', label: 'Copy comment', showText: true, execute: ({ event: ev }) => this.#actions.run(() => this.#actions.copyText(cm.text, ev.currentTarget))  }})), this.#node('p', { text: cm.text }))));
    }

    /** Create a thread reply editor whose in-flight completion preserves newer typing.
     * @param {*} values key, send
     * @pre Trusted source/review snapshots and action capabilities.
     * @post Detached controls created; source remains unchanged until explicit action execution.
     * @return {*} DOM node or reply editor/action pair. @throws {Error} DOM/metadata failure; actions own recovery.
     */
    replyBox(key, send) {
      const box = this.#node('textarea', { rows: 1, placeholder: 'Reply…', 'aria-label': 'Reply' });
      box.value = this.#state.reply(key) || '';
      box.addEventListener('input', () => this.#state.setReply(key, box.value));
      const go = new window.EditorTools.Tool({ id: 'workspace.reply', label: 'Reply', showText: true, execute: () => this.#actions.run(async () => { if (!box.value.trim()) return; const submitted=box.value; await send(submitted); this.#state.completeReply(key, submitted); await this.#actions.reload(); }) });
      box.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); go.invoke(); } });
      return [box, go];
    }

    /** Render a linked source note with semantic status/reply/navigation actions.
     * @param {*} values n
     * @pre Trusted source/review snapshots and action capabilities.
     * @post Detached controls created; source remains unchanged until explicit action execution.
     * @return {*} DOM node or reply editor/action pair. @throws {Error} DOM/metadata failure; actions own recovery.
     */
    noteCard(n) {
      const key = 'note-' + n.id;
      const isSel = this.#state.selected?.type === 'note' && this.#state.selected.id === n.id;
      const badge = n.anchor === 'edited' ? 'text changed' : n.anchor === 'lost' ? 'text not found' : null;
      const [box, send] = this.replyBox(key, (text) => this.#actions.request(`/notes/${n.id}/comments`, { method: 'POST', body: JSON.stringify({ text, author: this.#actions.author() }) }));
      return this.#node('article', { class: 'ws-card ws-note-card' + (isSel ? ' sel' : '') + (n.status === 'resolved' ? ' resolved' : ''), 'data-key': key,
        tool: { id: 'workspace.select-note', label: 'Show comment location', showText: true, execute: ({ event: e }) => { if (!e.target.closest('button,textarea,input')) this.#actions.select('note', n.id, { source: true, pdf: true }); }  }},
        this.#node('header', null, this.#node('span', { class: 'ws-where', text: `${n.file}:${n.line}` }),
          n.style ? this.#node('span', { class: 'ws-badge ws-style-' + (n.style.intent || n.style.type) + (n.style.color ? ' ' + n.style.color : ''),
            text: n.style.intent === 'replace' ? 'replace' : n.style.type === 'strikethrough' ? 'remove' : 'highlight' }) : null,
          badge ? this.#node('span', { class: 'ws-badge warn', text: badge }) : null,
          n.carried_from ? this.#node('span', { class: 'ws-badge', text: `from V${n.carried_from}` }) : null,
          n.status === 'resolved' ? this.#node('span', { class: 'ws-badge', text: 'resolved' }) : null),
        this.#node('blockquote', { text: this.#short(n.quote, 200) }),
        n.anchor === 'edited' && n.current ? this.#node('p', { class: 'ws-now' }, this.#node('small', { text: 'Now: ' }), this.#short(n.current, 200)) : null,
        this.thread(n.comments), box,
        this.#node('div', { class: 'ws-buttons' },
          this.#actions.copyThreadButton({ n }),
          this.#node('button', { text: n.status === 'resolved' ? 'Reopen' : 'Resolve', tool: { id: 'workspace.resolve-note', label: n.status === 'resolved' ? 'Reopen comment' : 'Resolve comment', showText: true, execute: () => this.#actions.run(async () => {
            await this.#actions.request(`/notes/${n.id}/status`, { method: 'POST', body: JSON.stringify({ status: n.status === 'resolved' ? 'open' : 'resolved' }) });
            await this.#actions.reload();
          })  }}),
          this.#node('button', { class: 'primary', text: 'Reply', tool: send})));
    }

    /** Render a current or historical tracked change without touching source buffers.
     * @param {*} values c, inactive = false
     * @pre Trusted source/review snapshots and action capabilities.
     * @post Detached controls created; source remains unchanged until explicit action execution.
     * @return {*} DOM node or reply editor/action pair. @throws {Error} DOM/metadata failure; actions own recovery.
     */
    changeCard(c, inactive = false) {
      const key = 'change-' + c.id;
      const kind = this.#kinds[c.kind] || this.#kinds.replaced;
      const by = [...new Set(c.history.map((x) => x.by))].join(', ');
      const isSel = this.#state.selected?.type === 'change' && this.#state.selected.id === c.id;
      const card = this.#node('article', { class: 'ws-card' + (isSel ? ' sel' : '') + (inactive ? ' inactive' : ''), 'data-key': key,
        tool: { id: 'workspace.select-change', label: 'Show change location', showText: true, execute: ({ event: e }) => { if (!inactive && !e.target.closest('button,textarea,summary')) this.#actions.select('change', c.id, { source: true, pdf: true }); }  }},
        this.#node('header', null, this.#node('span', { class: 'draft-kind ' + kind.color, text: kind.label }), this.#node('span', { class: 'ws-where', text: `${c.file}:${c.line}` }),
          this.#node('span', { class: 'draft-status ' + c.status, text: c.status }), this.#node('span', { class: 'draft-by', text: by }), this.#actions.copyThreadButton({ c })),
        c.old.trim() ? this.#node('p', { class: 'draft-old' }, this.#node('del', { text: this.#short(c.old) })) : null,
        c.new.trim() ? this.#node('p', { class: 'draft-new' }, this.#node('ins', { text: this.#short(c.new) })) : null);
      if (c.history.length > 1) {
        const det = this.#node('details', { class: 'draft-history' }, this.#node('summary', { text: `History (${c.history.length})` }));
        for (const x of c.history) det.append(this.#node('p', null, this.#node('small', { text: `${this.#when(x.at)} · ${x.by}${x.note ? ' · ' + x.note : ''}` }), this.#node('br'), x.text.trim() ? this.#short(x.text, 400) : this.#node('em', { text: '(empty)' })));
        card.append(det);
      }
      card.append(this.thread(c.comments));
      if (inactive) return card;
      const [box, send] = this.replyBox(key, (text) => this.#actions.request(`/changes/${c.id}/comments`, { method: 'POST', body: JSON.stringify({ text, author: this.#actions.author() }) }));
      card.append(box, this.#node('div', { class: 'ws-buttons' },
        this.#node('button', { text: c.status === 'accepted' ? 'Reopen' : 'Accept', tool: { id: 'workspace.accept-change', label: c.status === 'accepted' ? 'Reopen change' : 'Accept change', showText: true, execute: () => this.#actions.run(async () => {
          await this.#actions.request(`/changes/${c.id}/status`, { method: 'POST', body: JSON.stringify({ status: c.status === 'accepted' ? 'open' : 'accepted' }) });
          await this.#actions.reload();
        })  }}),
        this.#node('button', { class: 'danger', text: 'Revert', title: 'Put the original text back in the source', tool: { id: 'workspace.revert-change', label: 'Revert change', showText: true, execute: () => this.#actions.run(async () => {
          const entry = this.#actions.bufferSnapshot(c.file);
          if (entry?.unsaved) throw new Error(`Save ${c.file} first.`);
          if (!confirm(`Revert this change in ${c.file}? The original text goes back into the source; the record and its comments are kept.`)) return;
          await this.#actions.request(`/changes/${c.id}/revert`, { method: 'POST' });
          await this.#actions.reloadFile(c.file);
          await this.#actions.compile();
        })  }}),
        this.#node('button', { class: 'primary', text: 'Reply', tool: send})));
      return card;
    }
  }
  window.ReviewCards = ReviewCards;
})();
