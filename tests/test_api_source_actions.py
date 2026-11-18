"""Real HTTP toolbar transactions using shared production JavaScript algorithms."""
import json
from pathlib import Path
import shutil
import unittest
from unittest.mock import patch

import http_fixture
import test_markup
from research_workbench.infrastructure.processes.toolbar import run_toolbar


@unittest.skipUnless(shutil.which('node'), 'Shared source toolbar actions require Node.js 18+')
class SourceActionTests(unittest.TestCase):
    setUp = http_fixture.setup
    tearDown = http_fixture.teardown
    request = http_fixture.request
    paper = test_markup.MarkupTests.paper

    def call(self, method, route, data=None, expected=200, **kwargs):
        """@param method,route,data,expected,kwargs: Request/expectation.
        @pre Fixture ready. @post HTTP result checked. @return dict.
        @throws AssertionError: Contract mismatch. Related: real Handler fixture.
        """
        code, body = self.request(method, route, data, **kwargs)
        self.assertEqual(code, expected, body)
        return json.loads(body)

    def edit(self, path, text, actions, **options):
        """@param path,text,actions,options: Fixture source and batch.
        @pre Isolated project. @post Source created then action submitted.
        @return dict: HTTP response. @throws AssertionError,OSError: Failure.
        """
        (self.folder / path).write_bytes(text.encode())
        p = '/api/projects/' + self.key
        current = self.call('GET', p + '/text-file?path=' + path)
        return self.call('POST', p + '/source-file/actions',
                         {'path': path, 'sha': current['sha'], 'actions': actions, **options})

    def test_every_discovered_action_executes_for_its_filetype(self):
        """@param None. @pre Shared action registry. @post All contributions exercised.
        @return None. @throws AssertionError: Missing/incompatible action or doc drift.
        """
        catalog = self.call('GET', '/api/source-tools')
        self.assertTrue(catalog['available'])
        self.assertGreater(len(catalog['actions']), 30)
        for item in catalog['actions']:
            with self.subTest(action=item['id']):
                ext = item['extensions'][0]
                text = '{"large":9007199254740993,"large":2}' if ext == '.json' else '@book{z,title={Z}}\n\n@book{a,title={A}}\n' if ext == '.bib' else 'Alpha\r\nBeta\r\n'
                command = {'action': item['id']}
                if item['id'].startswith('text.'):
                    command['options'] = {'text': text}
                if item['requires_selection']:
                    command['selection'] = {'quote': 'Alpha'}
                self.edit('test' + ext, text, [command])
        capabilities = self.call('GET', '/api/capabilities')
        self.assertEqual(capabilities['source_tools']['actions'], catalog['actions'])
        self.assertFalse(capabilities['browser_state']['supported'])
        self.assertIn('notes.pdfSource', [item['id'] for item in capabilities['note_tools']['actions']])
        root = Path(__file__).resolve().parents[1]
        for name in ('API.md', 'llms.txt'):
            self.assertIn('/api/capabilities', (root / name).read_text())
            self.assertIn('source-file/actions', (root / name).read_text())

    def test_unicode_crlf_batch_dry_run_undo_and_stale_requests(self):
        """@param None. @pre Unicode source. @post Atomicity/revisions/newlines retained.
        @return None. @throws AssertionError: Transaction regression.
        """
        text = '😀 Alpha\r\nBeta\r\n'
        command = {'action': 'markdown.bold', 'selection': {'start': 2, 'end': 7}}
        preview = self.edit('README.md', text, [command], dry_run=True)
        self.assertEqual(preview['text'], '😀 **Alpha**\r\nBeta\r\n')
        self.assertEqual((self.folder / 'README.md').read_bytes(), text.encode())
        result = self.edit('README.md', text, [command, {'action': 'markdown.italic', 'selection': {'quote': '**Alpha**'}}])
        self.assertIn('***Alpha***', result['text'])
        endpoint = '/api/projects/' + self.key + '/source-file/actions'
        payload = {'path': 'README.md', 'sha': result['sha'], 'actions': [result['undo']]}
        undone = self.call('POST', endpoint, payload)
        self.assertEqual(undone['text'], text)
        self.call('POST', endpoint, payload, 409)
        self.call('POST', endpoint, {**payload, 'sha': undone['sha']}, 403, token=False)
        self.call('POST', endpoint, {**payload, 'sha': undone['sha']}, 403, headers={'Origin': 'https://foreign.invalid'})

    def test_errors_conflicts_and_concurrent_edits_preserve_disk(self):
        """@param None. @pre Repeated quote. @post Invalid/partial/concurrent edits never overwrite.
        @return None. @throws AssertionError: Preservation or confinement regression.
        """
        original = 'Alpha Alpha'
        result = self.edit('README.md', original, [{'action': 'markdown.bold', 'selection': {'quote': 'Alpha', 'occurrence': 1}}], dry_run=True)
        endpoint = '/api/projects/' + self.key + '/source-file/actions'
        base = {'path': 'README.md', 'sha': result['base_sha']}
        for actions, status in [
            ([{'action': 'markdown.bold', 'selection': {'quote': 'Alpha'}}], 409),
            ([{'action': 'source.bold', 'selection': {'quote': 'Alpha', 'occurrence': 1}}], 400),
            ([{'action': 'markdown.bold', 'selection': {'quote': 'Alpha', 'occurrence': 1}}, {'action': 'unknown'}], 400),
            ([{'action': 'markdown.bold', 'selection': {'start': True, 'end': 3}}], 400),
            ([{'action': 'markdown.bold', 'selection': {'start': 0, 'end': 3}, 'options': {'unknown': 1}}], 400),
        ]:
            self.call('POST', endpoint, {**base, 'actions': actions}, status)
        self.call('POST', endpoint, {**base, 'path': '../outside.md', 'actions': [{'action': 'text.save', 'options': {'text': 'bad'}}]}, 400)
        self.assertEqual((self.folder / 'README.md').read_text(), original)
        def concurrent(data):
            """@param data: Worker input. @pre Fixture ready. @post Simulate external save.
            @return dict: Real worker output. @throws IO/runtime errors.
            """
            result = run_toolbar(data)
            if data.get('kind') != 'catalog':
                (self.folder / 'README.md').write_text('External edit')
            return result
        with patch('research_workbench.application.source_actions.run_toolbar', side_effect=concurrent):
            self.call('POST', endpoint, {**base, 'actions': [{'action': 'markdown.bold', 'selection': {'start': 0, 'end': 5}}]}, 409)
        self.assertEqual((self.folder / 'README.md').read_text(), 'External edit')

    def test_tables_bibtex_validation_and_real_markdown_heading_parser(self):
        """@param None. @pre Structured fixtures. @post Literal data and parser semantics retained.
        @return None. @throws AssertionError: Browser algorithm parity regression.
        """
        table = self.edit('main.tex', 'A&B\tC\nD\tE', [{'action': 'source.table', 'selection': {'quote': 'A&B\tC\nD\tE'},
                            'options': {'caption': 'A&B', 'label': 'tab:one'}}])
        self.assertIn('A\\&B & C', table['text'])
        self.assertIn('\\label{tab:one}', table['text'])
        bib = self.edit('refs.bib', '@book{z,abstract={Remove},title={  Z  }}\n\n@book{a,title={A}}',
                        [{'action': 'source.format-file'}, {'action': 'bibliography.sort-entries'}])
        self.assertNotIn('abstract', bib['text'])
        self.assertLess(bib['text'].index('@book{a'), bib['text'].index('@book{z'))
        source = '# A **bold** title\r\n\r\n# A **bold** title\r\n\r\n```md\r\n# Hidden\r\n```\r\n'
        toc = self.edit('README.md', source, [{'action': 'markdown.contents', 'selection': {'start': 0, 'end': 0}}])
        self.assertIn('- [A bold title](#a-bold-title-1)', toc['text'])
        self.assertNotIn('](#hidden)', toc['text'])
        json_text = '{"x":9007199254740993,"x":2}'
        valid = self.edit('data.json', json_text, [{'action': 'json.validate'}])
        self.assertFalse(valid['changed'])
        self.assertEqual((self.folder / 'data.json').read_text(), json_text)
        with patch('research_workbench.infrastructure.processes.toolbar.shutil.which', return_value=None):
            catalog = self.call('GET', '/api/source-tools')
            self.assertFalse(catalog['available'])

    def test_linked_source_uses_attributed_writer(self):
        """@param None. @pre Linked Git source. @post Toolbar saves retain tracked review changes.
        @return None. @throws AssertionError: Attribution regression.
        """
        self.paper(linked=True)
        d = self.base + '/' + self.doc['id'] + '/draft'
        current = self.call('GET', d + '/file?path=main.tex')
        result = self.call('POST', '/api/projects/' + self.key + '/source-file/actions',
                           {'path': 'main.tex', 'source_document': self.doc['id'], 'sha': current['sha'],
                            'actions': [{'action': 'source.bold', 'selection': {'quote': 'Unique words.'}}]})
        self.assertIn('\\textbf{Unique words.}', result['text'])
        self.assertTrue(self.call('GET', d)['changes'])


if __name__ == '__main__':
    unittest.main()
