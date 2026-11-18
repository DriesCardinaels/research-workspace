"""Revision-checked toolbar transactions for standalone and linked source files."""
import hashlib
from html.parser import HTMLParser
from pathlib import Path
import re
import shutil
import unicodedata

from research_workbench.domain.errors import ConflictError
from research_workbench.domain.note_tools import catalog as note_catalog, selection
from research_workbench.infrastructure.processes.toolbar import run_toolbar

LIMIT = 10 * 1024 * 1024


class HeadingText(HTMLParser):
    """Extract heading text while ignoring script/style content; never render HTML."""

    def __init__(self):
        """@param None. @pre None. @post Empty parser. @return None. @throws None."""
        super().__init__(convert_charrefs=True)
        self.parts, self.hidden = [], 0

    def handle_starttag(self, tag, attrs):
        """@param tag,attrs: Parser tokens. @pre Parsing. @post Unsafe text hidden.
        @return None. @throws None. Related: heading-only plain text extraction.
        """
        if tag in ('script', 'style'):
            self.hidden += 1

    def handle_endtag(self, tag):
        """@param tag: Closing tag. @pre Parsing. @post Visibility restored.
        @return None. @throws None. Related: handle_starttag.
        """
        if tag in ('script', 'style'):
            self.hidden = max(0, self.hidden - 1)

    def handle_data(self, data):
        """@param data: Literal text. @pre Parsing. @post Visible text collected.
        @return None. @throws None. Related: contents.
        """
        if not self.hidden:
            self.parts.append(data)


def contents(headings, text):
    """Build TOC from the same Marked block headings used by the browser.
    @param headings,text: Worker heading HTML and original source.
    @pre Trusted parser output. @post Source unchanged; duplicate slugs disambiguated.
    @return str: Navigation snippet. @throws None. Related: MarkdownPreview.contents.
    """
    newline = '\r\n' if '\r\n' in text else '\n'
    used, lines = set(), []
    for heading in headings:
        reader = HeadingText()
        reader.feed(heading['html'])
        title = ''.join(reader.parts)
        base = ''.join(char for char in title.lower() if unicodedata.category(char)[0] in ('L', 'M', 'N')
                       or unicodedata.category(char) == 'Pc' or char == '-' or char.isspace()).replace(' ', '-')
        slug, count = base, 0
        while slug in used:
            count += 1
            slug = base + '-' + str(count)
        used.add(slug)
        title = re.sub(r'([\[\]\\])', r'\\\1', title)
        lines.append('  ' * max(0, heading['depth'] - 2) + '- [' + title + '](#' + slug + ')')
    return newline + newline.join(lines) + newline


def action_catalog():
    """Discover shared toolbar actions and explicit selection/option contracts.
    @param None. @pre Trusted installation. @post No user data IO.
    @return dict: Availability and actions. @throws ValueError,OSError: Worker failed.
    Related: GET /api/source-tools, SourceActions.
    """
    available = shutil.which('node') is not None
    actions = run_toolbar({'kind': 'catalog'})['actions'] if available else []
    for item in actions:
        action = item['id']
        item['extensions'] = (['.md', '.markdown'] if action.startswith('markdown.') else
                              ['.json'] if action == 'json.validate' else ['.bib'] if action in
                              ('source.format-file', 'bibliography.sort-entries') else ['.tex'])
        item['requires_selection'] = action not in ('source.format-file', 'bibliography.sort-entries', 'json.validate')
        item['options'] = ['rows', 'columns', 'alignment', 'caption', 'label'] if action == 'source.table' else []
    actions.extend({'id': action, 'label': label, 'extensions': ['.tex', '.bib', '.md', '.markdown', '.json'],
                    'requires_selection': False, 'options': ['text'], 'requires_runtime': False}
                   for action, label in [('text.save', 'Save source snapshot'), ('text.undo', 'Undo API edit'),
                                         ('text.redo', 'Redo API edit')])
    schema = note_catalog()['request_schema']
    schema['properties']['actions']['items']['properties']['action']['enum'] = [item['id'] for item in actions]
    return {'version': 1, 'available': available, 'dependency': 'Node.js 18+ on PATH; bundled browser algorithms; no npm install',
            'endpoint': '/api/projects/{id}/source-file/actions', 'actions': actions,
            'request_schema': schema,
            'offset_encoding': 'unicode-code-points', 'max_actions': 100,
            'selection': {'offsets': {'start': 0, 'end': 5}, 'exact_quote': {'quote': 'text', 'occurrence': 1}},
            'transaction': 'path, sha, actions, optional source_document and dry_run; selections use preceding action output; one save after success',
            'linked_source': 'source_document selects draft/file read/write for .tex/.bib, preserving review attribution',
            'history': 'Returned undo/redo are text snapshots; submit with the current sha. Browser history is separate.'}


