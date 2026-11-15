"""Authenticated disk creation, extension initialization and preservation regressions."""
import json
from pathlib import Path
import unittest
from unittest.mock import patch

import http_fixture
from file_handlers import FileHandler, FileHandlerRegistry


class ProjectEntryTests(unittest.TestCase):
    setUp = http_fixture.setup
    tearDown = http_fixture.teardown
    request = http_fixture.request

    def create(self, kind, name, status=201, **options):
        """POST creation through real handlers.

        @param kind,name,status,options: Entry and expected HTTP contract.
        @pre Fixture ready. @post Expected response asserted.
        @return Decoded body. @throws AssertionError: Unexpected status.
        """
        code, body = self.request('POST', '/api/projects/' + self.key + '/entries',
                                  {'kind': kind, 'name': name, **options})
        self.assertEqual(code, status, body)
        return json.loads(body)

    def test_directories_files_and_registered_initialization(self):
        """@pre Empty project. @post Nested disk entries and valid JSON; reviews unchanged.
        @return None. @throws AssertionError: Creation or navigation regression.
        """
        before = self.project.index_path.read_bytes()
        self.create('directory', 'sections')
        self.create('directory', 'nested', parent='sections')
        for name in ('intro.tex', 'references.bib', 'notes.md', 'notes.txt', 'LICENSE', 'data.custom'):
            self.create('file', name, parent='sections/nested')
            self.assertEqual((self.folder / 'sections/nested' / name).read_bytes(), b'')
        self.create('file', 'settings.JSON', parent='sections')
        self.assertEqual(json.loads((self.folder / 'sections/settings.JSON').read_text()), {})
        self.assertIn('sections', [entry['name'] for entry in self.project.tree()['children']])
        self.assertEqual(self.project.index_path.read_bytes(), before)
        registry = FileHandlerRegistry().register(FileHandler('custom', ('.custom',), editable=True, initial_text='template'))
        with patch('research_workbench.application.projects.file_handlers', registry):
            self.create('file', 'new.custom')
        self.assertEqual((self.folder / 'new.custom').read_text(), 'template')

    def test_collisions_and_failed_publication_preserve_existing_data(self):
        """@pre Existing data. @post Conflicts and disk failure never overwrite or leave staging files.
        @return None. @throws AssertionError: Preservation regression.
        """
        self.create('file', 'notes.txt')
        (self.folder / 'notes.txt').write_text('keep')
        self.create('file', 'NOTES.TXT', status=409)
        self.create('directory', 'notes.txt', status=409)
        self.assertEqual((self.folder / 'notes.txt').read_text(), 'keep')
        before = set(self.folder.iterdir())
        with patch('research_workbench.launcher.os.link', side_effect=OSError('disk failure')):
            self.create('file', 'failed.tex', status=500)
        self.assertEqual(set(self.folder.iterdir()), before)

    def test_unsafe_paths_binary_types_auth_and_unknown_fields(self):
        """@pre Untrusted requests. @post Traversal, symlinks, managed paths and binary stubs rejected.
        @return None. @throws AssertionError: Confinement or authorization regression.
        """
        for name in ('../escape', '/absolute', '.hidden', 'a/b', 'a\\b', 'versions', 'bad\x00name', ' spaced '):
            self.create('directory', name, status=400)
        for parent in ('../', '/tmp', '.research-workbench', 'originals', 'versions', 'annotated', 'a/../b'):
            self.create('file', 'escape.txt', parent=parent, status=400)
        for name in ('blank.pdf', 'blank.png', 'blank.jpg'):
            self.create('file', name, status=400)
            self.assertFalse((self.folder / name).exists())
        self.create('file', 'missing.txt', parent='absent', status=404)
        outside = Path(self.temp.name) / 'outside'
        outside.mkdir()
        (self.folder / 'link').symlink_to(outside)
        self.create('file', 'escape.txt', parent='link', status=400)
        self.assertEqual(list(outside.iterdir()), [])
        self.create('file', 'unknown.txt', status=400, unknown=True)
        route = '/api/projects/' + self.key + '/entries'
        self.assertEqual(self.request('POST', route, {'kind': 'file', 'name': 'private.txt'}, token=False)[0], 403)
        self.assertFalse((self.folder / 'private.txt').exists())

    def test_creation_inside_linked_source_uses_the_authorized_root(self):
        """@pre Active linked source. @post Entries use source root; review index unchanged.
        @return None. @throws AssertionError: Linked destination or preservation regression.
        """
        import test_standalone_latex as source_fixture
        source_fixture.StandaloneLatexTests.git_source(self)
        with patch.object(self.project.drafts, 'latexmk', side_effect=source_fixture.StandaloneLatexTests.build):
            code, body = self.request('POST', '/api/projects/' + self.key + '/latex/compile', {'path': 'main.tex'})
        self.assertEqual(code, 200, body)
        document = json.loads(body)['document']['id']
        before = self.project.index_path.read_bytes()
        self.create('directory', 'sections', source_document=document)
        self.create('file', 'methods.tex', parent='sections', source_document=document)
        self.assertTrue((self.folder / 'sections/methods.tex').is_file())
        self.assertEqual(self.project.index_path.read_bytes(), before)
