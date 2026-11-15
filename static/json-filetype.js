/* JSON is an independent text provider; validating never rewrites or rounds source values. */
'use strict';
(function () {
  CodeMirror.defineMode('workbench-json', () => ({
    /** Tokenize JSON strings, property names, numbers and literals for the existing editor.
     * @param {StringStream} stream Source stream. @pre Cursor is at the next token.
     * @post Stream advances; original file bytes are unchanged. @return {string|null} Token style.
     * @throws {void} None.
     */
    token(stream) {
      if (stream.eatSpace()) return null;
      if (stream.peek() === '"') {
        stream.next(); let escaped = false, char;
        while ((char = stream.next()) != null) {
          if (char === '"' && !escaped) return stream.match(/^\s*:/, false) ? 'property' : 'string';
          escaped = char === '\\' && !escaped;
        }
        return 'error';
      }
      if (stream.match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/)) return 'number';
      if (stream.match(/^(?:true|false|null)\b/)) return 'atom';
      if (stream.match(/^[{}\[\],:]/)) return null;
      stream.next(); return 'error';
    },
  }));
  window.EditorTools.registry.contribute('json.tools', {
    id: 'json.validate', label: 'Validate JSON', icon: 'code', showText: true,
    /** Validate the current buffer through its public session capability.
     * @param {object} context Active session and status callback.
     * @pre JSON buffer is active. @post Text, numeric spellings, duplicate keys and history are untouched.
     * @return {void} Nothing. @throws {SyntaxError} Invalid JSON; the shared Tool boundary reports it.
     */
    execute: ({ session, message }) => { JSON.parse(session.getText()); message('Valid JSON.'); },
  });
})();
