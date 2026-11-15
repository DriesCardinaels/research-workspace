/* File formatting providers: compact bibliography layout and field cleanup. */
'use strict';
(function () {
  class SourceFormatterRegistry {
    #providers = new Map();
    /** Register a formatter independently of editor and toolbar implementations.
     * @param {string} extension File suffix including its dot.
     * @param {object} provider Object implementing format(text).
     * @pre The extension has no registered formatter.
     * @post Provider is available through supports() and format(); storage stays private.
     * @return {SourceFormatterRegistry} This registry.
     * @throws {TypeError|Error} Invalid provider or duplicate suffix.
     */
    register(extension, provider) {
      if (!/^\.[a-z0-9]+$/i.test(extension) || typeof provider?.format !== 'function') throw new TypeError('A file extension and format(text) provider are required');
      extension = extension.toLowerCase();
      if (this.#providers.has(extension)) throw new Error('Formatter already registered: ' + extension);
      this.#providers.set(extension, provider); return this;
    }
    /** Check whether a path has a registered formatter.
     * @param {string} file Source path.
     * @pre None. @post No state changes.
     * @return {boolean} Whether formatting is supported.
     * @throws {Error} None under normal operation.
     */
    supports(file) { return this.#providers.has((file?.match(/\.[^./]+$/)?.[0] || '').toLowerCase()); }
    /** Format a supported file, leaving other file types untouched.
     * @param {string} file Source path.
     * @param {string} text Complete source buffer.
     * @pre Text is a string. @post Input and registrations are unchanged.
     * @return {string} Formatted source, or original source for unsupported files.
     * @throws {SyntaxError|Error} Provider validation or formatting failure.
     */
    format(file, text) { return this.#providers.get((file?.match(/\.[^./]+$/)?.[0] || '').toLowerCase())?.format(text) ?? text; }
  }

  class BibtexFormatter {
    /** Compact whitespace in a field value while preserving escaped characters.
     * @param {string} value Parsed BibTeX field expression.
     * @pre Value has balanced delimiters, as checked by format().
     * @post Input is unchanged; ordinary whitespace runs become single spaces.
     * @return {string} Compact value without padding inside its outer delimiters.
     * @throws {Error} None under normal operation.
     */
    static #compactValue(value) {
      value = value.replace(/\\[\s\S]|[ \t\r\n]+/g, token => token.startsWith('\\') ? token : ' ').trim();
      if ((value.startsWith('{') && value.endsWith('}')) || (value.startsWith('"') && value.endsWith('"'))) {
        value = value[0] + value.slice(1, -1).trimStart().replace(/(?<!\\)\s+$/, '') + value.at(-1);
      }
      return value;
    }

    /** Lay out BibTeX records, compact field whitespace and remove abstract fields.
     * @param {string} text Complete bibliography, with LF or CRLF line endings.
     * @pre Text is a string; records have balanced delimiters.
     * @post Abstract fields are removed; keys, macros and field ordering remain.
     * Comments and special records stay literal.
     * @return {string} One field per line, aligned assignments and blank entry separators.
     * @throws {SyntaxError} Incomplete or unbalanced record; no partial result is returned.
     */
    static format(text) {
      const newline = text.includes('\r\n') ? '\r\n' : '\n';
      let output = '', copied = 0, i = 0;
      while (i < text.length) {
        if (text[i] === '%') { const end = text.indexOf('\n', i); i = end < 0 ? text.length : end + 1; continue; }
        const header = text.slice(i).match(/^@(\w+)\s*([{(])/);
        if (!header) { i++; continue; }
        const start = i, bodyStart = i + header[0].length, close = header[2] === '{' ? '}' : ')';
        const special = /^(comment|preamble|string)$/i.test(header[1]);
        const commas = [];
        let depth = 0, quoted = false, comments = false;
        i = bodyStart;
        for (; i < text.length; i++) {
          const ch = text[i];
          if (ch === '\\') { i++; continue; }
          if (ch === '"' && depth === 0 && !/^comment$/i.test(header[1])) { quoted = !quoted; continue; }
          if (ch === '{') { depth++; continue; }
          if (ch === '}' && depth > 0) { depth--; continue; }
          if (depth || quoted) continue;
          if (ch === close) break;
          if (ch === '}') throw new SyntaxError('Unbalanced BibTeX record near ' + start);
          if (ch === '%') {
            comments = true;
            const end = text.indexOf('\n', i);
            if (end < 0) { i = text.length; break; }
            i = end; continue;
          }
          if (ch === ',') commas.push(i);
        }
        if (i >= text.length || depth || quoted) throw new SyntaxError('Incomplete BibTeX record near ' + start);
        let record = text.slice(start, i + 1);
        // Remove abstract assignments even when inter-field comments prevent relayout.
        if (!special && comments && commas.length) {
          const parts = [];
          let fieldStart = commas[0] + 1, pendingComments = '';
          for (const end of [...commas.slice(1), i]) {
            const part = text.slice(fieldStart, end); fieldStart = end + 1;
            const prefix = part.match(/^\s*(?:%[^\r\n]*(?:\r\n|\n)\s*)*/)[0];
            if (/^abstract\s*=/i.test(part.slice(prefix.length))) {
              if (prefix.includes('%')) pendingComments += prefix;
            } else {
              parts.push(pendingComments + part); pendingComments = '';
            }
          }
          record = text.slice(start, commas[0] + 1) + parts.join(',') + pendingComments + close;
        }
        // Retain special records and records with inter-field comments verbatim.
        if (!special && !comments && commas.length) {
          const key = text.slice(bodyStart, commas[0]).trim();
          const fields = [];
          let fieldStart = commas[0] + 1, valid = !!key;
          for (const end of [...commas.slice(1), i]) {
            const part = text.slice(fieldStart, end).trim(); fieldStart = end + 1;
            if (!part && end === i) continue; // optional trailing comma
            const field = part.match(/^([\w:.-]+)\s*=\s*([\s\S]+)$/);
            if (!field) { valid = false; break; }
            if (field[1].toLowerCase() !== 'abstract') {
              fields.push({ name: field[1], value: this.#compactValue(field[2]) });
            }
          }
          if (valid) {
            const width = Math.max(...fields.map(field => field.name.length));
            record = '@' + header[1] + header[2] + key + ',' + (fields.length ? newline
              + fields.map((field, index) => '  ' + field.name.padEnd(width) + ' = ' + field.value
                + (index < fields.length - 1 || !text.slice(commas.at(-1) + 1, i).trim() ? ',' : '')).join(newline)
              + newline : '') + close;
          }
        }
        let gap = text.slice(copied, start);
        if (copied && /^\s*$/.test(gap)) gap = newline + newline;
        output += gap + record; copied = ++i;
      }
      return output + text.slice(copied);
    }
  }

  const formatters = new SourceFormatterRegistry();
  formatters.register('.bib', BibtexFormatter);
  window.SourceFormatting = Object.freeze({ SourceFormatterRegistry, BibtexFormatter, formatters });

  if (window.EditorTools) {
    class FormatFileTool extends window.EditorTools.Tool {
      static id = 'source.format-file';
      static label = 'Format file';
      /** Build the file layout command through the public workspace interface.
       * @param {object} context Toolbar context containing owner.
       * @pre Owner implements formatFile() and runToolbarCommand().
       * @post A detached control is created; activation applies an undoable edit.
       * @return {HTMLButtonElement} Formatting control.
       * @throws {Error} DOM creation failure.
       */
      create({ owner }) {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'pdfa-btn'; button.textContent = 'Format file';
        button.title = 'Format file (Shift+Alt+F); also applied automatically on save';
        window.EditorTools.Tool.bind(button, this, { owner });
        return button;
      }
      /** Restrict the command to supported individual source files.
       * @param {object} context Toolbar context containing owner.
       * @pre Owner implements canFormatFile(). @post No state changes.
       * @return {boolean} Whether the command applies.
       * @throws {Error} Capability access failure.
       */
      available({ owner }) { return owner.canFormatFile(); }
      /** Format through the workspace interface. @param {object} context Public owner.
       * @pre File has a formatter. @post One undoable formatting edit applies.
       * @return {*} Formatting result. @throws {Error} Validation or editor failure.
       */
      execute({ owner }) { return owner.formatFile(); }
    }
    window.EditorTools.registry.register('workspace.source', FormatFileTool, { views: ['source', 'both'] });
  }
})();
