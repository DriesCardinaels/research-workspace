/* Native modal lifecycle and reusable forms. Domain modules register pane factories;
 * buttons call EditorPanes.open(id, context). No filesystem or network policy lives here. */
'use strict';
(() => {
  class PaneRegistry {
    #factories = new Map();
    #active = new WeakSet();
    #number = 0;
    /** Register or replace a pane implementation at a stable action seam.
     * @param {string} id Stable name used by buttons. @param {Function} factory Context => {dialog, focus?, disposable?}.
     * @pre Factory builds a native dialog and does not open it.
     * @post Subsequent opens use this factory; already open panes are unchanged.
     * @return {void} Nothing. @throws {TypeError} Invalid name or factory.
     */
    register(id, factory) {
      if (typeof id !== 'string' || !id.trim() || typeof factory !== 'function') throw new TypeError('A pane needs a name and factory');
      this.#factories.set(id, factory);
    }
    /** Open a registered pane or existing native dialog with one consistent lifecycle.
     * @param {string|HTMLDialogElement} target Registered name or existing dialog.
     * @param {object} context Factory input; for existing dialogs, optional focus element and disposable flag.
     * @pre Caller owns initialization errors; any supplied focus element belongs to the dialog.
     * @post Modal traps focus natively; Escape dismisses; close restores focus and disposes transient panes.
     * @return {HTMLDialogElement} Open dialog. @throws {Error|TypeError} Unknown name, invalid markup or native open failure.
     */
    open(target, context = {}) {
      let spec;
      if (typeof target === 'string') {
        const factory = this.#factories.get(target);
        if (!factory) throw new Error('Unknown pane: ' + target);
        spec = factory(context);
      } else spec = { dialog: target, ...context };
      const { dialog, focus, disposable = false } = spec;
      if (dialog?.tagName !== 'DIALOG') throw new TypeError('A pane must provide a native dialog');
      if (dialog.open || this.#active.has(dialog)) return dialog;
      const origin = document.activeElement;
      dialog.classList.add('ui-pane');
      const heading = dialog.querySelector('h2,h3');
      if (heading && !dialog.getAttribute('aria-labelledby')) {
        heading.id ||= 'pane-title-' + (++this.#number);
        dialog.setAttribute('aria-labelledby', heading.id);
      }
      if (!dialog.getAttribute('aria-labelledby') && !dialog.getAttribute('aria-label')) throw new TypeError('A pane needs an accessible title');
      if (!dialog.isConnected) document.body.append(dialog);
      this.#active.add(dialog);
      const cleanup = () => {
        this.#active.delete(dialog);
        if (disposable) dialog.remove();
        if (origin?.isConnected && !origin.closest('[inert]')) origin.focus({ preventScroll: true });
      };
      dialog.addEventListener('close', cleanup, { once: true });
      try {
        dialog.showModal();
        const initial = focus || dialog.querySelector('[autofocus]') || dialog.querySelector('input:not([disabled]),select:not([disabled]),textarea:not([disabled]),button:not([disabled])');
        initial?.focus({ preventScroll: true });
      } catch (error) {
        dialog.removeEventListener('close', cleanup);
        cleanup();
        throw error;
      }
      return dialog;
    }
    /** Build a labeled form; submit errors and pending state belong to this UI boundary.
     * @param {object} definition Title, description, fields, submitLabel, danger and async onSubmit(values).
     * Fields accept name, label, value, hint, type, required, maxLength and options [{value,label}].
     * @pre Definition comes from trusted application code; onSubmit throws on failure.
     * @post Values are retained on failure; duplicate submits and dismissal while saving are blocked.
     * @return {object} Disposable pane descriptor for open() or a registered factory.
     * @throws {TypeError|Error} Invalid definition or DOM failure; submit failures are displayed locally.
     */
    form({ title, description, fields = [], submitLabel = 'Save', danger = false, onSubmit }) {
      if (!title || typeof onSubmit !== 'function') throw new TypeError('A form pane needs a title and submit operation');
      const dialog = document.createElement('dialog'), form = document.createElement('form');
      const prefix = 'pane-' + (++this.#number), inputs = new Map();
      const heading = document.createElement('h2'); heading.id = prefix + '-title'; heading.textContent = title;
      dialog.setAttribute('aria-labelledby', heading.id); form.append(heading);
      if (description) {
        const text = document.createElement('p'); text.id = prefix + '-description'; text.className = 'pane-description'; text.textContent = description;
        dialog.setAttribute('aria-describedby', text.id); form.append(text);
      }
      for (const field of fields) {
        const group = document.createElement('div'), label = document.createElement('label');
        const input = document.createElement(field.options ? 'select' : field.type === 'textarea' ? 'textarea' : 'input');
        group.className = 'pane-field'; input.id = prefix + '-' + field.name; input.name = field.name;
        label.htmlFor = input.id; label.textContent = field.label;
        if (field.options) for (const option of field.options) {
          const node = document.createElement('option'); node.value = option.value; node.textContent = option.label; input.append(node);
        }
        else { if (field.type === 'textarea') input.rows = 5; else input.type = field.type || 'text'; input.autocomplete = 'off'; input.spellcheck = field.type === 'textarea'; }
        input.value = field.value ?? field.options?.[0]?.value ?? '';
        input.required = !!field.required;
        if (field.maxLength) input.maxLength = field.maxLength;
        group.append(label, input);
        if (field.hint) {
          const hint = document.createElement('p'); hint.id = input.id + '-hint'; hint.className = 'pane-hint'; hint.textContent = field.hint;
          input.setAttribute('aria-describedby', hint.id); group.append(hint);
        }
        inputs.set(field.name, input); form.append(group);
      }
      const error = document.createElement('p'); error.className = 'pane-error'; error.setAttribute('role', 'alert');
      const actions = document.createElement('div'); actions.className = 'dialog-actions';
      const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel';
      const submit = document.createElement('button'); submit.type = 'submit'; submit.textContent = submitLabel; submit.className = danger ? 'pane-destructive' : 'primary';
      const unavailable = fields.some(field => field.options && !field.options.length);
      submit.disabled = unavailable;
      if (unavailable) error.textContent = 'No options are available for this action.';
      actions.append(cancel, submit); form.append(error, actions); dialog.append(form);
      window.EditorTools.Tool.bind(cancel, { id: prefix + '.cancel', label: 'Cancel ' + title, showText: true, execute: () => dialog.close('cancel') });
      let pending = false;
      dialog.addEventListener('cancel', event => { if (pending) event.preventDefault(); });
      window.EditorTools.Tool.submit(form, submit, { id: prefix + '.submit', label: submitLabel, showText: true, execute: async () => {
        if (pending || unavailable || !form.reportValidity()) return;
        pending = true; error.textContent = ''; form.setAttribute('aria-busy', 'true');
        const controls = [...inputs.values(), cancel, submit];
        controls.forEach(control => { control.disabled = true; }); submit.textContent = 'Working…';
        try {
          await onSubmit(Object.fromEntries([...inputs].map(([name, input]) => [name, input.value])));
          dialog.close('submit');
        } catch (failure) { error.textContent = failure.message || 'The action could not be completed.'; }
        finally {
          pending = false; form.removeAttribute('aria-busy'); controls.forEach(control => { control.disabled = false; });
          submit.disabled = unavailable; submit.textContent = submitLabel;
          if (dialog.open) (inputs.values().next().value || cancel).focus();
        }
      } });
      return { dialog, focus: danger ? cancel : inputs.values().next().value || cancel, disposable: true };
    }
  }
  window.PaneRegistry = PaneRegistry;
  window.EditorPanes = new PaneRegistry();
})();
