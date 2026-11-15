"""Incremental markup API shared by the HTTP editor and external HTTP clients.

Python 3.10+ standard library only. Storage and source anchoring remain owned by
Project and Drafts; callers must hold App.lock for each read/modify/write operation.
"""
from research_workbench.domain.errors import MarkupConflict
from research_workbench.domain.schemas import SCOPE, TEXT, NUMBER, PAGE, RECT, CREATE_SCHEMA, validate

from research_workbench.domain.comments import create_comment

import copy
import hashlib
import re
import time
import uuid




def merge_annotations(base, local, remote):
    """Merge independent edits by ID. Pre: annotation snapshots; post: new snapshot.
    Raises MarkupConflict on divergent edits to one item; never drops remote additions.
    Used by the visual editor's full-snapshot save alongside incremental API writes.
    """
    if local == base:
        return copy.deepcopy(remote)
    if remote == base or remote == local:
        return copy.deepcopy(local)
    result = {'version': 1}
    for kind in ('highlights', 'strokes'):
        maps = []
        for snapshot in (base, local, remote):
            items = snapshot.get(kind) if isinstance(snapshot, dict) else None
            if not isinstance(items, list) or any(not isinstance(x, dict) or not isinstance(x.get('id'), str) for x in items):
                raise MarkupConflict('Annotations changed. Reload before saving legacy marks without IDs.')
            index = {x['id']: x for x in items}
            if len(index) != len(items):
                raise ValueError('Duplicate annotation IDs.')
            maps.append(index)
        before, ours, theirs = maps
        merged = []
        for key in dict.fromkeys([*theirs, *ours, *before]):
            old, left, right = before.get(key), ours.get(key), theirs.get(key)
            if left != old and right != old and left != right:
                raise MarkupConflict(f'Mark {key} changed in another client. Keep your text, reload, and retry.')
            chosen = left if left != old else right
            if chosen is not None:
                merged.append(copy.deepcopy(chosen))
        result[kind] = merged
    return result


