"""Direct HTTP client workflows for standalone and linked LaTeX source edits."""
import json
from pathlib import Path
import subprocess
import sys
import unittest

import http_fixture
import test_markup


class SourceApiTests(unittest.TestCase):
    setUp = http_fixture.setup
    tearDown = http_fixture.teardown
    request = http_fixture.request
    paper = test_markup.MarkupTests.paper

    def call(self, method, path, data=None, expected=200, **options):
        """Exercise the actual authentication, dispatch and serialization boundary.

        @param method,path,data,expected,options: Request and expected status.
        @pre Isolated session exists. @post Expected status checked; writes persist.
        @return dict: Decoded response. @throws AssertionError: Contract mismatch.
        """
        code, body = self.request(method, path, data, **options)
        self.assertEqual(code, expected, body)
        return json.loads(body)

    def test_create_add_append_edit_and_stale_save_without_pdf_or_git(self):
        """Verify real standalone text editing and concurrent-write preservation.

        @param None. @pre Empty project. @post Exact Unicode/LaTeX bytes saved;
        stale and unauthorized writes preserve them; no PDF or Git is created.
        @return None. @throws AssertionError: Save or preservation regression.
        """
        p = '/api/projects/' + self.key
        self.call('POST', p + '/entries', {'kind': 'file', 'name': 'main.tex'}, 201)
        route = p + '/text-file'
        current = self.call('GET', route + '?path=main.tex')
        initial = '\\documentclass{article}\r\n\\begin{document}\r\nCafé.\r\n'
        current = self.call('PUT', route, {'path': 'main.tex', 'sha': current['sha'], 'text': initial})
        old_sha = current['sha']
        appended = current['text'] + 'Additional paragraph.\r\n\\end{document}\r\n'
        current = self.call('PUT', route, {'path': 'main.tex', 'sha': old_sha, 'text': appended})
        edited = current['text'].replace('Café.', 'Revised café text.')
        self.call('PUT', route, {'path': 'main.tex', 'sha': current['sha'], 'text': edited})
        self.call('PUT', route, {'path': 'main.tex', 'sha': old_sha, 'text': 'stale'}, 409)
        self.call('PUT', route, {'path': 'main.tex', 'sha': current['sha'], 'text': 'unauthorized'}, 403, token=False)
        self.assertEqual((self.folder / 'main.tex').read_bytes(), edited.encode())
        self.assertEqual(self.project.documents(), [])
        self.assertFalse((self.folder / '.git').exists())

    def test_linked_file_creation_editing_review_and_stale_write(self):
        """Verify linked source saves preserve review and require a current revision.

        @param None. @pre Isolated Git-linked paper. @post New and edited source
        is persisted with tracked changes; stale writes leave text untouched.
        @return None. @throws AssertionError: Linked source contract mismatch.
        """
        self.paper(linked=True)
        p = '/api/projects/' + self.key
        d = self.base + '/' + self.doc['id'] + '/draft'
        current = self.call('GET', d + '/file?path=main.tex')
        changed = current['text'].replace('Unique words.', 'Edited source text. Added sentence.')
        result = self.call('PUT', d + '/file', {'path': 'main.tex', 'sha': current['sha'], 'text': changed})
        self.assertTrue(result['changes'])
        self.call('PUT', d + '/file', {'path': 'main.tex', 'sha': current['sha'], 'text': 'stale'}, 422)
        self.assertEqual((self.source / 'main.tex').read_text(), changed)
        self.call('PUT', p + '/text-file', {'path': 'main.tex', 'source_document': self.doc['id'], 'sha': result['sha'], 'text': 'bypass'}, 400)
        self.call('POST', p + '/entries', {'kind': 'file', 'name': 'new.tex', 'source_document': self.doc['id']}, 201)
        created = self.call('GET', d + '/file?path=new.tex')
        self.call('PUT', d + '/file', {'path': 'new.tex', 'sha': created['sha'], 'text': '\\section{New}\nText added through HTTP.\n'})
        self.assertIn('Text added through HTTP.', (self.source / 'new.tex').read_text())

    def test_client_guides_are_served_with_local_authorization(self):
        """Verify discoverable client contracts and confined documentation serving.

        @param None. @pre Installed guides. @post Reads match repository bytes;
        foreign hosts/origins and arbitrary repository paths remain inaccessible.
        @return None. @throws AssertionError: Exposure or guide routing regression.
        """
        root = Path(__file__).resolve().parents[1]
        for name in ('llms.txt', 'API.md'):
            code, body = self.request('GET', '/' + name)
            self.assertEqual(code, 200)
            self.assertEqual(body, (root / name).read_bytes())
            self.assertEqual(self.request('GET', '/' + name, headers={'Origin': 'https://foreign.invalid'})[0], 403)
        self.assertEqual(self.request('GET', '/CONTRIBUTING.md')[0], 404)
        self.assertEqual(self.request('GET', '/llms.txt/../research_workbench.py')[0], 404)

    def test_renamed_launcher_works_from_unrelated_directory(self):
        """Verify both public launch commands without starting a network listener.

        @param None. @pre Python 3.10+ source checkout. @post Help succeeds and
        temporary settings are untouched. @return None. @throws AssertionError,
        CalledProcessError: Launcher regression.
        """
        root = Path(__file__).resolve().parents[1]
        result = subprocess.run([sys.executable, str(root / 'research_workbench.py'), '--help'],
                                cwd=self.temp.name, check=True, capture_output=True, text=True)
        self.assertIn('Research Workbench', result.stdout)
        result = subprocess.run([sys.executable, '-m', 'research_workbench', '--help'],
                                cwd=root, check=True, capture_output=True, text=True)
        self.assertIn('--settings', result.stdout)
