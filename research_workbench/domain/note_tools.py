"""Pure note toolbar commands over explicit source selections; no filesystem or UI state."""
import hashlib
import re
from urllib.parse import quote, unquote, urlencode, parse_qsl

from research_workbench.domain.errors import ConflictError

PALETTE = dict(zip(('yellow', 'peach', 'pink', 'lavender', 'blue', 'sky', 'mint', 'green'),
                   ('#f9e2af', '#fab387', '#f5c2e7', '#cba6f7', '#89b4fa', '#89dceb', '#94e2d5', '#a6e3a1')))
INLINE = {'notes.bold': '**', 'notes.italic': '*', 'notes.strike': '~~', 'notes.code': '`', 'notes.quotation': '“'}
BLOCK = {'notes.title': '# ', 'notes.heading': '## ', 'notes.subheading': '### ', 'notes.bullet': '- ',
         'notes.number': '1. ', 'notes.task': '- [ ] ', 'notes.quote': '> ', 'notes.paragraph': ''}
COMMENT = re.compile(r'<!--note-comment:([^>]*?)-->(.*?)<!--/note-comment-->')
HIGHLIGHT = re.compile(r'==(?:\{(#[a-f\d]{6})\})?(.*?)==', re.I)
ALIASES = {'notes.comment.Edit comment': 'notes.comment.edit', 'notes.comment.Remove comment': 'notes.comment.remove'}


def catalog():
    """Describe note toolbar coverage and payloads. Pre: none. Post: fresh metadata.
    Returns a JSON-compatible dictionary. Raises no exceptions for valid constants.
    Related: /api/note-tools and API.md.
    """
    option_fields = {
        **{key: ['mode'] for key in INLINE}, **{key: ['mode'] for key in BLOCK},
        'notes.highlight': ['mode', 'color'], 'notes.highlightColor': ['color'],
        'notes.comment': ['comment'], 'notes.comment.edit': ['comment_id', 'comment'],
        'notes.comment.remove': ['comment_id'], 'notes.pdfSource': ['document', 'page', 'comment', 'color', 'match', 'kind'],
        'notes.fileSource': ['path', 'source_document', 'document'], 'notes.sourceColor': ['color'],
        'notes.comments': [], 'notes.source': [], 'text.save': ['text'], 'text.undo': ['text'], 'text.redo': ['text'],
    }
    option_types = {'mode': {'enum': ['toggle', 'apply', 'remove']},
                    'color': {'type': 'string', 'description': 'A pastel palette name or #RRGGBB.'},
                    'text': {'type': 'string'}, 'comment': {'type': 'string', 'minLength': 1},
                    'match': {'type': 'string', 'description': 'Exact PDF passage when the note is a paraphrase or transcription.'},
                    'kind': {'enum': ['quote', 'context'], 'description': 'Context links do not claim a verbatim quotation or draw quote highlights.'},
                    'comment_id': {'type': 'string', 'description': 'ID returned by the latest note read.'},
                    'document': {'type': 'string', 'description': 'Active PDF document ID from note-sources.'},
                    'path': {'type': 'string', 'description': 'Project tree file path. Omit for managed PDFs addressed by document.'},
                    'source_document': {'type': 'string', 'description': 'Owning document ID for a file under a linked source root.'},
                    'page': {'type': 'integer', 'minimum': 1, 'maximum': 9007199254740991}}
    required = {'notes.highlightColor': ['color'], 'notes.comment': ['comment'],
                'notes.comment.edit': ['comment_id', 'comment'], 'notes.comment.remove': ['comment_id'],
                'notes.pdfSource': ['document', 'page'], 'notes.sourceColor': ['color'], 'text.undo': ['text'], 'text.redo': ['text']}
    return {'version': 1, 'file_extensions': ['.txt'], 'offset_encoding': 'unicode-code-points',
            'endpoint': '/api/projects/{id}/note-file/actions',
            'read_endpoint': '/api/projects/{id}/note-file?path=notes.txt',
            'pdf_sources_endpoint': '/api/projects/{id}/note-sources',
            'pdf_quote_lookup_endpoint': '/api/projects/{id}/note-sources/locate',
            'palette': PALETTE.copy(), 'modes': ['toggle', 'apply', 'remove'],
            'request_schema': {'type': 'object', 'additionalProperties': False,
                'required': ['path', 'sha', 'actions'], 'properties': {
                    'path': {'type': 'string'}, 'source_document': {'type': ['string', 'null']},
                    'sha': {'type': 'string'}, 'dry_run': {'type': 'boolean'},
                    'actions': {'type': 'array', 'minItems': 1, 'maxItems': 100, 'items': {
                        'type': 'object', 'additionalProperties': False, 'required': ['action'],
                        'properties': {'action': {'enum': list(option_fields) + list(ALIASES)},
                            'selection': {'oneOf': [
                                {'type': 'object', 'required': ['quote'], 'additionalProperties': False,
                                 'properties': {'quote': {'type': 'string', 'minLength': 1}, 'occurrence': {'type': 'integer', 'minimum': 1}}},
                                {'type': 'object', 'required': ['start', 'end'], 'additionalProperties': False,
                                 'properties': {'start': {'type': 'integer', 'minimum': 0}, 'end': {'type': 'integer', 'minimum': 0}}}]},
                            'options': {'type': 'object'}}}}}},
            'actions': [{'id': key, 'options': fields,
                         'options_schema': {'type': 'object', 'additionalProperties': False,
                                            'required': required.get(key, []),
                                            'properties': {field: option_types[field].copy() for field in fields}},
                         'requires_selection': key in INLINE or key in BLOCK or key in ('notes.highlight', 'notes.highlightColor', 'notes.comment', 'notes.pdfSource', 'notes.fileSource', 'notes.sourceColor'),
                         'effect': 'read' if key in ('notes.source', 'notes.comments') else 'restore_snapshot' if key in ('text.undo', 'text.redo') else 'edit',
                         'aliases': [alias for alias, target in ALIASES.items() if target == key]}
                        for key, fields in option_fields.items()],
            'semantics': {'batch': 'Selections resolve against the result of preceding actions. One atomic save after all actions succeed.',
                'dry_run': 'Compute proposed text/SHA without writing. base_sha remains the on-disk revision.',
                'undo_redo': 'Use the returned undo/redo action with the CURRENT sha. Browser undo history is not exposed.',
                'source': 'Returns raw source and annotation metadata; does not switch an open browser view.',
                'highlightColor': 'Apply/recolor the selection. palette names or #RRGGBB accepted; default yellow.',
                'pdfSource': 'Use an active document ID and a physical PDF page. Locate an unknown page with the lookup endpoint first.',
                'fileSource': 'Choose a file from GET /api/projects/{id}/tree. Use path and optional source_document, or document for a managed PDF. A collapsed range inserts at the cursor. Other ranges insert after the selection.'}}


