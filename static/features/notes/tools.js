/* Annotation UI uses shared modal lifecycle, Tool dispatch, and the public text session. */
'use strict';
(() => {
  const {registry,Tool,icons} = window.EditorTools, model = window.NoteAnnotations;
  icons.register('notePalette','M12 3a9 9 0 1 0 0 18h2a2 2 0 0 0 0-4h-1a2 2 0 0 1 0-4h4a4 4 0 0 0 4-4c0-4-5-6-9-6 M7 8h.01 M11 6h.01 M16 7h.01 M6 12h.01');
  icons.register('noteComment','M4 4h16v12H9l-5 4z M8 8h8 M8 12h5');
  icons.register('notePdfSource','M6 3h8l4 4v14H6z M14 3v5h4 M9 12h6 M9 16h6');
  /** Open a host-owned modal and retain it through the note view lifecycle.
   * @pre Shared panes and active view exist. @post Navigation cannot leave stale dialogs.
   * @throws {Error} Modal initialization failure reaches Tool dispatcher.
   */
  function open(context, spec) { const dialog = window.EditorPanes.open(spec.dialog, spec); context.writingView.trackDialog(dialog); return dialog; }
  /** Build a comment form bound to the current session and optional verified range.
   * @pre Selected text or existing annotation. @post Submission is one undoable edit.
   * @throws {Error} Empty selection or stale annotation. Related: comments list.
   */
  function commentForm(context, entry) {
    const {session} = context, selection = entry?.text || session.getSelection();
    if (!selection.trim()) throw new Error('Select text before adding a comment');
    const spec = window.EditorPanes.form({title:entry ? 'Edit comment' : 'Add comment',
      fields:[{name:'comment',label:'Comment',type:'textarea',value:entry?.comment || '',required:true}],submitLabel:entry ? 'Save comment' : 'Add comment',
      onSubmit:({comment}) => {
        const replacement = model.annotate(selection,comment);
        if (entry) session.replaceTextRange(entry.start,entry.end,replacement,entry.raw);
        else { if (session.getSelection() !== selection) throw new Error('Selection changed. Select text again.'); session.replaceSelection(replacement); }
        context.run(() => {});
      }});
    return open(context,spec);
  }
  registry.contribute('notes.tools', {
    id:'notes.highlight',label:'Highlight',icon:'noteHighlight',shortcut:'Ctrl/Cmd+Shift+H',
    /** Highlight selected text with the retained color, or remove an existing highlight.
     * @pre Active text session. @post One undoable plain-text edit.
     * @throws {Error} Session failure reaches host dispatcher.
     */
    execute:({session,writingView}) => {
      writingView?.selectHighlight();
      const text = session.getSelection() || 'text';
      const highlighted = text.split(/(\r\n|\n)/).filter(line => line && !/^\r?\n$/.test(line)).every(line => /^==(?:\{#[a-f\d]{6}\})?.*==$/i.test(line));
      session.replaceSelection(highlighted ? text.replace(/^==(?:\{#[a-f\d]{6}\})?(.*?)==$/gim,'$1') : model.highlight(text,writingView?.highlightColor || model.palette[0].color));
    },
  });
  registry.contribute('notes.tools', {
    id:'notes.highlightColor',label:'Highlight color',icon:'notePalette',info:'Pastel highlights and custom colors',
    /** Choose a pastel or any RGB color and apply it to selected text.
     * @pre Active note. @post Chosen color is retained and persisted with the highlight.
     * @throws {Error} Form or session failure reaches host dispatcher.
     */
    execute:context => {
      const {session,writingView} = context; writingView.selectHighlight();
      const selection = session.getSelection();
      const current = selection.match(/^==\{(#[a-f\d]{6})\}/i)?.[1] || writingView.highlightColor;
      const spec = window.EditorPanes.form({title:'Highlight color',description:'Choose a pastel default or use the color picker for any color.',
        fields:[{name:'color',label:'Custom color',type:'color',value:current}],submitLabel:selection ? 'Apply highlight' : 'Set highlight color',
        onSubmit:({color}) => {
          if (selection && session.getSelection() !== selection) throw new Error('Selection changed. Select text again.');
          if (selection) session.replaceSelection(model.highlight(selection,color));
          writingView.highlightColor = color; context.run(() => {});
        }});
      const swatches = document.createElement('div'); swatches.className = 'note-color-swatches'; swatches.setAttribute('role','group'); swatches.setAttribute('aria-label','Default pastel colors');
      const input = spec.dialog.querySelector('input[name="color"]');
      for (const {label,color} of model.palette) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'note-color-swatch'; button.style.backgroundColor = color;
        button.innerHTML = icons.markup('noteHighlight');
        button.dataset.color = color;
        Tool.bind(button,{id:'notes.color.'+label.toLowerCase(),label:label+' highlight',info:label+' '+color,icon:'noteHighlight',
          execute:() => { input.value = color; for (const node of swatches.children) node.setAttribute('aria-pressed',String(node === button)); }});
        button.setAttribute('aria-pressed',String(color === current)); swatches.append(button);
      }
      input.addEventListener('input', () => { for (const node of swatches.children) node.setAttribute('aria-pressed',String(node.dataset.color === input.value)); });
      input.parentElement.before(swatches); open(context,spec);
    },
  });
  registry.contribute('notes.tools', {id:'notes.comment',label:'Add comment',icon:'noteComment',shortcut:'Ctrl/Cmd+Alt+M',
    enabled:({session}) => !!session?.getSelection().trim(),
    /** Annotate selected text. @pre Nonempty selection. @post Opens comment form.
     * @throws {Error} Form failure reaches host dispatcher.
     */
    execute:context => commentForm(context),
  });
  registry.contribute('notes.tools', {id:'notes.comments',label:'View comments',icon:'noteComment',
    /** Review, edit or remove persisted comments. @pre Active note session.
     * @post Comment text uses safe DOM nodes; edits use verified source ranges.
     * @throws {Error} Modal/session failure reaches host dispatcher.
     */
    execute:context => {
      const dialog = document.createElement('dialog'), heading = document.createElement('h2'); heading.textContent = 'Comments'; dialog.append(heading);
      const entries = model.comments(context.session.getText());
      if (!entries.length) { const empty = document.createElement('p'); empty.textContent = 'No comments. Select text and use Add comment.'; dialog.append(empty); }
      for (const entry of entries) {
        const card = document.createElement('article'); card.className = 'note-comment-card';
        const quote = document.createElement('blockquote'), body = document.createElement('p'); quote.textContent = entry.text;
        window.NoteSources.renderComment(body,entry.comment,{...context,dismiss:() => dialog.close()},entry.text); card.append(quote,body);
        for (const [label,execute] of [
          ['Edit comment',() => { dialog.close(); commentForm(context,entry); }],
          ['Remove comment',() => { context.session.replaceTextRange(entry.start,entry.end,entry.text,entry.raw); dialog.close(); context.run(() => {}); }],
        ]) { const button = document.createElement('button'); button.type = 'button'; button.textContent = label; Tool.bind(button,{id:'notes.comment.'+label,label,showText:true,execute},context); card.append(button); }
        dialog.append(card);
      }
      const close = document.createElement('button'); close.type = 'button'; close.textContent = 'Close';
      Tool.bind(close,{id:'notes.comments.close',label:'Close comments',showText:true,execute:() => dialog.close()}); dialog.append(close);
      open(context,{dialog,focus:close,disposable:true});
    },
  });
  registry.contribute('notes.tools', {id:'notes.pdfSource',label:'Link quote to PDF page',icon:'notePdfSource',
    enabled:context => !!context.listProjectSources && !!context.session?.getSelection().trim(),
    /** Attach a verified source page, optionally inside a comment, to the selected quote.
     * @pre Selected quote and project PDF capabilities. @post One undoable text edit.
     * @throws {Error} Missing source, ambiguous search or changed selection; note stays intact.
     */
    execute:async context => {
      const {session,writingView} = context, selection = session.getSelection();
      const sources = (await context.listProjectSources()).filter(source => source.pdf);
      if (writingView.disposed) return;
      const spec = window.EditorPanes.form({title:'Link quote to PDF page',
        description:'Choose the book or document. Enter a PDF page number, or leave it blank to find the selected quote. Page numbers count from the first PDF page, including cover pages.',
        fields:[{name:'source',label:'Source PDF',options:sources.map((source,index) => ({value:String(index),label:source.label}))},
          {name:'page',label:'PDF page (blank: find quote)',type:'number'},
          {name:'color',label:'Quote underline and PDF highlight color',type:'color',value:writingView.highlightColor || '#89b4fa'},
          {name:'kind',label:'Source relationship',options:[{value:'quote',label:'Quotation / transcription'},{value:'context',label:'Paraphrase / related context (no quote highlight)'}]},
          {name:'match',label:'Exact PDF passage (optional for paraphrases or transcription differences)',type:'textarea'},
          {name:'comment',label:'Comment (optional; stores the source link in this comment)',type:'textarea'}],submitLabel:'Add source link',
        onSubmit:async ({source,page,comment,color = '#89b4fa',match = '',kind = 'quote'}) => {
          const base = await sources[Number(source)].resolvePdf();
          const ensureActive = () => { if (writingView.disposed || session.getSelection() !== selection) throw new Error('Selection changed. Select the quote again.'); };
          ensureActive();
          let pages;
          if (page.trim()) {
            if (!/^[1-9]\d*$/.test(page) || !Number.isSafeInteger(Number(page))) throw new Error('Enter a positive PDF page number.');
            pages = await window.NoteSources.locate(base,selection,Number(page));
          } else pages = await window.NoteSources.locate(base,match.trim() || window.NoteSources.plain(selection));
          ensureActive();
          if (!pages.length) throw new Error('Quote not found. Check the wording or enter a PDF page number. Scanned PDFs need searchable text.');
          /** Persist the reviewed location. @pre Same active selection and valid page.
           * @post Link and optional comment share native undo. @throws {Error} Stale selection.
           */
          const apply = selectedPage => {
            ensureActive();
            const link = '[' + (kind==='context'?'Context':'Source') + ' p. ' + selectedPage + '](' + window.NoteSources.location(base + '/original#page=' + selectedPage,color,match.trim(),kind) + ')';
            session.replaceSelection(comment.trim() ? model.annotate(selection,comment.trim() + '\n' + link) : selection + ' ' + link);
            context.run(() => {});
          };
          if (pages.length === 1) apply(pages[0]);
          else throw new Error('Quote found on PDF pages ' + pages.join(', ') + '. Enter the intended page number.');
        }});
      open(context,spec);
    },
  });
  registry.contribute('notes.tools',{id:'notes.sourceColor',label:'Quote underline color',icon:'notePalette',
    enabled:context => !!context.writingView?.sourceAtCursor?.(),
    /** Recolor the current linked quote and its PDF mark as one native text edit.
     * @pre Cursor/selection on a linked quote. @post Saved source color drives both views.
     * @throws {Error} Stale text; no original PDF or review annotation is overwritten.
     */
    execute:context => {
      const current = context.writingView.sourceAtCursor(), snapshot = context.session.getText();
      if (!current) throw new Error('Place the cursor on a linked quote.');
      open(context,window.EditorPanes.form({title:'Quote underline color',
        fields:[{name:'color',label:'Underline and PDF highlight color',type:'color',value:current.color}],submitLabel:'Apply color',
        onSubmit:({color}) => {
          if (context.writingView.disposed || context.session.getText() !== snapshot) throw new Error('The note changed. Reopen the color picker.');
          context.session.transformLines(line=>window.NoteSources.recolorLine(line,color)); context.run(()=>{});
        }}));
    },
  });
})();
