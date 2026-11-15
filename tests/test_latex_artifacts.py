"""Tree presentation hides build outputs without altering the original project structure."""
import json
import unittest

import http_fixture


class LatexArtifactTests(unittest.TestCase):
    setUp = http_fixture.setup
    tearDown = http_fixture.teardown
    request = http_fixture.request

    def tree(self):
        """@pre Fixture project. @post Real tree route read. @return Nodes. @throws AssertionError."""
        code, body = self.request('GET', '/api/projects/' + self.key + '/tree')
        self.assertEqual(code, 200)
        return json.loads(body)['children']

    def test_latex_build_outputs_hidden_but_sources_assets_and_disk_retained(self):
        """@pre LaTeX source, outputs and PDF figure. @post Only source/assets are visible; bytes stay intact."""
        (self.folder / 'main.tex').write_text('Source')
        (self.folder / 'references.bib').write_text('Bibliography')
        for name in ('build', '_build', 'figures', 'sections'):
            (self.folder / name).mkdir()
        for name in ('build/main.pdf', '_build/main.log', 'main.pdf', 'main.aux', 'main.synctex.gz', 'sections/chapter.aux', 'figures/chart.pdf'):
            (self.folder / name).write_bytes(b'Unchanged fixture bytes')
        before = {str(p.relative_to(self.folder)): p.read_bytes() for p in self.folder.rglob('*') if p.is_file()}
        entries = self.tree()
        self.assertEqual({e['name'] for e in entries}, {'main.tex', 'references.bib', 'figures', 'sections'})
        self.assertEqual(next(e for e in entries if e['name'] == 'figures')['children'][0]['name'], 'chart.pdf')
        self.assertEqual(next(e for e in entries if e['name'] == 'sections')['children'], [])
        after = {str(p.relative_to(self.folder)): p.read_bytes() for p in self.folder.rglob('*') if p.is_file()}
        self.assertEqual(before, after)
        self.assertTrue((self.folder / 'build').is_dir())
        self.assertTrue((self.folder / '_build').is_dir())

    def test_non_latex_build_and_pdf_files_remain_visible(self):
        """@pre Non-LaTeX project. @post A build directory and ordinary PDFs are not hidden globally."""
        (self.folder / 'build').mkdir()
        (self.folder / 'build/result.txt').write_text('Output')
        (self.folder / 'reading.pdf').write_bytes(b'PDF fixture')
        self.assertEqual({e['name'] for e in self.tree()}, {'build', 'reading.pdf'})

    def test_nested_latex_filter_does_not_hide_sibling_project_files(self):
        """@pre Mixed project. @post Artifact filtering stays inside the LaTeX subtree."""
        (self.folder / 'paper').mkdir()
        (self.folder / 'paper/main.tex').write_text('Source')
        (self.folder / 'paper/build').mkdir()
        (self.folder / 'build').mkdir()
        entries = self.tree()
        self.assertEqual({e['name'] for e in entries}, {'paper', 'build'})
        self.assertEqual([e['name'] for e in next(e for e in entries if e['name'] == 'paper')['children']], ['main.tex'])