def selection(text, target):
    """Resolve exact quotes or code-point offsets. Pre: current source and target object.
    Post: no mutation; returns (start, end). Raises ValueError for malformed input,
    ConflictError for missing/ambiguous quotes. Related: apply_action and source API ranges.
    """
    if not isinstance(target, dict):
        raise ValueError('Supply selection with an exact quote or start/end offsets.')
    if set(target) == {'start', 'end'}:
        start, end = target['start'], target['end']
        if type(start) is not int or type(end) is not int or not 0 <= start <= end <= len(text):
            raise ValueError('Selection offsets must be valid Unicode code-point positions.')
        return start, end
    if set(target) - {'quote', 'occurrence'} or not isinstance(target.get('quote'), str) or not target['quote']:
        raise ValueError('Supply a nonempty exact source quote and optional positive occurrence.')
    occurrence = target.get('occurrence')
    if occurrence is not None and (type(occurrence) is not int or occurrence < 1):
        raise ValueError('Occurrence must be a positive integer.')
    matches = [match.start() for match in re.finditer('(?=' + re.escape(target['quote']) + ')', text)]
    if not matches or (occurrence is not None and occurrence > len(matches)) or (occurrence is None and len(matches) != 1):
        raise ConflictError('Quote missing or ambiguous. Read the note and supply occurrence or offsets.',
                            [{'start': start, 'end': start + len(target['quote'])} for start in matches[:100]])
    start = matches[(occurrence or 1) - 1]
    return start, start + len(target['quote'])


def _lines(text):
    """Yield code-free physical lines and offsets. Pre: source string.
    Post: no mutation; fences remain literal. Raises no exceptions. Related: annotations.
    """
    offset, fence = 0, None
    for line in text.splitlines(keepends=True):
        boundary = re.match(r'^ {0,3}(`{3,}|~{3,})(.*?)(?:\r?\n)?$', line)
        if boundary and fence is None:
            fence = boundary[1]
        elif fence:
            if boundary and boundary[1][0] == fence[0] and len(boundary[1]) >= len(fence) and not boundary[2].strip():
                fence = None
        else:
            yield offset, line
        offset += len(line)


