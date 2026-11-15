/* Hover links use CodeMirror's public API and never modify bibliography text. */
'use strict';
(() => {
  /** Find an HTTP URL or bare DOI under the pointer.
   * @param {string} line Source line. @param {number} ch Pointer column.
   * @pre Column belongs to this line. @post Source is unchanged.
   * @return {object|null} Source range and safe destination.
   * @throws {void} None. Used by the editor hover and click handlers.
   */
  function linkAt(line, ch) {
    const pattern = /https?:\/\/[^\s{}"<>]+|\b10\.\d{4,9}\/[^\s{}"<>]+/gi;
    for (const match of line.matchAll(pattern)) {
      const value = match[0].replace(/[,;]+$/, '');
      if (ch >= match.index && ch < match.index + value.length) {
        return { from: match.index, to: match.index + value.length,
          href: /^https?:/i.test(value) ? value : 'https://doi.org/' + value };
      }
    }
    return null;
  }

  /** Attach bibliography-only hover behavior to each editor, including swapped documents.
   * @param {CodeMirror.Editor} editor Initialized editor.
   * @pre CodeMirror 5 is loaded. @post Hover highlights links; click opens a new tab.
   * @return {void} Nothing. @throws {Error} Editor initialization failure.
   */
  CodeMirror.defineInitHook(editor => {
    const wrapper = editor.getWrapperElement();
    let mark = null, hovered = null, down = null;
    /** Remove transient decoration after edits, navigation or pointer departure.
     * @param {void} none. @pre Editor exists. @post No hover mark remains.
     * @return {void} Nothing. @throws {void} None.
     */
    function clear() { if (mark) mark.clear(); mark = null; hovered = null; }
    /** Resolve pointer coordinates against the current document only.
     * @param {MouseEvent} event Pointer event. @pre Editor exists.
     * @post No changes. @return {object|null} Link and line position.
     * @throws {Error} Editor coordinate failure.
     */
    function locate(event) {
      if (editor.getMode().name !== 'bibtex') return null;
      const pos = editor.coordsChar({ left: event.clientX, top: event.clientY }, 'window');
      if (pos.outside) return null;
      const link = linkAt(editor.getLine(pos.line), pos.ch);
      return link ? { ...link, line: pos.line } : null;
    }
    wrapper.addEventListener('mousemove', event => {
      if (event.buttons) { clear(); return; }
      const link = locate(event);
      if (link && hovered && link.line === hovered.line && link.from === hovered.from && link.href === hovered.href) return;
      clear();
      if (!link) return;
      hovered = link;
      mark = editor.markText({ line: link.line, ch: link.from }, { line: link.line, ch: link.to }, {
        className: 'bib-hover-link', title: 'Open ' + link.href, addToHistory: false
      });
    });
    wrapper.addEventListener('mouseleave', clear);
    wrapper.addEventListener('mousedown', event => {
      down = event.button === 0 ? { x: event.clientX, y: event.clientY, link: locate(event) } : null;
    });
    window.EditorTools.Tool.bind(wrapper, {
      id: 'bibliography.open-link', label: 'Bibliography links',
      info: 'Open the URL or DOI under the pointer', showText: true,
      /** Follow a source link through the shared action dispatcher.
       * @param {object} context Original pointer event. @pre A bibliography editor is active.
       * @post A stationary single click opens a safe URL; text and selections stay unchanged.
       * @return {void} Nothing. @throws {Error} Browser/editor failure reaches Tool recovery.
       */
      execute: ({ event }) => {
      const start = down; down = null;
      if (!start?.link || event.button !== 0 || event.detail > 1 || editor.somethingSelected()) return;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) return;
      const link = locate(event);
      if (!link || link.href !== start.link.href || link.line !== start.link.line || link.from !== start.link.from) return;
      event.preventDefault();
      window.open(link.href, '_blank', 'noopener,noreferrer');
      },
    });
    editor.on('change', clear);
    editor.on('swapDoc', clear);
    editor.on('optionChange', clear);
  });
})();
