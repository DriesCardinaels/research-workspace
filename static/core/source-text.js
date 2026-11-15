/* Pure source-coordinate utilities; native editor offsets are UTF-16. */
'use strict';
(() => {
  /** Blank unescaped LaTeX comments without moving editor coordinates.
   * @param {*} text: Unicode source.
   * @pre Text is a string. @post Input unchanged; output preserves UTF-16 length.
   * @return {*} string: Blanked source. @throws TypeError: Invalid text.
   */
  const stripComments = (text) => text.replace(/(?<!\\)%[^\n]*/g, (m) => ' '.repeat(m.length));
  // Normalize display newlines only. Requires text; leaves native source bytes to the buffers.
  /** Normalize display newlines without changing native buffers.
   * @param {*} text: Exact Unicode source.
   * @pre Text is a string. @post Input unchanged; CRLF becomes LF in the returned view.
   * @return {*} string: Display source. @throws TypeError: Invalid text.
   */
  const normalizedSource = (text) => text.replace(/\r\n/g, '\n');
  // Convert a normalized offset to native UTF-16 units. Requires an in-bounds offset;
  // preserves CRLF when projection edits and comments are routed to the original file.
  /** Convert a normalized display offset to native UTF-16 units.
   * @param {*} text,offset: Native source and in-bounds normalized offset.
   * @pre Offset belongs to the normalized view. @post Inputs unchanged; CRLF width is retained in the result.
   * @return {*} number: Native offset. @throws TypeError: Invalid input.
   */
  function nativeOffset(text, offset) {
    let i = 0, n = 0;
    while (i < text.length && n < offset) { if (text[i] === '\r' && text[i + 1] === '\n') i++; i++; n++; }
    return i;
  }
  // Convert a CodeMirror position against a pre-change snapshot, not the already edited doc.
  // Requires a valid position; returns a UTF-16 offset for applyProjectionEdit.
  /** Resolve a CodeMirror position against a pre-change source snapshot.
   * @param {*} text,pos: Snapshot and line/ch position.
   * @pre Position refers to that snapshot. @post Inputs unchanged.
   * @return {*} number: UTF-16 offset. @throws TypeError: Invalid input.
   */
  function textOffset(text, pos) {
    let at = 0;
    for (let line = 0; line < pos.line; line++) { const end = text.indexOf('\n', at); if (end < 0) return text.length; at = end + 1; }
    return Math.min(text.length, at + pos.ch);
  }
  window.SourceText = Object.freeze({ stripComments, normalizedSource, nativeOffset, textOffset });
})();
