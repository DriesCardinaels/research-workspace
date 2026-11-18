/* Plain-text note extensions. All values are data; HTML is never interpreted. */
'use strict';
(() => {
  const palette = Object.freeze([
    ['Yellow','#f9e2af'], ['Peach','#fab387'], ['Pink','#f5c2e7'],
    ['Lavender','#cba6f7'], ['Blue','#89b4fa'], ['Sky','#89dceb'],
    ['Mint','#94e2d5'], ['Green','#a6e3a1'],
  ].map(([label,color]) => Object.freeze({label,color})));
  /** Apply or recolor a selection, retaining native line separators.
   * @pre Hex RGB color. @post Returns text with per-line highlight metadata.
   * @throws {TypeError} Invalid color. Related: note style parser and color picker.
   */
  function highlight(text, color) {
    if (!/^#[a-f\d]{6}$/i.test(color)) throw new TypeError('Choose a valid highlight color');
    return text.split(/(\r\n|\n)/).map(line => {
      if (!line || /^\r?\n$/.test(line)) return line;
      const existing = line.match(/^==(?:\{#[a-f\d]{6}\})?(.*?)==$/i);
      return '=={' + color.toLowerCase() + '}' + (existing ? existing[1] : line) + '==';
    }).join('');
  }
  /** Attach a safely encoded comment to selected text.
   * @pre Nonempty selection and comment. @post Annotation survives ordinary text saves.
   * @throws {Error} Empty selection/comment. Related: comments() and note decorations.
   */
  function annotate(text, comment) {
    if (!text.trim()) throw new Error('Select text before adding a comment');
    if (!comment.trim()) throw new Error('Enter a comment');
    return text.split(/(\r\n|\n)/).map(line => !line || /^\r?\n$/.test(line) ? line : '<!--note-comment:' + encodeURIComponent(comment.trim()) + '-->' + line + '<!--/note-comment-->').join('');
  }
  /** Read comment ranges without evaluating markup; ignore fenced/inline code.
   * @pre Plain document text. @post Returns UTF-16 ranges for verified session edits.
   * @throws {void} None; malformed metadata stays literal. Related: TextSession.replaceTextRange.
   */
  function comments(text) {
    const result = []; let offset = 0, fence = null;
    for (const line of text.split(/(?<=\n)/)) {
      const boundary = line.match(/^ {0,3}(`{3,}|~{3,})(.*?)(?:\r?\n)?$/);
      if (boundary && !fence) fence = boundary[1];
      else if (fence) { if (boundary && boundary[1][0] === fence[0] && boundary[1].length >= fence.length && !boundary[2].trim()) fence = null; }
      else {
        const code = [...line.matchAll(/(`+)([^`]*?)\1/g)];
        for (const match of line.matchAll(/<!--note-comment:([^>]*?)-->(.*?)<!--\/note-comment-->/g)) {
          if (code.some(span => match.index >= span.index && match.index < span.index + span[0].length)) continue;
          try { result.push({start:offset + match.index,end:offset + match.index + match[0].length,raw:match[0],text:match[2],comment:decodeURIComponent(match[1])}); } catch { /* Keep malformed comments literal. */ }
        }
      }
      offset += line.length;
    }
    return result;
  }
  window.NoteAnnotations = Object.freeze({palette,highlight,annotate,comments});
})();