def annotations(text):
    """Read persisted comments/highlights with code-point ranges. Pre: note source.
    Post: returns detached records; code examples and malformed comments stay literal.
    Raises no exceptions for source data. Related: read API and comment actions.
    """
    comments, highlights = [], []
    for offset, line in _lines(text):
        code = [(match.start(), match.end()) for match in re.finditer(r'(`+)([^`]*?)\1', line)]
        for pattern, records in ((COMMENT, comments), (HIGHLIGHT, highlights)):
            for match in pattern.finditer(line):
                if any(start <= match.start() < end for start, end in code):
                    continue
                item = {'start': offset + match.start(), 'end': offset + match.end(), 'text': match[2]}
                if pattern is COMMENT:
                    try:
                        if re.search(r'%(?![a-f\d]{2})', match[1], re.I):
                            continue
                        item['comment'] = unquote(match[1], errors='strict')
                    except UnicodeError:
                        continue
                    item['id'] = hashlib.sha256((str(item['start']) + '\0' + match[0]).encode()).hexdigest()[:20]
                else:
                    item['color'] = match[1] or PALETTE['yellow']
                records.append(item)
    return {'comments': comments, 'highlights': highlights}


def annotate(text, comment):
    """Serialize a comment on each nonempty selected line. Pre: nonempty strings.
    Post: native newlines retained. Raises ValueError for empty selection/comment.
    Related: browser NoteAnnotations.annotate.
    """
    if not isinstance(comment, str) or not comment.strip() or not text.strip():
        raise ValueError('Select text and provide a nonempty comment.')
    encoded = quote(comment.strip(), safe="~()*!.'-_")
    return ''.join(part if not part or part in ('\n', '\r\n') else '<!--note-comment:' + encoded + '-->' + part + '<!--/note-comment-->'
                   for part in re.split(r'(\r\n|\n)', text))


def _layer(text):
    """Inspect a complete enclosing inline layer. Pre: selected source.
    Post: returns (style, opening width, closing width) or None; no mutation.
    Raises no exceptions. Related: toggle_inline, including mixed bold/italic.
    """
    code = re.fullmatch(r'(`+)([^`]*?)\1', text, re.S)
    if code:
        return 'code', len(code[1]), len(code[1])
    # Delimiter-looking text in code/comment metadata never closes an enclosing style.
    masked = re.sub(r'(`+)([^`]*?)\1', lambda match: '\ue000' * len(match[0]), text)
    masked = COMMENT.sub(lambda match: '\ue000' * (match[0].find('-->') + 3) + match[2]
                         + '\ue000' * len('<!--/note-comment-->'), masked)
    highlight = re.fullmatch(r'==(\{#[a-f\d]{6}\})?((?:(?!==).)+)==', masked, re.I | re.S)
    if highlight:
        return 'highlight', 2 + len(highlight[1] or ''), 2
    for delimiter, kind in (('**', 'bold'), ('__', 'bold'), ('~~', 'strike'), ('*', 'italic'), ('_', 'italic'), ('“', 'quotation')):
        closing = '”' if delimiter == '“' else delimiter
        if not text.startswith(delimiter) or not text.endswith(closing) or len(text) <= len(delimiter) + len(closing):
            continue
        body = text[len(delimiter):-len(closing)]
        visible_body = masked[len(delimiter):-len(closing)]
        if not body.strip() or body != body.strip():
            continue
        if delimiter in ('*', '_'):
            if text.startswith(delimiter * 2) or any(len(run[0]) != 2 for run in re.finditer(re.escape(delimiter) + '+', visible_body)):
                continue
        elif delimiter != '“' and delimiter in visible_body:
            continue
        return kind, len(delimiter), len(closing)
    return None


def toggle_inline(text, delimiter, mode):
    """Apply/remove one format while preserving enclosing styles. Pre: valid mode.
    Post: source only; raises no exceptions for string input. Related: inline toolbar.
    """
    target = {'**': 'bold', '*': 'italic', '~~': 'strike', '`': 'code', '“': 'quotation'}[delimiter]
    offset, end = 0, len(text)
    for _ in range(len(text) + 1):
        layer = _layer(text[offset:end])
        if not layer:
            break
        kind, opening, closing = layer
        if kind == target:
            return text if mode == 'apply' else text[:offset] + text[offset + opening:end - closing] + text[end:]
        if kind == 'code':
            break
        offset, end = offset + opening, end - closing
    return text if mode == 'remove' else delimiter + (text or 'text') + ('”' if delimiter == '“' else delimiter)


