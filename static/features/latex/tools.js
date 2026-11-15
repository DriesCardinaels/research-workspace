/* Concrete feature contributions use only the public Tool interface. */
'use strict';
(() => {
  const { Tool, ToolInfo, ControlTool, TabCloseTool, registry } = window.EditorTools;
  class CompileTool extends ControlTool { static label = 'Build PDF'; static control = 'compileControls'; }
  class CommentsTool extends ControlTool { static label = 'Comments'; static control = 'reviewBtn'; }
  class ChangesTool extends ControlTool { static label = 'Changes'; static control = 'changesBtn'; }
  class FormatTool extends ControlTool {
    static label = 'Source formatting';
    static control = 'formatControls';
    /** Limit formatting to LaTeX source.
     * @param {object} context Workspace public interface.
     * @pre Owner implements isLatexSource().
     * @post State is unchanged.
     * @return {boolean} Whether formatting applies.
     * @throws {Error} Capability access failure.
     */
    available({ owner }) { return owner.isLatexSource(); }
  }
  class SourceCommentTool extends ControlTool { static label = 'Comment on selected text'; static control = 'commentBtn'; }
  class ReferencesTool extends ControlTool {
    static label = 'Check references';
    static control = 'referencesBtn';
    /** Scope metadata checks to bibliography editing.
     * @param {object} context Public workspace owner.
     * @pre Owner implements isBibliographySource().
     * @post Document and controls are unchanged.
     * @return {boolean} Whether a bibliography is active.
     * @throws {TypeError} An invalid owner lacks the public capability method.
     */
    available({ owner }) { return owner.isBibliographySource(); }
  }
  registry.register('workspace.actions', CommentsTool).register('workspace.actions', ChangesTool)
    .register('workspace.build', CompileTool, { views:['both','pdf'] })
    .register('workspace.source', FormatTool, { views:['source','both'] })
    .register('workspace.source', SourceCommentTool, { views:['source','both'] })
    .register('workspace.source', ReferencesTool, { views:['source','both'] });
})();
