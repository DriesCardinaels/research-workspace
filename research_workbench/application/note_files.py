"""SHA-checked note toolbar transactions, backed by the existing confined text-file owner."""
import hashlib
from pathlib import Path
import shutil
import subprocess
import tempfile
import unicodedata
from urllib.parse import urlencode

from research_workbench.domain.errors import ConflictError
from research_workbench.domain.note_tools import annotations, apply_action, source_location


class NoteFiles:
    """Own note API content operations without accessing browser buffers/history."""

    def __init__(self, project, project_id):
        """Bind an authorized project. Pre: project resolved by transport.
        Post: no IO. Raises no exceptions. Related: ProjectRoutes.
        """
        self.project, self.project_id = project, project_id

    def read(self, path, source_document=None):
        """Read note source and annotation records. Pre: application lock held.
        Post: no mutations. Returns a text snapshot with source code-point ranges.
        Raises ValueError/OSError for unsupported/confined/missing files.
        """
        if not isinstance(path, str) or Path(path).suffix.lower() != '.txt':
            raise ValueError('Note toolbar actions require an existing .txt file.')
        if source_document is not None and (not isinstance(source_document, str) or not source_document):
            raise ValueError('Choose a nonempty linked source document ID or omit source_document.')
        snapshot = self.project.text_file(path, source_document)
        return {**snapshot, **annotations(snapshot['text']), 'offset_encoding': 'unicode-code-points',
                'format': 'workbench-note-markdown'}

    def actions(self, data):
        """Validate and publish an entire action batch once. Pre: app lock held.
        Post: one atomic save or no file change on any failure/dry-run; no review/version
        side effects. Returns proposed/persisted SHA plus reversible snapshots.
        Raises ValueError/ConflictError/OSError for invalid, stale or failed edits.
        """
        if (not isinstance(data, dict) or set(data) - {'path', 'source_document', 'sha', 'actions', 'dry_run'}
                or not {'path', 'sha', 'actions'} <= set(data) or not isinstance(data['sha'], str)
                or type(data.get('dry_run', False)) is not bool or not isinstance(data['actions'], list)
                or not 1 <= len(data['actions']) <= 100):
            raise ValueError('Send path, sha, 1–100 actions, optional source_document and boolean dry_run.')
        before = self.read(data['path'], data.get('source_document'))
        if before['sha'] != data['sha']:
            raise ConflictError('This note changed. Read its current text and SHA before retrying.', [])
        text = before['text']
        tree = None
        for command in data['actions']:
            link = None
            if isinstance(command, dict) and command.get('action') == 'notes.pdfSource':
                options = command.get('options', {})
                if not isinstance(options, dict):
                    raise ValueError('PDF source options must be an object.')
                document = self.pdf_document(options.get('document'))
                page = options.get('page')
                if type(page) is not int or page < 1 or page > 9007199254740991:
                    raise ValueError('Provide a positive physical PDF page number. Use note-sources/locate to find an unknown page.')
                href = source_location(self._pdf_url(document) + '#page=' + str(page), options.get('color', 'blue'), options.get('match'), options.get('kind'))
                link = '[' + ('Context' if options.get('kind') == 'context' else 'Source') + ' p. ' + str(page) + '](' + href + ')'
            if isinstance(command, dict) and command.get('action') == 'notes.fileSource':
                if tree is None:
                    tree = self.project.tree()['children']
                link = self._file_link(tree, command.get('options'))
            text = apply_action(text, command, link)
            if '\0' in text or len(text.encode('utf-8')) > 10 * 1024 * 1024:
                raise ValueError('Notes must be UTF-8 text without binary data, at most 10 MB.')
        digest = hashlib.sha256(text.encode('utf-8')).hexdigest()
        dry_run = data.get('dry_run', False)
        if not dry_run and text != before['text']:
            self.project.text_file(data['path'], data.get('source_document'), {'text': text, 'sha': before['sha']})
        return {'file': before['file'], 'text': text, 'sha': digest, 'base_sha': before['sha'],
                'persisted': not dry_run, 'changed': text != before['text'], 'offset_encoding': 'unicode-code-points',
                **annotations(text), 'undo': {'action': 'text.undo', 'options': {'text': before['text']}},
                'redo': {'action': 'text.redo', 'options': {'text': text}}}

    def _file_link(self, tree, options):
        """Resolve and serialize exactly one visible project tree file.
        Pre: authorized tree snapshot. Post: emits Markdown without importing any PDF.
        Raises ValueError or FileNotFoundError for malformed or missing addresses.
        Related: browser NoteSources.projectFileLink.
        """
        if (not isinstance(options, dict) or set(options) not in ({'document'}, {'path'}, {'path', 'source_document'})
                or not all(isinstance(value, str) and value for value in options.values())):
            raise ValueError('Choose a project path with optional source_document, or a managed PDF document ID.')
        pending = [(entry, None) for entry in reversed(tree)]
        while pending:
            entry, owner = pending.pop()
            if 'children' in entry:
                child_owner = entry.get('source_document') or entry.get('document') or owner
                pending.extend((child, child_owner) for child in reversed(entry['children']))
                continue
            if 'document' in options:
                matches = entry['kind'] == 'pdf' and entry.get('document') == options['document']
            else:
                matches = (entry['kind'] == 'file' and entry.get('path') == options['path']
                           and owner == options.get('source_document'))
            if matches:
                label = entry['name'].replace('\r', ' ').replace('\n', ' ').replace('\\', '\\\\').replace('[', '\\[').replace(']', '\\]')
                address = {key: options[key] for key in ('document', 'path', 'source_document') if key in options}
                query = urlencode(address, safe='*').replace('~', '%7E')
                return f'[{label}](#project-file?{query})'
        raise FileNotFoundError('Project file not found in the current tree.')

    def _pdf_url(self, document):
        """Build a current-project PDF route. Pre: authorized document snapshot.
        Post: no IO. Returns local URL. Raises no exceptions. Related: PDF source links.
        """
        return '/api/projects/' + self.project_id + '/documents/' + document['id'] + '/original'

    def pdf_document(self, document_id):
        """Resolve an active PDF in this project. Pre: app lock held.
        Post: no mutation. Raises ValueError/FileNotFoundError/ConflictError for bad IDs.
        Related: explicit source links and quote lookup preparation.
        """
        if not isinstance(document_id, str):
            raise ValueError('Choose an active PDF document ID from note-sources.')
        document = self.project.doc(document_id)
        self.project.require_active(document)
        return document

    def sources(self):
        """List active PDF sources and optional quote lookup availability.
        Pre: app lock held. Post: no imports or mutations. Returns detached records.
        Raises filesystem errors from the project owner. Related: open-file for raw PDFs.
        """
        return {'sources': [{'document': doc['id'], 'label': doc['name'], 'url': self._pdf_url(doc)}
                            for doc in self.project.documents() if doc['active']],
                'quote_lookup_available': shutil.which('pdftotext') is not None,
                'quote_lookup_dependency': 'Poppler pdftotext (optional)'}

    def prepare_lookup(self, data):
        """Snapshot an immutable PDF location for unlocked extraction.
        Pre: app lock held; authenticated request. Post: no writes/imports.
        Returns (path, plain quote, base URL). Raises ValueError/ConflictError on invalid data.
        """
        if (not isinstance(data, dict) or set(data) != {'document', 'quote'}
                or not isinstance(data['quote'], str) or len(data['quote']) > 100000):
            raise ValueError('Quote lookup requires only an active document ID and quote text (at most 100,000 characters).')
        if len(normalize_quote(data['quote'])) < 12:
            raise ValueError('Provide a longer quote (at least 12 letters/numbers), or choose an explicit page.')
        document = self.pdf_document(data['document'])
        return self.project.path(document, 'original'), data['quote'], self._pdf_url(document)