def source_location(href, color, passage=None, kind=None):
    """Serialize one source color and optional verbatim passage. Pre: local PDF URL.
    Post: page/revision preserved; no IO. Raises ValueError for invalid options.
    Related: browser NoteSources.location and note-owned PDF overlays.
    """
    color = PALETTE.get(color.lower(), color) if isinstance(color, str) else ''
    if not re.fullmatch(r'#[a-f\d]{6}', color, re.I):
        raise ValueError('Choose a valid PDF source color (#RRGGBB or palette name).')
    if passage is not None and (not isinstance(passage, str) or len(passage) > 100000):
        raise ValueError('The PDF matching passage must be text of at most 100,000 characters.')
    match = re.fullmatch(r'(/api/projects/[a-f\d]+/documents/[a-f\d]{32}/original)#(.+)', href)
    if not match:
        raise ValueError('Choose a valid local PDF source link.')
    params = dict(parse_qsl(match[2], keep_blank_values=True))
    if not re.fullmatch(r'[1-9]\d*', params.get('page', '')) or set(params) - {'page', 'color', 'match', 'kind'}:
        raise ValueError('Choose a valid PDF page.')
    kind = params.get('kind', 'quote') if kind is None else kind
    if kind not in ('quote', 'context'):
        raise ValueError('Choose quote or context source type.')
    if kind == 'context':
        params['kind'] = kind
    else:
        params.pop('kind', None)
    params['color'] = color[1:].lower()
    if passage is not None:
        if passage:
            params['match'] = passage
        else:
            params.pop('match', None)
    return match[1] + '#' + urlencode(params)


def recolor_sources(line, color):
    """Recolor visible/commented source links in one code-free line. Pre: RGB/palette.
    Post: text and PDF matching passages retained; no IO. Raises ValueError for color.
    Related: notes.sourceColor, which expands selections to complete physical lines.
    """
    source_location('/api/projects/a/documents/' + 'b' * 32 + '/original#page=1', color)
    def links(value):
        """Rewrite recognized source URLs. Pre: trusted line fragment. Post: other links unchanged.
        Raises ValueError on invalid source color. Related: encoded comment handling below.
        """
        code = [(span.start(), span.end()) for span in re.finditer(r'(`+)([^`]*?)\1', value)]
        def replace(match):
            """Recolor a local PDF href. Pre: Markdown match. Post: unrelated links retained.
            Raises no exceptions for unrelated URLs; related: source_location validation.
            """
            if any(start <= match.start() < end for start, end in code):
                return match[0]
            try:
                return match[1] + source_location(match[2], color) + match[3]
            except ValueError:
                return match[0]
        return re.sub(r'(\[[^\]\r\n]+\]\()([^\s)]+)(\))', replace, value)
    def comment(match):
        """Preserve note comment encoding while recoloring its links. Pre: opening marker.
        Post: safe encoded data. Raises no exceptions for malformed encoded comments.
        """
        try:
            return '<!--note-comment:' + quote(links(unquote(match[1], errors='strict')), safe="~()*!.'-_") + '-->'
        except UnicodeError:
            return match[0]
    return links(re.sub(r'<!--note-comment:([^>]*?)-->', comment, line))


