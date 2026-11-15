/* Local citation analysis and ranking; no editor, DOM, storage or network access. */
'use strict';
(() => {
  const { stripComments } = window.SourceText;
  // Citations: the same rules as drafts.cite_uses on the server, in UTF-16 offsets for CodeMirror.
  const CITE_SRC = String.raw`\\(?:[A-Za-z]*cite[A-Za-z]*|nocite)\*?\s*(?:\[[^\]]*\]\s*){0,2}\{`;
  /** Locate citation keys for editor decorations.
   * @param {*} text: Unicode source using native editor offsets.
   * @pre Text is a string. @post Input unchanged; empty citations remain visible.
   * @return {*} object[]: Key/range records in UTF-16 units. @throws TypeError: Invalid source.
   */
  function citeUses(text) {
    const clean = stripComments(text), out = [];
    for (const m of clean.matchAll(new RegExp(CITE_SRC + '([^}]*)\\}', 'g'))) {
      const inner = m[1], base = m.index + m[0].length - 1 - inner.length;
      if (!inner.trim()) { out.push({ key: '', start: m.index, end: m.index + m[0].length }); continue; }
      let pos = 0;
      for (const part of inner.split(',')) {
        const key = part.trim();
        if (key && key !== '*') { const start = base + pos + part.indexOf(key); out.push({ key, start, end: start + key.length }); }
        pos += part.length + 1;
      }
    }
    return out;
  }
  // The cite key being typed at `ch` in `line`: { from, to, query } or null outside \cite{…}.
  /** Find the citation key currently being typed.
   * @param {*} line,ch: Current source line and UTF-16 cursor column.
   * @pre Cursor belongs to this line. @post Inputs unchanged.
   * @return {*} object|null: Replacement range and query. @throws TypeError: Invalid source.
   */
  function citeContext(line, ch) {
    const before = stripComments(line).slice(0, ch);
    const m = before.match(new RegExp(CITE_SRC + '([^}]*)$'));
    if (!m) return null;
    const raw = m[1].slice(m[1].lastIndexOf(',') + 1);
    const from = ch - raw.length + raw.match(/^\s*/)[0].length;
    const to = ch + line.slice(ch).match(/^[^,}\s]*/)[0].length;
    return { from, to, query: line.slice(from, ch) };
  }
  // Bib entries for a query: key prefix first, then key substring, then author, year or title.
  /** Rank linked bibliography entries for local autocomplete.
   * @param {*} entries,query,limit: Current metadata snapshots, search text and maximum results.
   * @pre Entries contain string keys. @post Inputs unchanged; key prefixes rank before metadata matches.
   * @return {*} object[]: Matching entries. @throws TypeError: Invalid entry/query shape.
   */
  function citeMatches(entries, query, limit = 50) {
    const q = query.toLowerCase();
    if (!q) return entries.slice(0, limit);
    const rank = (e) => {
      const k = e.key.toLowerCase();
      if (k.startsWith(q)) return 0;
      if (k.includes(q)) return 1;
      if (`${e.author} ${e.year} ${e.title}`.toLowerCase().includes(q)) return 2;
      return -1;
    };
    return entries.map((e) => [rank(e), e]).filter(([r]) => r >= 0).sort((a, b) => a[0] - b[0]).slice(0, limit).map(([, e]) => e);
  }
  window.BibliographyCitations = Object.freeze({ citeUses, citeContext, citeMatches });
})();
