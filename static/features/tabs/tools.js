/* Concrete feature contributions use only the public Tool interface. */
'use strict';
(() => {
  const { Tool, ToolInfo, ControlTool, TabCloseTool, registry } = window.EditorTools;
  class CloseOtherTabsTool extends TabCloseTool {
    static label = 'Close Others'; static select = (owner, file) => owner.getOpenTabs().filter(f => f !== file);
  }
  class CloseRightTabsTool extends TabCloseTool {
    static label = 'Close to the Right'; static select = (owner, file) => owner.getOpenTabs().slice(owner.getOpenTabs().indexOf(file) + 1);
  }
  class CloseSavedTabsTool extends TabCloseTool {
    static label = 'Close Saved'; static select = owner => owner.getOpenTabs().filter(f => owner.isTabSaved(f));
  }
  class CloseUnpinnedTabsTool extends TabCloseTool {
    static label = 'Close Non-Pinned'; static select = owner => owner.getOpenTabs().filter(f => !owner.isTabPinned(f));
  }
  class CloseAllTabsTool extends TabCloseTool {
    static label = 'Close All'; static select = owner => owner.getOpenTabs(); static includePinned = true;
  }
  class PinTabTool extends Tool {
    static label = 'Pin tab';
    /** Create a pin toggle for the clicked tab, independent of active selection.
     * @param {object} context Owner, clicked file and dismiss callback.
     * @pre Tab is open. @post Click dispatches through the owner error boundary.
     * @return {HTMLButtonElement} Menu item. @throws {Error} DOM creation failure.
     */
    create(context) {
      const button = document.createElement('button'); button.setAttribute('role', 'menuitem');
      Tool.bind(button, this, context);
      return button;
    }
    /** Toggle the requested tab pin. @param {object} context Public tab owner.
     * @pre Tab exists. @post Pin state toggles. @return {*} Owner result.
     * @throws {Error} Owner failure.
     */
    execute({ owner, file, dismiss }) { dismiss(); return owner.setTabPinned(file, !owner.isTabPinned(file)); }
    /** Reflect the clicked tab's current pin state.
     * @param {HTMLButtonElement} button Menu item. @param {object} context Public owner and file.
     * @pre Tab is open. @post Correct Pin/Unpin label is shown.
     * @return {void} Nothing. @throws {Error} Owner state failure.
     */
    update(button, { owner, file }) {
      button.textContent = owner.isTabPinned(file) ? 'Unpin' : 'Pin';
      ToolInfo.apply(button, { label: button.textContent });
    }
  }
  for (const Type of [TabCloseTool, CloseOtherTabsTool, CloseRightTabsTool, CloseSavedTabsTool, CloseUnpinnedTabsTool, CloseAllTabsTool, PinTabTool])
    registry.register('workspace.tabs', Type);
})();