def capabilities():
    """Describe API equivalents for every toolbar family, including browser state.
    @param None. @pre Authorized read. @post No project mutation.
    @return dict: Discoverable coverage map. @throws ValueError,OSError: Worker failure.
    Related: llms.txt and API.md; P/D are client-resolved project/document base paths.
    """
    return {'version': 1, 'source_tools': action_catalog(), 'note_tools': note_catalog(),
            'families': [
                {'id': 'project', 'routes': ['GET /api/projects', 'POST /api/projects', 'GET P/tree', 'POST P/reload',
                    'POST P/imports/file', 'POST P/imports/directory', 'POST P/entries', 'PATCH P/entries',
                    'POST P/entries/reveal', 'POST P/open-file', 'DELETE P', 'GET P/folders', 'POST P/folders', 'PUT D/folder',
                    'DELETE D', 'POST D/restore', 'GET D/versions']},
                {'id': 'source', 'catalog': '/api/source-tools', 'routes': ['GET P/text-file', 'PUT P/text-file',
                    'GET D/draft/file', 'PUT D/draft/file', 'POST P/source-file/actions']},
                {'id': 'notes', 'catalog': '/api/note-tools', 'routes': ['GET P/note-file', 'POST P/note-file/actions',
                    'GET P/note-sources', 'POST P/note-sources/locate']},
                {'id': 'build', 'routes': ['GET P/latex/source', 'POST P/latex/compile', 'POST P/latex/archive',
                    'POST D/draft/link', 'POST D/draft/compile', 'POST D/draft/compile-active',
                    'POST D/draft/no-figures', 'POST D/draft/archive', 'POST D/draft/promote',
                    'GET D/draft/synctex/edit', 'GET D/draft/synctex/view']},
                {'id': 'review', 'routes': ['GET /api/markup/schema', 'GET D/markup', 'POST D/markup',
                    'POST D/markup/{id}/comments', 'POST D/markup/{id}/status', 'DELETE D/markup/{id}',
                    'GET D/draft', 'POST D/draft/changes/{id}/revert', 'GET D/draft/history', 'POST D/draft/writing/ignores'],
                 'copy_all': 'Read markup and serialize comments; API does not write the OS clipboard.',
                 'undo_redo': 'Use explicit status changes for markup; GET before updating. Browser undo stacks are not shared.'},
                {'id': 'pdf', 'routes': ['GET D/original', 'GET D/annotated', 'GET D/annotations',
                    'PUT D/annotations', 'PUT D/annotated'],
                 'export': 'PUT annotated uploads rendered PDF bytes; GET downloads the last saved export. Rendering is performed by the client.'},
                {'id': 'bibliography', 'routes': ['POST /api/bibliography/entries', 'POST /api/openalex/search',
                    'POST /api/openalex/check', 'POST /api/openalex/diagnose', 'GET /api/settings/openalex', 'PUT /api/settings/openalex'],
                 'checks': 'Parse entries locally and diagnose each key explicitly; no implicit network lookup.'},
                {'id': 'github', 'routes': ['GET P/github', 'PUT P/github', 'POST P/github/push']},
                {'id': 'image', 'routes': ['GET P/image-file']},
            ],
            'browser_state': {'supported': False,
                'controls': ['tabs: close/close others/right/saved/unpinned/all, pin', 'PDF page/zoom, text selection and active drawing mode',
                    'image fit/actual size/zoom', 'source/PDF/both and raw note view', 'panes, menus, focus, search, full screen',
                    'appearance/theme preferences', 'Auto OpenAlex, cached status, suppress/restore bibliography warnings'],
                'reason': 'These controls own browser-local state. HTTP performs their content operations; it does not remote-control an open browser or its unsaved buffers.'}}


