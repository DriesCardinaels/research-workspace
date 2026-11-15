"""All markup types, exact source anchoring, concurrent saves."""
import copy
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

import http_fixture
import test_editor
from research_workbench.launcher import Project


class MarkupTests(unittest.TestCase):
    setUp = http_fixture.setup
    tearDown = http_fixture.teardown
    request = http_fixture.request

    def paper(self, linked=False):
        """Make a fixture PDF, optionally linked to Unicode source in git.
        Pre: setup; post: current document and API URL. Git/file failures propagate.
        """
        self.doc = self.project.import_pdf('paper.pdf', test_editor.sample_pdf())
        self.url = self.base + '/' + self.doc['id'] + '/markup'
        if linked:
            self.source = Path(self.temp.name) / 'source'
            self.source.mkdir()
            self.text = '\\documentclass{article}\n\\begin{document}\n😀 repeated phrase. Another repeated phrase. Unique words.\n\\end{document}\n'
            (self.source / 'main.tex').write_text(self.text)
            for command in [('init', '-q'), ('add', '.'), ('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture')]:
                subprocess.run(['git', '-C', str(self.source), *command], check=True, capture_output=True)
            commit = subprocess.check_output(['git', '-C', str(self.source), 'rev-parse', 'HEAD'], text=True).strip()
            self.project.drafts.link(self.doc, str(self.source), 'main.tex', commit)
            self.doc = self.project.doc(self.doc['id'])
        return self.doc

    def call(self, method='GET', suffix='', data=None, expected=200):
        """Call the markup HTTP route. Pre: paper; post: decoded response.
        Asserts the expected HTTP status; full Handler errors remain visible.
        """
        code, body = self.request(method, self.url + suffix, data)
        self.assertEqual(code, expected, body)
        return json.loads(body)

    def create(self, kind='highlight', **kwargs):
        """Create a fixture mark. Pre: paper; post: API record; assertions propagate.
        Text targets use real source quotes or scale-1 PDF rectangles.
        """
        target = ({'file': 'main.tex', 'quote': 'Unique words'} if hasattr(self, 'source') else
                  {'quote': 'Research Workbench test document', 'rects': [{'p': 1, 'x': 60, 'y': 52, 'w': 100, 'h': 20}]})
        data = {'kind': kind, **({} if kind == 'pen' else {'target': target}), **kwargs}
        return self.call('POST', data=data, expected=201)

    def test_pdf_all_tools_replies_erase_persistence(self):
        self.paper()
        for color in ('yellow', 'green', 'blue', 'pink'):
            mark = self.create(color=color)
            self.assertEqual(mark['record']['color'], color)
        comment = self.create('comment', text='Explain this.', author='Codex')
        self.create('strikethrough')
        replacement = self.create('replace', replacement='New words', text='Reason.')
        self.assertEqual(replacement['record']['intent'], 'replace')
        self.assertEqual(replacement['record']['comments'][0]['text'], 'Replacement: New words\n\nReason.')
        pen = self.create('pen', page=1, points=[[12, 13], [18, 30]], width=2.5, color='#1971c2')
        reply = self.call('POST', '/' + comment['id'] + '/comments', {'text': 'A reply', 'author': 'Reviewer'})
        self.assertEqual([c['author'] for c in reply['record']['comments']], ['Codex', 'Reviewer'])
        self.assertEqual(len(self.call()['items']), 8)
        self.call('DELETE', '/' + pen['id'])
        self.assertEqual(len(self.call()['items']), 7)
        reopened = Project(self.folder)
        self.assertEqual(len(reopened.annotations(reopened.doc(self.doc['id']))['highlights']), 7)
        self.assertEqual(self.project.path(self.doc, 'original').read_bytes(), test_editor.sample_pdf())

    def test_draft_all_tools_status_and_source_preservation(self):
        self.paper(linked=True)
        for color in ('yellow', 'green', 'blue', 'pink'):
            self.create(color=color)
        comment = self.create('comment', text='Clarify.', author='Codex')
        self.create('strikethrough')
        self.create('replace', replacement='Suggested words')
        pen = self.create('pen', page=1, points=[[1, 2]], width=1, color='#20252d',
                          anchor={'words': ['Unique'], 'context': [], 'dx': -2, 'dy': 0})
        self.assertEqual(comment['scope'], 'draft')
        self.assertEqual(comment['record']['start'], self.text.index('Unique words'))
        self.call('POST', '/' + comment['id'] + '/comments', {'text': 'Reply.'})
        resolved = self.call('POST', '/' + comment['id'] + '/status', {'status': 'resolved'})
        self.assertEqual(resolved['record']['status'], 'resolved')
        self.call('POST', '/' + comment['id'] + '/status', {'status': 'open'})
        self.call('DELETE', '/' + pen['id'])
        self.call('POST', '/' + pen['id'] + '/status', {'status': 'open'})
        result = self.call()
        self.assertEqual(result['files'], ['main.tex'])
        self.assertEqual(len(result['items']), 8)
        self.assertEqual((self.source / 'main.tex').read_text(), self.text)
        self.assertEqual(self.project.annotations(self.doc)['highlights'], [])

    def test_ambiguous_stale_unicode_and_unsafe_source_targets(self):
        self.paper(linked=True)
        data = {'kind': 'highlight', 'target': {'file': 'main.tex', 'quote': 'repeated phrase'}}
        self.call('POST', data=data, expected=409)
        chosen = self.call('POST', data={**data, 'target': {**data['target'], 'occurrence': 2}}, expected=201)
        self.assertEqual(chosen['record']['start'], self.text.rindex('repeated phrase'))
        self.call('POST', data={**data, 'target': {**data['target'], 'start': 1, 'end': 5}}, expected=409)
        self.call('POST', data={**data, 'target': {**data['target'], 'file': '../outside.tex'}}, expected=422)
        self.call('POST', data={**data, 'target': {**data['target'], 'occurrence': 9}}, expected=409)
        start = self.text.index('Unique words')
        exact = self.create(target={'file': 'main.tex', 'quote': 'Unique words', 'start': start, 'end': start + 12})
        self.assertEqual(exact['record']['quote'], 'Unique words')
        self.assertEqual(len(self.call()['items']), 2)

    def test_invalid_requests_never_write(self):
        self.paper()
        before = self.project.path(self.doc, 'annotations').read_bytes()
        invalid = [[], {'kind': 'underline'}, {'kind': 'comment'}, {'kind': 'replace'},
                   {'kind': 'highlight', 'unexpected': 1},
                   {'kind': 'pen', 'page': True, 'points': [[1, 2]], 'width': 1, 'color': '#123456'},
                   {'kind': 'pen', 'page': 1, 'points': [[float('nan'), 2]], 'width': 1, 'color': '#123456'},
                   {'kind': 'pen', 'page': 1, 'points': [[1, 2]], 'width': -1, 'color': '#123456'},
                   {'kind': 'highlight', 'target': {'quote': 'x', 'rects': [{'p': 1, 'x': 0, 'y': 0, 'w': -1, 'h': 1}]}}]
        for data in invalid:
            self.call('POST', data=data, expected=400)
            self.assertEqual(self.project.path(self.doc, 'annotations').read_bytes(), before)
        self.assertEqual(self.request('POST', self.url, {'kind': 'comment'}, token=False)[0], 403)
        self.assertEqual(self.request('GET', self.url, headers={'Origin': 'https://example.com'})[0], 403)
        self.call('GET', '?scope=invalid', expected=400)

    def test_archived_and_wrong_document_rejected(self):
        old = self.paper(linked=True)
        self.project.import_pdf('paper.pdf', test_editor.sample_pdf(), version_of=old['id'])
        self.call('POST', data={'kind': 'highlight'}, expected=409)
        self.call('GET', '?scope=draft', expected=409)
        self.assertEqual(self.call()['scope'], 'pdf')
        code, _ = self.request('POST', self.base + '/' + '0' * 32 + '/markup', {'kind': 'highlight'})
        self.assertEqual(code, 404)

    def test_api_and_visual_saves_merge_and_conflict(self):
        self.paper()
        first = self.create()
        base = self.project.annotations(self.doc)
        local = copy.deepcopy(base)
        local['highlights'][0]['color'] = 'blue'
        remote = self.create('comment', text='Added by another client')
        url = self.base + '/' + self.doc['id'] + '/annotations'
        code, body = self.request('PUT', url, {**local, 'base': base})
        self.assertEqual(code, 200, body)
        saved = json.loads(body)['annotations']
        self.assertEqual(len(saved['highlights']), 2)
        self.assertEqual(saved['highlights'][0]['color'], 'blue')
        self.assertEqual(saved['highlights'][1]['id'], remote['record']['id'])
        self.call('POST', '/' + first['id'] + '/comments', {'text': 'Concurrent reply'})
        local = copy.deepcopy(saved)
        local['highlights'][0]['color'] = 'pink'
        self.assertEqual(self.request('PUT', url, {**local, 'base': saved})[0], 409)
        self.assertEqual(self.project.annotations(self.doc)['highlights'][0]['comments'][0]['text'], 'Concurrent reply')

    def test_revision_changes_after_write_and_export_becomes_stale(self):
        self.paper()
        before = self.call(suffix='/revision')
        self.project.export(self.doc, test_editor.sample_pdf())
        self.create()
        self.assertNotEqual(before['revision'], self.call(suffix='/revision')['revision'])
        self.assertTrue(self.project.doc(self.doc['id'])['export_stale'])

    def test_tracked_changes_support_replies_and_acceptance(self):
        self.paper(linked=True)
        (self.source / 'main.tex').write_text(self.text.replace('Unique words', 'Different words'))
        change = next(x for x in self.call()['items'] if x['kind'] == 'change')
        self.call('POST', '/' + change['id'] + '/comments', {'text': 'Checked.'})
        accepted = self.call('POST', '/' + change['id'] + '/status', {'status': 'accepted'})
        self.assertEqual(accepted['record']['status'], 'accepted')



if __name__ == '__main__':
    unittest.main()
