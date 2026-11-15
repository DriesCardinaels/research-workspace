"""Explorer HTTP regressions: preservation, confinement, authentication and moving trees."""
import json
import unittest
from pathlib import Path
from unittest.mock import patch
import http_fixture


class EntryManipulationTests(unittest.TestCase):
    setUp = http_fixture.setup
    tearDown = http_fixture.teardown
    request = http_fixture.request

    def change(self, path, operation='move', destination=None, status=200, **extra):
        """@param path,operation,destination,status,extra: HTTP contract.
        @pre Isolated project. @post Expected status asserted. @return JSON response.
        @throws AssertionError: Unexpected behavior.
        """
        data = {'path': path, 'operation': operation, **extra}
        if destination is not None:
            data['destination'] = destination
        code, body = self.request('PATCH', '/api/projects/' + self.key + '/entries', data)
        self.assertEqual(code, status, body)
        return json.loads(body)

    def test_move_nested_tree_rename_and_recover_delete(self):
        """@pre Nested files. @post Moves retain bytes; deletion remains recoverable.
        @return None. @throws AssertionError: Content or operation regression.
        """
        (self.folder / 'a/nested').mkdir(parents=True)
        (self.folder / 'b').mkdir()
        (self.folder / 'a/nested/data.bin').write_bytes(b'\x00\xffcontents')
        self.change('a', destination='b/renamed')
        self.assertFalse((self.folder / 'a').exists())
        self.change('b/renamed/nested/data.bin', destination='b/data.bin')
        result = self.change('b', 'delete')
        self.assertFalse((self.folder / 'b').exists())
        self.assertEqual((Path(result['recovery_path']) / 'data.bin').read_bytes(), b'\x00\xffcontents')
        self.assertNotIn('trash', str(self.project.tree()))

    def test_cycles_collisions_and_invalid_destinations_preserve_sources(self):
        """@pre Existing folders. @post Bad moves do not alter contents.
        @return None. @throws AssertionError: Preservation failure.
        """
        (self.folder / 'a/child').mkdir(parents=True)
        (self.folder / 'existing').write_text('preserve')
        self.change('a', destination='a/child/a', status=400)
        self.change('a', destination='EXISTING', status=409)
        self.change('a', destination='absent/a', status=404)
        self.change('a', destination='a')
        for path in ('../escape', '/tmp', '.research-workbench', 'originals', 'versions', 'annotated', 'a/../existing', ''):
            self.change(path, 'delete', status=400)
        for target in ('../escape', '/tmp/a', 'a/../escape', '.hidden', 'versions', 'bad\\name', 'a/.hidden/x'):
            self.change('existing', destination=target, status=400)
        self.assertEqual((self.folder / 'existing').read_text(), 'preserve')

    def test_symlinks_auth_unknown_fields_and_disk_failure(self):
        """@pre Outside directory and valid source. @post No escape or unauthorized mutation.
        @return None. @throws AssertionError: Safety regression.
        """
        outside = Path(self.temp.name) / 'outside'
        outside.mkdir()
        (self.folder / 'link').symlink_to(outside)
        (self.folder / 'note.txt').write_text('preserve')
        self.change('link', 'delete', status=400)
        self.change('note.txt', destination='link/note.txt', status=400)
        self.change('note.txt', destination='new.txt', unknown=True, status=400)
        route = '/api/projects/' + self.key + '/entries'
        self.assertEqual(self.request('PATCH', route, {'path': 'note.txt', 'operation': 'delete'}, token=False)[0], 403)
        with patch('research_workbench.application.entries.shutil.move', side_effect=OSError('disk failure')):
            self.change('note.txt', 'delete', status=500)
        self.assertEqual((self.folder / 'note.txt').read_text(), 'preserve')
        self.assertFalse(list(outside.iterdir()))

    def test_linked_owner_and_main_protection(self):
        """@pre Linked source. @post Ordinary files move; configured main stays intact.
        @return None. @throws AssertionError: Source routing regression.
        """
        import test_standalone_latex as fixture
        fixture.StandaloneLatexTests.git_source(self)
        with patch.object(self.project.drafts, 'latexmk', side_effect=fixture.StandaloneLatexTests.build):
            code, body = self.request('POST', '/api/projects/' + self.key + '/latex/compile', {'path': 'main.tex'})
        self.assertEqual(code, 200, body)
        doc = json.loads(body)['document']['id']
        (self.folder / 'notes.txt').write_text('notes')
        self.change('notes.txt', destination='renamed.txt', source_document=doc)
        self.assertEqual((self.folder / 'renamed.txt').read_text(), 'notes')
        self.change('main.tex', 'delete', source_document=doc, status=400)
        self.assertTrue((self.folder / 'main.tex').exists())

    def test_finder_reveal_for_root_files_folders_and_review_snapshots(self):
        """@pre Authorized project entries. @post Exact targets passed to Finder; nothing deleted.
        @return None. @throws AssertionError: Reveal routing or preservation regression.
        """
        from types import SimpleNamespace
        from test_editor import sample_pdf
        (self.folder / 'notes.txt').write_text('keep')
        (self.folder / 'folder').mkdir()
        doc = self.project.import_pdf('review.pdf', sample_pdf())
        route = '/api/projects/' + self.key + '/entries/reveal'
        before = self.project.index_path.read_bytes()
        with patch('research_workbench.application.entries.sys.platform', 'darwin'), patch('research_workbench.application.entries.subprocess.run', return_value=SimpleNamespace(returncode=0)) as launch:
            for payload, target in (({'path': ''}, self.folder),
                                    ({'path': 'notes.txt'}, self.folder / 'notes.txt'),
                                    ({'path': 'folder'}, self.folder / 'folder'),
                                    ({'document': doc['id']}, self.project.path(doc, 'original'))):
                code, body = self.request('POST', route, payload)
                self.assertEqual(code, 200, body)
                self.assertTrue(json.loads(body)['revealed'])
                self.assertEqual(launch.call_args.args[0], ['/usr/bin/open', '-R', str(target.resolve())])
            launch.reset_mock()
            for payload in ({'path': '../'}, {'path': '.research-workbench'}, {'path': 'originals'},
                            {'path': 'notes.txt', 'extra': True}, {'document': doc['id'], 'path': 'notes.txt'}):
                self.assertEqual(self.request('POST', route, payload)[0], 400)
            self.assertEqual(self.request('POST', route, {'path': ''}, token=False)[0], 403)
            self.assertEqual(self.request('POST', route, {'path': 'missing'})[0], 404)
            launch.assert_not_called()
        self.assertEqual(self.project.index_path.read_bytes(), before)
        self.assertEqual((self.folder / 'notes.txt').read_text(), 'keep')
        self.change('', 'delete', status=400)

    def test_finder_launcher_failure_and_unsupported_platform(self):
        """@pre Valid root. @post Launcher failure becomes a visible HTTP error.
        @return None. @throws AssertionError: Error boundary regression.
        """
        import subprocess
        from types import SimpleNamespace
        route = '/api/projects/' + self.key + '/entries/reveal'
        with patch('research_workbench.application.entries.sys.platform', 'darwin'), patch('research_workbench.application.entries.subprocess.run', return_value=SimpleNamespace(returncode=1)):
            self.assertEqual(self.request('POST', route, {'path': ''})[0], 400)
        with patch('research_workbench.application.entries.sys.platform', 'darwin'), patch('research_workbench.application.entries.subprocess.run', side_effect=subprocess.TimeoutExpired('open', 10)):
            self.assertEqual(self.request('POST', route, {'path': ''})[0], 400)
        with patch('research_workbench.application.entries.sys.platform', 'linux'), patch('research_workbench.application.entries.subprocess.run') as launch:
            self.assertEqual(self.request('POST', route, {'path': ''})[0], 400)
            launch.assert_not_called()