class Markup:
    def __init__(self, project, doc, scope='auto'):
        """Select a version's storage. Pre: verified doc, App.lock held.
        Post: explicit scope; raises ValueError/MarkupConflict for invalid targets.
        """
        validate(scope, SCOPE, 'scope')
        self.project, self.doc = project, doc
        linked = doc['paper_id'] in project.drafts.sources()
        self.scope = ('draft' if linked and doc['active'] else 'pdf') if scope == 'auto' else scope
        if self.scope == 'draft':
            project.require_active(doc)
            project.drafts.require(doc)

    def item(self, prefix, record):
        """Wrap a native record with a stable API ID. Pre: stored record; no writes.
        Post: JSON object preserving native data; no expected exceptions.
        """
        style = record.get('style', record)
        kind = ('pen' if prefix == 'pen' else 'change' if prefix == 'change' else
                'replace' if style.get('intent') == 'replace' else style.get('type', 'comment'))
        if prefix == 'text' and 'type' not in record:
            kind = 'highlight'
        return {'id': prefix + ':' + record['id'], 'scope': self.scope, 'kind': kind, 'record': record}

    def read(self):
        """Read markup and target metadata. Pre: selected storage; post: JSON snapshot.
        Drafts.status relocates source notes; its source/file errors propagate.
        """
        if self.scope == 'pdf':
            ann = self.project.annotations(self.doc)
            items = [self.item(prefix, r) for prefix, key in [('text', 'highlights'), ('pen', 'strokes')] for r in ann[key]]
            return {'scope': self.scope, 'document_id': self.doc['id'], 'items': items}
        status = self.project.drafts.status(self.doc)
        items = [self.item(prefix, r) for prefix, key in [('note', 'notes'), ('pen', 'strokes'), ('change', 'changes')] for r in status.get(key, [])]
        return {'scope': self.scope, 'document_id': self.doc['id'], 'files': status.get('files', []),
                'main': status.get('main'), 'source_root': status.get('root'), 'items': items}

    def revision(self):
        """Fingerprint persisted markup without refreshing source. Pre: valid scope.
        Post: opaque revision for UI polling; missing draft state is an empty snapshot.
        File-access errors propagate; read() still owns source-anchor relocation.
        """
        path = (self.project.drafts.state_path(self.doc['paper_id']) if self.scope == 'draft'
                else self.project.path(self.doc, 'annotations'))
        data = path.read_bytes() if path.exists() else b''
        return {'scope': self.scope, 'revision': hashlib.sha256(data).hexdigest()}

    def source_target(self, target):
        """Resolve exact source text. Pre: validated target; post: native note fields.
        Raises ValueError/MarkupConflict for absent, ambiguous, stale or unsafe targets.
        Offsets use Python Unicode code points, never concatenated-paper offsets.
        """
        if not target.get('file') or not target.get('quote') or 'rects' in target:
            raise ValueError('Draft text marks require target.file and an exact, nonempty target.quote.')
        source = self.project.drafts.read_file(self.doc, target['file'])['text']
        quote = target['quote']
        if 'start' in target or 'end' in target:
            if 'start' not in target or 'end' not in target or 'occurrence' in target:
                raise ValueError('Supply both start and end, or occurrence, not both.')
            start, end = target['start'], target['end']
            if not 0 <= start < end <= len(source) or source[start:end] != quote:
                raise MarkupConflict('The source selection changed. Read the file and select it again.')
        else:
            matches = [m.start() for m in re.finditer('(?=' + re.escape(quote) + ')', source)]
            occurrence = target.get('occurrence')
            if not matches or (occurrence is not None and occurrence > len(matches)):
                raise MarkupConflict('The exact quote or occurrence was not found in the source file.')
            if occurrence is None and len(matches) != 1:
                raise MarkupConflict(f'The quote occurs {len(matches)} times. Supply occurrence or start/end.')
            start = matches[(occurrence or 1) - 1]
            end = start + len(quote)
        return {'rel': target['file'], 'start': start, 'end': end, 'quote': quote}

    def create(self, data):
        """Create one supported mark. Pre: App.lock held; post: one persisted item.
        Validates all input before writing; storage/selection errors propagate.
        Source replacements are suggestions stored as comments, not source edits.
        """
        self.project.require_active(self.doc)
        validate(data, CREATE_SCHEMA)
        kind = data['kind']
        if kind == 'pen':
            if any(k in data for k in ('target', 'text', 'replacement', 'author')):
                raise ValueError('Pen strokes accept geometry, color, width and an optional draft anchor.')
            if not all(k in data for k in ('page', 'points', 'width', 'color')) or not re.fullmatch(r'#[0-9a-fA-F]{6}', data['color']):
                raise ValueError('Pen requires page, points, positive width and #RRGGBB color.')
            if self.scope == 'pdf' and 'anchor' in data:
                raise ValueError('Source anchors are only supported for draft pen strokes.')
            stroke = {k: data[k] for k in ('page', 'points', 'width', 'color', 'anchor') if k in data}
            if self.scope == 'draft':
                return self.item('pen', self.project.drafts.add_stroke(self.doc, stroke))
            stroke.update(id=uuid.uuid4().hex, created_at=time.strftime('%Y-%m-%dT%H:%M:%S%z'))
            ann = self.project.annotations(self.doc)
            ann['strokes'].append(stroke)
            self.project.save_annotations(self.doc, ann)
            return self.item('pen', stroke)
        if any(k in data for k in ('page', 'points', 'width', 'anchor')):
            raise ValueError('Text marks require target, not pen geometry.')
        target = data.get('target', {})
        text = data.get('text', '').strip()
        if kind == 'comment' and not text:
            raise ValueError('A comment requires nonempty text.')
        if kind == 'replace':
            if not data.get('replacement', '').strip():
                raise ValueError('A replacement requires nonempty replacement text; use strikethrough for removal.')
            text = 'Replacement: ' + data['replacement'].strip() + ('\n\n' + text if text else '')
        elif 'replacement' in data:
            raise ValueError('replacement is only valid for kind replace.')
        if len(text) > 20000:
            raise ValueError('Combined comment text exceeds 20000 characters.')
        color = data.get('color', 'yellow')
        if color not in ('yellow', 'green', 'blue', 'pink'):
            raise ValueError('Text color must be yellow, green, blue or pink.')
        if kind in ('strikethrough', 'replace') and 'color' in data:
            raise ValueError('Strikethrough and replacement use the editor’s fixed colors.')
        author = data.get('author', 'LLM').strip()
        if not author:
            raise ValueError('author must not be blank.')
        style = {'type': 'strikethrough'} if kind in ('strikethrough', 'replace') else {'type': 'highlight', 'color': color}
        if kind == 'replace':
            style['intent'] = 'replace'
        if self.scope == 'draft':
            selection = self.source_target(target)
            note = self.project.drafts.add_note(self.doc, **selection, text=text, author=author, origin='source', style=style)
            return self.item('note', note)
        if set(target) - {'quote', 'rects'} or not target.get('rects') or 'quote' not in target:
            raise ValueError('PDF text marks require target.quote and target.rects; use draft scope for source selections.')
        mark = {'id': uuid.uuid4().hex, **style, 'page': target['rects'][0]['p'], 'rects': target['rects'],
                'text': target['quote'], 'comments': [create_comment(text, author)] if text else [],
                'created_at': time.strftime('%Y-%m-%dT%H:%M:%S%z')}
        ann = self.project.annotations(self.doc)
        ann['highlights'].append(mark)
        self.project.save_annotations(self.doc, ann)
        return self.item('text', mark)

    def mutate(self, item_id, action, data):
        """Reply, resolve/reopen, accept, or erase one mark. Pre: App.lock held.
        Post: native record persisted without replacing other marks. Invalid IDs,
        unsupported actions and unavailable versions raise before any write.
        """
        self.project.require_active(self.doc)
        prefix, sep, key = item_id.partition(':')
        if not sep or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', key):
            raise ValueError('Use an item ID returned by the markup API.')
        properties = {'scope': SCOPE}
        if action == 'comments':
            properties.update(text={**TEXT, 'minLength': 1}, author=CREATE_SCHEMA['properties']['author'])
            required = ['text']
        elif action == 'status':
            properties['status'] = {'type': 'string', 'enum': ['open', 'resolved', 'accepted', 'deleted']}
            required = ['status']
        else:
            raise FileNotFoundError('Markup action not found.')
        validate(data, {'type': 'object', 'properties': properties, 'required': required, 'additionalProperties': False})
        if action == 'comments' and (not data['text'].strip() or not data.get('author', 'LLM').strip()):
            raise ValueError('Comment text and author must not be blank.')
        if self.scope == 'draft':
            drafts = self.project.drafts
            methods = {('note', 'comments'): drafts.reply_note, ('change', 'comments'): drafts.comment,
                       ('note', 'status'): drafts.set_note_status, ('change', 'status'): drafts.set_status,
                       ('pen', 'status'): drafts.set_stroke_status}
            method = methods.get((prefix, action))
            if method is None:
                raise ValueError('This draft item does not support that action.')
            args = [data['text'], data.get('author', 'LLM')] if action == 'comments' else [data['status']]
            return self.item(prefix, method(self.doc, key, *args))
        collection = {'text': 'highlights', 'pen': 'strokes'}.get(prefix)
        if collection is None or (prefix == 'pen' and action == 'comments'):
            raise ValueError('PDF replies require a text item; pen strokes support deletion.')
        ann = self.project.annotations(self.doc)
        record = next((x for x in ann[collection] if x.get('id') == key), None)
        if record is None:
            raise FileNotFoundError('Markup item not found.')
        if action == 'comments':
            if record.get('note') and not record.get('comments'):
                record['comments'] = [create_comment(record.pop('note'), 'Author')]
            record.setdefault('comments', []).append(create_comment(data['text'], data.get('author', 'LLM')))
        else:
            if data['status'] != 'deleted':
                raise ValueError('PDF review supports deletion; resolve/reopen applies to draft notes.')
            ann[collection].remove(record)
        self.project.save_annotations(self.doc, ann)
        return self.item(prefix, record)
