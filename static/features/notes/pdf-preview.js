/* Note-owned quote overlays reuse the PDF viewer; saved review annotations remain separate. */
'use strict';
(() => {
  /** Map one unique normalized passage to scale-one PDF rectangles.
   * @pre PDF.js text content and viewport at scale 1; nonempty quote.
   * @post Only the matched glyph ranges receive geometry; no approximate text matches.
   * @throws {void} Missing/ambiguous/unsupported geometry returns an empty array.
   */
  function rectangles(content, viewport, quote, measure) {
    const normalize = window.NoteSources.normalize, mapping = []; let haystack = '';
    content.items.forEach((item,index) => {
      let at = 0;
      for (const character of item.str || '') {
        const normalized = normalize(character);
        for (const letter of normalized) { haystack += letter; mapping.push({index,start:at,end:at + character.length}); }
        at += character.length;
      }
    });
    const needle = normalize(quote), found = needle.length >= 12 ? haystack.indexOf(needle) : -1;
    if (found < 0 || haystack.indexOf(needle,found + 1) >= 0) return [];
    const parts = new Map();
    for (const part of mapping.slice(found,found + needle.length)) {
      const previous = parts.get(part.index);
      parts.set(part.index,{start:previous?.start ?? part.start,end:part.end});
    }
    const [a,b,c,d,e,f] = viewport.transform, result = [];
    for (const [index,part] of parts) {
      const item = content.items[index], transform = item.transform;
      if (!transform || !item.width || !item.str) return [];
      const [g,h,i,j,k,l] = transform, x = a*k+c*l+e, y = b*k+d*l+f;
      const angle = Math.atan2(b*g+d*h,a*g+c*h), height = Math.hypot(a*i+c*j,b*i+d*j);
      const width = item.width, style = content.styles?.[item.fontName] || {}, ascent = (style.ascent ?? .85) * height;
      const total = measure?.(item.str,height,style.fontFamily) || item.str.length;
      const fraction = offset => (measure?.(item.str.slice(0,offset),height,style.fontFamily) ?? offset) / total;
      const start = item.dir === 'rtl' ? 1 - fraction(part.end) : fraction(part.start);
      const end = item.dir === 'rtl' ? 1 - fraction(part.start) : fraction(part.end);
      const cos = Math.cos(angle), sin = Math.sin(angle), points = [];
      for (const horizontal of [width*start,width*end]) for (const vertical of [-ascent,height-ascent]) points.push([x+cos*horizontal-sin*vertical,y+sin*horizontal+cos*vertical]);
      const xs = points.map(point=>point[0]), ys = points.map(point=>point[1]);
      const rect = {x:Math.min(...xs),y:Math.min(...ys),w:Math.max(...xs)-Math.min(...xs),h:Math.max(...ys)-Math.min(...ys)};
      if (!Object.values(rect).every(Number.isFinite) || rect.w <= 0 || rect.h <= 0) return [];
      result.push(rect);
    }
    return result;
  }
  /** Create a lifecycle-owned side preview with saved note colors and quote marks.
   * @pre Text host supplies an active session, PDF colors and side-preview mounting.
   * @post PDF switches reuse the pane; stale loads cannot navigate or publish overlays.
   * @throws {Error} Loading failures reach show(); background failures appear in the pane.
   */
  function create(context) {
    const element = document.createElement('section'), status = document.createElement('p'), pdfSlot = document.createElement('div');
    element.className = 'note-pdf-preview'; status.className = 'note-pdf-status'; status.setAttribute('role','status');
    pdfSlot.className = 'note-pdf-viewer'; element.append(status,pdfSlot);
    let viewer = null, base = null, closed = false, generation = 0, text = '', loading = Promise.resolve(), painting = Promise.resolve(), lastPaint = '', originalMarks = [], request;
    const reviewWrites = new WeakSet();
    const canvas = document.createElement('canvas'), measurement = canvas.getContext('2d'), pageCache = new Map(), quoteLines = new WeakMap();
    /** Route an overlay's color edit back to the exact source line in the note.
     * @pre Live overlay and unchanged note snapshot. @post One undoable note edit.
     * @throws {Error} Stale marks must be reopened after the note changes.
     */
    function markRecolor(mark, revision) {
      const line = quoteLines.get(mark);
      if (!line || !window.NoteAnnotations) return null;
      return {caption:' · Note source',colors:window.NoteAnnotations.palette.map(({label,color}) => ({id:color,label,hex:color})),
        apply:async color => {
          const current = context.session.getText();
          if (closed || revision !== generation || current !== line.snapshot) throw new Error('The source changed. Reopen the PDF highlight to change its color.');
          const end = current.indexOf('\n',line.start);
          const oldLine = current.slice(line.start,end < 0 ? undefined : end).replace(/\r$/,'');
          const newLine = window.NoteSources.recolorLine(oldLine,color);
          context.session.replaceTextRange(line.start,line.start + oldLine.length,newLine,oldLine);
          text = lastPaint = line.snapshot = context.session.getText();
          await queuePaint();
        }};
    }
    /** Measure PDF glyph proportions using the loaded font family.
     * @pre PDF font metrics. @post No DOM changes. @throws {void} None.
     */
    const measure = (value,height,family) => { if (!measurement) return value.length; measurement.font = height + 'px ' + (family || 'sans-serif'); return measurement.measureText(value).width; };
    /** Paint all linked quotes in the current source, preserving existing reviews.
     * @pre Source PDF loaded. @post Unmatched text gets a visible warning, never a guessed mark.
     * @throws {Error} Extraction failure reaches show or the status boundary.
     */
    async function paint() {
      const active = viewer, revision = generation, snapshot = text;
      if (!active?.doc || closed) return;
      const refs = window.NoteSources.references(snapshot).filter(ref=>ref.base === base);
      const overlays = [], missing = [], seen = new Set(), groups = new Map(), marked = new Set();
      for (const ref of refs) {
        const group = ref.line + ':' + window.NoteSources.normalize(ref.quote);
        if (!groups.has(group)) groups.set(group,[]);
        groups.get(group).push(ref);
      }
      for (const ref of refs) {
        if (ref.kind === 'context') continue;
        const group = ref.line + ':' + window.NoteSources.normalize(ref.quote);
        const passage = ref.match || ref.quote, key = group + ':' + ref.page + ':' + window.NoteSources.normalize(passage);
        if (seen.has(key)) continue; seen.add(key);
        const page = active.pages[ref.page-1];
        if (!page) { missing.push(ref.page); continue; }
        if (!pageCache.has(ref.page)) pageCache.set(ref.page,page.page.getTextContent());
        const content = await pageCache.get(ref.page);
        if (closed || active !== viewer || revision !== generation || snapshot !== text) return;
        const rects = rectangles(content,page.base,passage,measure).map(rect=>({p:ref.page,...rect}));
        if (!rects.length) { missing.push(ref.page); continue; }
        marked.add(group);
        const overlay = {id:'note-source-'+overlays.length,type:'highlight',page:ref.page,rects,color:ref.color,text:passage,comments:[]};
        quoteLines.set(overlay,{start:ref.start - ref.from,snapshot});
        overlays.push(overlay);
      }
      if (closed || active !== viewer || revision !== generation || snapshot !== text) return;
      active.setMarks([...originalMarks,...overlays]);
      const contextOnly = [...groups.values()].filter(refs=>refs.every(ref=>ref.kind==='context')).length;
      const counts = marked.size + ' of ' + groups.size + ' quote' + (groups.size===1?'':'s') + ' marked'
        + (contextOnly ? ' · ' + contextOnly + ' context-only (not verbatim)' : '')
        + (missing.length ? ' · No unique text match on PDF page(s) ' + [...new Set(missing)].join(', ') + '.' : '');
      status.textContent = [request?.name, groups.size || !request?.name ? counts : ''].filter(Boolean).join(' · ');
    }
    /** Queue one paint for the latest note snapshot after loading.
     * @pre Live controller. @post Extraction is serialized; stale revisions cannot paint.
     * @throws {void} Background failures are shown without discarding note edits.
     */
    function queuePaint() {
      painting = painting.catch(()=>{}).then(()=>loading).then(paint).catch(error=>{ if (!closed) status.textContent = error.message; });
      return painting;
    }
    /** Supply review colors for an active PDF's saved comment highlight.
     * @pre Saved review and authenticated writer. @post Merges one color change by ID.
     * @throws {Error} Conflicting or stale review edits reach the popup's Tool boundary.
     */
    function reviewRecolor(mark, active, writer, revision) {
      if (!writer || !mark.comments.length || !originalMarks.includes(mark)) return null;
      return {caption:' · PDF review',colors:context.pdfSourceColors.highlight_colors,
        apply:async color => {
          if (closed || revision !== generation) throw new Error('Reopen the PDF highlight to change its color.');
          if (reviewWrites.has(active)) throw new Error('A PDF color change is being saved. Try again once it finishes.');
          const before = active.savedAnn;
          if (!before.highlights.some(item => item.id === mark.id)) throw new Error('The PDF highlight was removed.');
          const highlights = before.highlights.map(item => item.id === mark.id ? {...item,color} : item);
          reviewWrites.add(active);
          try {
            const saved = await writer({...before,highlights,base:before});
            if (closed || revision !== generation) return;
            active.loadAnnotationSnapshot(saved);
            originalMarks = [...active.ann.highlights];
            await queuePaint();
          } finally { reviewWrites.delete(active); }
        }};
    }
    return {id:'note-pdf',label:'Source PDF',viewLabels:{edit:'Notes',split:'Both',preview:'PDF'},element,
      /** Reflect note edits/recoloring without replacing its buffer.
       * @pre Source string. @post Only changed snapshots trigger overlay work.
       * @throws {void} Paint errors are handled by the pane.
       */
      update(value) { text = value; if (value !== lastPaint) { lastPaint = value; queuePaint(); } },
      /** Open a source page and scroll to its first matched quote rectangle.
       * @pre Valid source href. @post Pane is measured before PDF navigation.
       * @throws {Error} PDF loading failure; notes remain intact.
       */
      async show(target) {
        request = target;
        const source = window.NoteSources.parse(target.href);
        if (!source || closed) throw new Error('Choose a valid PDF source.');
        if (base !== source.base) {
          const previous = viewer, previousLoading = loading, revision = ++generation;
          base = source.base; pageCache.clear(); originalMarks = [];
          let reviewWriter;
          const writer = context.pdfReviewWriter?.(base).catch(() => null);
          viewer = new window.PdfAnnotator({pdfUrl:base+'/original',annUrl:base+'/annotations',colors:context.pdfSourceColors,
            readOnly:true,readOnlyLabel:'Quote context',alignBars:false,
            markRecolor:mark => markRecolor(mark,revision) || reviewRecolor(mark,active,reviewWriter,revision)});
          const active = viewer; pdfSlot.replaceChildren(active.root); status.textContent = 'Loading source PDF…';
          Promise.resolve(previousLoading).finally(()=>previous?.destroy()).catch(()=>{});
          loading = active.open().then(async ()=>{
            reviewWriter = await writer;
            if (closed || revision !== generation) return;
            if (!active.doc) throw new Error('Could not open the source PDF.');
            originalMarks = [...active.ann.highlights];
          });
        }
        const active = viewer, revision = generation;
        await loading; text = context.session.getText(); await queuePaint();
        if (closed || active !== viewer || revision !== generation || request !== target) return;
        const mark = active.ann.highlights.find(mark=>mark.id.startsWith('note-source-') && mark.page===source.page && window.NoteSources.normalize(mark.text)===window.NoteSources.normalize(target.reference?.match || source.match || target.reference?.quote || ''));
        if (mark) active.scrollToRect(source.page,mark.rects[0].y,'instant'); else active.goToPage(source.page);
      },
      /** Release viewer/worker after in-flight loading and extraction settle.
       * @pre Controller may be loading. @post No late overlays or navigation survive.
       * @throws {void} Cleanup failures are contained.
       */
      dispose() { closed = true; generation++; element.remove(); Promise.allSettled([loading,painting]).then(()=>viewer?.destroy()).catch(()=>{}); },
    };
  }
  window.NotePdfPreview = Object.freeze({create,rectangles});
})();
