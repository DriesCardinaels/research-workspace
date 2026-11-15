"""Standalone source opening, safe compilation, reusable association and automatic Git linkage."""
import json
from pathlib import Path
import shutil
import subprocess
import unittest
from unittest.mock import patch
from urllib.parse import urlencode

import http_fixture
from drafts import SourceError
from test_editor import sample_pdf

MAIN = '\\documentclass{article}\n\\begin{document}\nStandalone source.\\end{document}\n'


class StandaloneLatexTests(unittest.TestCase):
    setUp = http_fixture.setup
    tearDown = http_fixture.teardown
    request = http_fixture.request

    def call(self, method, suffix, data=None, status=200, **options):
        """@param method,suffix,data,status: Request contract. @pre Fixture active.
        @post Expected status checked. @return Decoded response. @throws AssertionError: Mismatch.
        """
        code, body = self.request(method, '/api/projects/' + self.key + suffix, data, **options)
        self.assertEqual(code, status, body)
        return json.loads(body)

    def git_source(self):
        """@pre Fixture only. @post Main source has an explicit test commit.
        @return HEAD and index bytes. @throws CalledProcessError: Git failed.
        """
        (self.folder / 'main.tex').write_text(MAIN)
        for args in [('init', '-q'), ('config', 'user.name', 'Fixture'), ('config', 'user.email', 'fixture@example.invalid'), ('add', 'main.tex'), ('commit', '-qm', 'baseline')]:
            subprocess.run(['git', '-C', str(self.folder), *args], check=True, capture_output=True)
        head = subprocess.check_output(['git', '-C', str(self.folder), 'rev-parse', 'HEAD']).decode().strip()
        return head, (self.folder / '.git/index').read_bytes()

    @staticmethod
    def build(root, main, out, name):
        """@param root,main,out,name: Compiler inputs. @pre Temporary output directory.
        @post Complete fixture PDF and SyncTeX data. @return Successful compiler result.
        @throws OSError: Fixture write failed.
        """
        pdf = Path(out) / (name + '.pdf')
        pdf.write_bytes(sample_pdf())
        (Path(out) / (name + '.synctex.gz')).write_bytes(b'fixture sync data')
        return True, 'fixture build', [], pdf

    def test_existing_workspace_status_and_shared_citations_need_no_pdf(self):
        """@pre Source-only folder. @post Existing split workspace receives files and citations.
        @return None. @throws AssertionError: Metadata depends on an imported paper.
        """
        (self.folder / 'main.tex').write_text(MAIN + '\\bibliography{references}\n\\cite{key}\n')
        (self.folder / 'references.bib').write_text('@article{key, title={Existing citation}, year={2026}}')
        status = self.call('GET', '/latex/source?path=main.tex')
        self.assertTrue(status['source_only'])
        self.assertFalse(status['draft_pdf'])
        self.assertEqual(status['files'], ['main.tex', 'references.bib'])
        cites = self.call('GET', '/latex/citations?path=main.tex')
        self.assertEqual(cites['entries'][0]['key'], 'key')
        self.assertEqual(cites['bib_files'], ['references.bib'])
        self.assertEqual(cites['problems'], [])
        self.assertEqual(self.project.documents(), [])
        self.call('GET', '/latex/source?path=../outside.tex', status=400)

    def test_workspace_reopens_its_previous_preview_and_handles_incomplete_source(self):
        """@pre Source without documentclass. @post Editor opens; successful PDFs survive reopening.
        @return None. @throws AssertionError: Opening compiles or loses the association.
        """
        (self.folder / 'main.tex').write_text('Incomplete source')
        status = self.call('GET', '/latex/source?path=main.tex')
        self.assertTrue(status['source_only'])
        self.assertTrue(status['root_error'])
        (self.folder / 'main.tex').write_text('% !TeX root = ../outside.tex\n')
        invalid = self.call('GET', '/latex/source?path=main.tex')
        self.assertTrue(invalid['source_only'])
        self.assertTrue(invalid['root_error'])
        (self.folder / 'main.tex').write_text(MAIN)
        with patch.object(self.project.drafts, 'latexmk', side_effect=self.build):
            built = self.call('POST', '/latex/compile', {'path': 'main.tex'})
        reopened = self.call('GET', '/latex/source?path=main.tex')
        self.assertTrue(reopened['draft_pdf'])
        self.assertEqual(reopened['document']['id'], built['document']['id'])

    def test_source_opens_and_saves_before_any_pdf_or_git_exists(self):
        """@pre Source-only directory. @post Exact text saves; no PDF or Git is created.
        @return None. @throws AssertionError: Opening depends on existing paper.
        """
        (self.folder / 'main.tex').write_text(MAIN)
        snapshot = self.call('GET', '/text-file?' + urlencode({'path': 'main.tex'}))
        self.call('PUT', '/text-file', {'path': 'main.tex', 'text': MAIN + '% unsaved draft\n', 'sha': snapshot['sha']})
        self.assertEqual(self.project.documents(), [])
        self.assertFalse((self.folder / '.git').exists())
        self.assertTrue((self.folder / 'main.tex').read_text().endswith('% unsaved draft\n'))

    def test_success_links_git_source_without_changing_head_or_index_or_creating_versions(self):
        """@pre Git-backed source without PDF. @post First build links; rebuild reuses original paper.
        @return None. @throws AssertionError: Duplicate versions, lost data or Git mutation.
        """
        head, index = self.git_source()
        with patch.object(self.project.drafts, 'latexmk', side_effect=self.build):
            first = self.call('POST', '/latex/compile', {'path': 'main.tex'})
            second = self.call('POST', '/latex/compile', {'path': 'main.tex'})
        self.assertTrue(first['ok'] and first['linked'])
        self.assertEqual(first['document']['id'], second['document']['id'])
        self.assertEqual(len(self.project.documents()), 1)
        doc = self.project.doc(first['document']['id'])
        self.assertEqual(len(self.project.versions(doc)), 1)
        self.assertEqual(doc['source_commit'], head)
        self.assertEqual((self.folder / '.git/index').read_bytes(), index)
        self.assertEqual(subprocess.check_output(['git', '-C', str(self.folder), 'rev-parse', 'HEAD']).decode().strip(), head)
        self.assertEqual(self.project.path(doc, 'original').read_bytes(), sample_pdf())
        self.assertEqual(self.project.drafts.config(doc)['main'], 'main.tex')
        self.assertTrue(self.project.drafts.status(doc)['draft_pdf'])
        self.call('GET', '/text-file?path=main.tex', status=400)
        self.assertEqual(self.call('GET', '/documents/' + doc['id'] + '/draft/file?path=main.tex')['text'], MAIN)

    def test_non_git_build_keeps_source_editable_and_publishes_reusable_preview(self):
        """@pre Plain folder. @post PDF is associated without initializing Git or locking source.
        @return None. @throws AssertionError: Unnecessary source restriction or data loss.
        """
        (self.folder / 'main.tex').write_text(MAIN)
        with patch.object(self.project.drafts, 'latexmk', side_effect=self.build):
            result = self.call('POST', '/latex/compile', {'path': 'main.tex'})
            again = self.call('POST', '/latex/compile', {'path': 'main.tex'})
        self.assertTrue(result['ok']); self.assertFalse(result['linked'])
        self.assertEqual(result['document']['id'], again['document']['id'])
        self.assertEqual(result['document']['source_main'], 'main.tex')
        self.assertFalse((self.folder / '.git').exists())
        self.call('GET', '/text-file?path=main.tex')
        code, body = self.request('GET', '/api/projects/' + self.key + result['preview'])
        self.assertEqual(code, 200); self.assertEqual(body, sample_pdf())

    def test_failed_build_leaves_editor_and_previous_pdf_intact(self):
        """@pre Successful preview followed by compiler failure. @post Existing PDF/source retained.
        @return None. @throws AssertionError: Partial failed publication.
        """
        (self.folder / 'main.tex').write_text(MAIN)
        with patch.object(self.project.drafts, 'latexmk', return_value=(False, 'bad source', ['! Failure'], Path('absent.pdf'))):
            failed = self.call('POST', '/latex/compile', {'path': 'main.tex'})
        self.assertFalse(failed['ok']); self.assertEqual(self.project.documents(), [])
        self.call('GET', '/text-file?path=main.tex')
        with patch.object(self.project.drafts, 'latexmk', side_effect=self.build):
            first = self.call('POST', '/latex/compile', {'path': 'main.tex'})
        with patch.object(self.project.drafts, 'latexmk', return_value=(False, 'bad source', [], Path('absent.pdf'))):
            self.call('POST', '/latex/compile', {'path': 'main.tex'})
        code, data = self.request('GET', '/api/projects/' + self.key + first['preview'])
        self.assertEqual((code, data), (200, sample_pdf()))
        self.assertEqual(len(self.project.documents()), 1)

    def test_section_root_discovery_and_invalid_targets(self):
        """@pre A section with an explicit root. @post Main document is built; unsafe paths rejected.
        @return None. @throws AssertionError: Wrong build target or confinement failure.
        """
        (self.folder / 'main.tex').write_text(MAIN)
        (self.folder / 'sections').mkdir()
        (self.folder / 'sections/intro.tex').write_text('% !TeX root = ../main.tex\nIntroduction')
        with patch.object(self.project.drafts, 'latexmk', side_effect=self.build) as compiler:
            result = self.call('POST', '/latex/compile', {'path': 'sections/intro.tex'})
            self.assertEqual(result['main'], 'main.tex')
            self.assertEqual(compiler.call_args.args[1], 'main.tex')
        with patch.object(self.project.drafts, 'latexmk') as compiler:
            self.call('POST', '/latex/compile', {'path': '../outside.tex'}, status=400)
            self.call('POST', '/latex/compile', {'path': 'main.tex', 'extra': True}, status=400)
            self.call('POST', '/latex/compile', {'path': 'main.tex'}, status=403, token=False)
            self.assertFalse(compiler.called)

    @unittest.skipUnless(shutil.which('latexmk') and shutil.which('pdflatex'), 'TeX runtime unavailable')
    def test_real_compile_publishes_pdf_and_link(self):
        """@pre Real compiler and Git fixture. @post Source-only project builds and links end to end.
        @return None. @throws AssertionError: Invalid PDF or missing review linkage.
        """
        self.git_source()
        result = self.call('POST', '/latex/compile', {'path': 'main.tex'})
        self.assertTrue(result['ok'], result['log'])
        self.assertTrue(result['linked'])
        doc = self.project.doc(result['document']['id'])
        self.assertTrue(self.project.drafts.draft_pdf(doc).startswith(b'%PDF-'))
