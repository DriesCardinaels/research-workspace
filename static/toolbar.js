/* View-scoped tools. Load before the workspace and PDF annotator.
 * Extend Tool, implement create(context), and register the class in an area.
 * Owners supply document operations; toolbars own only placement and visibility.
 */
'use strict';
(function () {
  class ToolbarIconSet {
    #paths = new Map();
    /** Register one outline icon for any toolbar extension.
     * @param {string} name Unique icon identifier.
     * @param {string} path SVG path data in a 24-unit view box.
     * @pre Icon geometry is application-authored, not provider content.
     * @post Geometry is registered privately; all rendering uses the shared size and stroke.
     * @return {ToolbarIconSet} This catalog.
     * @throws {TypeError|Error} Invalid definition or duplicate identifier.
     */
    register(name, path) {
      if (typeof name !== 'string' || !name || typeof path !== 'string' || !path) throw new TypeError('Icon name and path are required');
      if (this.#paths.has(name)) throw new Error('Icon already registered: ' + name);
      this.#paths.set(name, path); return this;
    }
    /** Render a shared icon as markup for source command definitions.
     * @param {string} name Registered icon identifier.
     * @pre Icon has been registered.
     * @post No state or document changes; path attributes are escaped.
     * @return {string} Decorative SVG with common dimensions, stroke and inherited color.
     * @throws {Error} Unknown icon.
     */
    markup(name) {
      const path = this.#paths.get(name);
      if (!path) throw new Error('Unknown toolbar icon: ' + name);
      const escaped = path.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return `<svg class="toolbar-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${escaped}"/></svg>`;
    }
    /** Create a shared icon for controls built through DOM APIs.
     * @param {string} name Registered icon identifier.
     * @pre Browser DOM supports SVG creation.
     * @post A detached SVG is created; catalog storage is unchanged.
     * @return {SVGElement} Decorative icon with the same appearance as markup().
     * @throws {Error} Unknown icon or DOM creation failure.
     */
    create(name) {
      const path = this.#paths.get(name);
      if (!path) throw new Error('Unknown toolbar icon: ' + name);
      const ns = 'http://www.w3.org/2000/svg', icon = document.createElementNS(ns, 'svg');
      for (const [key, value] of Object.entries({class:'toolbar-icon',width:18,height:18,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':1.75,'stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'})) icon.setAttribute(key, value);
      const geometry = document.createElementNS(ns, 'path'); geometry.setAttribute('d', path); icon.append(geometry); return icon;
    }
  }
  const icons = new ToolbarIconSet();
  for (const [name, path] of Object.entries({
    bold:'M7 5h6a3.5 3.5 0 0 1 0 7H7z M7 12h7a3.5 3.5 0 0 1 0 7H7z',
    italic:'M10 5h8 M6 19h8 M14.5 5l-5 14',
    code:'M8 7l-5 5 5 5 M16 7l5 5-5 5',
    quote:'M4 7h6v6H4z M10 13c0 3-2 5-5 5 M14 7h6v6h-6z M20 13c0 3-2 5-5 5',
    citation:'M8 4H5v16h3 M16 4h3v16h-3 M11 9l2-1v8',
    link:'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7 M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
    footnote:'M3 7h11 M3 12h11 M3 17h11 M18 5l2-1v6',
    comment:'M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 3V6a2 2 0 0 1 2-2z M12 8v6 M9 11h6',
    more:'M6 12a1 1 0 1 1-2 0 1 1 0 0 1 2 0 M13 12a1 1 0 1 1-2 0 1 1 0 0 1 2 0 M20 12a1 1 0 1 1-2 0 1 1 0 0 1 2 0',
    commentLines:'M19 5 5 19 M9 7a2 2 0 1 1-4 0 2 2 0 0 1 4 0 M19 17a2 2 0 1 1-4 0 2 2 0 0 1 4 0',
    table:'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z M3 9h18 M3 15h18 M9 3v18',
    select:'M5 3l14 9-7 1-3 7z', highlight:'M14 3l7 7-9 9H5v-7z M3 21h13 M7 10l7 7',
    strike:'M6 5h12 M12 5v14 M4 12h16', replace:'M4 5h10 M9 5v10 M3 10h12 M14 17h7 M18 14l3 3-3 3',
    pen:'M4 20l1-6L16 3l5 5L10 19z M13 6l5 5', eraser:'M3 14l9-10 9 8-8 9H9z M8 9l9 8 M13 21h8',
    undo:'M9 5 4 10l5 5 M4 10h10a6 6 0 0 1 0 12', redo:'M15 5l5 5-5 5 M20 10H10a6 6 0 0 0 0 12',
    minus:'M5 12h14', plus:'M5 12h14 M12 5v14', fit:'M8 4H4v4 M16 4h4v4 M4 16v4h4 M20 16v4h-4 M8 8h8v8H8z',
    notes:'M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 3V6a2 2 0 0 1 2-2z M7 8h10 M7 12h7',
    copy:'M9 8h11v13H9z M15 8V3H4v13h5', save:'M4 3h13l4 4v14H3V3z M7 3v6h10V3 M7 21v-8h10v8',
    refresh:'M20 7a8 8 0 0 0-13-2L3 9 M3 4v5h5 M4 17a8 8 0 0 0 13 2l4-4 M21 20v-5h-5',
    pin:'m16 3 5 5-4 1-3 5v3l-3-3-3-3h3l5-3z M8 16l-5 5',
    chevronDown:'m6 9 6 6 6-6', close:'m6 6 12 12 M18 6 6 18',
  })) icons.register(name, path);
  class ToolInfo {
    /** Apply mandatory label metadata consistently to interactive controls.
     * @param {HTMLElement} control Control receiving hover and accessibility text.
     * @param {object} definition Required nonblank label and optional descriptive info.
     * @param {boolean} preserve Keep existing descriptive titles and accessible names.
     * @pre Control supports DOM attributes; definitions use application-authored text.
     * @post Hover title, accessible name and label metadata are present.
     * @return {HTMLElement} The same control.
     * @throws {TypeError} Missing or blank label/info, or invalid control.
     */
    static apply(control, { label, info = label } = {}, preserve = false) {
      if (typeof label !== 'string' || !label.trim() || typeof info !== 'string' || !info.trim())
        throw new TypeError('Tool definitions require a non-empty label and info text');
      if (!control || typeof control.setAttribute !== 'function') throw new TypeError('Tool info requires a DOM control');
      const title = preserve && (control.getAttribute?.('title') || control.getAttribute?.('data-tool-info') || control.title);
      const name = preserve && control.getAttribute?.('aria-label');
      control.setAttribute('title', title || info);
      control.setAttribute('aria-label', name || label);
      control.setAttribute('data-tool-label', label);
      return control;
    }
  }
  class Tool {
    #definition;
    #contexts = new WeakMap();
    /** Construct a standard action or a concrete subclass.
     * @param {object} definition Optional immutable action definition.
     * @pre Definitions have an id, label and executable operation.
     * @post Presentation and behavior are encapsulated independently of placement.
     * @return {Tool} New tool. @throws {TypeError} Invalid definition.
     */
    constructor(definition = null) {
      if (definition) {
        Tool.validate(definition);
        this.#definition = Object.freeze({ ...definition, presentation: Object.freeze({ ...definition.presentation }) });
      }
    }
    /** Read immutable action metadata without exposing mutable implementation state.
     * @param {void} none No arguments. @pre Tool initialized.
     * @post No changes. @return {object} Definition or subclass metadata. @throws {void} None.
     */
    getDefinition() { return this.#definition || this.constructor; }
    /** Validate a public tool definition before rendering.
     * @param {object} definition Action metadata and operation.
     * @pre None. @post Input remains unchanged.
     * @return {void} Nothing. @throws {TypeError} Unsupported metadata.
     */
    static validate(definition) {
      if (!definition || !['id', 'label'].every(key => typeof definition[key] === 'string' && definition[key].trim()))
        throw new TypeError('Tools require a non-empty id and label');
      if (typeof definition.execute !== 'function') throw new TypeError('Tools require execute(context)');
      if (definition.showText !== undefined && typeof definition.showText !== 'boolean') throw new TypeError('showText must be boolean');
      for (const key of ['text', 'info', 'shortcut']) if (definition[key] !== undefined && (typeof definition[key] !== 'string' || !definition[key].trim()))
        throw new TypeError(key + ' must be non-empty text');
      if (definition.shortcut) {
        const parts = definition.shortcut.toLowerCase().split('+');
        if (!parts.pop() || parts.some(part => !['mod', 'ctrl/cmd', 'ctrl', 'cmd', 'meta', 'alt', 'shift'].includes(part))) throw new TypeError('Invalid tool shortcut');
      }
      if (!definition.icon && definition.showText !== true) throw new TypeError('Tools without icons must show text');
      const styles = { background: ['transparent', 'soft', 'solid'], emphasis: ['normal', 'primary', 'danger'], size: ['compact', 'normal'] };
      if (definition.presentation !== undefined && (!definition.presentation || typeof definition.presentation !== 'object' || Array.isArray(definition.presentation)))
        throw new TypeError('presentation must be an object');
      for (const [key, value] of Object.entries(definition.presentation || {}))
        if (!styles[key]?.includes(value)) throw new TypeError('Unsupported tool presentation: ' + key);
      for (const key of ['available', 'enabled', 'state']) if (definition[key] !== undefined && typeof definition[key] !== 'function')
        throw new TypeError(key + ' must be callable');
    }
    /** Match portable shortcut metadata against a keyboard interaction.
     * @param {string} shortcut Plus-separated modifiers/key; Mod or Ctrl/Cmd is portable.
     * @param {KeyboardEvent} event Current event.
     * @pre Application-authored shortcut. @post Event is unchanged.
     * @return {boolean} Exact modifier/key match. @throws {void} None.
     */
    static matchesShortcut(shortcut, event) {
      if (!shortcut || event.isComposing || event.defaultPrevented || event.repeat) return false;
      const parts = shortcut.toLowerCase().split('+'), key = parts.pop();
      const portable = parts.includes('mod') || parts.includes('ctrl/cmd');
      const control = parts.includes('ctrl'), meta = parts.includes('cmd') || parts.includes('meta');
      return event.key.toLowerCase() === key &&
        (portable ? !!(event.ctrlKey || event.metaKey) : !!event.ctrlKey === control && !!event.metaKey === meta) &&
        !!event.altKey === parts.includes('alt') && !!event.shiftKey === parts.includes('shift');
    }
    /** Create a toolbar control; subclasses implement this operation.
     * @param {object} context Public owner interface and current view.
     * @pre Owner implements the methods required by this tool.
     * @post One control is created without modifying the document.
     * @return {HTMLElement} Control to mount.
     * @throws {Error} Abstract operation or creation failure.
     */
    create(context) {
      if (!this.#definition) throw new Error('Tool.create must be implemented');
      const definition = this.#definition, button = document.createElement('button');
      this.#contexts.set(button, context);
      button.type = 'button'; button.className = 'tool-button';
      button.setAttribute('data-tool-id', definition.id);
      for (const [key, value] of Object.entries(definition.presentation)) button.setAttribute('data-tool-' + key, value);
      if (definition.icon) button.append(icons.create(definition.icon));
      if (definition.showText) {
        const text = document.createElement('span'); text.textContent = definition.text || definition.label; button.append(text);
      }
      ToolInfo.apply(button, { label: definition.label, info: (definition.info || definition.label) + (definition.shortcut ? ' (' + definition.shortcut + ')' : '') });
      Tool.bind(button, this, () => this.#contexts.get(button));
      this.update(button, context);
      return button;
    }
    /** Determine whether this tool applies.
     * @param {object} context Public owner interface and current view.
     * @pre Context is initialized.
     * @post Document and context are unchanged.
     * @return {boolean} Availability.
     * @throws {Error} Capability evaluation failure.
     */
    available(context) { return this.#definition?.available ? !!this.#definition.available(context?.publicContext || context) : true; }
    /** Evaluate executability without changing visibility.
     * @param {object} context Current capabilities. @pre Initialized context.
     * @post No changes. @return {boolean} Whether execution is permitted.
     * @throws {Error} Capability failures propagate.
     */
    enabled(context) { return this.#definition?.enabled ? !!this.#definition.enabled(context?.publicContext || context) : true; }
    /** Execute through the public capability interface.
     * @param {object} context Current capabilities. @pre Tool is enabled and available.
     * @post Operation's documented effects apply. @return {*} Operation result.
     * @throws {Error} Operation failures propagate to the interaction handler.
     */
    execute(context) { if (!this.#definition) throw new Error('Tool.execute must be implemented'); return this.#definition.execute(context?.publicContext || context); }
    /** Refresh local control state.
     * @param {HTMLElement} control Mounted control.
     * @param {object} context Current public owner interface and view.
     * @pre Control was created by this tool.
     * @post Subclasses may update enabled, label or pressed state.
     * @return {void} No return value.
     * @throws {Error} Subclass update failure.
     */
    update(control, context) {
      this.#contexts.set(control, context);
      if (!this.#definition) return;
      control.disabled = !this.enabled(context);
      const state = this.#definition.state?.(context?.publicContext || context) || {};
      for (const key of ['pressed', 'expanded', 'busy']) {
        if (state[key] !== undefined) control.setAttribute('aria-' + key, String(!!state[key]));
        else control.removeAttribute?.('aria-' + key);
      }
      control.setAttribute('data-tool-selected', String(!!state.selected || !!state.pressed));
    }
  }
  const toolIdentities = new WeakMap();
  const bindings = new WeakMap();
  /** Dispatch one declared Tool through the same operation for every trigger.
   * @param {object} context Public capabilities and optional recovery function.
   * @param {Event|null} event Original interaction. @param {HTMLElement|null} control Triggering view.
   * @pre A concrete execution definition exists; controls are not separately bound.
   * @post An enabled action executes once; failures reach the nearest recovery interface.
   * @return {*} Synchronous result or handled promise. @throws {Error} Missing recovery surface.
   */
  Tool.prototype.invoke = function(context = {}, event = null, control = null) {
    // Preserve pointer coordinates and native Event getters/methods. currentTarget
    // remains the bound view even after an asynchronous operation yields.
    const trigger = event && new Proxy(event, { get(original, key) {
      if (key === 'currentTarget') return control || original.currentTarget;
      if (key === 'target') return original.target || control;
      const value = Reflect.get(original, key, original);
      if (typeof value === 'function') return value.bind(original);
      if (value === undefined && ['preventDefault', 'stopPropagation'].includes(key)) return () => {};
      return value;
    } });
    const current = { ...context, event: trigger || { target: control, currentTarget: control, preventDefault() {}, stopPropagation() {} }, control };
    if (context.publicContext) current.publicContext = { ...context.publicContext, event: current.event, control };
    const operation = () => {
      if (control?.disabled || !this.available(current) || !this.enabled(current)) return;
      return this.execute(current);
    };
    if (context.run) return context.run(operation);
    if (context.owner?.runToolbarCommand) return context.owner.runToolbarCommand(operation);
    if (context.owner?.run) return context.owner.run(operation);
    const recover = error => {
      if (typeof window.message === 'function') return window.message(error.message, true);
      const host = control?.closest?.('dialog,[role="dialog"]') || document.getElementById?.('message');
      if (!host) throw error;
      let alert = host.querySelector?.('[data-tool-error]');
      if (!alert) { alert = document.createElement('p'); alert.setAttribute('role', 'alert'); alert.setAttribute('data-tool-error', ''); host.append(alert); }
      alert.textContent = error.message;
    };
    try { const result = operation(); return result?.then ? Promise.resolve(result).catch(recover) : result; }
    catch (error) { return recover(error); }
  };
  /** Bind declared execution to existing markup without retaining another action handler.
   * @param {HTMLElement} control Custom-rendered action control.
   * @param {Tool|object} definition Concrete Tool or validated action definition.
   * @param {object|Function} context Public context, optionally resolved at activation.
   * @pre No independent button handler is present; label and operation are explicit.
   * @post Exactly one shared dispatcher owns activation; rebinding removes the old dispatcher.
   * @return {Tool} Concrete action. @throws {TypeError} Invalid definition/control.
   */
  Tool.bind = (control, definition, context = {}) => {
    const tool = definition instanceof Tool ? definition : new Tool(definition);
    const previous = bindings.get(control);
    if (previous) control.removeEventListener?.('click', previous.listener);
    const listener = event => {
      if (['button', 'summary'].includes(String(control.tagName || control.tag || '').toLowerCase())) event?.preventDefault?.();
      if (control.type === 'submit' && control.form?.reportValidity && !control.form.reportValidity()) return;
      const current = typeof context === 'function' ? context() : context;
      return tool.invoke(current, event, control);
    };
    bindings.set(control, { tool, context, listener }); toolIdentities.set(control, tool);
    const metadata = tool.getDefinition();
    ToolInfo.apply(control, { label: metadata.label, info: metadata.info || metadata.label }, true);
    control.setAttribute('data-tool-id', metadata.id || 'tool.' + tool.constructor.name);
    control.addEventListener('click', listener);
    return tool;
  };
  /** Activate the Tool directly, including keyboard/menu triggers, without synthesizing clicks.
   * @param {HTMLElement} control Bound action. @param {Event|null} event Trigger.
   * @pre Control was explicitly bound. @post The same action and recovery guards execute once.
   * @return {*} Action result. @throws {Error} Unbound action.
   */
  Tool.activate = (control, event = null) => {
    const binding = bindings.get(control);
    if (!binding) throw new Error('Control has no concrete Tool');
    return binding.tool.invoke(typeof binding.context === 'function' ? binding.context() : binding.context, event, control);
  };
  /** Release only the shared dispatch owned by this control.
   * @param {HTMLElement} control Bound control. @pre None; repeatable.
   * @post Dispatcher and identity are released. @return {void} Nothing. @throws {void} None.
   */
  Tool.unbind = control => { const binding = bindings.get(control); if (binding) control.removeEventListener?.('click', binding.listener); bindings.delete(control); toolIdentities.delete(control); };
  /** Bind a disclosure's native functionality as a concrete Tool.
   * @param {HTMLElement} control Summary. @param {string} label Required action name.
   * @pre Parent details exists by activation. @post Native double toggling is prevented.
   * @return {Tool} Disclosure action. @throws {Error} Invalid parent.
   */
  Tool.disclosure = (control, label = 'Expand or collapse section') => Tool.bind(control, {
    id: 'ui.disclosure', label, showText: true,
    execute: ({ control: summary }) => { const details = summary.closest('details'); if (!details) throw new Error('Disclosure has no details owner'); details.open = !details.open; },
  });
  /** Bind a popover invoker using the same Tool activation path.
   * @param {HTMLElement} control Native invoker. @param {string} id Target popover id.
   * @param {string} label Action name. @pre Target exists at activation.
   * @post Exactly one native popover transition occurs. @return {Tool} Popover action.
   * @throws {Error} Missing popover.
   */
  Tool.popover = (control, id, label) => Tool.bind(control, {
    id: 'ui.popover.' + id, label, showText: true,
    execute: () => { const target = document.getElementById(id); if (!target) throw new Error('Popover not found: ' + id); if (target.matches(':popover-open')) target.hidePopover(); else target.showPopover(); },
  });
  /** Route native form submission and button activation through one concrete Tool.
   * @param {HTMLFormElement} form Validating form. @param {HTMLElement|null} control Submit button.
   * @param {Tool|object} definition Submission action. @param {object} context Recovery/capabilities.
   * @pre Form contains a submit button. @post Enter and click execute identical validated behavior.
   * @return {Tool} Bound action. @throws {Error} Missing submit control.
   */
  Tool.submit = (form, control, definition, context = {}) => {
    control ||= form.querySelector('button[type=submit],button:not([type])');
    if (!control) throw new Error('Form has no submit Tool control');
    const tool = Tool.bind(control, definition, context);
    form.addEventListener('submit', event => { event.preventDefault(); return Tool.activate(control, event); });
    return tool;
  };
  /** Read the tool associated with a control.
   * @param {HTMLElement} control Mounted control. @pre None. @post No changes.
   * @return {Tool|undefined} Tool identity. @throws {void} None.
   */
  Tool.forControl = control => toolIdentities.get(control);
  class ControlTool extends Tool {
    /** Adapt an owner control through its public accessor.
     * @param {object} context Owner implementing getToolbarControl(id).
     * @pre Subclass control names an initialized control.
     * @post Existing control is returned; owner storage is not accessed.
     * @return {HTMLElement} Owner-provided control.
     * @throws {Error} Unknown or unavailable control.
     */
    create(context) { return context.owner.getToolbarControl(this.constructor.control); }
  }
  class ToolRegistry {
    /** Initialize private registration storage.
     * @param {void} none No arguments.
     * @pre None.
     * @post Registry is empty and independent of other registries.
     * @return {ToolRegistry} New registry.
     * @throws {Error} None under normal operation.
     */
    constructor() {}
    #areas = new Map();
    /** Register a tool without changing renderers or other tools.
     * @param {string} area Non-empty toolbar area identifier.
     * @param {Function} Type Concrete Tool subclass with a no-argument constructor and required static label.
     * @param {object} options Optional views array restricting visibility.
     * @pre Class is not already registered in the area.
     * @post Future mounts include the class with default hover/accessibility text; existing mounts remain stable.
     * @return {ToolRegistry} This registry for composition.
     * @throws {TypeError|Error} Invalid definition or duplicate registration.
     */
    register(area, Type, { views = null } = {}) {
      if (typeof area !== 'string' || !area.trim()) throw new TypeError('Toolbar area must be a non-empty string');
      if (typeof Type !== 'function' || !(Type.prototype instanceof Tool)) throw new TypeError('Register a Tool subclass');
      if (typeof Type.label !== 'string' || !Type.label.trim()) throw new TypeError('Tool definitions require a non-empty static label');
      if (Type.id !== undefined && (typeof Type.id !== 'string' || !Type.id.trim())) throw new TypeError('Tool id must be non-empty text');
      if (Type.info !== undefined && (typeof Type.info !== 'string' || !Type.info.trim())) throw new TypeError('Tool info must be non-empty text');
      if (views !== null && (!Array.isArray(views) || views.some(view => typeof view !== 'string'))) throw new TypeError('Views must be an array of strings');
      const entries = this.#areas.get(area) || [];
      if (entries.some(entry => entry.Type === Type || (Type.id !== undefined && entry.Type.id === Type.id))) throw new Error('Tool already registered in ' + area);
      entries.push({ Type, views: views && Object.freeze([...views]) }); this.#areas.set(area, entries);
      return this;
    }
    /** Register a standard Tool definition without creating a custom subclass.
     * @param {string} area Host location. @param {object} definition Valid Tool definition.
     * @param {object} options Optional view restriction.
     * @pre ID is unique within this area. @post Future mounts include this action.
     * @return {ToolRegistry} This registry. @throws {TypeError|Error} Invalid or duplicate action.
     */
    contribute(area, definition, options = {}) {
      Tool.validate(definition);
      if ((this.#areas.get(area) || []).some(entry => entry.Type.id === definition.id)) throw new Error('Tool already registered: ' + definition.id);
      const frozen = Object.freeze({ ...definition, presentation: Object.freeze({ ...definition.presentation }) });
      class Action extends Tool { static id = frozen.id; static label = frozen.label; static info = frozen.info; static shortcut = frozen.shortcut; constructor() { super(frozen); } }
      return this.register(area, Action, options);
    }
    /** Invoke a registered concrete action without requiring a visible button.
     * @param {string} area Contribution location. @param {string} id Stable Tool id.
     * @param {object} context Current public capabilities and recovery interface.
     * @pre ID is registered. @post The same Tool implementation handles the trigger.
     * @return {*} Operation result. @throws {Error} Unknown action.
     */
    execute(area, id, context) {
      const entry = (this.#areas.get(area) || []).find(({ Type }) => Type.id === id);
      if (!entry) throw new Error('Unknown registered Tool: ' + id);
      return new entry.Type().invoke(context);
    }
    /** Mount a snapshot of the area's tools.
     * @param {string} area Registered toolbar area; an empty area is allowed.
     * @param {object} context Public owner interface and current view.
     * @param {string} label Accessible toolbar label.
     * @pre Registered owner controls are initialized.
     * @post Stable nodes are created; refresh(nextContext) updates visibility/state without recreating tools.
     * @return {object} Element and refresh function; tool instances and registrations remain private.
     * @throws {TypeError|Error} Invalid controls or tool construction, capability or update failures.
     */
    mount(area, context, label) {
      const element = document.createElement('div');
      element.className = 'editor-toolbar'; element.setAttribute('role', 'group');
      element.setAttribute('aria-label', label);
      const items = (this.#areas.get(area) || []).map(({ Type, views }) => {
        const tool = new Type(), wrapper = document.createElement('div');
        const control = tool.create(context);
        if (!control || typeof control !== 'object') throw new TypeError('Tool.create must return a DOM control');
        wrapper.className = 'toolbar-item'; wrapper.append(control); element.append(wrapper);
        if (!toolIdentities.has(control)) toolIdentities.set(control, tool);
        return { tool, wrapper, views, control, Type };
      });
      const refresh = next => {
        for (const { tool, wrapper, views, control, Type } of items) {
          wrapper.hidden = !!(views && !views.includes(next.view)) || !tool.available(next);
          tool.update(control, next);
          ToolInfo.apply(control, { label: Type.label, info: Type.info || Type.title || Type.hint || Type.label }, true);
        }
        element.hidden = items.every(item => item.wrapper.hidden);
      };
      refresh(context);
      const keyTarget = context.keyTarget;
      const keydown = event => {
        const item = items.find(({ Type, wrapper }) => !wrapper.hidden && Tool.matchesShortcut(Type.shortcut, event));
        if (!item) return;
        event.preventDefault(); event.stopPropagation(); if (!item.control.disabled) Tool.activate(item.control, event);
      };
      if (keyTarget && items.some(({ Type }) => Type.shortcut)) keyTarget.addEventListener('keydown', keydown);
      return { element, refresh, dispose() {
        keyTarget?.removeEventListener?.('keydown', keydown);
        for (const { tool, control } of items) { tool.dispose?.(control); Tool.unbind(control); }
        element.remove?.();
      } };
    }
  }
  class SourceCommandRegistry {
    #commands = new Map();
    #tools = new Map();
    /** Register an independent formatting command.
     * @param {object} command ID, name, label, icon, group, optional key and execute(workspace).
     * @pre The ID is unique and execute is callable.
     * @post A frozen copy is registered; caller mutations cannot alter it.
     * @return {SourceCommandRegistry} This registry.
     * @throws {TypeError|Error} Invalid definition or duplicate ID.
     */
    register(command) {
      if (!command || !['id', 'name', 'label', 'icon', 'group'].every(key => typeof command[key] === 'string' && command[key].trim()) || typeof command.execute !== 'function')
        throw new TypeError('Source commands require id, name, label, icon, group and execute');
      if (this.#commands.has(command.id)) throw new Error('Source command already registered: ' + command.id);
      this.#commands.set(command.id, Object.freeze({ ...command }));
      const definition = this.#commands.get(command.id);
      class SourceCommandTool extends Tool {
        static id = 'source.' + definition.id;
        static label = definition.label;
        /** Execute a registered source operation using the current owner.
         * @param {object} context Public owner. @pre Owner supplies command capabilities.
         * @post Command effects apply. @return {*} Result. @throws {Error} Operation failure.
         */
        execute({ owner, dismiss }) { dismiss?.(); return definition.execute(owner); }
      }
      this.#tools.set(command.id, new SourceCommandTool());
      return this;
    }
    /** Bind a formatting control to its Tool while retaining its existing renderer.
     * @param {string} id Command identity. @param {HTMLElement} control Rendered button.
     * @pre Command exists. @post The control resolves to the command's Tool.
     * @return {HTMLElement} Original button. @throws {Error} Unknown command.
     */
    bind(id, control, owner, dismiss = null) { const tool = this.#tools.get(id); if (!tool) throw new Error('Unknown source command: ' + id); Tool.bind(control, tool, { owner, dismiss }); return control; }
    /** Read registered commands without exposing storage.
     * @param {void} none No arguments.
     * @pre None.
     * @post Registrations are unchanged.
     * @return {object[]} A new insertion-ordered array of immutable command definitions.
     * @throws {Error} None under normal operation.
     */
    list() { return [...this.#commands.values()]; }
    /** Execute a command through the workspace's public interface.
     * @param {string} id Registered command ID.
     * @param {Workspace} workspace Target workspace.
     * @pre Workspace implements the command's required public methods.
     * @post The command's documented edit is applied.
     * @return {*} Command result, including a promise for asynchronous commands.
     * @throws {Error} Unknown command or any command failure; callers handle errors.
     */
    execute(id, workspace) {
      const command = this.#commands.get(id);
      if (!command) throw new Error('Unknown source command: ' + id);
      return this.#tools.get(id).execute({ owner: workspace });
    }
  }
  class TabCloseTool extends Tool {
    static label = 'Close';
    static select = (_owner, file) => [file];
    static includePinned = false;
    /** Create an independently registered tab-closing action.
     * @param {object} context Owner, clicked file and dismiss callback.
     * @pre Owner implements getOpenTabs, closeTabs and run.
     * @post Menu button dispatches through the public batch-close boundary.
     * @return {HTMLButtonElement} Menu item.
     * @throws {Error} DOM creation failures propagate to the menu boundary.
     */
    create(context) {
      const button = document.createElement('button');
      button.textContent = this.constructor.label;
      button.setAttribute('role', 'menuitem');
      Tool.bind(button, this, context);
      return button;
    }
    /** Close the selected tabs through the public save/confirmation operation.
     * @param {object} context Owner, file and dismissal operation.
     * @pre Tab menu is active. @post Eligible tabs close or cancellation preserves them.
     * @return {*} Close result. @throws {Error} Owner failure.
     */
    execute({ owner, file, dismiss }) { dismiss(); return owner.closeTabs(this.constructor.select(owner, file), { includePinned: this.constructor.includePinned }); }
    /** Disable actions with no eligible tabs.
     * @param {HTMLButtonElement} button Menu item. @param {object} context Public owner and file.
     * @pre Selection function is initialized. @post Disabled state reflects close eligibility.
     * @return {void} Nothing. @throws {Error} Selection failures propagate.
     */
    update(button, { owner, file }) {
      button.disabled = !this.constructor.select(owner, file).some(f => this.constructor.includePinned || !owner.isTabPinned(f));
    }
  }
  const registry = new ToolRegistry();
  window.EditorTools = Object.freeze({ Tool, ToolInfo, ControlTool, ToolRegistry, TabCloseTool, ToolbarIconSet, icons, SourceCommandRegistry, sourceCommands: new SourceCommandRegistry(), registry });
})();
