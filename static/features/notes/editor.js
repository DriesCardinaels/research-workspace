/* Editable note typography over the original CodeMirror document. No HTML serialization. */
'use strict';
(() => {
  // Use the bundled Markdown lexer for nested emphasis; keep note extensions local.
  const inlineParser = new window.marked.Marked();
  inlineParser.use({extensions:[{
    name:'noteHighlight', level:'inline',
    /** Locate a possible highlight. @pre Plain inline source. @post No mutation.
     * @returns {number} Candidate offset. @throws {void} None.
     */
    start(source) { return source.indexOf('=='); },
    /** Tokenize a highlight and recursively parse its formatted contents.
     * @pre Lexer calls at a candidate delimiter. @post Global Markdown parser unchanged.
     * @returns {object|undefined} Local extension token. @throws {Error} Lexer failure.
     */
    tokenizer(source) {
      const match = source.match(/^==(\{(#[a-fA-F0-9]{6})\})?(?=\S)(.+?)(?<!\\)==/);
      if (match) return {type:'noteHighlight',raw:match[0],color:match[2],opening:2 + (match[1]?.length || 0),tokens:this.lexer.inlineTokens(match[3])};
    },
  }]});
  /** Map nested lexer tokens to overlapping native styles and hidden delimiter ranges.
   * @pre Tokens retain raw source and offsets; code/comments are masked by describeLine.
   * @post Every recognized nested delimiter is recorded without changing the buffer.
   * @throws {void} None. Related: NoteView decorations.
   */
  function describeTokens(tokens, offset, ranges, markers) {
    for (const token of tokens) {
      const end = offset + token.raw.length;
      const style = {strong:'bold',em:'italic',del:'strike',noteHighlight:'highlight'}[token.type];
      const source = token.type === 'link' && (window.NoteSources?.parse(token.href) || window.NoteSources?.parseProjectFile(token.href));
      if (source) ranges.push({from:offset,to:end,className:'note-source',href:token.href,label:token.text});
      else if (style) {
        const opening = token.type === 'noteHighlight' ? token.opening : token.type === 'em' ? 1 : 2;
        const closing = token.type === 'em' ? 1 : 2;
        ranges.push({from:offset,to:end,className:'note-' + style,color:token.color});
        markers.push([offset,offset + opening],[end - closing,end]);
        describeTokens(token.tokens || [],offset + opening,ranges,markers);
      }
      offset = end;
    }
  }
  /** Toggle one emphasis layer while preserving any other enclosing styles.
   * @pre Plain selected Markdown and a supported delimiter.
   * @post Returns source for one native edit; bold markers never count as italic.
   * @throws {Error} Lexer failure. Related: inline note Tools.
   */
  function toggleFormat(text, delimiter) {
    const target = {'**':'strong','*':'em','~~':'del','`':'codespan'}[delimiter];
    if (target) {
      let tokens = window.marked.Lexer.lexInline(text,inlineParser.defaults), offset = 0;
      while (tokens.length === 1) {
        const token = tokens[0];
        if (token.type === target) {
          const width = target === 'codespan' ? token.raw.match(/^`+/)[0].length : delimiter.length;
          const end = offset + token.raw.length;
          return text.slice(0,offset) + text.slice(offset + width,end - width) + text.slice(end);
        }
        if (!['em','strong','del','noteHighlight'].includes(token.type)) break;
        offset += token.type === 'em' ? 1 : token.type === 'noteHighlight' ? token.opening : 2;
        tokens = token.tokens || [];
      }
    }
    const end = delimiter === '“' ? '”' : delimiter;
    if (delimiter === '“' && text.startsWith(delimiter) && text.endsWith(end) && text.length >= 2) return text.slice(1,-1);
    return delimiter + (text || 'text') + end;
  }
  /** Describe supported Markdown without changing the source.
   * @pre Text is one document line; fenced code is handled by the caller.
   * @post Returns style ranges only. @returns {object} Block class and inline ranges.
   * @throws {void} None. Used by NoteView and regression tests.
   */
  function describeLine(text) {
    const ranges = [], markers = [];
    const block = text.match(/^( {0,3})(#{1,6})\s+/) || text.match(/^\s*(>+)\s?/) || text.match(/^\s*(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/);
    let className = '';
    if (block) {
      className = /^ {0,3}#/.test(block[0]) ? 'note-h' + block[2].length : /^\s*>/.test(block[0]) ? 'note-quote' : 'note-list';
      // Keep bullet and task markers visible and directly editable.
      if (className !== 'note-list') markers.push([0, block[0].length]);
    }
    // Mask metadata and code before parsing emphasis, keeping original UTF-16 offsets.
    let visible = text;
    const literalCode = [...text.matchAll(/(`+)([^`]*?)\1/g)];
    for (const match of text.matchAll(/<!--note-comment:([^>]*?)-->(.*?)<!--\/note-comment-->/g)) {
      if (literalCode.some(code => match.index >= code.index && match.index < code.index + code[0].length)) continue;
      let comment; try { comment = decodeURIComponent(match[1]); } catch { continue; }
      const from = match.index, content = from + match[0].indexOf('-->') + 3, to = content + match[2].length;
      markers.push([from, content], [to, from + match[0].length]);
      ranges.push({from:content,to,className:'note-comment',title:comment});
      visible = visible.slice(0, from) + '\uE000'.repeat(content - from) + visible.slice(content, to) + '\uE000'.repeat(from + match[0].length - to) + visible.slice(from + match[0].length);
    }
    for (const match of visible.matchAll(/(`+)([^`]*?)\1/g)) {
      const start = match.index, end = start + match[0].length;
      ranges.push({from:start,to:end,className:'note-code'});
      markers.push([start,start + match[1].length],[end - match[1].length,end]);
      visible = visible.slice(0,start) + '\uE000'.repeat(end-start) + visible.slice(end);
    }
    describeTokens(window.marked.Lexer.lexInline(visible,inlineParser.defaults),0,ranges,markers);
    for (const source of window.NoteSources?.references(text) || []) {
      if (source.to > source.from) ranges.push({from:source.from,to:source.to,className:'note-source-quote',underlineColor:source.color});
    }
    return { className, ranges, markers };
  }
  class NoteView {
    highlightColor = '#f9e2af';
    disposed = false;
    #context;
    #mounted = false;
    #editor; #marks = []; #lines = []; #rendering = false; #mode; #render; #renderLine; #enter; #oldKeys; #dialogs = new Set();
    /** Attach a reversible presentation to the host-owned editor.
     * @pre Editor displays the selected TextSession. @post Text/history remain intact.
     * @throws {Error} Native editor failure. Related: TextEditorViews registry.
     */
    constructor(editor, mode = 'note', context = {}) {
      this.#context = {...context,writingView:this};
      this.#editor = editor; this.#mode = mode;
      this.#oldKeys = editor.getOption('extraKeys');
      this.#render = () => this.#paint();
      this.#renderLine = (_editor, line, element) => this.#indentList(line, element);
      this.#enter = cm => {
        if (this.#mode !== 'note' || cm.somethingSelected() || cm.listSelections().length !== 1) return CodeMirror.Pass;
        const cursor = cm.getCursor(), line = cm.getLine(cursor.line);
        const match = line.match(/^(\s*)(?:(>\s?)|([-+*])\s+(\[[ xX]\]\s+)?|(\d+)([.)])\s+)(.*)$/);
        if (!match || cursor.ch !== line.length) return CodeMirror.Pass;
        if (!match[7].trim()) { cm.replaceRange('', {line:cursor.line,ch:0}, cursor, '+input'); return; }
        const prefix = match[2] || (match[3] ? match[3] + ' ' + (match[4] ? '[ ] ' : '') : (Number(match[5]) + 1) + match[6] + ' ');
        cm.replaceSelection((cm.getDoc().lineSeparator() || '\n') + match[1] + prefix, 'end', '+input');
      };
      editor.setOption('extraKeys', { ...this.#oldKeys, Enter: this.#enter });
      editor.on('change', this.#render);
      editor.on('renderLine', this.#renderLine);
      this.setMode(mode);
    }
    /** Read current presentation. @pre Attached. @post No mutation.
     * @returns {string} note or source. @throws {void} None.
     */
    get mode() { return this.#mode; }
    /** Restore the first linked PDF after the note is attached and measurable.
     * @pre Host has mounted the editor. @post Linked notes default to the shared split view.
     * @throws {void} Source failures are reported through the host without losing the note.
     */
    async mount() {
      if (this.#mounted || this.disposed || !this.#context.pdfSourceColors) return;
      this.#mounted = true;
      const source = window.NoteSources.references(this.#editor.getDoc().getValue())[0];
      if (source) await this.#context.run(()=>window.NoteSources.preview(source.href,this.#context,source));
    }
    /** Read the source reference on the cursor line for recoloring.
     * @pre Attached note. @post No selection or text changes.
     * @throws {void} None; returns undefined without a linked quote.
     */
    sourceAtCursor() { return window.NoteSources.references(this.#editor.getDoc().getValue()).find(ref=>ref.line===this.#editor.getDoc().getCursor().line); }
    /** Capture where the file picker will insert links.
     * @pre Attached note. @post Returns a command tied to this buffer and selection.
     * @throws {Error} The command rejects a changed or inactive note. Related: notes.fileSource.
     */
    captureFileLinkInsertion() {
      const doc = this.#editor.getDoc(), at = doc.getCursor('to'), snapshot = doc.getValue();
      return link => {
        const current = doc.getCursor('to');
        if (this.disposed || doc.getValue() !== snapshot || at.line !== current.line || at.ch !== current.ch) {
          throw new Error('The note changed. Reopen Add project file.');
        }
        const line = doc.getLine(at.line);
        const before = at.ch && !/\s/.test(line[at.ch - 1]) ? ' ' : '';
        const after = at.ch < line.length && !/\s/.test(line[at.ch]) ? ' ' : '';
        doc.replaceRange(before + link + after,at,at,'note-file-link');
        doc.setCursor({line:at.line,ch:at.ch + before.length + link.length + after.length});
      };
    }
    /** Align wrapped list text after the complete visible marker and indentation.
     * @pre CodeMirror has built a measured text line with its note-list class.
     * @post Only native line styles change; source, selection and history are preserved.
     * @throws {Error} DOM measurement failure. Related: renderLine and text-line measurement.
     */
    #indentList(line, element) {
      // renderLine fires before CodeMirror copies textClass onto the new element.
      const textClass = this.#editor.lineInfo?.(line)?.textClass || '';
      if (this.#mode !== 'note' || !(element.classList.contains('note-list') || textClass.split(/\s+/).includes('note-list'))) return;
      const prefix = line.text.match(/^\s*(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/)?.[0];
      if (!prefix) return;
      const measure = document.createElement('span'); measure.className = 'note-list-measure'; measure.setAttribute('aria-hidden','true');
      const tabSize = this.#editor.getOption('tabSize') || 4; let column = 0;
      measure.textContent = [...prefix].map(character => {
        const width = character === '\t' ? tabSize - column % tabSize : 1;
        column += width; return character === '\t' ? ' '.repeat(width) : character;
      }).join('');
      this.#editor.getWrapperElement().append(measure);
      let width;
      try { width = measure.getBoundingClientRect().width; } finally { measure.remove(); }
      // A first-line negative indent leaves the marker at 4px; all text starts after it.
      element.style.paddingLeft = (4 + width) + 'px';
      element.style.textIndent = -width + 'px';
    }
    /** Own a note dialog until dismissal or file navigation.
     * @pre Open dialog. @post File disposal closes outstanding annotation UI.
     * @throws {Error} DOM failure. Related: notes/tools.js.
     */
    trackDialog(dialog) { this.#dialogs.add(dialog); dialog.addEventListener('close', () => this.#dialogs.delete(dialog), {once:true}); }
    /** Include existing highlight metadata when recoloring selected highlighted text.
     * @pre Attached note; single selection. @post Complete enclosing highlight selected.
     * @throws {Error} Native selection failure. Related: highlight/color Tools.
     */
    selectHighlight() {
      const doc = this.#editor.getDoc();
      if (!doc.somethingSelected() || doc.listSelections().length !== 1) return;
      const from = doc.getCursor('from'), to = doc.getCursor('to');
      if (from.line !== to.line) return;
      for (const match of doc.getLine(from.line).matchAll(/==(?:\{#[a-f\d]{6}\})?.*?==/gi)) {
        if (from.ch >= match.index && to.ch <= match.index + match[0].length) {
          doc.setSelection({line:from.line,ch:match.index},{line:from.line,ch:match.index + match[0].length}); return;
        }
      }
    }
    /** Toggle formatted writing and literal source without replacing the document.
     * @pre Valid mode. @post Selection, history and dirty state survive.
     * @throws {TypeError} Invalid mode. Related: notes.source Tool.
     */
    setMode(mode) {
      if (!['note', 'source'].includes(mode)) throw new TypeError('Choose note or source');
      this.#mode = mode;
      this.#editor.getWrapperElement().classList.toggle('notes-editor', mode === 'note');
      this.#paint(); this.#editor.refresh();
    }
    /** Remove only owned decorations. @pre Attached. @post Native text is unchanged.
     * @throws {Error} Native editor failure. Used before repaint and disposal.
     */
    #clear() {
      for (const mark of this.#marks) mark.clear(); this.#marks = [];
      for (const [handle, name] of this.#lines) this.#editor.removeLineClass(handle, 'text', name);
      this.#lines = [];
    }
    /** Style Markdown while keeping formatting syntax hidden on every line.
     * @pre Attached. @post Decorations reflect current text; no source edits.
     * @throws {Error} Native editor failure. Fences keep code literal.
     */
    #paint() {
      if (this.#rendering) return;
      this.#rendering = true;
      try { this.#editor.operation(() => {
        this.#clear(); if (this.#mode !== 'note') return;
        const cm = this.#editor; let fence = null;
        for (let line = 0; line < cm.lineCount(); line++) {
          const text = cm.getLine(line), boundary = text.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
          if (boundary && !fence) { fence = boundary[1]; continue; }
          if (fence) { if (boundary && boundary[1][0] === fence[0] && boundary[1].length >= fence.length && !boundary[2].trim()) fence = null; continue; }
          const description = describeLine(text);
          if (description.className) this.#lines.push([cm.addLineClass(line, 'text', description.className), description.className]);
          const sources = window.NoteSources.references(text);
          for (const range of description.ranges) {
            let css;
            if (range.underlineColor) css = 'text-decoration-color:' + range.underlineColor;
            if (range.className === 'note-highlight') {
              css = '--note-highlight-color:' + (range.color || window.NoteAnnotations.palette[0].color);
            }
            this.#marks.push(cm.markText({line,ch:range.from}, {line,ch:range.to}, {
              replacedWith:range.href ? window.NoteSources.anchor(range.href,range.label,this.#context,sources.find(ref=>ref.href===range.href)) : undefined,
              className:range.className, title:range.title, css,
            }));
          }
          for (const [from, to] of description.markers) this.#marks.push(cm.markText({line,ch:from}, {line,ch:to}, {className:'note-marker', collapsed:true, atomic:true, inclusiveLeft:false, inclusiveRight:false}));
        }
      }); } finally { this.#rendering = false; }
    }
    /** Detach before the host swaps documents. @pre Attached once.
     * @post No marks, event handlers or editor options leak to another file.
     * @throws {Error} Native editor failure. Related: TextWorkspace.destroy/openFile.
     */
    dispose() {
      this.disposed = true;
      for (const dialog of this.#dialogs) { dialog.close(); dialog.remove(); } this.#dialogs.clear();
      this.#editor.off('change', this.#render); this.#editor.off('cursorActivity', this.#render);
      this.#editor.off('renderLine', this.#renderLine);
      this.#clear(); this.#editor.setOption('extraKeys', this.#oldKeys);
      this.#editor.getWrapperElement().classList.remove('notes-editor');
    }
  }
  window.NoteEditor = Object.freeze({ describeLine, toggleFormat });
  window.TextEditorViews.register('text', (editor, mode, context) => new NoteView(editor, mode, context));
  const {registry, icons} = window.EditorTools;
  icons.register('noteHighlight', 'M4 20h16 M6 14l8-10 6 5-8 10H6z M6 14l6 5');
  const inlineTools = [
    ['bold','Bold','bold','**','Ctrl/Cmd+B'], ['italic','Italic','italic','*','Ctrl/Cmd+I'],
    ['strike','Strikethrough','strike','~~'],
    ['code','Inline code','code','`'], ['quotation','Quotation marks','quote','“'],
  ];
  for (const [id,label,icon,delimiter,shortcut] of inlineTools) registry.contribute('notes.tools', {
    id:'notes.'+id,label,icon,shortcut,info:label+' — format selected text',
    /** Wrap or unwrap selected plain text as one native undo step.
     * @pre Active text session. @post Markdown is stored literally; CRLF survives.
     * @throws {Error} Session failure reaches host dispatcher.
     */
    execute:({session}) => {
      session.replaceSelection(toggleFormat(session.getSelection(),delimiter));
    },
  });
  registry.contributeGroup('notes.tools', {id:'notes.headings',label:'Headings',icon:'mdHeading'});
  registry.contributeGroup('notes.tools', {id:'notes.lists',label:'Lists',icon:'mdBulletList'});
  for (const [id,label,icon,prefix,group] of [
    ['title','Title','mdHeading1','# ','notes.headings'], ['heading','Heading','mdHeading2','## ','notes.headings'],
    ['subheading','Subheading','mdHeading3','### ','notes.headings'], ['bullet','Bulleted list','mdBulletList','- ','notes.lists'],
    ['number','Numbered list','mdNumberedList','1. ','notes.lists'], ['task','Checklist','mdTaskList','- [ ] ','notes.lists'],
    ['quote','Block quote','blockQuote','> ',null],
  ]) registry.contribute('notes.tools', {
    id:'notes.'+id,label,icon,showText:!!group,
    /** Toggle block syntax on whole selected lines in a single native edit.
     * @pre Active text session. @post Newline style and undo history survive.
     * @throws {Error} Session failure reaches host dispatcher.
     */
    execute:({session}) => {
      let index = 0;
      session.transformLines(line => {
        const current = id === 'number' ? (++index) + '. ' : prefix;
        if (line.startsWith(current)) return line.slice(current.length);
        return current + line.replace(/^\s*(?:#{1,6}\s+|>\s?|[-+*]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, '');
      });
    },
  }, {group});
  registry.contribute('notes.tools', {
    id:'notes.source',label:'Raw Markdown',info:'Toggle raw Markdown source',icon:'code',
    state:({writingView}) => ({pressed:writingView?.mode === 'source'}),
    /** Toggle the editable presentation. @pre View attached by host.
     * @post Source and history unchanged. @throws {Error} View failure reaches host.
     */
    execute:({writingView}) => writingView.setMode(writingView.mode === 'source' ? 'note' : 'source'),
  });
})();
