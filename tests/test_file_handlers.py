"""Independent filetype saves and permission checks through the real HTTP handler."""
import hashlib
import json
from pathlib import Path
from unittest.mock import patch
import unittest
from urllib.parse import urlencode

import http_fixture
from file_handlers import FileHandler, FileHandlerRegistry


class FileHandlerTests(unittest.TestCase):
    setUp = http_fixture.setup
    tearDown = http_fixture.teardown
    request = http_fixture.request

    def call(self, method='GET', path='notes.md', data=None, status=200, **options):
        """@param method,path,data: Request. @pre Isolated fixture. @post Status verified.
        @return Parsed response. @throws AssertionError: Unexpected result.
        """
        url = '/api/projects/' + self.key + '/text-file'
        if method == 'GET':
            url += '?' + urlencode({'path': path})
        code, body = self.request(method, url, data, **options)
        self.assertEqual(code, status, body)
        return json.loads(body)

    def test_exact_text_conflicts_and_no_review_side_effects(self):
        """@pre UTF-8 CRLF fixture. @post Writes preserve bytes/mode and do not create review metadata.
        @return None. @throws AssertionError: Changed behavior.
        """
        file = self.folder / 'notes.md'
        original = 'Évidence 😀\r\nSecond line\r\n'
        file.write_bytes(original.encode())
        file.chmod(0o640)
        index_before = self.project.index_path.read_bytes()
        read = self.call()
        self.assertEqual(read['text'], original)
        changed = original + 'Third\r\n'
        saved = self.call('PUT', data={'path': 'notes.md', 'text': changed, 'sha': read['sha']})
        self.assertEqual(saved['sha'], hashlib.sha256(changed.encode()).hexdigest())
        self.assertEqual(file.read_bytes(), changed.encode())
        self.assertEqual(file.stat().st_mode & 0o777, 0o640)
        self.call('PUT', data={'path': 'notes.md', 'text': 'stale', 'sha': read['sha']}, status=409)
        self.assertEqual(file.read_bytes(), changed.encode())
        self.assertEqual(self.project.index_path.read_bytes(), index_before)
        self.assertEqual(self.project.documents(), [])

    def test_confinement_binary_and_dedicated_editors(self):
        """@pre Unsafe requests. @post Files stay unchanged; dedicated draft routes cannot be bypassed.
        @return None. @throws AssertionError: Permission regression.
        """
        (self.folder / 'notes.md').write_text('keep')
        outside = Path(self.temp.name) / 'outside.md'
        outside.write_text('outside')
        (self.folder / 'link.md').symlink_to(outside)
        (self.folder / 'binary.md').write_bytes(b'a\x00b')
        (self.folder / 'invalid.md').write_bytes(b'\xff')
        for name in ('../outside.md', str(outside), 'link.md', '.private.md', 'originals/a.md', 'binary.md', 'invalid.md', 'paper.pdf', 'unknown.zzz'):
            self.call(path=name, status=400)
        self.call(path='absent.md', status=404)
        self.call('PUT', data={'path': 'notes.md', 'text': 'bad', 'sha': 'x'}, token=False, status=403)
        self.call('PUT', data={'path': 'notes.md', 'text': 'bad', 'sha': 'x', 'unexpected': True}, status=400)
        self.call('PUT', data={'path': 'notes.md', 'text': 'binary\x00', 'sha': self.call()['sha']}, status=400)
        self.assertEqual((self.folder / 'notes.md').read_text(), 'keep')
        self.assertEqual(outside.read_text(), 'outside')

    def test_provider_registration_without_route_changes(self):
        """@pre A new extension registered through the interface. @post Existing route reads/saves it.
        @return None. @throws AssertionError: Extension requires core changes.
        """
        registry = FileHandlerRegistry().register(FileHandler('notes', ('.notes',), editable=True))
        file = self.folder / 'new.notes'
        file.write_text('one')
        with patch('research_workbench.application.projects.file_handlers', registry):
            read = self.call(path=file.name)
            self.call('PUT', data={'path': file.name, 'sha': read['sha'], 'text': 'two'})
        self.assertEqual(file.read_text(), 'two')
        with self.assertRaises(ValueError):
            registry.register(FileHandler('other', ('.notes',), editable=True))
        self.assertIsNone(registry.resolve('unknown.txt'))
        self.assertEqual(registry.resolve('NEW.NOTES').id, 'notes')

    def test_failed_publication_preserves_target(self):
        """@pre Atomic replacement fails. @post Original bytes are retained and request reports failure.
        @return None. @throws AssertionError: Partial save.
        """
        file = self.folder / 'notes.md'
        file.write_text('before')
        read = self.call()
        with patch('research_workbench.infrastructure.filesystem.storage.os.replace', side_effect=OSError('fixture failure')):
            self.call('PUT', data={'path': file.name, 'text': 'after', 'sha': read['sha']}, status=500)
        self.assertEqual(file.read_text(), 'before')