class SourceActions:
    """Run pure transformations outside application locks, then publish one checked save."""

    def __init__(self, app, project_id):
        """@param app,project_id: Session owner and selected ID. @pre Authorized request.
        @post Dependencies retained. @return None. @throws None. Related: ProjectRoutes.
        """
        self.app, self.project_id = app, project_id

    def actions(self, data):
        """Validate, compute and save an atomic toolbar batch.
        @param data: path, sha, actions; optional source_document and dry_run.
        @pre Shared HTTP auth passed. @post One save or none; stale/invalid batches never write.
        @return dict: Proposed/persisted source, SHA and inverse snapshot actions.
        @throws ValueError,ConflictError,FileNotFoundError,OSError: Bad action, stale/session or IO failure.
        Related: confined Project.text_file and attributed Drafts.write_file.
        """
        if (not isinstance(data, dict) or set(data) - {'path', 'sha', 'actions', 'source_document', 'dry_run'}
                or not {'path', 'sha', 'actions'} <= set(data) or not isinstance(data['path'], str)
                or not isinstance(data['sha'], str) or type(data.get('dry_run', False)) is not bool
                or not isinstance(data['actions'], list) or not 1 <= len(data['actions']) <= 100):
            raise ValueError('Send path, sha, 1–100 actions, optional source_document and boolean dry_run.')
        with self.app.lock:
            project = self.app.projects.get(self.project_id)
            if project is None:
                raise FileNotFoundError('Project session expired.')
            document_id = data.get('source_document')
            if document_id is not None and not isinstance(document_id, str):
                raise ValueError('source_document must be a document ID.')
            suffix = Path(data['path']).suffix.lower()
            document = project.doc(document_id) if document_id and suffix in ('.tex', '.bib') else None
            if document:
                project.require_active(document)
                before = project.drafts.read_file(document, data['path'])
            else:
                before = project.text_file(data['path'], document_id)
            if data['sha'] != before['sha']:
                raise ConflictError('Source changed. Read current text and SHA before retrying.', [])
        descriptors = {item['id']: item for item in action_catalog()['actions']}
        text = before['text']
        for command in data['actions']:
            if (not isinstance(command, dict) or set(command) - {'action', 'selection', 'options'}
                    or not isinstance(command.get('action'), str) or not isinstance(command.get('options', {}), dict)):
                raise ValueError('Each action accepts action, selection and options.')
            action, options = command['action'], command.get('options', {})
            if action in ('text.save', 'text.undo', 'text.redo'):
                if set(options) != {'text'} or not isinstance(options['text'], str):
                    raise ValueError('Snapshot actions require options.text.')
                text = options['text']
            else:
                descriptor = descriptors.get(action)
                if descriptor is None or suffix not in descriptor['extensions']:
                    raise ValueError('Unknown or incompatible source action: ' + action)
                if set(options) - set(descriptor['options']):
                    raise ValueError('Unsupported options for ' + action)
                start, end = selection(text, command.get('selection')) if descriptor['requires_selection'] else (0, 0)
                result = run_toolbar({'text': text, 'command': command, 'start': start, 'end': end})
                text = text[:start] + contents(result['headings'], text) + text[end:] if 'headings' in result else result['text']
            if '\0' in text or len(text.encode('utf-8')) > LIMIT:
                raise ValueError('Source must contain no NUL bytes and fit within 10 MB.')
        with self.app.lock:
            if self.app.projects.get(self.project_id) is not project:
                raise ConflictError('Project session changed during the operation.', [])
            if document:
                project.require_active(document)
                current = project.drafts.read_file(document, data['path'])
            else:
                current = project.text_file(data['path'], document_id)
            if current['sha'] != before['sha']:
                raise ConflictError('Source changed during the operation; no actions were saved.', [])
            persisted = not data.get('dry_run', False)
            if persisted and text != before['text']:
                if document:
                    project.drafts.write_file(document, data['path'], text, before['sha'])
                else:
                    project.text_file(data['path'], document_id, {'text': text, 'sha': before['sha']})
        return {'file': before['file'], 'text': text, 'sha': hashlib.sha256(text.encode()).hexdigest(),
                'base_sha': before['sha'], 'persisted': persisted, 'changed': text != before['text'],
                'offset_encoding': 'unicode-code-points',
                'undo': {'action': 'text.undo', 'options': {'text': before['text']}},
                'redo': {'action': 'text.redo', 'options': {'text': text}}}
