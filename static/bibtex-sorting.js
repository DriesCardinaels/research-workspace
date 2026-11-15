/* Explicit BibTeX sorting contribution; existing tools and providers are unchanged. */
'use strict';
(function () {
  class BibtexSorting {
    /** Sort entries by case-insensitive citation key without rewriting their contents.
     * @param {string} text Complete bibliography, including its native line endings.
     * @pre Records are structurally balanced and ordinary entries have citation keys.
     * @post Entry bytes are retained; equal keys retain order; macros, special records and cross-reference entries stay anchored.
     * @return {string} Sorted bibliography. @throws {TypeError|SyntaxError} Invalid source.
     */
    static sort(text) { return BibtexSorting.#reorder(text).text; }

    /** Generate one source edit, retaining selection within moved entry/comment blocks.
     * @param {string} text Complete source. @param {number} from Selection start, UTF-16.
     * @param {number} to Selection end, UTF-16.
     * @pre Offsets identify an ordered range in a structurally valid bibliography.
     * @post No inputs change; unchanged edges are excluded from the replacement.
     * @return {object} Workspace editSelection() replacement and new selection offsets.
     * @throws {TypeError|RangeError|SyntaxError} Invalid source, offsets or records.
     */
    static edit(text, from, to) {
      if (typeof text !== 'string') throw new TypeError('Bibliography source must be text');
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > text.length) throw new RangeError('Invalid source selection');
      const result = BibtexSorting.#reorder(text);
      let start = 0, oldEnd = text.length, newEnd = result.text.length;
      while (start < oldEnd && start < newEnd && text[start] === result.text[start]) start++;
      while (oldEnd > start && newEnd > start && text[oldEnd - 1] === result.text[newEnd - 1]) { oldEnd--; newEnd--; }
      const map = offset => {
        const span = result.moves.find(move => offset >= move.from && offset < move.to);
        return span ? span.target + offset - span.from : offset;
      };
      const selectionStart = map(from);
      // A nonempty selection ending at a block boundary still belongs to that block.
      const selectionEnd = to > from ? map(to - 1) + 1 : selectionStart;
      return { from: start, to: oldEnd, insert: result.text.slice(start, newEnd),
        selFrom: Math.min(selectionStart, selectionEnd), selTo: Math.max(selectionStart, selectionEnd) };
    }

    /** Validate all records, then reorder independent runs separated by special records.
     * @param {string} text Bibliography. @pre None.
     * @post No partial result escapes on failure; all separators retain their original bytes.
     * @return {object} Complete text and moved-block offset mapping.
     * @throws {TypeError|SyntaxError} Invalid source or record.
     */
    static #reorder(text) {
      if (typeof text !== 'string') throw new TypeError('Bibliography source must be text');
      const records = BibtexSorting.#records(text), chunks = [], moves = [];
      let cursor = 0, outputLength = 0, index = 0;
      const append = value => { chunks.push(value); outputLength += value.length; };
      while (index < records.length) {
        const first = records[index];
        const prefix = text.slice(cursor, first.start);
        if (first.special) { append(prefix); append(text.slice(first.start, first.end)); cursor = first.end; index++; continue; }
        const split = BibtexSorting.#commentPrefix(prefix), unitStart = cursor + split;
        append(prefix.slice(0, split));
        const run = [first], separators = [], units = [{ record: first, from: unitStart, raw: text.slice(unitStart, first.end) }];
        let previous = first;
        while (index + run.length < records.length) {
          const next = records[index + run.length];
          if (next.special) break;
          const gap = text.slice(previous.end, next.start);
          // Unstructured prose between entries is an anchor, rather than an inferred comment.
          if (gap.replace(/%[^\r\n]*/g, '').trim()) break;
          const whitespace = gap.match(/^\s*/)[0];
          separators.push(whitespace);
          const from = previous.end + whitespace.length;
          units.push({ record: next, from, raw: text.slice(from, next.end) });
          run.push(next); previous = next;
        }
        const sorted = [...units].sort((a, b) => {
          const left = a.record.key.toLowerCase(), right = b.record.key.toLowerCase();
          return left < right ? -1 : left > right ? 1 : 0;
        });
        for (let position = 0; position < sorted.length; position++) {
          if (position) append(separators[position - 1]);
          const unit = sorted[position];
          moves.push({ from: unit.from, to: unit.from + unit.raw.length, target: outputLength });
          append(unit.raw);
        }
        cursor = previous.end; index += run.length;
      }
      append(text.slice(cursor));
      return { text: chunks.join(''), moves };
    }

    /** Separate a file/section header from an adjacent entry comment block.
     * @param {string} prefix Text before the first sortable entry in a section.
     * @pre Prefix lies outside records. @post A header separated by a blank line stays anchored.
     * @return {number} Start of adjacent percent comments, or prefix length.
     * @throws {void} None.
     */
    static #commentPrefix(prefix) {
      let boundary = 0;
      for (const match of prefix.matchAll(/\r?\n[\t ]*\r?\n/g)) boundary = match.index + match[0].length;
      const suffix = prefix.slice(boundary), whitespace = suffix.match(/^\s*/)[0].length;
      if (suffix.trim() && !suffix.replace(/%[^\r\n]*/g, '').trim()) return boundary + whitespace;
      return prefix.length;
    }

    /** Scan complete records without interpreting field values or expanding string macros.
     * @param {string} text Complete bibliography. @pre Text is a string.
     * @post Percent comments, escaped characters, quoted values and nested braces are respected.
     * @return {object[]} Validated record spans, keys and anchored-record flags.
     * @throws {SyntaxError} Malformed header, key or unbalanced record.
     */
    static #records(text) {
      const records = [];
      let index = 0;
      while (index < text.length) {
        if (text[index] === '%') { const end = text.indexOf('\n', index); index = end < 0 ? text.length : end + 1; continue; }
        if (text[index] !== '@') { index++; continue; }
        const header = text.slice(index).match(/^@([A-Za-z][\w-]*)\s*([{(])/);
        if (!header) throw new SyntaxError('Invalid BibTeX record near character ' + index);
        const start = index, bodyStart = index + header[0].length;
        const comment = /^comment$/i.test(header[1]), special = /^(comment|string|preamble)$/i.test(header[1]);
        const close = header[2] === '{' ? '}' : ')';
        let depth = 0, parentheses = 0, quoted = false, keyEnd = null;
        const commas = [];
        index = bodyStart;
        for (; index < text.length; index++) {
          const ch = text[index];
          if (ch === '\\') { index++; continue; }
          if (ch === '"' && depth === 0 && !comment) { quoted = !quoted; continue; }
          if (ch === '{') { depth++; continue; }
          if (ch === '}' && depth > 0) { depth--; continue; }
          if (depth || quoted) continue;
          if (ch === '%' && !comment) { const end = text.indexOf('\n', index); index = end < 0 ? text.length : end; continue; }
          if (comment && close === ')' && ch === '(') { parentheses++; continue; }
          if (comment && close === ')' && ch === ')' && parentheses) { parentheses--; continue; }
          if (ch === close) break;
          if (ch === '}') throw new SyntaxError('Unbalanced BibTeX record near character ' + start);
          if (ch === ',') { if (keyEnd === null) keyEnd = index; commas.push(index); }
        }
        if (index >= text.length || depth || quoted) throw new SyntaxError('Incomplete BibTeX record near character ' + start);
        const key = special ? '' : text.slice(bodyStart, keyEnd ?? index).trim();
        if (!special && (!key || /[\s{},=()"#%]/u.test(key))) throw new SyntaxError('Invalid citation key near character ' + start);
        let end = index + 1;
        // An inline percent comment belongs to the preceding record, not the next one.
        const trailing = text.slice(end).match(/^[\t ]*%[^\r\n]*/);
        if (trailing) end += trailing[0].length;
        // Classic BibTeX crossref parents must follow their children. Keep every
        // referencing record anchored so alphabetical sorting cannot cross that dependency.
        const dependency = !special && commas.some((comma, position) =>
          /^\s*(?:%[^\r\n]*(?:\r?\n|$)\s*)*(?:crossref|xref|xdata)\s*=/i.test(text.slice(comma + 1, commas[position + 1] ?? index)));
        records.push({ start, end, key, special: special || dependency }); index = end;
      }
      return records;
    }
  }
  window.BibtexSorting = Object.freeze(BibtexSorting);
  window.EditorTools.icons.register('sort-entries', 'M4 5h9 M4 10h7 M4 15h5 M4 20h3 M18 4v16 M14 16l4 4 4-4');
  window.EditorTools.registry.contribute('bibtex.tools', {
    id: 'bibliography.sort-entries', label: 'Sort entries',
    info: 'Sort citation keys A–Z within independent sections. Preserve comments, macros and cross-reference order.',
    icon: 'sort-entries', showText: true,
    available: ({ fileType }) => fileType === 'bibtex',
    execute: ({ editor }) => editor.editSelection(BibtexSorting.edit),
  }, { views: ['source', 'both'] });
})();
