"""Source export and generated-paper presentation preserve the user's original project tree."""
import io
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import http_fixture
import test_standalone_latex as fixtures
from source_archive import SourceArchive
from test_editor import sample_pdf


class SourceArchiveTests(unittest.TestCase):
    setUp = http_fixture.setup
    tearDown = http_fixture.teardown
    request = http_fixture.request
    call = fixtures.StandaloneLatexTests.call
    git_source = fixtures.StandaloneLatexTests.git_source
    build = staticmethod(fixtures.StandaloneLatexTests.build)

    def archive(self, suffix='/latex/archive', data=None, status=200, **options):
        """@param suffix,data,status: Export request. @pre Fixture ready.
        @post HTTP status verified. @return ZIP bytes. @throws AssertionError: Unexpected result.
        """
        code, body = self.request('POST', '/api/projects/' + self.key + suffix,
                                  {'path': 'main.tex'} if data is None else data, **options)
        self.assertEqual(code, status, body[:300])
        return body

    def test_compile_preserves_original_tree_without_virtual_source_folders(self):
        """@pre Git source with an existing build folder. @post Compile adds no visible folders.
        @return None. @throws AssertionError: Project structure or source routing regresses.
        """
        self.git_source()
        (self.folder / 'references.bib').write_text('@book{key,title={Source}}')
        (self.folder / 'build').mkdir()
        (self.folder / 'build/user-file.txt').write_text('Keep this folder untouched')
        before = self.project.tree()['children']
        top = set(path.name for path in self.folder.iterdir())
        with patch.object(self.project.drafts, 'latexmk', side_effect=self.build):
            result = self.call('POST', '/latex/compile', {'path': 'main.tex'})
        after = self.project.tree()['children']
        self.assertEqual([(e['kind'], e['path']) for e in before], [(e['kind'], e['path']) for e in after])
        self.assertEqual(set(path.name for path in self.folder.iterdir()), top)
        self.assertEqual((self.folder / 'build/user-file.txt').read_text(), 'Keep this folder untouched')
        for name in ('main.tex', 'references.bib'):
            entry = next(e for e in after if e['path'] == name)
            self.assertEqual(entry['source_document'], result['document']['id'])
            self.assertEqual(entry['source_path'], name)
        manual = self.project.import_pdf('reading.pdf', sample_pdf(), separate=True)
        self.assertTrue(any(e.get('document') == manual['id'] for e in self.project.tree()['children']))

    def test_zip_builds_the_exact_source_snapshot_and_preserves_pdf_figures(self):
        """@pre Source/assets plus private/generated files. @post Archive preserves paths and fresh PDF.
        @return None. @throws AssertionError: Export mutates input or mixes source/build snapshots.
        """
        (self.folder / 'main.tex').write_text(fixtures.MAIN)
        (self.folder / 'references.bib').write_text('@book{key,title={Source}}')
        (self.folder / 'figures').mkdir()
        (self.folder / 'figures/diagram.pdf').write_bytes(sample_pdf())
        (self.folder / 'style.cls').write_text('custom class')
        (self.folder / 'main.pdf').write_bytes(b'old build')
        (self.folder / 'main.aux').write_text('generated')
        (self.folder / '.env').write_text('private fixture')
        (self.folder / 'build').mkdir()
        (self.folder / 'build/main.log').write_text('build log')
        (self.folder / 'linked.tex').symlink_to(self.folder / 'main.tex')
        index = self.project.index_path.read_bytes()
        top = set(path.name for path in self.folder.iterdir())
        def build(root, main, output, job):
            """@pre Snapshot exists. @post Original edit cannot affect exported sources/PDF."""
            self.assertNotEqual(root, self.folder)
            self.assertEqual((root / main).read_text(), fixtures.MAIN)
            (self.folder / 'main.tex').write_text('External edit during export')
            return self.build(root, main, output, job)
        with patch.object(self.project.drafts, 'latexmk', side_effect=build):
            data = self.archive()
        with zipfile.ZipFile(io.BytesIO(data)) as zipped:
            self.assertEqual(set(zipped.namelist()), {'main.tex', 'references.bib', 'figures/diagram.pdf', 'style.cls', 'main.pdf'})
            self.assertEqual(zipped.read('main.tex'), fixtures.MAIN.encode())
            self.assertEqual(zipped.read('main.pdf'), sample_pdf())
            self.assertEqual(zipped.read('figures/diagram.pdf'), sample_pdf())
        self.assertEqual(self.project.index_path.read_bytes(), index)
        self.assertEqual(set(path.name for path in self.folder.iterdir()), top)
        self.assertEqual((self.folder / 'main.pdf').read_bytes(), b'old build')
        self.assertEqual((self.folder / 'main.tex').read_text(), 'External edit during export')

    def test_linked_archive_keeps_versions_git_and_review_unchanged(self):
        """@pre Linked Git paper. @post Download creates no commits, documents or versions.
        @return None. @throws AssertionError: Export changes review persistence.
        """
        head, _ = self.git_source()
        with patch.object(self.project.drafts, 'latexmk', side_effect=self.build):
            built = self.call('POST', '/latex/compile', {'path': 'main.tex'})
            index = self.project.index_path.read_bytes()
            data = self.archive('/documents/' + built['document']['id'] + '/draft/archive', {})
        self.assertTrue(zipfile.is_zipfile(io.BytesIO(data)))
        self.assertEqual(self.project.index_path.read_bytes(), index)
        self.assertEqual(len(self.project.versions(built['document'])), 1)
        self.assertEqual(subprocess.check_output(['git', '-C', str(self.folder), 'rev-parse', 'HEAD']).decode().strip(), head)

    def test_invalid_export_and_failed_compile_never_download_stale_pdf(self):
        """@pre Uncompiled source. @post Unsafe/unauthorized/failed builds return errors, no archive.
        @return None. @throws AssertionError: Invalid export succeeds.
        """
        (self.folder / 'main.tex').write_text(fixtures.MAIN)
        with patch.object(self.project.drafts, 'latexmk') as compiler:
            self.archive(data={'path': '../outside.tex'}, status=400)
            self.archive(data={'path': 'main.tex', 'extra': True}, status=400)
            self.archive(token=False, status=403)
            compiler.assert_not_called()
        with patch.object(self.project.drafts, 'latexmk', return_value=(False, 'build failed', ['syntax error'], None)):
            error = json.loads(self.archive(status=422))
        self.assertIn('compilation failed', error['error'])
        self.assertEqual(self.project.documents(), [])
        self.assertFalse((self.folder / 'main.pdf').exists())

    def test_archive_limits_fail_before_compilation(self):
        """@pre Input over configured limit. @post No expensive build or partial download.
        @return None. @throws AssertionError: Limit bypassed.
        """
        (self.folder / 'main.tex').write_text(fixtures.MAIN)
        with patch.object(SourceArchive, 'MAX_BYTES', 1), patch.object(self.project.drafts, 'latexmk') as compiler:
            self.archive(status=422)
            compiler.assert_not_called()

    @unittest.skipUnless(shutil.which('latexmk') and shutil.which('pdflatex'), 'TeX compiler unavailable')
    def test_real_archive_is_rebuildable_and_leaves_source_structure_intact(self):
        """@pre Real compiler. @post Exported source rebuilds; original root has no new outputs.
        @return None. @throws AssertionError: PDF/source archive mismatch or disk pollution.
        """
        (self.folder / 'main.tex').write_text(fixtures.MAIN)
        top = set(path.name for path in self.folder.iterdir())
        data = self.archive()
        with tempfile.TemporaryDirectory() as temporary, zipfile.ZipFile(io.BytesIO(data)) as zipped:
            zipped.extractall(temporary)
            self.assertTrue((Path(temporary) / 'main.pdf').read_bytes().startswith(b'%PDF-'))
            output = Path(temporary) / 'output'; output.mkdir()
            ok, log, _, _ = self.project.drafts.latexmk(Path(temporary), 'main.tex', output, 'rebuilt')
            self.assertTrue(ok, log)
        self.assertEqual(set(path.name for path in self.folder.iterdir()), top)
