/* Source projection model; exact buffers stay owned by editor sessions. */
'use strict';
(() => {
  const { stripComments, normalizedSource, nativeOffset } = window.SourceText;
  // Expand literal inputs into an editable projection with normalized UTF-16 offsets.
  // Requires a main path, allowed paths and an async reader. Returns source spans and original
  // file bytes alongside the text; failed/cyclic inputs remain visible and produce warnings.
  // Does not evaluate TeX. projectionRange/projectionSpans translate its coordinates.
  /** Expand literal LaTeX inputs into an editable source projection.
   * @param {*} main,names,read: Main relative path, authorized paths and async exact-text reader.
   * @pre Reader authorizes each path and returns Unicode text. @post No files change; unresolved/circular inputs produce warnings.
   * @return {*} Promise<object>: Display text, native sources, segments and warnings. @throws TypeError: Invalid inputs; reader failures become visible model warnings.
   */
  async function combinedSource(main, names, read) {
    const known = new Set(names), warnings = new Set();
    const segments = [], sources = new Map();
    let output = '';
    const append = (text, file = null, sourceStart = 0) => {
      const previous = segments[segments.length - 1];
      if (file && previous?.file === file && previous.sourceEnd === sourceStart && previous.end === output.length) {
        previous.end += text.length; previous.sourceEnd += text.length;
      } else segments.push({ start: output.length, end: output.length + text.length, file, sourceStart, sourceEnd: sourceStart + text.length });
      output += text;
    };
    const normalize = (path) => {
      const parts = [];
      for (const part of path.split('/')) {
        if (!part || part === '.') continue;
        if (part === '..') { if (!parts.length) return null; parts.pop(); }
        else parts.push(part);
      }
      return parts.join('/');
    };
    const resolve = (name, parent) => {
      if (name.startsWith('/') || /[\\#$]/.test(name)) return null;
      const paths = [name, parent.slice(0, parent.lastIndexOf('/') + 1) + name];
      for (const path of paths) {
        const rel = normalize(path.endsWith('.tex') ? path : path + '.tex');
        if (known.has(rel)) return rel;
      }
      return null;
    };
    let includeOnly = null;
    /** Append one authorized source while detecting input cycles.
     * @param {*} file,stack,subfile: Current file, ancestor path list and subdocument flag.
     * @pre Called only while constructing this projection. @post Private output/maps gain this file; reader failures add warnings.
     * @return {*} Promise<boolean>: Whether source was expanded. @throws TypeError: Malformed source; read failures are converted to warnings.
     */
    async function expand(file, stack = [], subfile = false) {
      if (stack.includes(file)) { warnings.add(`Circular input: ${[...stack, file].join(' → ')}`); return false; }
      let text;
      try { const raw = await read(file); sources.set(file, raw); text = normalizedSource(raw); }
      catch { warnings.add(`Could not read ${file}`); return false; }
      let offset = 0;
      if (subfile) {
        const clean = stripComments(text), begin = clean.indexOf('\\begin{document}');
        if (begin >= 0) {
          const end = clean.indexOf('\\end{document}', begin);
          offset = begin + '\\begin{document}'.length;
          text = text.slice(offset, end < 0 ? text.length : end);
        }
      }
      const clean = stripComments(text).replace(/\\begin\{(verbatim|lstlisting|minted)\*?\}[\s\S]*?\\end\{\1\*?\}|\\verb\*?([^\w\s])[\s\S]*?\2/g, (m) => ' '.repeat(m.length));
      if (file === main) {
        const only = clean.match(/\\includeonly\s*\{([^}]*)\}/);
        if (only) includeOnly = new Set(only[1].split(',').map((x) => x.trim().replace(/\.tex$/, '')));
      }
      const inputs = /\\(input|include|subfile)(?![A-Za-z])\s*(?:\{([^}]+)\}|([^\s%{}]+))/g;
      let at = 0;
      for (const match of clean.matchAll(inputs)) {
        if (match.index > 0 && clean[match.index - 1] === '\\') continue;
        const name = (match[2] || match[3]).trim();
        append(text.slice(at, match.index), file, offset + at);
        at = match.index + match[0].length;
        if (match[1] === 'include' && includeOnly && !includeOnly.has(name.replace(/\.tex$/, ''))) continue;
        const child = resolve(name, file);
        if (!child) { warnings.add(`Unresolved input: ${name} in ${file}`); append(text.slice(match.index, at), file, offset + match.index); continue; }
        append(`\n% --- ${child} ---\n`);
        if (!await expand(child, [...stack, file], match[1] === 'subfile')) append(text.slice(match.index, at), file, offset + match.index);
        append(`\n% --- back to ${file} ---\n`);
      }
      append(text.slice(at), file, offset + at);
      return true;
    }
    await expand(main);
    return { text: output, warnings: [...warnings], segments, sources };
  }

  // Resolve a display range contained in one source span. Returns null for generated separators
  // or a selection crossing files; consumers must reject those edits rather than guess a target.
  /** Resolve a display range entirely inside one native source span.
   * @param {*} model,start,end: Projection and display range.
   * @pre Offsets use normalized UTF-16 coordinates. @post Inputs unchanged; generated separators are not editable.
   * @return {*} object|null: Native file/range or no single source target. @throws TypeError: Malformed model.
   */
  function projectionRange(model, start, end = start) {
    const s = model?.segments.find((s) => s.file && start >= s.start && end <= s.end);
    return s ? { file: s.file, start: s.sourceStart + start - s.start, end: s.sourceStart + end - s.start, segment: s } : null;
  }
  // Map a normalized source range to every visible occurrence, clipping at include boundaries.
  // Requires the model from combinedSource. Returns no ranges for omitted source text.
  /** Map one source range to all displayed occurrences.
   * @param {*} model,file,start,end: Projection, source identity and source range.
   * @pre Ranges use normalized UTF-16 units. @post Inputs unchanged.
   * @return {*} object[]: Visible display spans. @throws TypeError: Malformed model.
   */
  function projectionSpans(model, file, start, end = start) {
    return (model?.segments || []).filter((s) => s.file === file && (start === end
      ? start >= s.sourceStart && start <= s.sourceEnd : start < s.sourceEnd && end > s.sourceStart))
      .map((s) => ({ start: s.start + Math.max(start, s.sourceStart) - s.sourceStart,
        end: s.start + Math.min(end, s.sourceEnd) - s.sourceStart }));
  }
  // Apply one accepted editor change to its original file and to the projection map.
  // Requires a single, uniquely included source span; throws before mutation otherwise.
  // Returns native file offsets/text for the backing CodeMirror.Doc; keeps include commands
  // and original line endings intact. Called for typing, formatting, undo and redo alike.
  /** Calculate an edit to one uniquely included source passage.
   * @param {*} model,from,to,inserted: Projection, display range and replacement string.
   * @pre Edit belongs to one uniquely included source span. @post Input model and file buffers are unchanged; a fresh model preserves native CRLF.
   * @return {*} object: Native edit and updated projection model. @throws Error: Cross-file, generated or repeated passage; TypeError: Invalid input.
   */
  function applyProjectionEdit(model, from, to, inserted) {
    const target = projectionRange(model, from, to);
    if (!target) throw new Error('Edit within one source passage. File separators cannot be edited.');
    if (projectionSpans(model, target.file, target.start, target.end).length !== 1)
      throw new Error('This passage is included more than once. Edit it in its source file.');
    const raw = model.sources.get(target.file);
    const start = nativeOffset(raw, target.start), end = nativeOffset(raw, target.end);
    const insert = /\r\n/.test(raw) ? inserted.replace(/\n/g, '\r\n') : inserted;
    const delta = inserted.length - (to - from);
    const segments = model.segments.map((s) => {
      const next = { ...s };
      if (s === target.segment) { next.end += delta; next.sourceEnd += delta; }
      else {
        if (s.start >= to) { next.start += delta; next.end += delta; }
        if (s.file === target.file && s.sourceStart >= target.end) { next.sourceStart += delta; next.sourceEnd += delta; }
      }
      return next;
    });
    const sources = new Map(model.sources);
    sources.set(target.file, raw.slice(0, start) + insert + raw.slice(end));
    return { file: target.file, start, end, insert,
      model: { ...model, text: model.text.slice(0, from) + inserted + model.text.slice(to), segments, sources } };
  }
  window.SourceProjection = Object.freeze({ combinedSource, projectionRange, projectionSpans, applyProjectionEdit });
})();
