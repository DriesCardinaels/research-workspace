/* Offline Research Workbench. PDF.js renders pages; pdf-lib exports highlights,
 * ink and PDF comment annotations. Coordinates use viewport units at scale 1.
 */
"use strict";

(function () {
  const VENDOR = "/static/vendor";
  let pdfjsPromise = null;
  let pdflibPromise = null;

  function loadPdfjs() {
    if (!pdfjsPromise) {
      pdfjsPromise = import(VENDOR + "/pdfjs/pdf.min.mjs").then((m) => {
        m.GlobalWorkerOptions.workerSrc = VENDOR + "/pdfjs/pdf.worker.min.mjs";
        return m;
      });
    }
    return pdfjsPromise;
  }
  function loadPdfLib() {
    if (!pdflibPromise) {
      pdflibPromise = new Promise((resolve, reject) => {
        if (window.PDFLib) return resolve(window.PDFLib);
        const s = document.createElement("script");
        s.src = VENDOR + "/pdf-lib/pdf-lib.min.js";
        s.onload = () => resolve(window.PDFLib);
        s.onerror = () => reject(new Error("could not load pdf-lib"));
        document.head.append(s);
      });
    }
    return pdflibPromise;
  }

  const SVGNS = "http://www.w3.org/2000/svg";
  const HL_OPACITY = 0.4; // same on screen and in the exported PDF (multiply blend)
  const uid = () => Math.random().toString(36).slice(2, 10);
  /** Create annotator DOM with shared hover/accessibility metadata.
   * @param {string} tag HTML tag. @param {string} cls Optional classes.
   * @param {object} attrs Attributes, text and handlers.
   * @pre Document exists; icon controls supply aria-label metadata.
   * @post New node receives attributes, handlers and default hover text.
   * @return {HTMLElement} Detached node. @throws {Error} DOM or label validation failure.
   */
  function el(tag, cls, attrs) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'tool') continue;
      if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (k === "text") e.textContent = v;
      else e.setAttribute(k, v);
    }
    if (attrs?.tool) window.EditorTools.Tool.bind(e, attrs.tool);
    else if (tag === 'summary') window.EditorTools.Tool.disclosure(e, attrs?.text || attrs?.['aria-label'] || 'Annotation options');
    if (["button", "summary"].includes(tag) && attrs?.["aria-label"] && window.EditorTools)
      window.EditorTools.ToolInfo.apply(e, { label: attrs["aria-label"], info: attrs.title || attrs["aria-label"] }, true);
    return e;
  }
  function svg(tag, attrs) {
    const e = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
    return e;
  }
  function hexToRgb(hex) {
    const n = parseInt(hex.replace("#", ""), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  function strokePath(points) {
    if (!points.length) return "";
    if (points.length === 1) {
      const [x, y] = points[0];
      return `M${x} ${y} L${x + 0.01} ${y + 0.01}`;
    }
    // quadratic smoothing through midpoints
    let d = `M${points[0][0]} ${points[0][1]}`;
    for (let i = 1; i < points.length - 1; i++) {
      const [x, y] = points[i];
      const [nx, ny] = points[i + 1];
      d += ` Q${x} ${y} ${(x + nx) / 2} ${(y + ny) / 2}`;
    }
    const last = points[points.length - 1];
    return d + ` L${last[0]} ${last[1]}`;
  }
  function distToSegment(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
  }
  // "Copied" feedback: the button pulses green with a check, and a small "Copied" bubble rises from it.
  function copiedFeedback(btn, label = "Copied") {
    if (!btn?.isConnected) return;
    const r = btn.getBoundingClientRect();
    btn.classList.remove("pdfa-copied"); void btn.offsetWidth; btn.classList.add("pdfa-copied");
    clearTimeout(btn._copiedTimer);
    btn._copiedTimer = setTimeout(() => btn.classList.remove("pdfa-copied"), 1800);
    const tip = document.createElement("div");
    tip.className = "pdfa-copied-tip"; tip.setAttribute("role", "status");
    tip.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7"/></svg>';
    tip.append(label);
    document.body.append(tip);
    const w = tip.offsetWidth, below = r.top < 120;
    tip.style.left = Math.max(6, Math.min(innerWidth - w - 6, r.left + r.width / 2 - w / 2)) + "px";
    tip.style.top = (below ? r.bottom + 8 : r.top - tip.offsetHeight - 8) + "px";
    tip.classList.add(below ? "below" : "above");
    tip.addEventListener("animationend", () => tip.remove());
  }
  window.copiedFeedback = copiedFeedback;

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;opacity:0;left:-9999px";
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      if (!ok) throw new Error("clipboard unavailable");
    }
  }
  function isTyping() {
    const a = document.activeElement;
    return a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT" || a.isContentEditable);
  }

  class PdfAnnotator {
    constructor(opts) {
      this.o = opts; // {pdfUrl, annUrl, exportUrl, openExportUrl, colors, headers, onSaved, onExport, barExtra: owner's elements shown after the page box}
      this.cfg = opts.colors;
      this.tool = "select";
      this.hlColor = this.cfg.highlight_colors[0].id;
      this.penColor = this.cfg.pen_colors[0].hex;
      this.penWidth = this.cfg.pen_widths[1];
      this.scale = null; // null = fit width
      this.ann = { version: 1, highlights: [], strokes: [] };
      this.undoStack = [];
      this.redoStack = [];
      this.pages = []; // {num, base (viewport@1), div, canvas, hl, tl, ink, rendered, renderTask}
      this.saveTimer = null;
      this.showList = false;
      this.root = el("div", "pdfa tool-select");
      // ::selection can't read custom properties reliably, so the live
      // selection color is written into a small per-instance stylesheet
      this.selStyle = el("style");
      this.root.append(this.selStyle);
      this.buildUi();
      this.onKey = this.onKey.bind(this);
      document.addEventListener("keydown", this.onKey);
      // Dismiss pane-local tool options when work resumes elsewhere in the editor.
      this.onToolbarOutside = event => {
        const settings = this.bar.querySelector('.pdfa-settings');
        if (settings?.open && !settings.contains(event.target)) settings.open = false;
      };
      document.addEventListener('pointerdown', this.onToolbarOutside);
    }

    // ------------------------------------------------------------ UI shell
    buildUi() {
      this.bar = el("div", "pdfa-bar");
      this.body = el("div", "pdfa-body");
      this.scroller = el("div", "pdfa-scroll");
      this.list = el("div", "pdfa-list");
      this.body.append(this.scroller, this.list);
      this.pop = el("div", "pdfa-pop");
      this.pop.hidden = true;
      this.selMenu = el("div", "pdfa-selmenu");
      this.selMenu.hidden = true;
      this.status = el("span", "pdfa-status", { text: "Loading PDF…" });
      // Current page / page count. Built once so renderBar keeps the input and its focus.
      this.pageInput = el("input", "pdfa-pageinput", { type: "text", inputmode: "numeric", value: "–", "aria-label": "Current page", title: "Current page: type a number and press Enter to go there" });
      this.pageTotal = el("span", "pdfa-pagetotal", { text: "/ –" });
      this.pageBox = el("span", "pdfa-pagebox", { role: "group", "aria-label": "Page" });
      this.pageBox.append(this.pageInput, this.pageTotal);
      this.pageInput.addEventListener("focus", () => this.pageInput.select());
      this.pageInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); this.goToPage(parseInt(this.pageInput.value, 10)); this.pageInput.blur(); }
        else if (e.key === "Escape") { e.preventDefault(); this.pageInput.blur(); }
      });
      this.pageInput.addEventListener("blur", () => this.updateCurrentPage(true));
      this.root.append(this.bar, this.body, this.pop, this.selMenu);
      this.renderBar();

      this.scroller.addEventListener("pointerup", (e) => this.onTextPointerUp(e));
      this.scroller.addEventListener("click", (e) => this.onClickHighlight(e));
      // Draft view: a double click reports the page point (scale-1 units, top-left origin).
      this.scroller.addEventListener("dblclick", (e) => {
        const hit = this.o.onPagePoint && this.pageAt(e.clientX, e.clientY);
        if (hit) this.o.onPagePoint(hit.p.num, (e.clientX - hit.r.left) / this.lastScale, (e.clientY - hit.r.top) / this.lastScale, e);
      });
      this.scroller.addEventListener("scroll", () => {
        this.hideSelMenu(); this.alignBarsToPage();
        if (!this.pageRaf) this.pageRaf = requestAnimationFrame(() => { this.pageRaf = 0; this.updateCurrentPage(); });
      }, { passive: true });
      this.resizeObs = new ResizeObserver(() => { if (this.scale === null && this.doc) this.relayout(); this.alignBarsToPage(); });
      this.resizeObs.observe(this.scroller);
    }

    // The current page is the one under the middle of the visible area (the last page once scrolled to the end).
    currentPageNum() {
      if (!this.pages.length || !this.pages[0].div) return 0;
      const sc = this.scroller;
      if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2) return this.pages.length;
      const mid = sc.scrollTop + sc.clientHeight / 2;
      let num = 1;
      for (const p of this.pages) { if (p.div.offsetTop <= mid) num = p.num; else break; }
      return num;
    }
    updateCurrentPage(force) {
      const total = this.pages.length;
      this.pageTotal.textContent = total ? `/ ${total}` : "/ –";
      this.pageInput.size = Math.max(1, String(total || 1).length);
      if (!force && document.activeElement === this.pageInput) return; // do not overwrite what is being typed
      const cur = this.currentPageNum();
      this.pageInput.value = cur ? String(cur) : "–";
      this.pageBox.title = total ? `Page ${cur} of ${total}` : "";
    }
    goToPage(n) {
      if (!this.pages.length || !Number.isFinite(n)) { this.updateCurrentPage(true); return; }
      const p = this.pages[Math.min(this.pages.length, Math.max(1, n)) - 1];
      this.scroller.scrollTo({ top: Math.max(0, p.div.offsetTop - 16) });
      this.updateCurrentPage(true);
    }

    updatePageTooltip() {
      const pages=this.doc?.numPages;
      if (!pages) return;
      const fit=(this.navigation || this.bar).querySelector('.pdfa-zoom, [aria-label="Fit to width"]');
      if (fit) fit.setAttribute('title', `Fit to width (0) · ${pages} ${pages === 1 ? 'page' : 'pages'}`);
    }

    /** Apply shared icons to toolbar commands while retaining accessible names.
     * @param {void} none No arguments.
     * @pre Toolbar, navigation and shared icon catalog are initialized.
     * @post Commands share one SVG style; selection colors, undo state and tooltips are refreshed.
     * @return {void} Nothing.
     * @throws {Error} Icon or DOM failures propagate to the owning render/event boundary.
     */
    compactBar() {
      const names = {
        'Select':'select', 'Highlight':'highlight', 'Remove text':'strike', 'Replace text':'replace',
        'Pen':'pen', 'Eraser':'eraser', 'Undo':'undo', 'Redo':'redo', '−':'minus', '+':'plus',
        'Fit':'fit', 'Notes':'notes', 'Copy all':'copy', 'Save PDF':'save',
      };
      for (const button of new Set([...this.bar.querySelectorAll('.pdfa-btn'), ...(this.navigation?.querySelectorAll('.pdfa-btn') || [])])) {
        const label=button.textContent;
        const key=label.startsWith('Notes (')?'Notes':label;
        if (key === 'Undo') button.disabled = this.o.delegate ? !this.o.delegate.canUndo() : !this.undoStack.length;
        if (key === 'Redo') button.disabled = this.o.delegate ? !this.o.delegate.canRedo() : !this.redoStack?.length;
        if (!names[key]) continue;
        const title=button.getAttribute('title');
        button.setAttribute('aria-label',label==='−'?'Zoom out':label==='+'?'Zoom in':label==='Fit'?'Fit to width':label);
        button.setAttribute('title',title?`${label}: ${title}`:label);
        button.classList.add('pdfa-icon');
        const icon = window.EditorTools.icons.create(names[key]);
        if (key === 'Highlight') {
          if (this.tool === 'highlight') {
            button.style.backgroundColor = `${this.color(this.hlColor).hex}33`;
            button.style.borderColor = this.color(this.hlColor).hex;
            button.style.boxShadow = `inset 0 -2px ${this.color(this.hlColor).hex}`;
          }
          button.setAttribute('title', `${button.getAttribute('title')} · ${this.color(this.hlColor).label}`);
        }
        if (key === 'Pen') {
          if (this.tool === 'pen') {
            button.style.backgroundColor = `${this.penColor}33`;
            button.style.borderColor = this.penColor;
            button.style.boxShadow = `inset 0 -2px ${this.penColor}`;
          }
          const pen = this.cfg.pen_colors.find(c => c.hex === this.penColor);
          button.setAttribute('title', `${button.getAttribute('title')} · ${pen?.label || this.penColor}`);
        }
        button.replaceChildren(icon);
      }
      this.updatePageTooltip();
    }

    /** Build page navigation. Pre: page input exists; post: stable input reused with fresh zoom controls. */
    renderNavigation() {
      this.navigation = el("div", "pdfa-navigation", { role: "group", "aria-label": "PDF page and zoom" });
      this.navigation.append(this.pageBox,
        el("button", "pdfa-btn", { text: "−", title: "Zoom out (-)", "aria-label": "Zoom out", tool: { id: 'annotator.zoom-out', label: 'Zoom out', showText: true, execute: () => this.zoom(1 / 1.15)  }}),
        el("button", "pdfa-btn pdfa-zoom", { text: this.scale === null ? "Fit" : Math.round(this.scale * 100) + "%", title: "Fit to width (0)", "aria-label": "Fit to width", tool: { id: 'annotator.fit', label: 'Fit to width', showText: true, execute: () => this.setScale(null)  }}),
        el("button", "pdfa-btn", { text: "+", title: "Zoom in (+)", "aria-label": "Zoom in", tool: { id: 'annotator.zoom-in', label: 'Zoom in', showText: true, execute: () => this.zoom(1.15)  }}));
      if (this.o.readOnly) this.navigation.append(...(this.o.barExtra || []));
      this.navigationToolbar = window.EditorTools.registry.mount('pdf.navigation', { owner: this, view: this.o.bareBar ? 'pdf' : 'review' }, 'PDF navigation');
      this.navigationToolbar.element.classList.add('pdfa-navigation-toolbar');
      return this.navigationToolbar.element;
    }

    /** Place owner-supplied slots. Pre: bar/navigation built; post: status belongs to its footer; navigation stays in the PDF pane. */
    placeToolbarStatus() {
      if (this.o.statusSlot) this.o.statusSlot.replaceChildren(this.status);
      else {
        if (!this.footer) { this.footer = el("footer", "pdfa-footer"); this.root.append(this.footer); }
        this.footer.replaceChildren(this.status);
      }
      // An initial local footer may precede the workspace supplying its status slot.
      if (this.o.statusSlot && this.footer) { this.footer.remove(); this.footer = null; }
    }

    /** Obtain a registered toolbar control without exposing owner storage.
     * @param {string} id Stable control identifier.
     * @pre Navigation has been rendered.
     * @post State is unchanged.
     * @return {HTMLElement} Existing navigation node.
     * @throws {Error} Unknown or uninitialized control.
     */
    getToolbarControl(id) {
      if (id !== 'navigation' || !this.navigation) throw new Error('Unknown or uninitialized PDF control: ' + id);
      return this.navigation;
    }
    /** Describe toolbar capabilities without exposing mutable internal objects.
     * @param {void} none No arguments.
     * @pre Annotator options and annotations are initialized.
     * @post State is unchanged.
     * @return {object} Frozen snapshot of tool, mode, notes and copy capability.
     * @throws {Error} None under normal operation.
     */
    getToolbarState() {
      return Object.freeze({ tool: this.tool, readOnly: !!this.o.readOnly, bareBar: !!this.o.bareBar,
        noteCount: this.ann.highlights.length, showNotes: this.showList, canCopyAll: !!this.o.onCopyAll });
    }
    /** Handle tool activation errors at the user interaction boundary.
     * @param {Function} command Synchronous or asynchronous public operation.
     * @pre Status control is initialized.
     * @post Failures are shown in the annotator status.
     * @return {Promise<*>} Operation result or undefined after failure.
     * @throws {Error} None if status reporting is available.
     */
    async runToolbarCommand(command) {
      try { return await command(); }
      catch (error) { this.setStatus(error.message, true); }
    }
    /** Toggle the public notes view.
     * @param {void} none No arguments.
     * @pre Annotator is mounted.
     * @post Notes visibility and toolbar state are refreshed.
     * @return {void} No return value.
     * @throws {Error} Rendering failure.
     */
    toggleNotes() { this.showList = !this.showList; this.renderBar(); this.renderList(); }
    /** Copy the comments belonging to this view.
     * @param {HTMLElement} button Triggering control for copy feedback.
     * @pre A copy callback is configured in preview mode.
     * @post The existing copy workflow runs.
     * @return {*} Result of the preview callback or review copy operation.
     * @throws {Error} Copy callback failure; event boundary reports it.
     */
    copyToolbarComments(button) { return this.o.bareBar ? this.o.onCopyAll(button) : this.copyAll(button); }

    renderBar() {
      const b = this.bar;
      b.replaceChildren();
      if (this.o.readOnly) {
        b.append(el("span", "pdfa-legend", { text: this.o.readOnlyLabel || "Archived version · Read only" }),
          this.renderNavigation(),
          window.EditorTools.registry.mount('pdf.actions', { owner: this, view: this.o.bareBar ? 'pdf' : 'review' }, 'PDF actions').element);
        this.placeToolbarStatus();
        this.compactBar();
        return;
      }
      const tools = el("div", "pdfa-tools", { role: "group", "aria-label": "Annotation tools" });
      const options = el("div", "pdfa-options", { role: "group", "aria-label": "Tool options" });
      const actions = el("div", "pdfa-utilities", { role: "group", "aria-label": "View and save" });
      const settings = el("details", "pdfa-settings");
      const settingsContent = el("div", "pdfa-settings-content"); settingsContent.append(options, actions);
      const more = el("summary", "pdfa-btn", { "aria-label": "PDF options and actions", title: "More PDF tools" });
      more.append(window.EditorTools.icons.create('more'));
      settings.append(more, settingsContent);
      // Embedded owners can supply a stable pane heading; standalone viewers keep their own.
      if (this.o.showTitle !== false) b.append(el("span", "pdfa-pane-title", { text: this.o.bareBar ? "PDF preview" : "PDF review" }));
      b.append(tools, settings);
      tools.append(window.EditorTools.registry.mount('pdf.marks', { owner: this, view: this.o.bareBar ? 'pdf' : 'review' }, 'PDF annotation tools').element);
      actions.append(...(this.o.barExtra || []));
      options.hidden = this.tool === 'select';
      options.append(el("span", "pdfa-option-label", { text: this.tool === "pen" ? "Pen style" : ["select", "highlight"].includes(this.tool) ? "Highlight color" : "Tip" }));
      if (this.tool === "pen") {
        for (const c of this.cfg.pen_colors) {
          options.append(el("button", "pdfa-swatch" + (this.penColor === c.hex ? " on" : ""), {
            "aria-pressed": String(this.penColor === c.hex), title: c.label + " pen", style: `--c:${c.hex}`, tool: { id: 'annotator.pen-color', label: 'Set ' + c.label + ' pen color', showText: true, execute: () => { this.penColor = c.hex; this.renderBar(); } },
          }));
        }
        options.append(el("span", "pdfa-sep"));
        this.cfg.pen_widths.forEach((w, i) => {
          const btn = el("button", "pdfa-width" + (this.penWidth === w ? " on" : ""), {
            "aria-pressed": String(this.penWidth === w), title: ["Fine", "Medium", "Thick"][i] || `${w}pt`, tool: { id: 'annotator.pen-width', label: 'Set pen width ' + w, showText: true, execute: () => { this.penWidth = w; this.renderBar(); } },
          });
          btn.append(el("i", "", { style: `height:${Math.max(1, w * 1.2)}px;background:${this.penColor}` }));
          options.append(btn);
        });
      } else if (this.tool === "highlight") {
        for (const c of this.cfg.highlight_colors) {
          options.append(el("button", "pdfa-swatch hl" + (this.hlColor === c.id ? " on" : ""), {
            "aria-pressed": String(this.hlColor === c.id), title: `${c.label} (highlight color)`, style: `--c:${c.hex}`, tool: { id: 'annotator.highlight-color', label: 'Set ' + c.label + ' highlight color', showText: true, execute: () => { this.hlColor = c.id; this.renderBar(); } },
          }));
        }
        const cur = this.cfg.highlight_colors.find((c) => c.id === this.hlColor);
        options.append(el("span", "pdfa-legend", { text: cur ? cur.label : "" }));
      }
      if (["strikethrough", "replace", "eraser"].includes(this.tool)) {
        options.append(el("span", "pdfa-tool-hint", { text: {strikethrough:"Select text to strike through.",replace:"Select text, then enter its replacement.",eraser:"Click or drag across a mark to remove it."}[this.tool] }));
      }
      options.append(window.EditorTools.registry.mount('pdf.options', { owner: this, view: this.o.bareBar ? 'pdf' : 'review' }, 'Additional tool options').element);
      actions.append(window.EditorTools.registry.mount('pdf.actions', { owner: this, view: this.o.bareBar ? 'pdf' : 'review' }, 'PDF actions').element);
      b.append(this.renderNavigation());
      this.placeToolbarStatus();
      this.compactBar();
      const sel = this.color(this.hlColor).hex;
      this.selStyle.textContent = `.pdfa.tool-highlight .textLayer ::selection { background: ${sel}80; color: transparent; }`;
      this.root.classList.remove("tool-select", "tool-highlight", "tool-strikethrough", "tool-replace", "tool-pen", "tool-eraser");
      this.root.classList.add("tool-" + this.tool);
    }

    setTool(t) {
      if (this.o.readOnly) return;
      this.tool = t;
      this.hideSelMenu();
      this.closePop();
      window.getSelection()?.removeAllRanges();
      this.renderBar();
      if (['pen', 'highlight'].includes(t)) this.bar.querySelector('.pdfa-settings').open = true;
    }
    setStatus(msg, err) {
      this.status.textContent = msg;
      this.status.classList.toggle("err", !!err);
      this.updatePageTooltip();
    }

    onKey(e) {
      if (!this.root.isConnected || this.exporting) return;
      if (e.key === 'Escape') {
        const settings = this.bar.querySelector('.pdfa-settings[open]');
        if (settings) { settings.open = false; settings.querySelector('summary').focus(); return; }
      }
      const hover = this.root.matches(":hover") || this.root.contains(document.activeElement);
      if (!hover || isTyping()) return;
      const mod = e.metaKey || e.ctrlKey;
      if (!this.o.readOnly && mod && e.key.toLowerCase() === "z") { e.preventDefault(); window.EditorTools.registry.execute('pdf.actions', e.shiftKey ? 'pdf.redo' : 'pdf.undo', {owner:this}); return; }
      if (!this.o.readOnly && mod && e.key.toLowerCase() === "y") { e.preventDefault(); window.EditorTools.registry.execute('pdf.actions','pdf.redo',{owner:this}); return; }
      if (mod || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "v") window.EditorTools.registry.execute('pdf.marks','select',{owner:this});
      else if (k === "h") window.EditorTools.registry.execute('pdf.marks','highlight',{owner:this});
      else if (k === "r") window.EditorTools.registry.execute('pdf.marks','strikethrough',{owner:this});
      else if (k === "t") window.EditorTools.registry.execute('pdf.marks','replace',{owner:this});
      else if (k === "p") window.EditorTools.registry.execute('pdf.marks','pen',{owner:this});
      else if (k === "e") window.EditorTools.registry.execute('pdf.marks','eraser',{owner:this});
      else if (k === "+" || k === "=") window.EditorTools.Tool.activate(this.navigation.querySelector('[data-tool-id="annotator.zoom-in"]'));
      else if (k === "-") window.EditorTools.Tool.activate(this.navigation.querySelector('[data-tool-id="annotator.zoom-out"]'));
      else if (k === "0") window.EditorTools.Tool.activate(this.navigation.querySelector('[data-tool-id="annotator.fit"]'));
      else if (k === "escape") { this.closePop(); this.hideSelMenu(); }
      else return;
      e.preventDefault();
    }

    // ------------------------------------------------------------ loading
    async open() {
      try {
        const [pdfjs, pdfRes, annRes] = await Promise.all([
          loadPdfjs(), fetch(this.o.pdfUrl), fetch(this.o.annUrl),
        ]);
        if (!pdfRes.ok) throw new Error("PDF not found. Reopen the project folder or import the PDF again.");
        this.bytes = new Uint8Array(await pdfRes.arrayBuffer());
        if (!annRes.ok) throw new Error("Could not load saved annotations. Reopen the project folder.");
        if (annRes.ok) {
          const a = await annRes.json();
          this.savedAnn = JSON.parse(JSON.stringify(a));
          this.ann = { version: 1, highlights: (a.highlights || []).map(migrateComments), strokes: a.strokes || [] };
        }
        this.pdfjs = pdfjs;
        this.loadingTask = pdfjs.getDocument({
          data: this.bytes.slice(),
          cMapUrl: VENDOR + "/pdfjs/cmaps/", cMapPacked: true,
          standardFontDataUrl: VENDOR + "/pdfjs/standard_fonts/",
          wasmUrl: VENDOR + "/pdfjs/wasm/",
          iccUrl: VENDOR + "/pdfjs/iccs/",
          isEvalSupported: false,
        });
        this.doc = await this.loadingTask.promise;
        for (let i = 1; i <= this.doc.numPages; i++) {
          const page = await this.doc.getPage(i);
          this.pages.push({ num: i, page, base: page.getViewport({ scale: 1 }), rendered: 0 });
        }
        this.buildPages();
        this.setStatus(`${this.doc.numPages} pages`);
        this.renderBar();
        this.renderList();
      } catch (e) {
        this.scroller.replaceChildren(el("div", "pdfa-empty", { text: "Could not open the PDF: " + e.message }));
        this.setStatus("Error", true);
      }
    }

    async destroy() {
      document.removeEventListener("keydown", this.onKey);
      if (this.onToolbarOutside) document.removeEventListener("pointerdown", this.onToolbarOutside);
      this.resizeObs?.disconnect();
      this.io?.disconnect();
      if (this.pageRaf) cancelAnimationFrame(this.pageRaf);
      clearTimeout(this.saveTimer);
      // The owner flushes pending edits before destroying the viewer.
      for (const p of this.pages || []) p.renderTask?.cancel();
      // PDF.js owns document/worker cleanup on PDFDocumentLoadingTask.
      // Retaining it also permits cleanup when loading has failed.
      const task = this.loadingTask || this.doc?.loadingTask;
      await task?.destroy();
      this.loadingTask = null;
      this.doc = null;
      this.pages = [];
    }

    alignBarsToPage() {
      if (this.o.alignBars === false) return; // embedded viewers (workspace) leave the page header alone
      const host = this.root.closest('.editor');
      if (!host || !this.pages.length) return;
      // Anchor controls to the fit-to-width layout, independently of zoom/scroll.
      const bounds = host.getBoundingClientRect();
      const viewport = this.scroller.getBoundingClientRect();
      const available = this.scroller.clientWidth - 32;
      const widest = Math.max(...this.pages.map(p => p.base.width));
      const fitScale = Math.max(0.3, Math.min(4, available / widest));
      const fitWidth = this.pages[0].base.width * fitScale;
      const left = viewport.left + 16 + Math.max(0, (available - fitWidth) / 2);
      host.style.setProperty('--bar-left', Math.max(0, left - bounds.left) + 'px');
      host.style.setProperty('--bar-right', Math.max(0, bounds.right - left - fitWidth) + 'px');
    }

    currentScale() {
      if (this.scale !== null) return this.scale;
      const w = this.scroller.clientWidth - 32;
      const maxBase = Math.max(...this.pages.map((p) => p.base.width));
      return Math.max(0.3, Math.min(4, w / maxBase));
    }

    buildPages() {
      this.scroller.replaceChildren();
      this.io?.disconnect();
      this.io = new IntersectionObserver((entries) => {
        for (const en of entries) if (en.isIntersecting) this.renderPage(this.pages[+en.target.dataset.idx]);
      }, { root: this.scroller, rootMargin: "600px 0px" });
      this.pages.forEach((p, idx) => {
        p.div = el("div", "pdfa-page loading", { "data-idx": idx });
        p.canvas = el("canvas", "pdfa-canvas");
        p.hl = svg("svg", { class: "pdfa-hl", viewBox: `0 0 ${p.base.width} ${p.base.height}`, preserveAspectRatio: "none" });
        p.tl = el("div", "textLayer");
        p.ink = svg("svg", { class: "pdfa-ink", viewBox: `0 0 ${p.base.width} ${p.base.height}`, preserveAspectRatio: "none" });
        p.marks = el("div", "pdfa-marks");
        p.div.append(p.canvas, p.hl, p.tl, p.ink, p.marks, el("span", "pdfa-pnum", { text: p.num }));
        this.bindInk(p);
        this.scroller.append(p.div);
        this.io.observe(p.div);
      });
      this.relayout();
    }

    relayout() {
      const s = this.currentScale();
      if (this.lastScale && Math.abs(this.lastScale - s) < 0.001) { this.alignBarsToPage(); return; }
      // keep the reading position while zooming
      const ratio = this.scroller.scrollHeight ? this.scroller.scrollTop / this.scroller.scrollHeight : 0;
      this.lastScale = s;
      for (const p of this.pages) {
        p.div.style.width = p.base.width * s + "px";
        p.div.style.height = p.base.height * s + "px";
        p.div.style.setProperty("--scale-factor", s);
        p.div.style.setProperty("--total-scale-factor", s);
        p.rendered = 0;
        p.renderTask?.cancel();
        this.drawAnnotations(p);
      }
      this.scroller.scrollTop = ratio * this.scroller.scrollHeight;
      this.alignBarsToPage();
      this.updateCurrentPage();
      // re-render visible pages
      this.io.disconnect();
      this.pages.forEach((p) => this.io.observe(p.div));
      this.renderBar();
    }

    async renderPage(p) {
      const s = this.lastScale;
      if (!p || p.rendered === s) return;
      p.rendered = s;
      const vp = p.page.getViewport({ scale: s });
      const dpr = window.devicePixelRatio || 1;
      const canvas = el("canvas", "pdfa-canvas");
      canvas.width = Math.floor(vp.width * dpr);
      canvas.height = Math.floor(vp.height * dpr);
      try {
        p.renderTask?.cancel();
        p.renderTask = p.page.render({ canvas, canvasContext: canvas.getContext("2d"), viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null });
        await p.renderTask.promise;
        if (p.rendered !== s) return;
        p.canvas.replaceWith(canvas);
        p.canvas = canvas;
        p.div.classList.remove("loading");
        const tl = el("div", "textLayer");
        const layer = new this.pdfjs.TextLayer({ textContentSource: p.page.streamTextContent(), container: tl, viewport: vp });
        await layer.render();
        if (p.rendered !== s) return;
        p.tl.replaceWith(tl);
        p.tl = tl;
      } catch (e) {
        if (e && e.name !== "RenderingCancelledException") { p.rendered = 0; console.warn("render failed", e); }
      }
    }

    setScale(s) {
      this.scale = s === null ? null : Math.max(0.3, Math.min(4, s));
      this.lastScale = null;
      this.relayout();
    }
    zoom(f) { this.setScale(this.currentScale() * f); }

    // ------------------------------------------------------------ drawing annotations
    color(id) { return (this.cfg.highlight_colors.find((c) => c.id === id) || this.cfg.highlight_colors[0]); }

    markColor(h) {
      return h.type === "strikethrough"
        ? { id: h.intent === "replace" ? "replace" : "strikethrough", label: h.intent === "replace" ? "Replace text" : "Remove text", hex: "#e03131" }
        : this.color(h.color);
    }

    // Shared geometry keeps on-screen and exported lines aligned, including
    // when PDF page rotation or crop-box offsets change the coordinate system.
    strikeLine(rect) {
      return { x1: rect.x, y1: rect.y + rect.h / 2,
        x2: rect.x + rect.w, y2: rect.y + rect.h / 2,
        width: Math.max(0.8, Math.min(2, rect.h * 0.06)) };
    }

    drawAnnotations(p) {
      p.hl.replaceChildren();
      for (const h of this.ann.highlights) {
        for (const r of h.rects) {
          if (r.p !== p.num) continue;
          if (h.type === "strikethrough") {
            const line = this.strikeLine(r);
            p.hl.append(svg("line", {
              x1: line.x1, y1: line.y1, x2: line.x2, y2: line.y2,
              stroke: this.markColor(h).hex, "stroke-width": line.width,
              class: "pdfa-strike" + (this.activeId === h.id ? " active" : ""), "data-id": h.id,
            }));
            continue;
          }
          p.hl.append(svg("rect", {
            x: r.x, y: r.y, width: r.w, height: r.h, rx: 1.2, fill: this.markColor(h).hex, "fill-opacity": HL_OPACITY,
            class: "pdfa-hlrect" + (this.activeId === h.id ? " active" : ""), "data-id": h.id,
          }));
        }
      }
      p.marks.replaceChildren();
      for (const h of this.ann.highlights) {
        if (!h.comments.length) continue;
        const onPage = h.rects.filter((r) => r.p === p.num);
        if (!onPage.length || onPage[0] !== h.rects[0]) continue; // one marker, on the first page of the highlight
        const last = onPage[onPage.length - 1];
        const mk = el("button", "pdfa-mark", {
          title: h.comments.map((x) => x.text).join("\n—\n"),
          style: `left:${((last.x + last.w) / p.base.width) * 100}%;top:${(onPage[0].y / p.base.height) * 100}%;--c:${this.markColor(h).hex}`,
          text: h.comments.length > 1 ? String(h.comments.length) : "",
          tool: { id: 'annotator.open-mark', label: 'Open annotation', showText: true, execute: ({ event: ev }) => { ev.stopPropagation(); this.openPop(h, ev); } },
        });
        p.marks.append(mk);
      }
      p.ink.replaceChildren();
      for (const st of this.ann.strokes) {
        if (st.page !== p.num) continue;
        p.ink.append(svg("path", { d: strokePath(st.points), stroke: st.color, "stroke-width": st.width, class: "pdfa-stroke", "data-id": st.id }));
      }
    }
    // Marks supplied by the owner (read-only views), e.g. draft changes.
    setMarks(list, strokes) {
      this.ann.highlights = list;
      if (strokes) this.ann.strokes = strokes;
      this.redraw();
    }
    scrollToRect(page, y) {
      const p = this.pages[page - 1];
      if (!p) return;
      const top = p.div.offsetTop + y * this.lastScale - this.scroller.clientHeight / 3;
      this.scroller.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    }
    flash(id) {
      this.activeId = id;
      this.redraw();
    }
    redraw(pageNums) {
      for (const p of this.pages) if (!pageNums || pageNums.includes(p.num)) this.drawAnnotations(p);
      this.renderList();
      this.renderBar();
    }

    // ------------------------------------------------------------ highlights
    pageAt(clientX, clientY) {
      for (const p of this.pages) {
        const r = p.div.getBoundingClientRect();
        if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) return { p, r };
      }
      return null;
    }

    selectionRects() {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
      const range = sel.getRangeAt(0);
      if (!this.scroller.contains(range.commonAncestorContainer)) return null;
      const s = this.lastScale;
      const out = [];
      for (const cr of range.getClientRects()) {
        if (cr.width < 1 || cr.height < 1) continue;
        const hit = this.pageAt(cr.left + cr.width / 2, cr.top + cr.height / 2);
        if (!hit) continue;
        // skip giant rects from endOfContent / whole-span selections
        if (cr.height > 80 * s) continue;
        out.push({ p: hit.p.num, x: (cr.left - hit.r.left) / s, y: (cr.top - hit.r.top) / s, w: cr.width / s, h: cr.height / s });
      }
      return out.length ? { rects: mergeRects(out), text: sel.toString() } : null;
    }

    onTextPointerUp(e) {
      if (this.o.readOnly) return;
      if (!["select", "highlight", "strikethrough", "replace"].includes(this.tool)) return;
      setTimeout(() => {
        const got = this.selectionRects();
        if (!got) { this.hideSelMenu(); return; }
        if (this.tool === "replace") this.replaceText(got, e);
        else if (this.tool === "strikethrough") this.addHighlight(got, this.hlColor, "strikethrough");
        else if (this.tool === "highlight") this.addHighlight(got, this.hlColor);
        else this.showSelMenu(got, e);
      }, 0);
    }

    showSelMenu(got, e) {
      const m = this.selMenu;
      m.replaceChildren(el("span", "pdfa-selhint", { text: "Highlight as" }));
      for (const c of this.cfg.highlight_colors) {
        m.append(el("button", "pdfa-swatch hl", {
          title: c.label, style: `--c:${c.hex}`,
          onpointerdown: (ev) => ev.preventDefault(),
          tool: { id: 'annotator.selection-highlight', label: 'Highlight selected text', showText: true, execute: () => { this.addHighlight(got, c.id); this.hideSelMenu(); } },
        }));
      }
      m.append(
        el("button", "pdfa-btn pdfa-remove-text", { text: "Remove text", title: "Mark selected text with strikethrough",
          onpointerdown: (ev) => ev.preventDefault(),
          tool: { id: 'annotator.selection-strike', label: 'Remove selected text', showText: true, execute: () => { this.addHighlight(got, this.hlColor, "strikethrough"); this.hideSelMenu(); }  }}),
        el("button", "pdfa-btn", { text: "Replace text", title: "Strike through selected text and enter a replacement comment",
          onpointerdown: (ev) => ev.preventDefault(),
          tool: { id: 'annotator.selection-replace', label: 'Replace selected text', showText: true, execute: () => this.replaceText(got, e)  }}),
        el("button", "pdfa-btn", { text: "💬 Comment", title: "Highlight in the current color and add a comment",
          onpointerdown: (ev) => ev.preventDefault(),
          tool: { id: 'annotator.selection-comment', label: 'Comment on selected text', showText: true, execute: () => { const h = this.addHighlight(got, this.hlColor); this.hideSelMenu(); this.openPop(h, e); }  }}),
        el("button", "pdfa-btn", { text: "Copy", onpointerdown: (ev) => ev.preventDefault(), tool: { id: 'annotator.copy-selection', label: 'Copy selected text', showText: true, execute: ({ event: ev }) => { const b = ev.currentTarget; copyText(got.text.replace(/\s+/g, " ").trim()).then(() => { copiedFeedback(b); this.setStatus("Copied"); setTimeout(() => this.hideSelMenu(), 500); }); }  }}));
      m.hidden = false;
      this.place(m, e, m.offsetWidth);
    }
    // position a floating box near the pointer, below it if it fits, else above
    place(box, e, width) {
      const rr = this.root.getBoundingClientRect();
      const hgt = box.offsetHeight;
      const y = e.clientY - rr.top;
      const below = y + 14, above = y - hgt - 14;
      const top = below + hgt <= rr.height - 6 ? below : Math.max(this.bar.offsetHeight + 4, above);
      box.style.top = Math.min(top, Math.max(this.bar.offsetHeight + 4, rr.height - hgt - 6)) + "px";
      box.style.left = Math.max(4, Math.min(e.clientX - rr.left - width / 2, rr.width - width - 6)) + "px";
    }
    hideSelMenu() { this.selMenu.hidden = true; }

    replaceText(got, e) {
      const h = this.addHighlight(got, this.hlColor, "strikethrough", "replace");
      this.hideSelMenu();
      this.openPop(h, e);
      return h;
    }

    addHighlight(got, color, type = "highlight", intent = null) {
      const h = { id: uid(), type, ...(intent ? { intent } : {}), page: got.rects[0].p, rects: got.rects, color, text: got.text.replace(/\s+/g, " ").trim(), comments: [], created_at: new Date().toISOString() };
      this.ann.highlights.push(h);
      if (this.o.delegate) {
        // The owner stores the mark (as a linked comment) and redraws; no local save or undo entry.
        window.getSelection()?.removeAllRanges();
        this.redraw([...new Set(h.rects.map((r) => r.p))]);
        this.o.delegate.mark(h);
        return h;
      }
      this.redoStack = [];
      this.undoStack.push({ op: "add", kind: "highlights", item: h });
      window.getSelection()?.removeAllRanges();
      this.redraw([...new Set(h.rects.map((r) => r.p))]);
      this.changed();
      return h;
    }

    highlightAt(clientX, clientY) {
      const hit = this.pageAt(clientX, clientY);
      if (!hit) return null;
      const s = this.lastScale;
      const x = (clientX - hit.r.left) / s, y = (clientY - hit.r.top) / s;
      for (let i = this.ann.highlights.length - 1; i >= 0; i--) {
        const h = this.ann.highlights[i];
        if (h.rects.some((r) => r.p === hit.p.num && x >= r.x - 1 && x <= r.x + r.w + 1 && y >= r.y - 1 && y <= r.y + r.h + 1)) return h;
      }
      return null;
    }

    onClickHighlight(e) {
      if (!["select", "highlight", "strikethrough", "replace"].includes(this.tool)) return;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return;
      const h = this.highlightAt(e.clientX, e.clientY);
      if (h) this.openPop(h, e); else this.closePop();
    }

    openPop(h, e, opts = {}) {
      if (this.o.onMarkClick) { this.o.onMarkClick(h, e); return; }
      if (this.o.readOnly) {
        this.pop.replaceChildren(el("div", "pdfa-pophead", { text: `p. ${h.page} · ${this.markColor(h).label} · Archived` }),
          el("blockquote", "", { text: h.text }));
        for (const cm of h.comments) this.pop.append(this.commentView(cm));
        this.pop.append(el("button", "pdfa-btn", { text: "Copy with comments", tool: { id: 'annotator.copy-mark', label: 'Copy with comments', showText: true, execute: ({ event: ev }) => this.copyHighlights([h], ev.currentTarget)  }}),
          el("button", "pdfa-btn", { text: "Close", tool: { id: 'annotator.close-readonly-mark', label: 'Close annotation', showText: true, execute: () => this.closePop()  }}));
        this.pop.hidden = false;
        this.place(this.pop, e, 320);
        return;
      }
      const reopen = this.activeId === h.id && !this.pop.hidden;
      this.activeId = h.id;
      this.popAnchor = e;
      this.redraw([...new Set(h.rects.map((r) => r.p))]);
      const c = this.markColor(h);
      const pop = this.pop;
      const swatches = el("div", "pdfa-row");
      for (const cc of h.type === "strikethrough" ? [] : this.cfg.highlight_colors) {
        swatches.append(el("button", "pdfa-swatch hl" + (cc.id === h.color ? " on" : ""), {
          title: cc.label, style: `--c:${cc.hex}`,
          tool: { id: 'annotator.recolor-mark', label: 'Use ' + cc.label + ' highlight', showText: true, execute: () => { h.color = cc.id; this.changed(); this.redraw(); this.openPop(h, e); } },
        }));
      }
      const thread = this.renderThread(h, e);
      pop.replaceChildren(
        el("div", "pdfa-pophead", { text: `p. ${h.page} · ${c.label}` }),
        el("blockquote", "", { text: h.text.length > 280 ? h.text.slice(0, 280) + "…" : h.text }),
        swatches, thread.box,
        el("div", "pdfa-row pdfa-actions",
          {}),
      );
      const actions = pop.lastChild;
      actions.append(
        el("button", "pdfa-btn", { text: "Copy with comments", tool: { id: 'annotator.copy-mark-thread', label: 'Copy with comments', showText: true, execute: ({ event: ev }) => this.copyHighlights([h], ev.currentTarget)  }}),
        el("button", "pdfa-btn danger", { text: "Delete", tool: { id: 'annotator.delete-mark', label: 'Delete annotation', showText: true, execute: () => { this.removeItem("highlights", h); this.closePop(); }  }}),
        el("button", "pdfa-btn", { text: "Close", tool: { id: 'annotator.close-mark', label: 'Close annotation', showText: true, execute: () => this.closePop()  }}));
      const top = pop.style.top;
      pop.hidden = false;
      if (reopen && top) pop.style.top = top; else this.place(pop, e, 320);
      if (opts.focus !== false) setTimeout(() => thread.input.focus(), 0);
    }

    copyCommentButton(cm) {
      return el("button", "pdfa-link", { type: "button", text: "Copy", title: "Copy this comment only", "aria-label": "Copy comment",
        tool: { id: 'annotator.copy-comment', label: 'Copy comment', showText: true, execute: async ({ event: ev }) => {
          ev.stopPropagation();
          const btn = ev.currentTarget;
          try { await copyText(cm.text); copiedFeedback(btn); this.setStatus("Copied comment"); }
          catch { this.setStatus("Could not copy comment. Select its text and copy manually."); }
        }  }});
    }

    commentView(cm) {
      const item = el("div", "pdfa-comment");
      const meta = el("div", "pdfa-cmeta");
      meta.append(this.copyCommentButton(cm));
      item.append(el("div", "pdfa-ctext", { text: cm.text }), meta);
      return item;
    }

    // comment thread inside the highlight popup
    renderThread(h, e) {
      const box = el("div", "pdfa-thread");
      box.append(el("div", "pdfa-threadhead", { text: h.comments.length ? `Comments (${h.comments.length})` : "Comments" }));
      for (const cm of h.comments) {
        const item = el("div", "pdfa-comment");
        const body = el("div", "pdfa-ctext", { text: cm.text });
        const when = new Date(cm.edited_at || cm.created_at || Date.now());
        const meta = el("div", "pdfa-cmeta", { text: when.toLocaleString([], { dateStyle: "short", timeStyle: "short" }) + (cm.edited_at ? " · edited" : "") + " · " });
        meta.append(this.copyCommentButton(cm), " · ",
          el("button", "pdfa-link", { text: "Edit", tool: { id: 'annotator.edit-comment', label: 'Edit comment', showText: true, execute: () => {
            const ta = el("textarea", "", { rows: "3" });
            ta.value = cm.text;
            const save = new window.EditorTools.Tool({ id: 'annotator.save-comment-edit', label: 'Save comment', showText: true, execute: () => {
              const t = ta.value.trim();
              if (!t) return;
              cm.text = t; cm.edited_at = new Date().toISOString();
              this.changed(); this.openPop(h, e, { focus: false });
            } });
            ta.addEventListener("keydown", (ev) => {
              ev.stopPropagation(); // keep typing shortcuts inside the comment editor
              if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter") { ev.preventDefault(); save.invoke(); }
              if (ev.key === "Escape") this.openPop(h, e, { focus: false });
            });
            item.replaceChildren(ta, el("div", "pdfa-row", {}));
            item.lastChild.append(el("button", "pdfa-btn on", { text: "Save", tool: save}), el("button", "pdfa-btn", { text: "Cancel", tool: { id: 'annotator.cancel-comment-edit', label: 'Cancel comment edit', showText: true, execute: () => this.openPop(h, e, { focus: false })  }}));
            ta.focus();
          }  }}),
          " · ",
          el("button", "pdfa-link danger", { text: "Delete", tool: { id: 'annotator.delete-comment', label: 'Delete comment', showText: true, execute: () => {
            h.comments = h.comments.filter((x) => x !== cm);
            this.changed(); this.redraw(); this.openPop(h, e, { focus: false });
          }  }}));
        item.append(body, meta);
        box.append(item);
      }
      const needsReplacement = h.intent === "replace" && !h.comments.length;
      if (needsReplacement) box.append(el("div", "pdfa-replacement-hint", { text: "Enter the replacement wording. It will be saved as a comment on the crossed-out text." }));
      const input = el("textarea", "", { rows: "2",
        "aria-label": needsReplacement ? "Replacement text" : "Comment",
        placeholder: needsReplacement ? "Enter replacement text… (⌘/Ctrl+Enter to save)" : "Add a comment… (⌘/Ctrl+Enter to post)" });
      const post = new window.EditorTools.Tool({ id: 'annotator.post-comment', label: 'Post comment', showText: true, execute: () => {
        const t = input.value.trim();
        if (!t) return;
        h.comments.push({ id: uid(), text: needsReplacement ? "Replacement: " + t : t, created_at: new Date().toISOString() });
        this.changed(); this.redraw(); this.openPop(h, e);
      } });
      input.addEventListener("keydown", (ev) => {
        ev.stopPropagation(); // keep typing shortcuts inside the comment editor
        if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter") { ev.preventDefault(); post.invoke(); }
        if (ev.key === "Escape") this.closePop();
      });
      const postBtn = el("button", "pdfa-btn on", { text: needsReplacement ? "Save replacement" : "Comment", tool: post});
      box.append(input, el("div", "pdfa-row pdfa-postrow", {}));
      box.lastChild.append(postBtn);
      return { box, input };
    }
    closePop() {
      if (this.pop.hidden) return;
      this.pop.hidden = true;
      const was = this.activeId;
      this.activeId = null;
      if (was) this.redraw();
    }

    // ------------------------------------------------------------ pen & eraser
    bindInk(p) {
      if (this.o.readOnly) return;
      const toPage = (e) => {
        const r = p.div.getBoundingClientRect();
        const s = this.lastScale;
        return [+((e.clientX - r.left) / s).toFixed(2), +((e.clientY - r.top) / s).toFixed(2)];
      };
      let cur = null, pathEl = null, erasing = false;
      p.ink.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        if (this.tool === "pen") {
          p.ink.setPointerCapture(e.pointerId);
          cur = { id: uid(), page: p.num, color: this.penColor, width: this.penWidth, points: [toPage(e)], created_at: new Date().toISOString() };
          pathEl = svg("path", { stroke: cur.color, "stroke-width": cur.width, class: "pdfa-stroke", d: strokePath(cur.points) });
          p.ink.append(pathEl);
          e.preventDefault();
        } else if (this.tool === "eraser") {
          p.ink.setPointerCapture(e.pointerId);
          erasing = true;
          this.eraseAt(p, toPage(e));
          e.preventDefault();
        }
      });
      p.ink.addEventListener("pointermove", (e) => {
        if (cur) {
          const pt = toPage(e);
          const last = cur.points[cur.points.length - 1];
          if (Math.hypot(pt[0] - last[0], pt[1] - last[1]) < 0.8 / Math.max(1, this.lastScale / 2)) return;
          cur.points.push(pt);
          pathEl.setAttribute("d", strokePath(cur.points));
        } else if (erasing) {
          this.eraseAt(p, toPage(e));
        }
      });
      const end = () => {
        if (cur && this.o.delegate) {
          this.ann.strokes.push(cur);
          this.o.delegate.stroke(cur);
          cur = null; pathEl = null;
          this.redraw([p.num]);
        } else if (cur) {
          this.ann.strokes.push(cur);
          this.redoStack = [];
      this.undoStack.push({ op: "add", kind: "strokes", item: cur });
          cur = null; pathEl = null;
          this.changed();
          this.redraw([p.num]);
        }
        erasing = false;
      };
      p.ink.addEventListener("pointerup", end);
      p.ink.addEventListener("pointercancel", end);
    }

    eraseAt(p, pt) {
      const tol = 5 / Math.max(0.5, this.lastScale);
      const st = this.ann.strokes.find((s) => s.page === p.num && (s.points.length === 1
        ? Math.hypot(pt[0] - s.points[0][0], pt[1] - s.points[0][1]) <= tol + s.width / 2
        : s.points.some((q, i) => i > 0 && distToSegment(pt, s.points[i - 1], q) <= tol + s.width / 2)));
      if (st) return this.removeItem("strokes", st);
      const h = this.ann.highlights.find((h) => h.rects.some((r) => r.p === p.num && pt[0] >= r.x && pt[0] <= r.x + r.w && pt[1] >= r.y && pt[1] <= r.y + r.h));
      if (h) this.removeItem("highlights", h);
    }

    removeItem(kind, item) {
      const arr = this.ann[kind];
      const i = arr.indexOf(item);
      if (i < 0) return;
      if (this.o.delegate) {
        if (this.o.delegate.remove(kind, item) === false) return; // e.g. tracked changes cannot be erased
        arr.splice(i, 1);
        this.redraw(kind === "strokes" ? [item.page] : [...new Set(item.rects.map((r) => r.p))]);
        return;
      }
      arr.splice(i, 1);
      this.redoStack = [];
      this.undoStack.push({ op: "remove", kind, item, index: i });
      this.changed();
      this.redraw(kind === "strokes" ? [item.page] : [...new Set(item.rects.map((r) => r.p))]);
    }

    undo() {
      if (this.o.delegate) { this.o.delegate.undo(); return; }
      if (this.o.readOnly || this.exporting) return;
      const u = this.undoStack.pop();
      if (!u) { this.setStatus("Nothing to undo"); return; }
      (this.redoStack ||= []).push(u);
      const arr = this.ann[u.kind];
      if (u.op === "add") { const i = arr.indexOf(u.item); if (i >= 0) arr.splice(i, 1); }
      else arr.splice(Math.min(u.index, arr.length), 0, u.item);
      this.changed();
      this.redraw();
    }

    redo() {
      if (this.o.delegate) { this.o.delegate.redo(); return; }
      if (this.o.readOnly || this.exporting) return;
      const u = this.redoStack?.pop();
      if (!u) return;
      const arr = this.ann[u.kind];
      if (u.op === "add") arr.push(u.item);
      else { const i = arr.indexOf(u.item); if (i >= 0) arr.splice(i, 1); }
      this.undoStack.push(u);
      this.changed();
      this.redraw();
    }

    // ------------------------------------------------------------ copying
    // page, then column (two-column papers), then top to bottom
    readingOrder(list) {
      const key = (h) => {
        const r = h.rects[0];
        const w = (this.pages[r.p - 1] || { base: { width: 612 } }).base.width;
        return [r.p, r.x + r.w / 2 > w / 2 ? 1 : 0, r.y];
      };
      return [...list].sort((a, b) => {
        const ka = key(a), kb = key(b);
        return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2];
      });
    }

    formatHighlights(list) {
      return list.map((h) => {
        const lines = [`p. ${h.page} · ${this.markColor(h).label}`, `“${h.text}”`];
        for (const c of h.comments) lines.push(`  – ${c.text.trim().replace(/\n+/g, "\n    ")}`);
        return lines.join("\n");
      }).join("\n\n");
    }

    // Copy all: with a review request around it when the app gives one (copyIntro), else plain.
    async copyAll(btn) {
      const list = this.readingOrder(this.ann.highlights);
      if (!list.length || !this.o.copyIntro) return this.copyHighlights(list, btn);
      const items = list.map((h, i) => {
        const lines = [`### ${i + 1}. Page ${h.page} · ${h.type === "strikethrough" ? this.markColor(h).label : `Highlight (${this.markColor(h).label.toLowerCase()})`}`, "Passage:", ...h.text.split(/\n/).map((l) => "> " + l)];
        lines.push("Comments:", ...(h.comments.length ? h.comments.map((c) => `- ${c.text.trim().replace(/\n+/g, "\n  ")}`) : ["- (no words: only the mark)"]));
        return lines.join("\n");
      });
      try {
        await copyText(this.o.copyIntro(list) + "\n\n## Items\n\n" + items.join("\n\n") + "\n");
        copiedFeedback(btn);
        this.setStatus(`Copied ${list.length} mark${list.length === 1 ? "" : "s"} in reading order, with instructions`);
      } catch (e) {
        this.setStatus("Copy failed: " + e.message, true);
      }
    }

    async copyHighlights(list, btn) {
      if (!list.length) { this.setStatus("Nothing to copy"); return; }
      try {
        await copyText(this.formatHighlights(list));
        copiedFeedback(btn);
        const n = list.reduce((s, h) => s + h.comments.length, 0);
        this.setStatus(`Copied ${list.length} text mark${list.length === 1 ? "" : "s"} · ${n} comment${n === 1 ? "" : "s"}`);
      } catch (e) {
        this.setStatus("Copy failed: " + e.message, true);
      }
    }

    // ------------------------------------------------------------ list panel
    renderList() {
      this.root.classList.toggle("with-list", this.showList);
      if (!this.showList) return;
      const items = this.readingOrder(this.ann.highlights);
      this.list.replaceChildren(el("div", "pdfa-listhead", { text: `${items.length} text mark(s) · ${this.ann.strokes.length} pen mark(s)` }));
      if (items.length) {
        this.list.append(el("button", "pdfa-btn pdfa-copyall", { text: "Copy all with comments", tool: { id: 'annotator.copy-all', label: 'Copy all with comments', showText: true, execute: ({ event: ev }) => this.copyHighlights(items, ev.currentTarget)  }}));
      }
      for (const c of [...this.cfg.highlight_colors, this.markColor({ type: "strikethrough" }), this.markColor({ type: "strikethrough", intent: "replace" })]) {
        const of = items.filter((h) => this.markColor(h).id === c.id);
        if (!of.length) continue;
        const row = el("div", "pdfa-legendrow", { style: `--c:${c.hex}` });
        row.append(el("span", "", { text: `${c.label}: ${of.length}` }),
          el("button", "pdfa-link", { text: "Copy", title: `Copy the ${c.label} marks with their comments`, tool: { id: 'annotator.copy-color', label: 'Copy ' + c.label + ' marks', showText: true, execute: ({ event: ev }) => this.copyHighlights(of, ev.currentTarget)  }}));
        this.list.append(row);
      }
      for (const h of items) {
        const row = el("article", "pdfa-item" + (h.type === "strikethrough" ? " pdfa-strike-item" : ""), {
          style: `--c:${this.markColor(h).hex}`,
        });
        const open = el("button", "pdfa-item-open", {
          type: "button", title: "Open mark and comments",
          tool: { id: 'annotator.reveal-mark', label: 'Show annotation location', showText: true, execute: ({ event: e }) => {
            const r = h.rects[0];
            const p = this.pages[r.p - 1];
            this.scroller.scrollTop = p.div.offsetTop + r.y * this.lastScale - 80;
            setTimeout(() => {
              const pr = p.div.getBoundingClientRect();
              this.openPop(h, { clientX: pr.left + (r.x + r.w / 2) * this.lastScale, clientY: pr.top + (r.y + r.h) * this.lastScale });
            }, 50);
          } },
        });
        open.append(el("span", "pdfa-itemp", { text: "p. " + h.page }), el("span", "pdfa-itemt", { text: h.text.slice(0, 140) }));
        row.append(open);
        for (const cm of h.comments) row.append(this.commentView(cm));
        this.list.append(row);
      }
    }

    // ------------------------------------------------------------ persistence
    changed() {
      if (this.o.readOnly || this.o.delegate) return;
      this.revision = (this.revision || 0) + 1;
      this.dirty = true;
      this.setStatus("Saving editable annotations…");
      clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => this.saveNow(), 600);
    }
    async saveNow() {
      if (this.o.readOnly) return true;
      clearTimeout(this.saveTimer);
      if (this.savePromise) return this.savePromise;
      if (!this.dirty) return true;
      const revision = this.revision;
      const sent = JSON.parse(JSON.stringify(this.ann));
      const body = JSON.stringify({ ...sent, ...(this.savedAnn ? { base: this.savedAnn } : {}) });
      this.savePromise = (async () => {
        try {
          const r = await fetch(this.o.annUrl, { method: "PUT", headers: { "Content-Type": "application/json", ...this.o.headers }, body });
          if (!r.ok) throw new Error((await r.json()).error || r.statusText);
          const result = await r.json();
          if (result.annotations) this.adoptSavedAnnotations(sent, result.annotations);
          else this.savedAnn = sent;
          if (this.revision === revision) this.dirty = false;
          this.setStatus(this.dirty ? "Saving…" : "Annotations saved");
          this.o.onSaved?.();
          return true;
        } catch (e) {
          this.dirty = true;
          this.setStatus("Not saved: " + e.message, true);
          return false;
        } finally { this.savePromise = null; }
      })();
      const ok = await this.savePromise;
      if (ok && this.dirty) this.saveTimer = setTimeout(() => this.saveNow(), 100);
      return ok;
    }
    // Reconcile a server merge with edits made while saving. Requires sent/saved snapshots;
    // retains local object identity for undo and open comment threads, and never drops newer
    // local changes. No I/O; saveNow owns error handling and the dirty/revision state.
    adoptSavedAnnotations(sent, saved) {
      const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      for (const kind of ["highlights", "strokes"]) {
        const before = new Map(sent[kind].map(x => [x.id, x]));
        const current = new Map(this.ann[kind].map(x => [x.id, x]));
        const remote = new Map(saved[kind].map(x => [x.id, x]));
        const result = [];
        for (const id of new Set([...remote.keys(), ...current.keys()])) {
          const local = current.get(id), old = before.get(id), server = remote.get(id);
          if (!equal(local, old)) { if (local) result.push(local); }
          else if (server) result.push(local ? Object.assign(local, server) : server);
        }
        this.ann[kind] = result;
      }
      this.savedAnn = JSON.parse(JSON.stringify(saved));
      this.redraw(); this.renderBar(); this.renderList();
    }
    // Pull remote API marks into an idle PDF view. Requires savedAnn and a live viewer;
    // skips dirty or in-flight edits and checks again after I/O. Fetch errors propagate
    // to the polling owner; the existing snapshot and unsaved comments stay intact.
    async refreshAnnotations() {
      if (this.dirty || this.savePromise || this.exportPromise || !this.savedAnn) return;
      const revision = this.revision;
      const response = await fetch(this.o.annUrl);
      if (!response.ok) throw new Error('Could not refresh annotations.');
      const saved = await response.json();
      if (this.dirty || this.savePromise || this.revision !== revision || !this.doc) return;
      this.adoptSavedAnnotations(this.savedAnn, saved);
    }
    async flush() {
      if (this.exportPromise) await this.exportPromise;
      if (this.savePromise && !(await this.savePromise)) return false;
      while (this.dirty) if (!(await this.saveNow())) return false;
      return true;
    }

    // ------------------------------------------------------------ export
    async exportPdf() {
      if (this.o.readOnly) return;
      if (!this.doc || this.exporting) return;
      this.exporting = true;
      let finishExport;
      this.exportPromise = new Promise(resolve => { finishExport = resolve; });
      // Prevent edits while taking the export snapshot.
      this.body.inert = true;
      this.bar.inert = true;
      try {
        this.setStatus("Exporting…");
        if (this.savePromise && !(await this.savePromise)) throw new Error("Save annotations before exporting.");
        while (this.dirty) if (!(await this.saveNow())) throw new Error("Save annotations before exporting.");
        const PDFLib = await loadPdfLib();
        const doc = await PDFLib.PDFDocument.load(this.bytes.slice(), { ignoreEncryption: true });
        const pages = doc.getPages();
        const toPdf = (num, x, y) => this.pages[num - 1].base.convertToPdfPoint(x, y);
        for (const h of this.ann.highlights) {
          const [r, g, b] = hexToRgb(this.markColor(h).hex);
          for (const rc of h.rects) {
            const page = pages[rc.p - 1];
            if (!page) continue;
            if (h.type === "strikethrough") {
              const line = this.strikeLine(rc);
              const [x1, y1] = toPdf(rc.p, line.x1, line.y1);
              const [x2, y2] = toPdf(rc.p, line.x2, line.y2);
              page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 },
                thickness: line.width, color: PDFLib.rgb(r, g, b), opacity: 1 });
              continue;
            }
            const [x1, y1] = toPdf(rc.p, rc.x, rc.y);
            const [x2, y2] = toPdf(rc.p, rc.x + rc.w, rc.y + rc.h);
            page.drawRectangle({
              x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1),
              color: PDFLib.rgb(r, g, b), opacity: HL_OPACITY, blendMode: PDFLib.BlendMode.Multiply,
            });
          }
          if (h.comments.length) this.addNoteAnnot(PDFLib, doc, pages, h, toPdf, [r, g, b]);
        }
        for (const st of this.ann.strokes) {
          const page = pages[st.page - 1];
          if (!page) continue;
          const pts = st.points.map(([x, y]) => toPdf(st.page, x, y));
          const d = strokePath(pts.map(([x, y]) => [x, -y])); // drawSvgPath flips y
          const [r, g, b] = hexToRgb(st.color);
          page.drawSvgPath(d, { x: 0, y: 0, borderColor: PDFLib.rgb(r, g, b), borderWidth: st.width, borderLineCap: PDFLib.LineCapStyle.Round });
        }
        const out = await doc.save();
        const res = await fetch(this.o.exportUrl, { method: "PUT", headers: { "Content-Type": "application/pdf", ...this.o.headers }, body: out });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
        // a link, not window.open: popups opened after an await are blocked
        this.status.replaceChildren("Exported · ", el("a", "", { href: this.o.openExportUrl + "?t=" + Date.now(), target: "_blank", rel: "noopener", text: "Open" }));
        this.status.classList.remove("err");
        this.o.onExport?.();
      } catch (e) {
        console.error(e);
        this.setStatus("Export failed: " + e.message, true);
      } finally {
        this.exporting = false;
        this.body.inert = false;
        this.bar.inert = false;
        finishExport();
        this.exportPromise = null;
      }
    }

    addNoteAnnot(PDFLib, doc, pages, h, toPdf, rgb) {
      const rc = h.rects[0];
      const page = pages[rc.p - 1];
      const [x, y] = toPdf(rc.p, rc.x + rc.w, rc.y);
      const ctx = doc.context;
      const annot = ctx.obj({
        Type: "Annot", Subtype: "Text", Name: "Comment", Open: false,
        Rect: [x, y - 16, x + 16, y], C: rgb, F: 4,
        T: PDFLib.PDFHexString.fromText("Research Workbench"),
        Contents: PDFLib.PDFHexString.fromText(h.comments.map((x) => x.text.trim()).join("\n\n") + "\n\n“" + h.text + "”"),
      });
      page.node.addAnnot(ctx.register(annot));
    }
  }

  // older files stored a single `note`; it becomes the first comment
  function migrateComments(h) {
    const comments = Array.isArray(h.comments) ? h.comments : [];
    if ((h.note || "").trim() && !comments.length) comments.push({ id: uid(), text: h.note.trim(), created_at: h.created_at });
    const out = Object.assign({}, h, { comments });
    delete out.note;
    return out;
  }

  // merge rects on the same line that touch or overlap
  function mergeRects(rects) {
    const sorted = rects.slice().sort((a, b) => a.p - b.p || a.y - b.y || a.x - b.x);
    const out = [];
    for (const r of sorted) {
      const last = out[out.length - 1];
      if (last && last.p === r.p && Math.abs(last.y - r.y) < Math.min(last.h, r.h) * 0.5 && r.x <= last.x + last.w + 2) {
        const x2 = Math.max(last.x + last.w, r.x + r.w);
        const y1 = Math.min(last.y, r.y), y2 = Math.max(last.y + last.h, r.y + r.h);
        last.x = Math.min(last.x, r.x); last.w = x2 - last.x; last.y = y1; last.h = y2 - y1;
      } else {
        out.push({ ...r });
      }
    }
    return out.map((r) => ({ p: r.p, x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.w.toFixed(2), h: +r.h.toFixed(2) }));
  }

  window.PdfAnnotator = PdfAnnotator;
})();
