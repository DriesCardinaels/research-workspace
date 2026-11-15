/* Local GFM rendering. Untrusted HTML is sanitized before entering the document. */
'use strict';
(() => {
  /** Compute GitHub-style heading slugs with duplicate suffixes.
   * @param {string} text Plain heading. @param {Map} counts Per-document occurrences.
   * @pre Counts belongs to this render. @post Counts advances. @return {string} Anchor.
   * @throws {void} None. Shared by rendered headings and contents links.
   */
  function slug(text, counts) {
    const base = text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc}\-\s]/gu, '').replace(/ /g, '-');
    let value = base, index = 0; while (counts.has(value)) value = base + '-' + (++index);
    counts.set(value, true); return value;
  }
  /** Resolve a relative README resource within its authorized source root.
   * @param {string} file README path. @param {string} resource Relative URL.
   * @pre URL is not external. @post No IO. @return {string|null} Safe path.
   * @throws {void} None; malformed encoding and traversal are rejected.
   */
  function relativePath(file, resource) {
    try {
      const decoded = decodeURIComponent(resource.split(/[?#]/)[0]);
      if (!decoded || decoded.startsWith('/') || /[\\\x00-\x1f]/.test(decoded)) return null;
      const parts = file.split('/').slice(0, -1);
      for (const part of decoded.split('/')) {
        if (part === '..') { if (!parts.length) return null; parts.pop(); }
        else if (part && part !== '.') parts.push(part);
      }
      return parts.join('/');
    } catch { return null; }
  }
  /** Build a navigation snippet from real block headings, ignoring fenced code.
   * @param {string} text Current buffer. @pre Marked loaded. @post Source unchanged.
   * @return {string} Markdown navigation. @throws {Error} Parser failure.
   */
  function contents(text) {
    const counts = new Map(), newline = text.includes('\r\n') ? '\r\n' : '\n';
    return newline + window.marked.lexer(text).filter(token => token.type === 'heading').map(token => {
      const title = window.DOMPurify.sanitize(window.marked.parseInline(token.text), { RETURN_DOM_FRAGMENT: true, USE_PROFILES: { html: true } }).textContent;
      return '  '.repeat(Math.max(0, token.depth - 2)) + '- [' + title.replace(/[\[\]\\]/g, '\\$&') + '](#' + slug(title, counts) + ')';
    }).join(newline) + newline;
  }
  class Preview {
    label = 'README preview';
    #last; #options; #abort = new AbortController();
    /** Own one preview lifetime. @param {object} options file/imageURL/openFile capabilities.
     * @pre Authenticated host supplies resource routes. @post Detached preview created.
     * @return {Preview} Controller. @throws {Error} DOM failure.
     */
    constructor(options) {
      this.#options = options;
      this.element = document.createElement('section'); this.element.className = 'markdown-preview';
      this.element.setAttribute('aria-label', 'GitHub-style README preview'); this.element.tabIndex = 0;
      this.element.addEventListener('click', event => {
        const link = event.target.closest('a'); if (!link || !this.element.contains(link)) return;
        const href = link.getAttribute('href') || '';
        if (href.startsWith('#')) {
          event.preventDefault(); let id; try { id = decodeURIComponent(href.slice(1)); } catch { return; }
          [...this.element.querySelectorAll('[id]')].find(node => node.id === id)?.scrollIntoView({ block: 'start' });
        } else if (!/^[a-z][a-z\d+.-]*:/i.test(href) && !href.startsWith('//')) {
          event.preventDefault(); const path = relativePath(options.file, href); if (path) options.openFile(path);
        }
      }, { signal: this.#abort.signal });
    }
    /** Render only changed text; preserve scroll on every refresh.
     * @param {string} text Exact unsaved buffer. @pre Parser and sanitizer loaded.
     * @post Sanitized GFM replaces preview; scripts/forms/styles cannot execute.
     * @return {void} Nothing. @throws {Error} Render failure reaches host boundary.
     */
    update(text) {
      if (text === this.#last) return;
      const fragment = window.DOMPurify.sanitize(window.marked.parse(text, { gfm: true, breaks: false, async: false }), {
        RETURN_DOM_FRAGMENT: true, USE_PROFILES: { html: true },
        FORBID_TAGS: ['style', 'form', 'iframe', 'video', 'audio', 'source'],
        FORBID_ATTR: ['style', 'name', 'id', 'srcset'],
      });
      const counts = new Map();
      for (const heading of fragment.querySelectorAll('h1,h2,h3,h4,h5,h6')) heading.id = slug(heading.textContent, counts);
      for (const link of fragment.querySelectorAll('a')) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
      for (const image of fragment.querySelectorAll('img')) {
        const src = image.getAttribute('src') || '';
        if (!/^https?:\/\//i.test(src)) {
          const path = relativePath(this.#options.file, src);
          if (path && !/^[a-z][a-z\d+.-]*:/i.test(src)) image.src = this.#options.imageURL(path); else image.removeAttribute('src');
        }
        image.loading = 'lazy'; image.referrerPolicy = 'no-referrer';
      }
      const top = this.element.scrollTop;
      this.element.replaceChildren(fragment); this.element.scrollTop = top; this.#last = text;
    }
    /** Release owned listeners and DOM. @param {void} none. @pre Any state.
     * @post Preview cannot handle old-file navigation. @return {void} Nothing.
     * @throws {void} None. Called by text host on file changes and destruction.
     */
    dispose() { this.#abort.abort(); this.element.remove(); }
  }
  window.MarkdownPreview = Object.freeze({ contents, relativePath });
  window.TextPreviews.register('markdown', options => new Preview(options));
})();
