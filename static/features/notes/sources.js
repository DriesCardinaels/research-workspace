/* PDF source links are ordinary Markdown; only validated local PDF routes are opened. */
'use strict';
(() => {
  const projectFilePrefix = '#project-file?';

  /** Decode a project-local file target. @pre Untrusted Markdown link.
   * @post No IO; the app resolves the target against its authorized project tree.
   * @throws {void} Invalid targets return null. Related: projectFileLink.
   */
  function parseProjectFile(href) {
    if (typeof href !== 'string' || !href.startsWith(projectFilePrefix)) return null;
    const params = new URLSearchParams(href.slice(projectFilePrefix.length));
    const path = params.get('path'), sourceDocument = params.get('source_document'), document = params.get('document');
    if (params.size === 1 && /^[a-f\d]{32}$/.test(document || '')) return {document};
    if (params.size !== (params.has('source_document') ? 2 : 1) || !path ||
        path.split('/').some(part => !part || part.startsWith('.')) ||
        (params.has('source_document') && !/^[a-f\d]{32}$/.test(sourceDocument))) return null;
    return {path,sourceDocument};
  }

  /** Serialize a tree file as Markdown. @pre Exact address and visible file name.
   * @post The link contains a project-relative target. @throws {TypeError} Invalid address.
   */
  function projectFileLink({path,sourceDocument,document}, label) {
    const params = new URLSearchParams(document ? {document} : {path});
    if (sourceDocument) params.set('source_document',sourceDocument);
    const href = projectFilePrefix + params.toString();
    if (!parseProjectFile(href)) throw new TypeError('Choose a valid project file.');
    return '[' + label.replace(/[\r\n]/g,' ').replace(/[\\[\]]/g,'\\$&') + '](' + href + ')';
  }

  /** Decode a local PDF location. @pre Untrusted Markdown destination.
   * @post No navigation or mutation. @throws {void} Invalid destinations return null.
   */
  function parse(href) {
    if (typeof href !== 'string') return null;
    const match = href.match(/^(\/api\/projects\/[a-f\d]+\/documents\/[a-f\d]{32})\/original#(.+)$/);
    if (!match) return null;
    const params = new URLSearchParams(match[2]), page = params.get('page'), color = params.get('color');
    if (!/^[1-9]\d*$/.test(page || '') || !Number.isSafeInteger(Number(page)) || (color && !/^[a-f\d]{6}$/i.test(color))) return null;
    if ([...params.keys()].some(key => !['page','color','match','kind'].includes(key) || params.getAll(key).length !== 1)) return null;
    const kind = params.get('kind') || 'quote';
    if (!['quote','context'].includes(kind)) return null;
    return {base:match[1],page:Number(page),color:'#' + (color || '89b4fa').toLowerCase(),match:params.get('match') || '',kind,href};
  }
  /** Serialize durable source color and optional verbatim PDF passage.
   * @pre Valid source and RGB color. @post Page and unrelated source identity retained.
   * @throws {TypeError} Invalid color/location. Related: UI and API source actions.
   */
  function location(href, color, passage, kind) {
    const source = parse(href);
    if (!source || !/^#[a-f\d]{6}$/i.test(color)) throw new TypeError('Choose a valid PDF source and color');
    const params = new URLSearchParams({page:String(source.page),color:color.slice(1).toLowerCase()});
    if (passage ?? source.match) params.set('match',passage ?? source.match);
    const relation = kind ?? source.kind;
    if (!['quote','context'].includes(relation)) throw new TypeError('Choose quote or context source type');
    if (relation === 'context') params.set('kind','context');
    return source.base + '/original#' + params.toString();
  }
  /** Remove note-only syntax for source text matching; never interpret HTML.
   * @pre Stored note fragment. @post Returns plain quote text without annotation metadata.
   * @throws {void} None. Related: references and PDF matching.
   */
  function plain(text) {
    return text.replace(/\[(?:\\.|[^\]\\])*\]\((#project-file\?[^\s)]+)\)/g,(link,href)=>parseProjectFile(href)?'':link)
      .replace(/<!--note-comment:[^>]*-->|<!--\/note-comment-->/g,'').replace(/==\{#[a-f\d]{6}\}/gi,'').replace(/[*_~`=]/g,'').trim();
  }
  /** Collect quote/source associations, including encoded comments, outside code fences.
   * @pre Plain note source. @post UTF-16 ranges retain exact line/source offsets.
   * @throws {void} Malformed comments remain literal. Related: underline and PDF overlays.
   */
  function references(text) {
    const result = []; let offset = 0, fence = null, lineNumber = 0;
    for (const line of text.split(/\n/)) {
      const boundary = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (boundary && !fence) fence = boundary[1];
      else if (fence) { if (boundary && boundary[1][0] === fence[0] && boundary[1].length >= fence.length && !boundary[2].trim()) fence = null; }
      else {
        const code = [...line.matchAll(/(`+)([^`]*?)\1/g)], comments = [...line.matchAll(/<!--note-comment:([^>]*?)-->(.*?)<!--\/note-comment-->/g)];
        const visible = [];
        for (const link of line.matchAll(/\[([^\]\r\n]+)\]\(([^\s)]+)\)/g)) {
          const source = parse(link[2]);
          if (!source || code.some(span => link.index >= span.index && link.index < span.index + span[0].length)) continue;
          const first = visible[0]?.linkFrom ?? link.index, before = line.slice(0,first).trimEnd();
          const reference = {...source,quote:plain(before),line:lineNumber,from:0,to:before.length,start:offset,end:offset + before.length,linkFrom:link.index};
          visible.push(reference); result.push(reference);
        }
        for (const comment of comments) {
          if (code.some(span => comment.index >= span.index && comment.index < span.index + span[0].length)) continue;
          let body; try { body = decodeURIComponent(comment[1]); } catch { continue; }
          for (const link of body.matchAll(/\[([^\]\r\n]+)\]\(([^\s)]+)\)/g)) {
            const source = parse(link[2]);
            if (!source || visible.some(ref => ref.base === source.base && ref.page === source.page)) continue;
            const from = comment.index + comment[0].indexOf('-->') + 3, to = from + comment[2].length;
            result.push({...source,color:visible[0]?.color || source.color,quote:plain(comment[2]),line:lineNumber,from,to,start:offset + from,end:offset + to});
          }
        }
      }
      offset += line.length + 1; lineNumber++;
    }
    return result.filter(ref => ref.quote);
  }
  /** Recolor source links in one physical line, including comment metadata.
   * @pre Valid RGB. @post Other note content and source matching passage survive.
   * @throws {TypeError} Invalid color. Related: notes.sourceColor.
   */
  function recolorLine(line, color) {
    const links = text => {
      const code = [...text.matchAll(/(`+)([^`]*?)\1/g)];
      return text.replace(/(\[[^\]\r\n]+\]\()([^\s)]+)(\))/g,(raw,open,href,close,at) =>
        !code.some(span=>at>=span.index && at<span.index+span[0].length) && parse(href) ? open + location(href,color) + close : raw);
    };
    return links(line.replace(/<!--note-comment:([^>]*?)-->/g,(raw,encoded) => {
      try { return '<!--note-comment:' + encodeURIComponent(links(decodeURIComponent(encoded))) + '-->'; } catch { return raw; }
    }));
  }
  /** Normalize quote typography for PDF text matching. @pre Text string.
   * @post Returns comparable text; punctuation, whitespace and line hyphenation ignored.
   * @throws {void} None. Related: locate().
   */
  function normalize(text) {
    return text.normalize('NFKD').toLowerCase().replace(/\p{M}/gu,'').replace(/[^\p{L}\p{N}]/gu,'');
  }
  /** Find every matching physical PDF page, never silently choose an ambiguous match.
   * @pre Local source base; quote is nonempty. @post Worker released on all paths.
   * @throws {Error} Missing PDF, unsearchable quote, or extraction failure.
   */
  async function locate(base, quote, requestedPage = null) {
    const needle = normalize(quote);
    if (requestedPage === null && needle.length < 12) throw new Error('Select a longer quote or enter a PDF page number.');
    const pdfjs = await import('/static/vendor/pdfjs/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = '/static/vendor/pdfjs/pdf.worker.min.mjs';
    const response = await fetch(base + '/original');
    if (!response.ok) throw new Error('Could not load the source PDF.');
    const task = pdfjs.getDocument({data:new Uint8Array(await response.arrayBuffer()),isEvalSupported:false,
      cMapUrl:'/static/vendor/pdfjs/cmaps/',cMapPacked:true,standardFontDataUrl:'/static/vendor/pdfjs/standard_fonts/'});
    try {
      const pdf = await task.promise, pages = [];
      if (requestedPage !== null) {
        if (requestedPage > pdf.numPages) throw new Error('This PDF has only ' + pdf.numPages + ' pages.');
        return [requestedPage];
      }
      for (let page = 1; page <= pdf.numPages; page++) {
        const content = await (await pdf.getPage(page)).getTextContent();
        if (normalize(content.items.map(item => item.str || '').join(' ')).includes(needle)) pages.push(page);
      }
      return pages;
    } finally { await task.destroy(); }
  }
  /** Build an accessible link to an authorized local PDF location or project file.
   * @pre Valid local destination and active note context.
   * @post Click opens the source; keyboard activation uses native anchor behavior.
   * @throws {TypeError} Invalid link. Related: NoteView decorations and comments pane.
   */
  function anchor(href, label, context, reference) {
    const target = parseProjectFile(href);
    if (target) {
      const link = document.createElement('a'); link.href = href;
      link.textContent = label.replace(/\\([\\[\]])/g,'$1'); link.className = 'note-source-link';
      link.title = target.path || link.textContent;
      window.EditorTools.Tool.bind(link,{id:'notes.source.open',label:'Open '+link.textContent,showText:true,
        /** Open the selected file through the current project host.
         * @pre Validated address. @post Hosts can show PDF sources beside the note.
         * @throws {Error} Missing source or navigation failure reaches the Tool boundary.
         */
        execute:({event}) => {
          event.preventDefault();
          return context.openProjectSource?.(target,(pdfHref,name = link.textContent) => preview(pdfHref,context,undefined,name),() => !context.writingView?.disposed);
        }},context);
      return link;
    }
    if (!parse(href)) throw new TypeError('Invalid PDF source link');
    const link = document.createElement('a'); link.href = href; link.textContent = label; link.className = 'note-source-link';
    link.title = 'Open PDF context at page ' + parse(href).page;
    link.style && (link.style.color = reference?.color || parse(href).color);
    window.EditorTools.Tool.bind(link,{id:'notes.source.open',label:(parse(href).kind === 'context' ? 'Open related PDF context at page ' : 'Open PDF context at page ') + parse(href).page,showText:true,
      /** Navigate the source anchor through the shared dispatcher.
       * @pre Valid link and live note. @post Native navigation is replaced by PDF context.
       * @throws {Error} Viewer failure reaches the host's Tool boundary.
       */
      execute:({event}) => { event.preventDefault(); context.dismiss?.(); return preview(href,context,reference); }},context);
    return link;
  }
  /** Open source context without replacing or saving the note buffer.
   * @pre Valid local PDF location and active note view.
   * @post Read-only PDF opens at the stored physical page; closing releases its worker.
   * @throws {Error} Missing source or viewer failure. Related: shared PdfAnnotator.
   */
  async function preview(href, context, reference, name) {
    const source = parse(href);
    if (!source) throw new Error('Invalid PDF source link');
    if (context.writingView?.disposed) return;
    if (!context.openSidePreview) throw new Error('This note host cannot display a source PDF.');
    return context.openSidePreview('note-pdf',() => window.NotePdfPreview.create(context),{href,reference,name});
  }
  /** Render PDF links in comment text without interpreting arbitrary HTML/Markdown.
   * @pre Untrusted plain comment. @post Text remains literal except validated source links.
   * @throws {Error} DOM failure. Related: View comments.
   */
  function renderComment(body, text, context, quote = '') {
    let offset = 0;
    for (const match of text.matchAll(/\[([^\]\r\n]+)\]\(([^\s)]+)\)/g)) {
      if (!parse(match[2])) continue;
      body.append(document.createTextNode(text.slice(offset,match.index)),anchor(match[2],match[1],context,{...parse(match[2]),quote:plain(quote)})); offset = match.index + match[0].length;
    }
    body.append(document.createTextNode(text.slice(offset)));
  }
  window.NoteSources = Object.freeze({parse,parseProjectFile,projectFileLink,normalize,locate,anchor,preview,renderComment,location,plain,references,recolorLine});
})();
