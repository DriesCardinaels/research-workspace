/* Concrete feature contributions use only the public Tool interface. */
'use strict';
(() => {
  const { Tool, ToolInfo, ControlTool, TabCloseTool, registry } = window.EditorTools;
  class PdfNavigationTool extends ControlTool { static label = 'PDF page and zoom'; static control = 'navigation'; }
  class PdfMarkTool extends Tool {
    /** Build one annotation command.
     * @param {object} context Annotator public interface.
     * @pre Owner implements getToolbarState, runToolbarCommand and setTool.
     * @post A labeled control is created; activation is handled at the owner event boundary.
     * @return {HTMLButtonElement} Annotation command.
     * @throws {Error} State access or control creation failure.
     */
    create({ owner }) {
      const { id, label, key, hint } = this.constructor;
      const button = document.createElement('button'); button.type = 'button';
      button.className = 'pdfa-btn' + (owner.getToolbarState().tool === id ? ' on' : '');
      button.textContent = label; button.setAttribute('aria-label', label);
      button.setAttribute('aria-pressed', String(owner.getToolbarState().tool === id)); button.title = `${hint} (${key})`;
      Tool.bind(button, this, { owner }); return button;
    }
    /** Select this annotation mode. @param {object} context Public annotator.
     * @pre Editable PDF. @post Active mode updates. @return {*} Selection result.
     * @throws {Error} Owner operation failure.
     */
    execute({ owner }) { return owner.setTool(this.constructor.id); }
    /** Respect archived previews.
     * @param {object} context Annotator public interface.
     * @pre Owner implements getToolbarState().
     * @post State is unchanged.
     * @return {boolean} Whether annotations are editable.
     * @throws {Error} State access failure.
     */
    available({ owner }) { return !owner.getToolbarState().readOnly; }
  }
  class SelectTool extends PdfMarkTool { static id='select'; static label='Select'; static key='V'; static hint='Select text'; }
  class HighlightTool extends PdfMarkTool { static id='highlight'; static label='Highlight'; static key='H'; static hint='Highlight selected text'; }
  class StrikeTool extends PdfMarkTool { static id='strikethrough'; static label='Remove text'; static key='R'; static hint='Mark selected text for removal'; }
  class ReplaceTool extends PdfMarkTool { static id='replace'; static label='Replace text'; static key='T'; static hint='Suggest replacement text'; }
  class PenTool extends PdfMarkTool { static id='pen'; static label='Pen'; static key='P'; static hint='Free-form drawing'; }
  class EraseTool extends PdfMarkTool { static id='eraser'; static label='Eraser'; static key='E'; static hint='Remove a mark'; }
  class PdfActionTool extends Tool {
    /** Create an independent PDF action using public owner methods.
     * @param {object} context Annotator owner and current view.
     * @pre Owner implements getToolbarState and runToolbarCommand.
     * @post One accessible button is created; no document edits occur until activation.
     * @return {HTMLButtonElement} Action control.
     * @throws {Error} Invalid owner or control creation failure.
     */
    create({ owner }) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'pdfa-btn';
      button.textContent = this.constructor.label;
      if (this.constructor.title) button.title = this.constructor.title;
      if (this.constructor.className) button.className += ' ' + this.constructor.className;
      Tool.bind(button, this, { owner });
      return button;
    }
    /** Invoke the configured public operation.
     * @param {PdfAnnotator} owner Target annotator.
     * @param {HTMLButtonElement} button Triggering control.
     * @pre The subclass implements an action.
     * @post The action's documented effects occur.
     * @return {*} Operation result.
     * @throws {Error} Action failure, propagated to the event handler.
     */
    execute({ owner, control }) { return this.constructor.execute(owner, control); }
    /** Refresh an action's label and toggle state.
     * @param {HTMLElement} button Mounted action control.
     * @param {object} context Annotator owner.
     * @pre The owner exposes a toolbar state snapshot.
     * @post Notes label and pressed state reflect current state.
     * @return {void} No return value.
     * @throws {Error} Owner state access failure.
     */
    update(button, { owner }) {
      if (this.constructor.notes) {
        const state = owner.getToolbarState();
        button.textContent = `Notes (${state.noteCount})`;
        button.setAttribute('aria-pressed', String(state.showNotes));
      }
    }
    /** Determine action visibility for preview and archive modes.
     * @param {object} context Annotator owner.
     * @pre Owner provides toolbar state.
     * @post State is unchanged.
     * @return {boolean} Whether the action applies.
     * @throws {Error} Owner state access failure.
     */
    available({ owner }) {
      const state = owner.getToolbarState();
      return this.constructor.readOnly ? !state.bareBar : !state.readOnly;
    }
  }
  class UndoTool extends PdfActionTool { static id = 'pdf.undo'; static label = 'Undo'; static title = 'Undo (⌘/Ctrl+Z)'; static execute = owner => owner.undo(); }
  class RedoTool extends PdfActionTool { static id = 'pdf.redo'; static label = 'Redo'; static title = 'Redo (⌘/Ctrl+Shift+Z or Ctrl+Y)'; static execute = owner => owner.redo(); }
  class NotesTool extends PdfActionTool { static label = 'Notes'; static notes = true; static readOnly = true; static execute = owner => owner.toggleNotes(); }
  class CopyTool extends PdfActionTool {
    static label = 'Copy all'; static readOnly = true;
    static execute = (owner, button) => owner.copyToolbarComments(button);
    /** Include copy in previews only when an owner callback is configured.
     * @param {object} context Annotator owner.
     * @pre Owner provides toolbar state.
     * @post State is unchanged.
     * @return {boolean} Copy capability.
     * @throws {Error} Owner state access failure.
     */
    available({ owner }) { const state = owner.getToolbarState(); return !state.bareBar || (!state.readOnly && state.canCopyAll); }
  }
  class ExportTool extends PdfActionTool {
    static id = 'pdf.export'; static label = 'Save PDF'; static className = 'pdfa-save'; static title = 'Save an annotated copy in the project folder'; static execute = owner => owner.exportPdf();
    /** Limit export to editable review mode.
     * @param {object} context Annotator owner.
     * @pre Owner provides toolbar state.
     * @post State is unchanged.
     * @return {boolean} Export capability.
     * @throws {Error} Owner state access failure.
     */
    available({ owner }) { const state = owner.getToolbarState(); return !state.readOnly && !state.bareBar; }
  }
  registry.register('pdf.navigation', PdfNavigationTool, { views:['pdf','review'] });
  for (const Type of [SelectTool, HighlightTool, StrikeTool, ReplaceTool, PenTool, EraseTool])
    registry.register('pdf.marks', Type, { views:['pdf','review'] });
  for (const Type of [UndoTool, RedoTool, NotesTool, CopyTool, ExportTool]) registry.register('pdf.actions', Type, { views: ['pdf', 'review'] });
})();
