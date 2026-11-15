/* Text matching between LaTeX source and PDF text, used by the workspace to place
 * comment and change marks and to map PDF selections to source ranges.
 * Pure functions; tested in Node (tests/test_draft_match.mjs).
 */
'use strict';
(function (global) {
  // ------------------------------------------------------------ matching (pure)
  const WORD = /[\p{L}\p{N}]+/gu;
  const norm = (w) => w.normalize('NFKC').toLowerCase();
  const keep = (w) => !/^\d+$/.test(w); // citation numbers and page numbers are unreliable anchors

  // Words a reader sees in LaTeX, with their offsets in the source. Citations, references,
  // labels, math, comments and command names are blanked out (same length, so offsets hold).
  function latexWordPositions(src) {
    const blank = (m) => ' '.repeat(m.length);
    const masked = src
      .replace(/\\[$%&#_{}]/g, blank) // escaped characters such as \$ are not math or comments
      .replace(/(^|[^\\])(%.*)$/gm, (m, a, c) => a + blank(c))
      .replace(/\\(?:cite[a-z]*|[cC]?ref|autoref|eqref|label|url|href)\*?(?:\[[^\]]*\])*\{[^}]*\}/g, blank)
      .replace(/\$[^$]*\$/g, blank)
      .replace(/\\[a-zA-Z@]+\*?(?:\[[^\]]*\])?/g, blank);
    const out = [];
    for (const m of masked.matchAll(WORD)) {
      const w = norm(m[0]);
      if (keep(w)) out.push({ w, start: m.index, end: m.index + m[0].length });
    }
    return out;
  }
  const latexWords = (src) => latexWordPositions(src).map((x) => x.w);

  // Words of a PDF selection; a word hyphenated at a line end is joined again.
  // Whitespace may already be collapsed ("pro- cessing"), so any hyphen followed by space joins.
  const selectionWords = (text, join = true) => latexWords(join ? text.replace(/(\p{L})-\s+(\p{Ll})/gu, '$1$2') : text);

  // Source range for words selected in the PDF. `text` is the file, `near` the offset
  // SyncTeX gave (start of its line); the search covers the paragraph around it.
  function sourceRange(text, near, selected, context) {
    if (!selected.length) return null;
    const from = Math.max(0, text.lastIndexOf('\n\n', Math.max(0, near - 4000)));
    const to = Math.min(text.length, near + 6000);
    const words = latexWordPositions(text.slice(from, to));
    // The first and last selected words may be partial (a selection rarely starts or ends on a
    // word boundary). Prefer context matches, then the match closest to the SyncTeX position.
    const n = selected.length;
    // One selected word: whole-word matches first; part of a word only if there is none.
    const fits = (w, k, loose) => (n === 1 ? (loose ? w.includes(selected[0]) : w === selected[0]) : k === 0 ? w.endsWith(selected[0]) : k === n - 1 ? w.startsWith(selected[k]) : w === selected[k]);
    const search = (loose) => {
    let best = null;
    for (let i = 0; i + n <= words.length; i++) {
      let ok = true;
      for (let k = 0; k < n && ok; k++) ok = fits(words[i + k].w, k, loose);
      if (!ok) continue;
      const start = from + words[i].start;
      let score = 0;
      for (let c = 1; c <= context.length && i - c >= 0; c++) if (words[i - c].w === context[context.length - c]) score++;
      const dist = Math.abs(start - near);
      if (!best || score > best.score || (score === best.score && dist < best.dist)) {
        best = { score, dist, start, end: from + words[i + n - 1].end };
      }
    }
    return best;
    };
    const best = search(false) || (n === 1 ? search(true) : null);
    if (!best) return null;
    // Close braces opened inside the range (\\emph{slope -> \\emph{slope}).
    let end = best.end, open = 0;
    for (const ch of text.slice(best.start, end)) open += ch === '{' ? 1 : ch === '}' ? -1 : 0;
    while (open > 0 && text[end] === '}') { end++; open--; }
    return { start: best.start, end };
  }

  // Words on a PDF page with their position in the text items. A word split by a
  // line-end hyphen ("pro-" + "cessing") becomes one word with two parts.
  function pageWords(items) {
    const out = [];
    let pendingHyphen = false;
    items.forEach((item, idx) => {
      const str = item.str || '';
      const tokens = [...str.matchAll(WORD)];
      tokens.forEach((m, k) => {
        const part = { item: idx, start: m.index, end: m.index + m[0].length };
        const w = norm(m[0]);
        if (pendingHyphen && k === 0 && out.length) {
          const prev = out[out.length - 1];
          prev.w += w; prev.parts.push(part);
        } else if (keep(w)) {
          out.push({ w, parts: [part] });
        }
        pendingHyphen = false;
        const last = k === tokens.length - 1;
        if (last && /^-\s*$/.test(str.slice(part.end))) pendingHyphen = true;
      });
      if (!tokens.length && str.trim()) pendingHyphen = false;
    });
    return out;
  }

  const seqAt = (words, i, seq) => seq.every((w, k) => words[i + k] && words[i + k].w === w);

  // Find the page words for a change: target = the new passage, context = words just before it.
  // Returns {from, to} (inclusive word indices), {at} for a removal (caret after word `at`), or null.
  function findSpan(words, target, context) {
    const ctx = context.slice(-6);
    if (!target.length) {
      for (let n = Math.min(4, ctx.length); n >= 2; n--) {
        const seq = ctx.slice(-n);
        const hits = [];
        for (let i = 0; i + n <= words.length; i++) if (seqAt(words, i, seq)) hits.push(i + n - 1);
        if (hits.length === 1) return { at: hits[0] };
      }
      return null;
    }
    const k = Math.min(3, target.length);
    const head = target.slice(0, k), tail = target.slice(-k);
    let best = null;
    for (let i = 0; i + k <= words.length; i++) {
      if (!seqAt(words, i, head)) continue;
      let score = 0;
      for (let c = 1; c <= ctx.length; c++) if (words[i - c] && words[i - c].w === ctx[ctx.length - c]) score++;
      if (!best || score > best.score) best = { i, score };
    }
    if (!best) return null;
    const from = best.i;
    if (target.length <= k) return { from, to: from + target.length - 1 };
    const lo = Math.max(from + 1, from + target.length - k - 10), hi = from + target.length + 15;
    for (let j = lo; j <= hi && j + k <= words.length; j++) if (seqAt(words, j, tail)) return { from, to: j + k - 1 };
    return { from, to: Math.min(words.length - 1, from + target.length - 1), approximate: true };
  }

  // Float environments (figure, table) in LaTeX source: {start, end, caption: {start, end, text} | null}.
  // Offsets are string indices; comments are ignored.
  const FLOAT = /\\begin\{((?:figure|table|wrapfigure|wraptable|SCfigure)\*?)\}/g;
  function floats(src) {
    const clean = src.replace(/(^|[^\\])(%.*)$/gm, (m, a, c) => a + ' '.repeat(c.length));
    const out = [];
    for (const m of clean.matchAll(FLOAT)) {
      const endTag = `\\end{${m[1]}}`, e = clean.indexOf(endTag, m.index);
      if (e < 0) continue;
      let caption = null;
      const c = clean.slice(m.index, e).search(/\\caption(?![A-Za-z])/);
      if (c >= 0) {
        let i = m.index + c + '\\caption'.length;
        const skipSpace = () => { while (i < e && /\s/.test(clean[i])) i++; };
        skipSpace();
        if (clean[i] === '[') { let d = 0; for (; i < e; i++) { if (clean[i] === '[') d++; else if (clean[i] === ']' && --d === 0) { i++; break; } } skipSpace(); }
        if (clean[i] === '{') {
          let d = 0, j = i;
          for (; j < e; j++) { if (clean[j] === '\\') { j++; continue; } if (clean[j] === '{') d++; else if (clean[j] === '}' && --d === 0) break; }
          caption = { start: i + 1, end: j, text: src.slice(i + 1, j) };
        }
      }
      out.push({ start: m.index, end: e + endTag.length, caption });
    }
    return out;
  }
  // The float that the source range [start, end) touches outside its caption text, or null.
  // Such a change (image, \Description, layout) has no words in the PDF text; it is shown on the caption.
  function floatOutsideCaption(src, start, end) {
    for (const f of floats(src)) {
      const hit = start === end ? start >= f.start && start <= f.end : start < f.end && end > f.start;
      if (!hit) continue;
      if (f.caption && start >= f.caption.start && end <= f.caption.end) return null;
      return f;
    }
    return null;
  }

  // Index of `word` in a source line. With repeats, choose the occurrence whose three
  // neighbors on each side match the neighbors of the clicked word in the PDF line. -1 when absent.
  function pickOccurrence(line, word, around) {
    const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(?<![\\p{L}\\p{N}])' + esc + '(?![\\p{L}\\p{N}])', 'giu');
    const w = norm(word);
    const spots = around.map((x, i) => (x === w ? i : -1)).filter((i) => i >= 0);
    let best = -1, bestScore = -1;
    for (const m of line.matchAll(re)) {
      const before = latexWords(line.slice(Math.max(0, m.index - 100), m.index)).slice(-3);
      const after = latexWords(line.slice(m.index + word.length, m.index + word.length + 100)).slice(0, 3);
      let score = 0;
      for (const i of spots) {
        let sc = 0;
        before.forEach((x, j) => { if (around[i - before.length + j] === x) sc++; });
        after.forEach((x, j) => { if (around[i + 1 + j] === x) sc++; });
        score = Math.max(score, sc);
      }
      if (score > bestScore) { best = m.index; bestScore = score; }
    }
    return best;
  }

  const Match = { latexWords, latexWordPositions, sourceRange, selectionWords, pageWords, findSpan, pickOccurrence, floats, floatOutsideCaption };
  if (typeof module !== 'undefined') module.exports = Match;
  global.DraftMatch = Match;
})(typeof window !== 'undefined' ? window : globalThis);
