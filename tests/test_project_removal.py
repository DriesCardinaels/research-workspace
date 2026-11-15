"""Registration removal through real handlers; project contents must remain intact."""
import json
from pathlib import Path
import shutil
import unittest
from unittest.mock import patch

import http_fixture
from research_workbench.launcher import App
from test_editor import sample_pdf


class ProjectRemovalTests(unittest.TestCase):
    setUp = http_fixture.setup
    tearDown = http_fixture.teardown
    request = http_fixture.request

    def remove(self, key=None, status=200, **options):
        """@param key,status,options: Expected request. @pre Isolated fixture.
        @post HTTP result checked. @return Parsed result. @throws AssertionError: Mismatch.
        """
        code, body = self.request('DELETE', '/api/projects/' + (key or self.key), **options)
        self.assertEqual(code, status, body)
        return json.loads(body)

    def test_removal_preserves_every_file_and_readding_restores_project(self):
        """@pre Versioned PDF and source in fixture. @post Only registration disappears.
        @return None. @throws AssertionError: Data loss or persistence regression.
        """
        document = self.project.import_pdf('paper.pdf', sample_pdf())
        (self.folder / 'main.tex').write_text('Preserve source')
        before = {str(path.relative_to(self.folder)): path.read_bytes() for path in self.folder.rglob('*') if path.is_file()}
        result = self.remove()
        self.assertEqual(result['removed'], self.key)
        self.assertEqual(result['projects'], [])
        self.assertNotIn(self.key, self.app.projects)
        self.assertEqual(self.app.last_folder, '')
        self.assertEqual(App(self.app.settings).project_list(), [])
        after = {str(path.relative_to(self.folder)): path.read_bytes() for path in self.folder.rglob('*') if path.is_file()}
        self.assertEqual(after, before)
        key, reopened = self.app.choose(str(self.folder))
        self.assertEqual(key, self.key)
        self.assertEqual(reopened.doc(document['id'])['id'], document['id'])

    def test_unavailable_unloaded_project_can_be_removed_without_recreation(self):
        """@pre Registered root disappears and server restarts. @post Missing folder stays absent.
        @return None. @throws AssertionError: Incorrect route or recreation.
        """
        missing = Path(self.temp.name) / 'missing'
        key, _ = self.app.choose(str(missing))
        shutil.rmtree(missing)
        self.app = App(self.app.settings)
        self.server.app = self.app
        self.assertNotIn(key, self.app.projects)
        self.remove(key)
        self.assertFalse(missing.exists())
        self.assertEqual([item['id'] for item in App(self.app.settings).project_list()], [self.key])

    def test_nonactive_removal_preserves_current_project_and_last_folder(self):
        """@pre Two registered projects. @post Removing the other does not change the active root.
        @return None. @throws AssertionError: Unrelated state changed.
        """
        other = Path(self.temp.name) / 'other'
        other_key, _ = self.app.choose(str(other))
        self.app.choose(str(self.folder))
        self.remove(other_key)
        self.assertEqual(self.app.last_folder, str(self.folder.resolve()))
        self.assertIs(self.app.projects[self.key], self.project)
        self.assertTrue(other.is_dir())

    def test_failure_rolls_back_memory_and_persisted_registry(self):
        """@pre Settings publication fails. @post The open session and registry remain usable.
        @return None. @throws AssertionError: Partial removal.
        """
        before = self.app.settings.read_bytes()
        with patch('research_workbench.application.sessions.atomic', side_effect=OSError('fixture write failure')):
            self.remove(status=500)
        self.assertEqual(self.app.settings.read_bytes(), before)
        self.assertEqual(self.app.last_folder, str(self.folder.resolve()))
        self.assertEqual([item['id'] for item in self.app.project_list()], [self.key])
        self.assertIs(self.app.projects[self.key], self.project)

    def test_authorization_and_unknown_project_leave_registry_unchanged(self):
        """@pre Unauthorized/unknown removal. @post No registrations or files change.
        @return None. @throws AssertionError: Authorization bypass.
        """
        before = self.app.settings.read_bytes()
        self.remove(status=403, token=False)
        self.remove('unknown', status=404)
        self.remove(status=403, headers={'Origin': 'https://foreign.example'})
        self.assertEqual(self.app.settings.read_bytes(), before)
