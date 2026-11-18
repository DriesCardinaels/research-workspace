"""Real HTTP note toolbar coverage, atomicity, confinement and recoverable revisions."""
import json
from pathlib import Path
import shutil
from unittest.mock import patch
import unittest

import http_fixture
from test_editor import sample_pdf


class NoteApiTests(unittest.TestCase):
    setUp = http_fixture.setup
    tearDown = http_fixture.teardown
    request = http_fixture.request

    def call(self, method, route, data=None, status=200, **kwargs):
        """Dispatch an authenticated real request. Pre: fixture ready.
        Post: expected status checked. Returns decoded response; raises AssertionError.
        """
        code, body = self.request(method, route, data, **kwargs)
        self.assertEqual(code, status, body)
        return json.loads(body)

    def note(self, text='Alpha\r\nBeta\r\n'):
        """Create a note fixture. Pre: isolated project. Post: exact bytes on disk.
        Returns current snapshot. Raises IO/assertion errors. Related: commands.
        """
        (self.folder / 'notes.txt').write_bytes(text.encode())
        return self.call('GET', '/api/projects/' + self.key + '/note-file?path=notes.txt')

    def edit(self, current, *actions, status=200, **extra):
        """Submit an atomic command batch. Pre: snapshot supplied.
        Post: response checked. Returns response; raises assertion errors.
        """
        return self.call('POST', '/api/projects/' + self.key + '/note-file/actions',
                         {'path': 'notes.txt', 'sha': current['sha'], 'actions': list(actions), **extra}, status)

    def test_catalog_batch_stacking_and_reversible_snapshots(self):
        """Pre: Unicode/CRLF note. Post: stack, undo/redo and dry-run retain exact bytes.
        Raises AssertionError for workflow or revision regressions.
        """
        catalog = self.call('GET', '/api/note-tools')
        self.assertEqual(catalog['offset_encoding'], 'unicode-code-points')
        self.assertEqual(len(catalog['palette']), 8)
        current = self.note('😀 Alpha\r\nBeta\r\n')
        before_index = self.project.index_path.read_bytes()
        (self.folder / 'notes.txt').chmod(0o640)
        actions = [{'action': 'notes.bold', 'selection': {'quote': 'Alpha'}},
                   {'action': 'notes.italic', 'selection': {'quote': '**Alpha**'}}]
        preview = self.edit(current, *actions, dry_run=True)
        self.assertEqual(preview['text'], '😀 ***Alpha***\r\nBeta\r\n')
        self.assertFalse(preview['persisted'])
        self.assertEqual((self.folder / 'notes.txt').read_bytes(), current['text'].encode())
        result = self.edit(current, *actions)
        self.assertEqual(result['text'], preview['text'])
        self.assertEqual(result['base_sha'], current['sha'])
        self.edit(current, *actions, status=409)
        undone = self.edit(result, result['undo'])
        self.assertEqual(undone['text'], current['text'])
        redone = self.edit(undone, result['redo'])
        self.assertEqual(redone['text'], result['text'])
        self.assertEqual((self.folder / 'notes.txt').stat().st_mode & 0o777, 0o640)
        self.assertEqual(self.project.index_path.read_bytes(), before_index)

    def test_all_basic_blocks_and_inline_actions(self):
        """Pre: plain lines. Post: every block/inline content tool works and preserves CRLF.
        Raises AssertionError for missing actions or newline regressions.
        """
        for action, prefix in [('title', '# '), ('heading', '## '), ('subheading', '### '),
                               ('bullet', '- '), ('number', '1. '), ('task', '- [ ] '), ('quote', '> ')]:
            current = self.note()
            result = self.edit(current, {'action': 'notes.' + action, 'selection': {'quote': 'Alpha'}})
            self.assertEqual(result['text'], prefix + 'Alpha\r\nBeta\r\n')
        for action, expected in [('bold', '**Alpha**'), ('italic', '*Alpha*'), ('strike', '~~Alpha~~'),
                                 ('code', '`Alpha`'), ('quotation', '“Alpha”')]:
            current = self.note()
            result = self.edit(current, {'action': 'notes.' + action, 'selection': {'start': 0, 'end': 5}})
            self.assertEqual(result['text'], expected + '\r\nBeta\r\n')
        current = self.note()
        result = self.edit(current, {'action': 'notes.number', 'selection': {'start': 1, 'end': 7}})
        self.assertEqual(result['text'], '1. Alpha\r\nBeta\r\n', 'selection ending at column zero excludes the next line')
        current = self.note('😀 Alpha')
        result = self.edit(current, {'action': 'notes.bold', 'selection': {'start': 2, 'end': 7}})
        self.assertEqual(result['text'], '😀 **Alpha**', 'API offsets use code points, not UTF-16')

    def test_highlights_comments_and_source_reads(self):
        """Pre: selected text. Post: custom colors/comments persist and remain editable/removable.
        Raises AssertionError for annotation or stale-ID regressions.
        """
        current = self.note()
        colored = self.edit(current, {'action': 'notes.highlightColor', 'selection': {'quote': 'Alpha'}, 'options': {'color': 'pink'}})
        self.assertEqual(colored['highlights'][0]['color'], '#f5c2e7')
        recolored = self.edit(colored, {'action': 'notes.highlightColor', 'selection': {'quote': 'Alpha'}, 'options': {'color': '#123456'}})
        self.assertEqual(recolored['text'], '=={#123456}Alpha==\r\nBeta\r\n')
        plain = self.edit(recolored, {'action': 'notes.highlight', 'selection': {'quote': 'Alpha'}})
        self.assertEqual(plain['text'], current['text'])
        commented = self.edit(plain, {'action': 'notes.comment', 'selection': {'quote': 'Alpha'}, 'options': {'comment': 'Review <script>\nÉvidence 😀'}})
        self.assertEqual(commented['comments'][0]['comment'], 'Review <script>\nÉvidence 😀')
        entry = commented['comments'][0]
        edited = self.edit(commented, {'action': 'notes.comment.edit', 'options': {'comment_id': entry['id'], 'comment': 'Updated'}})
        self.assertEqual(edited['comments'][0]['comment'], 'Updated')
        self.edit(edited, {'action': 'notes.comment.remove', 'options': {'comment_id': entry['id']}}, status=409)
        read = self.edit(edited, {'action': 'notes.source'}, {'action': 'notes.comments'})
        self.assertEqual(read['text'], edited['text'])
        removed = self.edit(edited, {'action': 'notes.comment.remove', 'options': {'comment_id': edited['comments'][0]['id']}})
        self.assertEqual(removed['text'], current['text'])
        self.assertEqual(removed['comments'], [])

    def test_ambiguous_invalid_unauthorized_and_partial_batches_never_write(self):
        """Pre: repeated quote. Post: all rejected requests retain original bytes.
        Raises AssertionError if auth, validation, confinement or atomicity weakens.
        """
        current = self.note('Alpha Alpha')
        self.edit(current, {'action': 'notes.bold', 'selection': {'quote': 'Alpha'}}, status=409)
        self.edit(current, {'action': 'notes.bold', 'selection': {'quote': 'Alpha', 'occurrence': 2}},
                  {'action': 'notes.highlightColor', 'selection': {'quote': 'Alpha', 'occurrence': 1}, 'options': {'color': 'bad'}}, status=400)
        for command in [{'action': 'notes.missing'}, {'action': 'notes.bold', 'selection': {'start': True, 'end': 3}},
                        {'action': 'notes.bold', 'selection': {'quote': 'Alpha', 'occurrence': False}},
                        {'action': 'notes.comment', 'selection': {'start': 0, 'end': 0}, 'options': {'comment': 'Empty'}},
                        {'action': 'notes.source', 'options': {'unknown': 1}}, {'action': 'text.undo'}]:
            self.edit(current, command, status=400)
        body = {'path': 'notes.txt', 'sha': current['sha'], 'actions': [{'action': 'notes.source'}]}
        endpoint = '/api/projects/' + self.key + '/note-file/actions'
        self.call('POST', endpoint, body, 403, token=False)
        self.call('POST', endpoint, body, 403, headers={'Origin': 'https://foreign.invalid'})
        self.call('POST', endpoint, {**body, 'path': '../notes.txt'}, 400)
        self.call('POST', endpoint, {**body, 'path': 'notes.md'}, 400)
        self.assertEqual((self.folder / 'notes.txt').read_bytes(), current['text'].encode())

    def test_project_file_links_use_tree_targets(self):
        """Pre: PDFs, Markdown and a plain note. Post: links coexist and keep exact addresses.
        Raises AssertionError if unsafe paths, partial batches or generated references regress.
        """
        files = self.folder / 'papers'
        files.mkdir()
        (files / 'Paper [one].pdf').write_bytes(sample_pdf())
        (self.folder / 'README.md').write_text('# Guide')
        managed = self.project.import_pdf('Paper two.pdf', sample_pdf())
        current = self.note('Summary')
        sources = [{'path': 'papers/Paper [one].pdf'}, {'document': managed['id']}, {'path': 'README.md'}]
        for source in sources:
            cursor = len(current['text'])
            current = self.edit(current, {'action': 'notes.fileSource', 'selection': {'start': cursor, 'end': cursor}, 'options': source})
        self.assertEqual(current['text'], r'Summary [Paper \[one\].pdf](#project-file?path=papers%2FPaper+%5Bone%5D.pdf) '
                         f'[Paper two.pdf](#project-file?document={managed["id"]}) [README.md](#project-file?path=README.md)')
        self.assertEqual(len(self.project.documents()), 1, 'Linking a raw PDF does not import it')
        self.edit(current, {'action': 'notes.fileSource', 'selection': {'quote': 'Summary'}, 'options': {'path': '../outside.txt'}}, status=404)
        self.assertEqual((self.folder / 'notes.txt').read_text(), current['text'])

    def test_pdf_source_links_lookup_and_comments(self):
        """Pre: active PDF and note. Post: explicit/located pages and commented links work.
        Raises AssertionError for source routing, ambiguity or missing-capability regressions.
        """
        document = self.project.import_pdf('book.pdf', sample_pdf())
        sources = self.call('GET', '/api/projects/' + self.key + '/note-sources')
        self.assertEqual(sources['sources'][0]['document'], document['id'])
        current = self.note('A quoted passage')
        linked = self.edit(current, {'action': 'notes.pdfSource', 'selection': {'quote': 'A quoted passage'},
                                    'options': {'document': document['id'], 'page': 2, 'comment': 'Context'}})
        self.assertIn('/original#page=2', linked['comments'][0]['comment'])
        self.assertEqual(len(self.project.documents()), 1, 'source links never create a new review version')
        lookup = '/api/projects/' + self.key + '/note-sources/locate'
        def extracted(args, **kwargs):
            """Simulate bounded PDF extraction. Pre: output stream provided.
            Post: two physical pages written; returns successful process status.
            Raises IO errors. Related: unlocked quote lookup.
            """
            from types import SimpleNamespace
            self.assertEqual(args[-1], '-')
            kwargs['stdout'].write('A quoted passage\fA quoted passage\f'.encode())
            return SimpleNamespace(returncode=0)
        with patch('research_workbench.application.note_files.shutil.which', return_value='/usr/bin/pdftotext'), \
                patch('research_workbench.application.note_files.subprocess.run', side_effect=extracted):
            found = self.call('POST', lookup, {'document': document['id'], 'quote': 'A quoted passage'})
            self.assertEqual(found['pages'], [1, 2])
            self.assertTrue(found['ambiguous'])
        with patch('research_workbench.application.note_files.shutil.which', return_value=None):
            self.call('POST', lookup, {'document': document['id'], 'quote': 'A quoted passage'}, 400)
        self.edit(linked, {'action': 'notes.pdfSource', 'selection': {'quote': 'A quoted passage'},
                          'options': {'document': document['id'], 'page': 0}}, status=400)

    @unittest.skipUnless(shutil.which('pdftotext'), 'Optional Poppler extractor unavailable')
    def test_real_pdf_quote_extraction(self):
        """Pre: real searchable PDF and installed Poppler. Post: physical page located.
        Raises AssertionError for extraction or page-number regressions.
        """
        document = self.project.import_pdf('searchable.pdf', sample_pdf())
        result = self.call('POST', '/api/projects/' + self.key + '/note-sources/locate',
                           {'document': document['id'], 'quote': 'Research Workbench test document'})
        self.assertEqual(result['pages'], [1])
        self.assertFalse(result['ambiguous'])

    def test_pdf_source_colors_and_verbatim_passage(self):
        """Pre: saved note and PDF. Post: source colors and matching text survive recolor/undo.
        Raises AssertionError for lost text, commented links, unsafe colors or API parity.
        """
        from urllib.parse import parse_qs, urlsplit
        import re
        document = self.project.import_pdf('book.pdf', sample_pdf())
        current = self.note('A paraphrased passage\r\nOther text\r\n')
        linked = self.edit(current, {'action': 'notes.pdfSource', 'selection': {'quote': 'A paraphrased passage'},
                                    'options': {'document': document['id'], 'page': 1, 'color': 'pink',
                                                'match': 'Research Workbench test document', 'comment': 'Context'}})
        before = linked['text']
        colored = self.edit(linked, {'action': 'notes.sourceColor', 'selection': {'quote': 'A paraphrased passage'},
                                     'options': {'color': '#89b4fa'}})
        href = re.search(r'\]\(([^)]+)\)', colored['comments'][0]['comment'])[1]
        params = parse_qs(urlsplit(href).fragment)
        self.assertEqual(params['color'], ['89b4fa'])
        self.assertEqual(params['match'], ['Research Workbench test document'])
        self.assertEqual(colored['comments'][0]['text'], 'A paraphrased passage')
        self.assertIn('\r\nOther text\r\n', colored['text'])
        restored = self.edit(colored, colored['undo'])
        self.assertEqual(restored['text'], before)
        context_linked = self.edit(restored, {'action': 'notes.pdfSource', 'selection': {'quote': 'Other text'},
                                             'options': {'document': document['id'], 'page': 1, 'kind': 'context', 'color': 'pink'}})
        self.assertIn('[Context p. 1]', context_linked['text'])
        self.assertIn('kind=context', context_linked['text'])
        context_recolored = self.edit(context_linked, {'action': 'notes.sourceColor', 'selection': {'quote': 'Other text'},
                                                       'options': {'color': 'blue'}})
        self.assertIn('kind=context', context_recolored['text'], 'recolor retains a context-only relationship')
        restored = self.edit(context_recolored, {'action': 'text.save', 'options': {'text': before}})

        self.edit(restored, {'action': 'notes.sourceColor', 'selection': {'quote': 'A paraphrased passage'},
                             'options': {'color': 'red;display:none'}}, status=400)
        self.assertEqual(self.call('GET', '/api/projects/' + self.key + '/note-file?path=notes.txt')['text'], before)

    def test_source_validation_and_empty_batch(self):
        """Pre: existing note. Post: malformed batching/root/restore requests do not write.
        Raises AssertionError for a validation regression.
        """
        current = self.note()
        endpoint = '/api/projects/' + self.key + '/note-file/actions'
        body = {'path': 'notes.txt', 'sha': current['sha'], 'actions': [{'action': 'notes.source'}]}
        for change in ({'actions': []}, {'actions': [None]}, {'actions': body['actions'] * 101},
                       {'source_document': 0}, {'dry_run': 'true'}, {'unexpected': True}):
            self.call('POST', endpoint, {**body, **change}, 400)
        self.assertEqual((self.folder / 'notes.txt').read_bytes(), current['text'].encode())


if __name__ == '__main__':
    unittest.main()
