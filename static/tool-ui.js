/* Styled help for explicitly declared Tools. This module never creates actions. */
'use strict';
(function () {
  class ToolUI {
    #root;
    #observer;
    #tooltip;
    #target;
    #timer;
    #abort;
    #delay;
    /** Observe functional controls and install one delegated tooltip lifecycle.
     * @param {HTMLElement} root Application root.
     * @param {object} options Hover delay in milliseconds (default 150).
     * @pre Tool interfaces and a live DOM are available.
     * @post Declared Tools receive styled help; no action is inferred or adopted.
     * @return {ToolUI} Mounted UI. @throws {TypeError} Invalid root/delay.
     */
    constructor(root, { delay = 150 } = {}) {
      if (!root || !Number.isFinite(delay) || delay < 0) throw new TypeError('ToolUI needs a root and nonnegative delay');
      this.#root = root; this.#delay = delay; this.#abort = new AbortController();
      this.#tooltip = document.createElement('div');
      this.#tooltip.id = 'tool-tooltip-' + Math.random().toString(36).slice(2);
      this.#tooltip.className = 'tool-tooltip'; this.#tooltip.setAttribute('role', 'tooltip');
      this.#tooltip.setAttribute('popover', 'manual'); this.#tooltip.hidden = true;
      document.body.append(this.#tooltip);
      this.#scan(root);
      this.#observer = new MutationObserver(records => {
        for (const record of records) {
          if (record.type === 'attributes') this.#decorate(record.target);
          else { this.#decorate(record.target.closest?.('button,summary')); for (const added of record.addedNodes) if (added.nodeType === 1) this.#scan(added); }
        }
        if (this.#target && (!this.#target.isConnected || this.#target.closest('[hidden],[inert]'))) this.hide();
      });
      this.#observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['title', 'aria-label', 'hidden', 'disabled'] });
      const options = { signal: this.#abort.signal };
      root.addEventListener('pointerover', event => {
        if (event.pointerType === 'touch') return;
        const target = event.target.closest?.('[data-tool-info]');
        if (target && target !== this.#target) this.#schedule(target, this.#delay);
      }, options);
      root.addEventListener('pointerout', event => {
        if (this.#target?.contains(event.target) && !this.#target.contains(event.relatedTarget) && !this.#tooltip.contains(event.relatedTarget)) this.hide();
      }, options);
      root.addEventListener('focusin', event => {
        const target = event.target.closest?.('[data-tool-info]');
        if (target?.matches(':focus-visible')) this.#schedule(target, 0);
      }, options);
      root.addEventListener('focusout', () => this.hide(), options);
      root.addEventListener('pointerdown', () => this.hide(), options);
      root.addEventListener('click', () => this.hide(), options);
      document.addEventListener('keydown', event => { if (event.key === 'Escape') this.hide(); }, { ...options, capture: true });
      document.addEventListener('scroll', () => this.hide(), { ...options, capture: true });
      window.addEventListener('resize', () => this.hide(), options);
      this.#tooltip.addEventListener('pointerleave', () => this.hide(), options);
    }
    /** Decorate declared Tools in a subtree. @param {HTMLElement} node Inserted subtree.
     * @pre DOM exists. @post Bound Tools expose their declared hover metadata.
     * @return {void} Nothing. @throws {TypeError} Invalid tool metadata.
     */
    #scan(node) { this.#decorate(node); for (const control of node.querySelectorAll('button,summary,[data-tool-label][title]')) this.#decorate(control); }
    /** Render declared help without owning or synthesizing action behavior.
     * @param {HTMLElement} control Candidate control. @pre None.
     * @post Native tooltip is replaced; existing accessible names remain intact.
     * @return {void} Nothing. @throws {TypeError} Invalid tool label.
     */
    #decorate(control) {
      if (!control?.matches?.('button,summary,[role=status][data-tool-label]')) {
        // Compound hosts must not contribute inherited native help to their action buttons.
        if (control?.matches?.('[data-tool-label][title]')) control.removeAttribute('title');
        return;
      }
      const label = control.getAttribute('aria-label') || control.getAttribute('data-tool-label') || control.textContent.trim() || control.getAttribute('title');
      if (!label) return; // Compound controls may receive their content in the next mutation.
      const info = control.getAttribute('title') || control.getAttribute('data-tool-info') || label;
      if (!window.EditorTools.Tool.forControl(control)) return;
      if (control.getAttribute('data-tool-info') !== info) control.setAttribute('data-tool-info', info);
      if (control.hasAttribute('title')) control.removeAttribute('title');
      if (control === this.#target && !this.#tooltip.hidden) this.#tooltip.textContent = info;
    }
    /** Schedule hover help without retaining a stale target.
     * @param {HTMLElement} target Current control. @param {number} delay Milliseconds.
     * @pre Target carries tool metadata. @post Prior tooltip and timer are released.
     * @return {void} Nothing. @throws {Error} DOM positioning failures.
     */
    #schedule(target, delay) {
      this.hide(); this.#target = target;
      this.#timer = setTimeout(() => {
        this.#timer = null;
        if (!target.isConnected || target.closest('[hidden],[inert]')) return this.hide();
        this.#tooltip.textContent = target.getAttribute('data-tool-info'); this.#tooltip.hidden = false;
        this.#tooltip.showPopover?.();
        const described = new Set((target.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));
        described.add(this.#tooltip.id); target.setAttribute('aria-describedby', [...described].join(' '));
        const box = target.getBoundingClientRect(), tip = this.#tooltip.getBoundingClientRect();
        const left = Math.max(8, Math.min(window.innerWidth - tip.width - 8, box.left + (box.width - tip.width) / 2));
        const top = box.bottom + tip.height + 14 <= window.innerHeight ? box.bottom + 6 : Math.max(8, box.top - tip.height - 6);
        this.#tooltip.style.left = left + 'px'; this.#tooltip.style.top = top + 'px';
      }, delay);
    }
    /** Dismiss help and remove only the description owned by this module.
     * @param {void} none No arguments. @pre None; repeatable.
     * @post No timer or tooltip description remains. @return {void} Nothing.
     * @throws {void} None under normal operation.
     */
    hide() {
      clearTimeout(this.#timer); this.#timer = null;
      if (this.#target) {
        const ids = (this.#target.getAttribute('aria-describedby') || '').split(/\s+/).filter(id => id && id !== this.#tooltip.id);
        if (ids.length) this.#target.setAttribute('aria-describedby', ids.join(' ')); else this.#target.removeAttribute('aria-describedby');
      }
      if (this.#tooltip.matches(':popover-open')) this.#tooltip.hidePopover();
      this.#tooltip.hidden = true; this.#target = null;
    }
    /** Release every listener, observer, timer and tooltip node.
     * @param {void} none No arguments. @pre Mounted instance.
     * @post Application controls remain usable without this UI layer.
     * @return {void} Nothing. @throws {void} None under normal operation.
     */
    dispose() { this.hide(); this.#observer.disconnect(); this.#abort.abort(); this.#tooltip.remove(); }
  }
  window.ToolUI = ToolUI;
  document.addEventListener('DOMContentLoaded', () => { window.toolUI = new ToolUI(document.body); }, { once: true });
})();