def apply_action(text, command, source_link=None):
    """Apply a validated toolbar action to an in-memory note. Pre: explicit source.
    Post: returns fresh text; never writes. Raises ValueError/ConflictError on invalid
    requests or selections. Related: NoteFiles atomic publication and browser toolbar.
    """
    if not isinstance(command, dict) or set(command) - {'action', 'selection', 'options'}:
        raise ValueError('An action accepts action, selection and options only.')
    action = command.get('action')
    if not isinstance(action, str):
        raise ValueError('Choose a note toolbar action.')
    action = ALIASES.get(action, action)
    descriptor = next((item for item in catalog()['actions'] if item['id'] == action), None)
    if descriptor is None:
        raise ValueError('Unknown note action: ' + action)
    options = command.get('options', {})
    if not isinstance(options, dict) or set(options) - set(descriptor['options']):
        raise ValueError('Unsupported options for ' + action)
    if not set(descriptor['options_schema']['required']) <= set(options):
        raise ValueError('Missing required options for ' + action)
    mode = options.get('mode', 'toggle')
    if mode not in ('toggle', 'apply', 'remove'):
        raise ValueError('Mode must be toggle, apply or remove.')
    if action in ('notes.source', 'notes.comments'):
        return text
    if action in ('text.save', 'text.undo', 'text.redo'):
        if action != 'text.save' and 'text' not in options:
            raise ValueError('Undo/redo requires the text snapshot returned by the previous API edit.')
        result = options.get('text', text)
        if not isinstance(result, str):
            raise ValueError('Provide a text snapshot.')
        return result
    if action in ('notes.comment.edit', 'notes.comment.remove'):
        entry = next((entry for entry in annotations(text)['comments'] if entry['id'] == options.get('comment_id')), None)
        if entry is None:
            raise ConflictError('Comment not found. Read current comments before editing.', [])
        replacement = entry['text'] if action.endswith('remove') else annotate(entry['text'], options.get('comment'))
        return text[:entry['start']] + replacement + text[entry['end']:]
    start, end = selection(text, command.get('selection'))
    selected = text[start:end]
    if action in INLINE:
        replacement = toggle_inline(selected, INLINE[action], mode)
    elif action == 'notes.sourceColor':
        start = text.rfind('\n', 0, start) + 1
        probe = end - 1 if end > start and text[end - 1:end] == '\n' else end
        end = text.find('\n', probe)
        end = len(text) if end < 0 else end
        allowed = {offset for offset, _line in _lines(text)}
        parts, offset = [], 0
        for line in text[start:end].splitlines(keepends=True):
            parts.append(recolor_sources(line, options['color']) if start + offset in allowed else line)
            offset += len(line)
        replacement = ''.join(parts)
    elif action in BLOCK:
        start = text.rfind('\n', 0, start) + 1
        probe = end - 1 if end > start and text[end - 1:end] == '\n' else end
        end = text.find('\n', probe)
        end = len(text) if end < 0 else end - (1 if text[end - 1:end] == '\r' else 0)
        lines = re.split(r'(\r\n|\n)', text[start:end])
        number = 0
        for index in range(0, len(lines), 2):
            number += 1
            prefix = str(number) + '. ' if action == 'notes.number' else BLOCK[action]
            line = lines[index]
            if not prefix or mode == 'remove' or (mode == 'toggle' and line.startswith(prefix)):
                lines[index] = re.sub(r'^\s*(?:#{1,6}\s+|>\s?|[-+*]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)', '', line) if not prefix else line[len(prefix):] if line.startswith(prefix) else line
            else:
                lines[index] = prefix + re.sub(r'^\s*(?:#{1,6}\s+|>\s?|[-+*]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)', '', line)
        replacement = ''.join(lines)
    elif action in ('notes.highlight', 'notes.highlightColor'):
        if start != end and '\n' not in selected:
            for entry in annotations(text)['highlights']:
                if entry['start'] <= start <= end <= entry['end']:
                    start, end = entry['start'], entry['end']
                    selected = text[start:end]
                    break
        color = options.get('color', 'yellow')
        if not isinstance(color, str):
            raise ValueError('Choose a pastel name or #RRGGBB.')
        color = PALETTE.get(color.lower(), color)
        if not re.fullmatch(r'#[a-f\d]{6}', color, re.I):
            raise ValueError('Choose a pastel name or #RRGGBB.')
        parts = re.split(r'(\r\n|\n)', selected or 'text')
        colored = all(HIGHLIGHT.fullmatch(part) for part in parts[::2] if part)
        remove = mode == 'remove' or (action == 'notes.highlight' and mode == 'toggle' and colored)
        for index in range(0, len(parts), 2):
            part = parts[index]
            if not part:
                continue
            match = HIGHLIGHT.fullmatch(part)
            parts[index] = (match[2] if match else part) if remove else '=={' + color.lower() + '}' + (match[2] if match else part) + '=='
        replacement = ''.join(parts)
    elif action == 'notes.comment':
        replacement = annotate(selected, options.get('comment'))
    elif action == 'notes.fileSource':
        if not source_link:
            raise ValueError('Choose a project file.')
        before = ' ' if end and not text[end - 1].isspace() else ''
        after = ' ' if end < len(text) and not text[end].isspace() else ''
        return text[:end] + before + source_link + after + text[end:]
    elif action == 'notes.pdfSource':
        if not selected.strip() or not source_link:
            raise ValueError('Select a quote and provide an active PDF document and physical page.')
        comment = options.get('comment', '')
        if not isinstance(comment, str):
            raise ValueError('Comment must be text.')
        replacement = annotate(selected, comment.strip() + '\n' + source_link) if comment.strip() else selected + ' ' + source_link
    else:
        raise ValueError('Unsupported note action.')
    return text[:start] + replacement + text[end:]
