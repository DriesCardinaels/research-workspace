/* BibTeX diagnostics contribute to the existing source toolbar through public Tools. */
'use strict';
(function () {
  const { Tool, registry, ToolInfo } = window.EditorTools;
  class BibliographyTool extends Tool {
    /** Limit controls to individual bibliography buffers.
     * @param {object} context Public workspace owner. @pre Owner implements isBibliographySource().
     * @post No changes. @return {boolean} Applicability. @throws {Error} Invalid owner.
     */
    available({ owner }) { return owner.isBibliographySource(); }
    /** Create the common bibliography action control with shared dispatch.
     * @param {object} context Public owner. @pre Public diagnostics interface exists.
     * @post A concrete Tool owns activation; no independent handler exists.
     * @return {HTMLButtonElement} Detached control. @throws {Error} DOM failure.
     */
    create(context) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'tool-button bibliography-tool';
      Tool.bind(button, this, context); return button;
    }
  }
  class BibliographyWarningsTool extends BibliographyTool {
    static id = 'bibliography.warnings'; static label = 'Bibliography warnings';
    /** Reveal the first warning. @param {object} context Public owner.
     * @pre A warning is available. @post Selection navigates to it.
     * @return {*} Navigation result. @throws {Error} Owner failure.
     */
    execute({ owner }) { return owner.focusBibliographyWarning(); }
    /** Refresh the live count in place. @param {HTMLElement} button Control.
     * @param {object} context Public owner. @pre Mounted.
     * @post Count/availability update without recreating the control.
     * @return {void} Nothing. @throws {Error} State access failure.
     */
    update(button, { owner }) {
      const state = owner.getBibliographyToolState();
      button.textContent = state.warnings + (state.warnings === 1 ? ' warning' : ' warnings');
      button.disabled = !state.warnings; button.setAttribute('aria-live', 'polite');
      button.setAttribute('aria-label', button.textContent + (state.warnings ? '. Show first warning' : ''));
    }
  }
  class AutomaticOpenAlexTool extends BibliographyTool {
    static id = 'bibliography.automatic'; static label = 'Auto OpenAlex';
    /** Toggle automatic checks through the controller interface.
     * @param {object} context Public owner. @pre Bibliography is active.
     * @post Preference and queued checks update. @return {*} Controller result.
     * @throws {Error} Controller failure.
     */
    execute({ owner }) { return owner.runBibliographyOperation('automatic', !owner.getBibliographyToolState().automatic); }
    /** Refresh the accessible switch state. @param {HTMLElement} button Control.
     * @param {object} context Public owner. @pre Mounted.
     * @post Checked appearance matches controller preference. @return {void} Nothing.
     * @throws {Error} State failure.
     */
    update(button, { owner }) {
      const state = owner.getBibliographyToolState(); button.textContent = 'Auto OpenAlex';
      button.setAttribute('role', 'switch'); button.setAttribute('aria-checked', String(state.automatic));
    }
  }
  class RecheckBibliographyTool extends BibliographyTool {
    static id = 'bibliography.recheck'; static label = 'Recheck file';
    /** Explicitly retry current-file checks. @param {object} context Public owner.
     * @pre Bibliography is active. @post Controller rechecks current entries.
     * @return {*} Check completion. @throws {Error} Controller failure.
     */
    execute({ owner }) { return owner.runBibliographyOperation('recheck'); }
    /** Refresh progress. @param {HTMLElement} button Control. @param {object} context Owner.
     * @pre Mounted. @post Progress is announced without moving focus.
     * @return {void} Nothing. @throws {Error} State failure.
     */
    update(button, { owner }) { button.textContent = 'Recheck file'; button.setAttribute('aria-busy', String(owner.getBibliographyToolState().pending)); }
  }
  class RestoreBibliographyWarningsTool extends BibliographyTool {
    static id = 'bibliography.restore'; static label = 'Restore suppressed warnings';
    /** Restore current-file suppressions. @param {object} context Public owner.
     * @pre Suppressions exist. @post Warnings return through normal publication.
     * @return {*} Controller result. @throws {Error} Controller failure.
     */
    execute({ owner }) { return owner.runBibliographyOperation('restore'); }
    /** Apply only when there is something to restore. @param {object} context Owner.
     * @pre Mounted. @post No changes. @return {boolean} Visibility. @throws {Error} State failure.
     */
    available(context) { return super.available(context) && context.owner.getBibliographyToolState().suppressed > 0; }
    /** Refresh the suppression count. @param {HTMLElement} button Control. @param {object} context Owner.
     * @pre Mounted. @post Label updates. @return {void} Nothing. @throws {Error} State failure.
     */
    update(button, { owner }) { button.textContent = 'Restore suppressed (' + owner.getBibliographyToolState().suppressed + ')'; }
  }
  class BibliographyStatusTool extends BibliographyTool {
    static id = 'bibliography.status'; static label = 'Bibliography check status';
    /** Create a passive, accessible status contribution. @param {object} context Owner.
     * @pre Mounted registry. @post Status shares toolbar placement with actions.
     * @return {HTMLElement} Status. @throws {Error} DOM failure.
     */
    create(context) { const status = document.createElement('span'); status.className = 'bibliography-tool-status'; status.setAttribute('role', 'status'); return status; }
    /** Show only progress or a problem. @param {object} context Owner.
     * @pre State readable. @post No changes. @return {boolean} Visibility. @throws {Error} State failure.
     */
    available(context) { const state = context.owner.getBibliographyToolState(); return super.available(context) && !!(state.pending || state.problem); }
    /** Keep long recovery details in styled hover help. @param {HTMLElement} control Status.
     * @param {object} context Owner. @pre Mounted. @post Compact status and full accessible help update.
     * @return {void} Nothing. @throws {Error} State failure.
     */
    update(control, { owner }) {
      const state = owner.getBibliographyToolState(); control.textContent = state.problem ? 'OpenAlex unavailable' : 'Checking…';
      ToolInfo.apply(control, { label: this.constructor.label, info: state.problem || 'Checking bibliography entries' });
      control.setAttribute('aria-label', state.problem || 'Checking bibliography entries');
    }
  }
  for (const Type of [BibliographyWarningsTool, AutomaticOpenAlexTool, RecheckBibliographyTool, RestoreBibliographyWarningsTool, BibliographyStatusTool]) registry.register('bibtex.tools', Type, { views: ['source', 'both'] });
})();