def normalize_quote(text):
    """Normalize searchable quote typography. Pre: text string.
    Post: no mutations; Unicode letters/numbers retained, punctuation/marks ignored.
    Raises no exceptions. Related: browser NoteSources.normalize.
    """
    return ''.join(char for char in unicodedata.normalize('NFKD', text).lower()
                   if unicodedata.category(char)[0] in ('L', 'N'))


def locate_quote(path, quote, url):
    """Find every physical PDF page matching a quote, without the app lock.
    Pre: authorized immutable original path. Post: PDF/note unchanged, temp output closed.
    Returns all pages/URLs; ambiguity is explicit. Requires optional Poppler pdftotext.
    Raises ValueError/OSError on unavailable, invalid, oversized or timed-out extraction.
    """
    executable = shutil.which('pdftotext')
    if executable is None:
        raise ValueError('Automatic PDF quote lookup requires Poppler pdftotext. Explicit source page links remain available.')
    with tempfile.TemporaryFile() as output:
        try:
            result = subprocess.run([executable, '-layout', '-enc', 'UTF-8', str(path), '-'],
                                    stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.DEVNULL, timeout=30, check=False)
        except subprocess.TimeoutExpired as error:
            raise ValueError('PDF quote lookup timed out. Use an explicit page number.') from error
        if result.returncode:
            raise ValueError('Could not extract searchable text from this PDF. Use an explicit page number.')
        if output.tell() > 32 * 1024 * 1024:
            raise ValueError('PDF text exceeds the 32 MB search limit. Use an explicit page number.')
        output.seek(0)
        text = output.read().decode('utf-8', errors='replace')
    needle = normalize_quote(quote)
    pages = [index for index, page in enumerate(text.split('\f'), 1) if needle in normalize_quote(page)]
    return {'pages': pages, 'ambiguous': len(pages) > 1, 'matches': [{'page': page, 'url': url + '#page=' + str(page)} for page in pages]}
