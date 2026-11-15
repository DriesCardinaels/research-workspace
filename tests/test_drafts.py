"""LaTeX draft workflow: change records, attribution, revert, builds, SyncTeX and promotion."""
import base64
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from drafts import (SourceError, cite_uses, log_pages, no_figures_wrapper, parse_bib, relocate, removed_floats,
                    word_changes)
import test_editor
from test_editor import sample_pdf
from research_workbench.launcher import Project

HAVE_TEX = bool(shutil.which('latexmk') and shutil.which('pdflatex') and shutil.which('synctex'))

INTRO = ("In supervisory control, a person plans a robot's task. The robot carries out this plan "
         "while its inherited evidence calls for caution. Processing drops the supplied evidence.\n\n"
         "A second paragraph stays the same.\n")
MAIN = ("\\documentclass{article}\n\\begin{document}\n\\input{sections/intro}\n\\end{document}\n")


def run(cwd, *cmd):
    return subprocess.run(cmd, cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


class WordChangeTests(unittest.TestCase):
    def test_replacement_is_one_hunk(self):
        old = 'its inherited evidence calls for caution. Next.'
        new = 'its inherited evidence qualifies it. Next.'
        [h] = word_changes(old, new)
        self.assertEqual((h['old'], h['new']), ('calls for caution', 'qualifies it'))
        self.assertEqual(new[h['new_start']:h['new_end']], 'qualifies it')

    def test_insert_delete_and_whitespace(self):
        self.assertEqual(word_changes('a b c', 'a b c'), [])
        self.assertEqual(word_changes('one two\nthree', 'one two three'), [])  # rewrapping only
        # Pure deletions and insertions keep their adjacent space, so a revert restores the exact text.
        old, new = 'keep this word here', 'keep this here'
        [h] = word_changes(old, new)
        self.assertEqual((h['old'].strip(), h['new']), ('word', ''))
        self.assertEqual(new[:h['new_start']] + h['old'] + new[h['new_end']:], old)
        old, new = 'keep here', 'keep new text here'
        [h] = word_changes(old, new)
        self.assertEqual((h['old'], h['new'].strip()), ('', 'new text'))
        self.assertEqual(new[:h['new_start']] + h['old'] + new[h['new_end']:], old)

    def test_removed_sentence_starts_at_a_word(self):
        old = 'Processing can lose it. Each result depends on heights. It happens.'
        new = 'Processing can lose it. It happens.'
        [h] = word_changes(old, new)
        self.assertEqual(h['old'].strip(), 'Each result depends on heights.')
        self.assertEqual(new[:h['new_start']] + h['old'] + new[h['new_end']:], old)

    def test_far_apart_edits_stay_separate(self):
        old = 'alpha beta gamma delta epsilon zeta eta theta'
        new = 'ALPHA beta gamma delta epsilon zeta eta THETA'
        self.assertEqual([h['new'] for h in word_changes(old, new)], ['ALPHA', 'THETA'])


class NoFiguresHelperTests(unittest.TestCase):
    def test_wrapper_removes_figure_floats_and_reads_the_main_file(self):
        text = no_figures_wrapper('main.tex')
        for env in ('figure', 'figure*', 'teaserfigure'):
            self.assertIn(f'\\RenewDocumentEnvironment{{{env}}}{{+b}}', text)
        self.assertNotIn('{table', text)
        self.assertTrue(text.rstrip().endswith('\\input{main.tex}'))
        with self.assertRaises(SourceError):
            no_figures_wrapper('main%.tex')

    def test_page_count_from_a_wrapped_log_line(self):
        with tempfile.TemporaryDirectory() as tmp:
            log = Path(tmp) / 'x.log'
            # TeX wraps log lines at 79 characters, also inside the output path.
            log.write_text('Output written on /var/folders/ab/c/T/research-workbench-no-figures-1234/ca37d2c/build/no-figur\n'
                           'es.pdf (14 pages, 491265 bytes).\n'
                           'Research Workbench: removed figure\nResearch Workbench: removed figure\nResearch Workbench: removed teaserfigure\n')
            self.assertEqual(log_pages(log), 14)
            self.assertEqual(removed_floats(log), {'figure': 2, 'teaserfigure': 1})
            log.write_text('Output written on a.pdf (1 page, 10 bytes).\n')
            self.assertEqual(log_pages(log), 1)
            log.write_text('No pages of output.\n')
            self.assertIsNone(log_pages(log))
            self.assertIsNone(log_pages(Path(tmp) / 'missing.log'))


class DraftTests(test_editor.EditorTests):
    def setUp(self):
        super().setUp()
        self.repo = Path(self.temp.name) / 'paper-repo'
        self.src = self.repo / 'paper'
        (self.src / 'sections').mkdir(parents=True)
        (self.src / 'main.tex').write_text(MAIN)
        (self.src / 'sections' / 'intro.tex').write_text(INTRO)
        run(self.repo, 'git', 'init', '-q', '-b', 'main')
        run(self.repo, 'git', 'config', 'user.name', 'Test Author')
        run(self.repo, 'git', 'config', 'user.email', 'test@example.invalid')
        run(self.repo, 'git', 'add', '.')
        run(self.repo, 'git', 'commit', '-q', '-m', 'base')
        self.base_commit = run(self.repo, 'git', 'rev-parse', 'HEAD')
        code, body = self.request('POST', self.base, {'name': 'paper.pdf', 'data': base64.b64encode(sample_pdf()).decode()})
        self.doc = json.loads(body)
        self.url = self.base + '/' + self.doc['id'] + '/draft'

    def call(self, method, path='', data=None, ok=(200, 201)):
        code, body = self.request(method, self.url + path, data)
        result = json.loads(body) if body else None
        if ok:
            self.assertIn(code, ok, body)
        return code, result

    def link(self):
        return self.call('POST', '/link', {'root': str(self.src), 'main': 'main.tex', 'commit': self.base_commit[:7]})[1]

    def save(self, text, path='sections/intro.tex'):
        current = self.call('GET', '/file?path=' + path)[1]
        return self.call('PUT', '/file', {'path': path, 'text': text, 'sha': current['sha']})[1]

    def test_link_requires_valid_source(self):
        code, r = self.call('POST', '/link', {'root': str(self.src), 'main': 'main.tex', 'commit': 'deadbeef'}, ok=None)
        self.assertEqual(code, 422)
        code, r = self.call('POST', '/link', {'root': str(self.temp.name), 'main': 'main.tex', 'commit': self.base_commit}, ok=None)
        self.assertEqual(code, 422)
        status = self.link()
        self.assertTrue(status['linked'])
        self.assertEqual(status['source_commit'], self.base_commit)
        self.assertEqual(status['changes'], [])
        self.assertIn('sections/intro.tex', status['files'])

    def test_bibliography_edit_comments_stale_save_and_version(self):
        """BibTeX shares source save/review/version semantics; prose inputs stay TeX-only.
        Pre: isolated Git source; post: exact bibliography committed without unrelated files.
        """
        self.link()
        original = '@article{k, title={Original title}, year={2025}}\n'
        (self.src / 'references.bib').write_text(original)
        status = self.call('GET')[1]
        self.assertIn('references.bib', status['files'])
        cfg = self.project.drafts.config(self.doc)
        self.assertNotIn('references.bib', self.project.drafts.tex_files(cfg))
        read = self.call('GET', '/file?path=references.bib')[1]
        updated = original.replace('2025', '2026')
        self.save(updated, 'references.bib')
        code, _ = self.call('PUT','/file',{'path':'references.bib','text':'stale','sha':read['sha']},ok=None)
        self.assertEqual(code,422)
        markup = self.base + '/' + self.doc['id'] + '/markup'
        code, raw = self.request('POST',markup,{'kind':'comment','target':{'file':'references.bib','quote':'Original title'},'text':'Check the title.'})
        self.assertEqual(code,201,raw)
        (self.repo / 'unrelated.txt').write_text('Keep this out of the version')
        def build(cwd, main, outdir, jobname):
            """Inspect real committed export; substitute only TeX compilation."""
            self.assertEqual((cwd / 'references.bib').read_text(),updated)
            outdir.mkdir(parents=True,exist_ok=True)
            pdf = outdir / (jobname + '.pdf')
            pdf.write_bytes(sample_pdf())
            return True,'fixture',[],pdf
        with patch.object(self.project.drafts,'latexmk',side_effect=build):
            result = self.call('POST','/promote',{})[1]
        self.assertEqual(result['document']['number'],2)
        self.assertEqual(run(self.repo,'git','show','HEAD:paper/references.bib'),updated.strip())
        self.assertEqual(run(self.repo,'git','status','--porcelain','--','unrelated.txt'),'?? unrelated.txt')

    def test_citations_report_empty_and_unknown_keys(self):
        self.link()
        (self.src / 'refs.bib').write_text('@string{x = "y"}\n@article{known2020,\n  author = {Doe, Jane and Roe, Rick and Poe, Al},\n'
                                           '  title = {A {Known} Paper}, year = 2020}\n@book{known2020, title={Twice}}\n')
        (self.src / 'main.tex').write_text(MAIN.replace('\\end{document}', '\\bibliography{refs,gone}\n\\end{document}'))
        self.save(INTRO.replace('calls for caution.', 'calls for caution~\\cite{known2020, nope2021} % \\cite{hidden}\nand~\\cite{}.'))
        r = self.call('GET', '/citations')[1]
        self.assertEqual(r['bib_files'], ['refs.bib'])
        self.assertEqual(r['missing_bib'], ['gone.bib'])
        self.assertEqual(r['duplicates'], ['known2020'])
        self.assertEqual(r['entries'][0], {'key': 'known2020', 'type': 'article', 'title': 'A Known Paper', 'author': 'Doe et al.', 'year': '2020', 'bib': 'refs.bib'})
        self.assertEqual([(p['kind'], p['key'], p['file'], p['line']) for p in r['problems']],
                         [('unknown', 'nope2021', 'sections/intro.tex', 1), ('empty', '', 'sections/intro.tex', 2)])
        text = (self.src / 'sections' / 'intro.tex').read_text()
        p = r['problems'][0]
        self.assertEqual(text[p['start']:p['end']], 'nope2021')
        # Without \bibliography, every .bib in the source folder counts.
        (self.src / 'main.tex').write_text(MAIN)
        self.assertEqual(self.call('GET', '/citations')[1]['bib_files'], ['refs.bib'])

    def test_cite_parsing_helpers(self):
        uses = cite_uses('See~\\citep[p.~3][]{a,  b}, \\citeauthor*{c} and 50\\% \\nocite{*}.')
        self.assertEqual([u['key'] for u in uses], ['a', 'b', 'c'])
        self.assertEqual(parse_bib('@misc{k, author = "Ann Lee and Bo Ma", year = {1999}}')[0]['author'], 'Lee and Ma')

    def test_writing_ignores_persist_and_validate(self):
        self.link()
        r = self.call('POST', '/writing/ignores', {'key': 'abc123', 'rule': 'long', 'file': 'sections/intro.tex', 'text': 'A long one.'})[1]
        self.assertEqual([(x['key'], x['rule']) for x in r['writing_ignores']], [('abc123', 'long')])
        self.assertEqual(len(self.call('GET')[1]['writing_ignores']), 1)
        self.call('POST', '/writing/ignores', {'key': 'abc123', 'rule': 'long', 'ignored': False})
        self.assertEqual(self.call('GET')[1]['writing_ignores'], [])
        code, _ = self.call('POST', '/writing/ignores', {'key': '../x', 'rule': 'long'}, ok=None)
        self.assertEqual(code, 422)

    def test_editor_save_creates_attributed_replacement(self):
        self.link()
        result = self.save(INTRO.replace('calls for caution', 'qualifies it'))
        [c] = result['changes']
        self.assertEqual((c['kind'], c['old'], c['new'], c['line']), ('replaced', 'calls for caution', 'qualifies it', 1))
        self.assertEqual(c['history'][-1]['by'], 'editor')
        # Edit the same passage again: one record with two wordings.
        self.save(INTRO.replace('calls for caution', 'limits it'))
        [c2] = self.call('GET')[1]['changes']
        self.assertEqual(c2['id'], c['id'])
        self.assertEqual([h['text'] for h in c2['history']], ['qualifies it', 'limits it'])
        # The base PDF version is untouched; no new version exists.
        self.assertEqual(len(json.loads(self.request('GET', self.base + '/' + self.doc['id'] + '/versions')[1])), 1)

    def test_outside_edit_is_attributed_to_outside(self):
        self.link()
        (self.src / 'sections' / 'intro.tex').write_text(INTRO.replace('second', 'next'))
        [c] = self.call('GET')[1]['changes']
        self.assertEqual(c['history'][-1]['by'], 'outside the editor')

    def test_stale_save_is_refused(self):
        self.link()
        current = self.call('GET', '/file?path=sections/intro.tex')[1]
        (self.src / 'sections' / 'intro.tex').write_text(INTRO + 'x\n')
        code, r = self.call('PUT', '/file', {'path': 'sections/intro.tex', 'text': 'lost', 'sha': current['sha']}, ok=None)
        self.assertEqual(code, 422)
        self.assertIn('changed on disk', r['error'])
        self.assertTrue((self.src / 'sections' / 'intro.tex').read_text().endswith('x\n'))

    def test_paths_outside_source_and_non_tex_refused(self):
        self.link()
        (self.repo / 'secret.tex').write_text('secret')
        for path in ('../secret.tex', '/etc/hosts', 'main.aux', 'sections/../../secret.tex'):
            code, _ = self.call('GET', '/file?path=' + path, ok=None)
            self.assertEqual(code, 422, path)

    def test_accept_revert_and_comments(self):
        self.link()
        [c] = self.save(INTRO.replace('calls for caution', 'qualifies it'))['changes']
        self.assertEqual(self.call('POST', f'/changes/{c["id"]}/status', {'status': 'accepted'})[1]['status'], 'accepted')
        rec = self.call('POST', f'/changes/{c["id"]}/comments', {'text': 'Check against D7.', 'author': 'Claude'})[1]
        self.assertEqual(rec['comments'][0]['author'], 'Claude')
        rec = self.call('POST', f'/changes/{c["id"]}/revert')[1]
        self.assertEqual(rec['status'], 'reverted')
        self.assertEqual((self.src / 'sections' / 'intro.tex').read_text(), INTRO)
        status = self.call('GET')[1]
        self.assertEqual(status['changes'], [])
        self.assertEqual(status['inactive'][0]['comments'][0]['text'], 'Check against D7.')

    def test_archived_version_cannot_change_draft(self):
        self.link()
        code, body = self.request('POST', self.base, {'name': 'paper.pdf', 'data': base64.b64encode(sample_pdf()).decode(), 'version_of': self.doc['id']})
        self.assertEqual(code, 201)
        current = self.call('GET', '/file?path=sections/intro.tex', ok=None)
        code, _ = self.call('PUT', '/file', {'path': 'sections/intro.tex', 'text': 'x', 'sha': 'y'}, ok=None)
        self.assertEqual(code, 409)

    def test_mutations_require_token(self):
        self.link()
        code, _ = self.request('PUT', self.url + '/file', {'path': 'sections/intro.tex', 'text': 'x', 'sha': 'y'}, token=False)
        self.assertEqual(code, 403)
        code, _ = self.request('POST', self.url + '/compile', {}, token=False)
        self.assertEqual(code, 403)

    def test_active_file_validation_and_token(self):
        self.link()
        code, _ = self.request('POST', self.url + '/compile-active', {'path': 'main.tex'}, token=False)
        self.assertEqual(code, 403)
        for path in (None, '../secret.tex', str(self.src / 'main.tex'), 'main.aux', 'missing.tex', 'sections/intro.tex'):
            code, r = self.call('POST', '/compile-active', {'path': path}, ok=None)
            self.assertEqual(code, 422, (path, r))
        self.assertIn('fragment', r['error'])
        (self.src / 'escape.tex').symlink_to(self.src / 'main.tex')
        self.assertEqual(self.call('POST', '/compile-active', {'path': 'escape.tex'}, ok=None)[0], 422)
        self.assertEqual(self.call('GET', '/active-file/pdf?path=main.tex', ok=None)[0], 404)
        self.addCleanup(lambda: self.project.drafts.active_file_tmp and self.project.drafts.active_file_tmp.cleanup())

    @unittest.skipUnless(HAVE_TEX, 'latexmk, pdflatex and synctex are needed')
    def test_active_file_build_is_isolated_and_failed_build_keeps_preview(self):
        self.link()
        self.call('POST', '/compile', {})
        draft_pdf = self.request('GET', self.url + '/pdf')[1]
        state_path = self.project.drafts.state_path(self.doc['paper_id'])
        state = state_path.read_bytes()
        (self.src / 'review-notes').mkdir()
        selected = self.src / 'review-notes' / 'claims.tex'
        selected.write_text(MAIN.replace('\\input{sections/intro}', 'Standalone preview.'))
        files_before = {p.relative_to(self.src): p.read_bytes() for p in self.src.rglob('*') if p.is_file()}
        code, build = self.call('POST', '/compile-active', {'path': 'review-notes/claims.tex'})
        self.addCleanup(lambda: self.project.drafts.active_file_tmp and self.project.drafts.active_file_tmp.cleanup())
        self.assertTrue(build['ok'], build['log'])
        self.assertEqual(build['file'], 'review-notes/claims.tex')
        self.assertEqual(build['pages'], 1)
        preview = self.request('GET', self.url + '/active-file/pdf?path=review-notes/claims.tex')[1]
        self.assertTrue(preview.startswith(b'%PDF-'))
        self.assertNotEqual(preview, draft_pdf)
        self.assertEqual(state_path.read_bytes(), state)
        self.assertEqual(self.request('GET', self.url + '/pdf')[1], draft_pdf)
        self.assertEqual({p.relative_to(self.src): p.read_bytes() for p in self.src.rglob('*') if p.is_file()}, files_before)
        selected.write_text('\\documentclass{article}\n\\begin{document}\n\\badcommand\n\\end{document}')
        build = self.call('POST', '/compile-active', {'path': 'review-notes/claims.tex'})[1]
        self.assertFalse(build['ok'])
        self.assertEqual(self.request('GET', self.url + '/active-file/pdf?path=review-notes/claims.tex')[1], preview)
        self.assertEqual(state_path.read_bytes(), state)
        self.assertEqual(self.request('GET', self.url + '/pdf')[1], draft_pdf)

    @unittest.skipUnless(HAVE_TEX, 'latexmk, pdflatex and synctex are needed')
    def test_compile_synctex_and_promote(self):
        self.link()
        self.save(INTRO.replace('calls for caution', 'qualifies it'))
        code, build = self.call('POST', '/compile', {})
        self.assertTrue(build['ok'], build['log'][-800:])
        code, pdf = self.request('GET', self.url + '/pdf')
        self.assertTrue(pdf.startswith(b'%PDF-'))
        boxes = self.call('GET', '/synctex/view?path=sections/intro.tex&line=1')[1]
        self.assertTrue(boxes and boxes[0]['page'] == 1)
        b = boxes[0]
        where = self.call('GET', f'/synctex/edit?page=1&x={b["x"] + 5}&y={b["y"] + b["h"] / 2}')[1]
        self.assertEqual(where['file'], 'sections/intro.tex')
        # Unrelated staged work must survive promotion untouched.
        (self.repo / 'notes.md').write_text('staged elsewhere')
        run(self.repo, 'git', 'add', 'notes.md')
        code, result = self.call('POST', '/promote', {})
        commit = result['commit']
        self.assertEqual(run(self.repo, 'git', 'rev-parse', 'HEAD'), commit)
        self.assertEqual(run(self.repo, 'git', 'show', '--name-only', '--format=', commit), 'paper/sections/intro.tex')
        self.assertIn('"calls for caution" -> "qualifies it"', run(self.repo, 'git', 'log', '-1', '--format=%B'))
        self.assertEqual(run(self.repo, 'git', 'diff', '--cached', '--name-only'), 'notes.md')
        self.assertEqual(run(self.repo, 'git', 'status', '--porcelain', '--', 'paper'), '')
        new = result['document']
        self.assertEqual((new['number'], new['source_commit']), (2, commit))
        # The new version starts with a clean draft; the old draft history is kept.
        self.url = self.base + '/' + new['id'] + '/draft'
        status = self.call('GET')[1]
        self.assertEqual((status['changes'], status['draft_pdf']), ([], False))
        self.url = self.base + '/' + self.doc['id'] + '/draft'
        history = self.call('GET', '/history')[1]
        self.assertEqual(history['promoted_commit'], commit)
        self.assertEqual(history['records'][0]['new'], 'qualifies it')

    @unittest.skipUnless(HAVE_TEX, 'latexmk, pdflatex and synctex are needed')
    def test_failed_build_commits_nothing(self):
        self.link()
        self.save(INTRO.replace('calls for caution', '\\undefinedcommand'))
        head = run(self.repo, 'git', 'rev-parse', 'HEAD')
        code, r = self.call('POST', '/promote', {}, ok=None)
        self.assertEqual(code, 422)
        self.assertIn('nothing was committed', r['error'])
        self.assertEqual(run(self.repo, 'git', 'rev-parse', 'HEAD'), head)
        self.assertEqual(len(json.loads(self.request('GET', self.base + '/' + self.doc['id'] + '/versions')[1])), 1)


    # Hide images: the working tree built without figure floats, in a temporary folder.
    def test_no_figures_needs_a_build_and_the_token(self):
        self.link()
        code, r = self.call('GET', '/no-figures/pdf', ok=None)
        self.assertEqual(code, 404)
        self.assertIn('No PDF without figures yet', r['error'])
        code, _ = self.request('POST', self.url + '/no-figures', {}, token=False)
        self.assertEqual(code, 403)

    @unittest.skipUnless(HAVE_TEX, 'latexmk, pdflatex and synctex are needed')
    def test_no_figures_build_removes_figures_and_changes_nothing_else(self):
        # Every float sits on its own page; the teaser is a plain environment, as acmart's is outside floats.
        tall = '\\rule{1pt}{0.8\\textheight}'
        (self.src / 'main.tex').write_text(
            '\\documentclass{article}\n\\pdfobjcompresslevel=0\n\\newenvironment{teaserfigure}{}{}\n\\begin{document}\n'
            f'\\begin{{teaserfigure}}{tall}\\end{{teaserfigure}}\n\\input{{sections/intro}}\n'
            f'\\begin{{figure}}[p]{tall}\\caption{{One}}\\label{{fig:one}}\\end{{figure}}\n'
            f'\\begin{{figure*}}[p]{tall}\\caption{{Two}}\\end{{figure*}}\n'
            f'\\begin{{table}}[p]\\caption{{Stays}}{tall}\\end{{table}}\n'
            'See Figure~\\ref{fig:one}.\n\\end{document}\n')
        run(self.repo, 'git', 'commit', '-q', '-am', 'figures')
        self.base_commit = run(self.repo, 'git', 'rev-parse', 'HEAD')
        self.link()
        drafts = self.project.drafts
        self.addCleanup(lambda: drafts.no_figures_tmp and drafts.no_figures_tmp.cleanup())
        code, build = self.call('POST', '/compile', {})
        self.assertTrue(build['ok'], build['log'][-800:])
        # Snapshot everything the figure-free build must leave alone.
        files = lambda root: {p.relative_to(root): p.read_bytes() for p in sorted(root.rglob('*')) if p.is_file() and '.git' not in p.parts}
        sources, library = files(self.repo), files(self.folder)
        status = run(self.repo, 'git', 'status', '--porcelain', '--ignored')
        code, r = self.call('POST', '/no-figures', {})
        self.assertTrue(r['ok'], r['log'][-800:])
        self.assertEqual(r['removed'], {'teaserfigure': 1, 'figure': 1, 'figure*': 1})  # the table stays
        code, pdf = self.request('GET', self.url + '/no-figures/pdf')
        self.assertEqual(code, 200)
        draft_pdf = self.request('GET', self.url + '/pdf')[1]
        # The page counts from the TeX log match the page objects in the uncompressed PDFs.
        count = lambda data: len(re.findall(rb'/Type\s*/Page\b(?!s)', data))
        self.assertEqual((build['pages'], r['pages']), (count(draft_pdf), count(pdf)))
        self.assertEqual(r['pages'], 2)  # text, then the table's page
        self.assertGreater(build['pages'], r['pages'])
        # Sources, git status, the draft (state, PDF, builds) and the library are unchanged.
        self.assertEqual(files(self.repo), sources)
        self.assertEqual(run(self.repo, 'git', 'status', '--porcelain', '--ignored'), status)
        self.assertEqual(files(self.folder), library)
        # The build lives in a temporary folder outside the library and the sources.
        out = drafts.no_figures_dir(self.doc['paper_id'])
        self.assertTrue((out / 'no-figures.pdf').is_file())
        for root in (self.folder, self.repo, Path(self.temp.name)):
            self.assertFalse(out.resolve().is_relative_to(root.resolve()))
        # A second build with nothing changed gives the same result.
        code, again = self.call('POST', '/no-figures', {})
        self.assertEqual((again['ok'], again['pages'], again['removed']), (True, 2, r['removed']))
        # The temporary folder goes away with the server's drafts object.
        drafts.no_figures_tmp.cleanup()
        self.assertFalse(out.exists())

    @unittest.skipUnless(HAVE_TEX, 'latexmk, pdflatex and synctex are needed')
    def test_no_figures_build_reports_errors(self):
        self.link()
        self.addCleanup(lambda: self.project.drafts.no_figures_tmp and self.project.drafts.no_figures_tmp.cleanup())
        self.save(INTRO.replace('calls for caution', '\\undefinedcommand'))
        code, r = self.call('POST', '/no-figures', {})
        self.assertFalse(r['ok'])
        self.assertTrue(any('undefinedcommand' in e or 'Undefined control sequence' in e for e in r['errors']), r['errors'])
        self.assertEqual((r['pages'], r['removed']), (None, None))
        self.assertEqual(self.call('GET', '/no-figures/pdf', ok=None)[0], 404)

    # Comments anchored in the source, shown in the source and on the PDF.
    def note(self, quote, text='Is this the right term?', origin='source'):
        src = self.call('GET', '/file?path=sections/intro.tex')[1]['text']
        i = src.index(quote)
        return self.call('POST', '/notes', {'file': 'sections/intro.tex', 'start': i, 'end': i + len(quote),
                                            'quote': quote, 'text': text, 'author': 'Dries', 'origin': origin})[1]

    def test_note_follows_edits_and_keeps_its_thread(self):
        self.link()
        n = self.note('inherited evidence')
        self.assertEqual((n['line'], n['anchor'], n['comments'][0]['author']), (1, 'ok', 'Dries'))
        self.save('New first sentence. ' + INTRO)
        [n2] = self.call('GET')[1]['notes']
        src = (self.src / 'sections' / 'intro.tex').read_text()
        self.assertEqual((src[n2['start']:n2['end']], n2['anchor']), ('inherited evidence', 'ok'))
        self.save(INTRO.replace('inherited evidence', 'supplied record'))
        [n3] = self.call('GET')[1]['notes']
        self.assertEqual((n3['anchor'], n3['current'].strip()), ('edited', 'supplied record'))
        n4 = self.call('POST', f'/notes/{n["id"]}/comments', {'text': 'Fine now.', 'author': 'Claude'})[1]
        self.assertEqual([c['author'] for c in n4['comments']], ['Dries', 'Claude'])
        self.assertEqual(self.call('POST', f'/notes/{n["id"]}/status', {'status': 'resolved'})[1]['status'], 'resolved')

    def test_note_path_is_canonical_and_body_must_be_object(self):
        self.link()
        src = self.call('GET', '/file?path=sections/intro.tex')[1]['text']
        i = src.index('second')
        n = self.call('POST', '/notes', {'file': './sections/intro.tex', 'start': i, 'end': i + 6, 'quote': 'second',
                                         'text': 'x', 'author': 'Dries'})[1]
        self.assertEqual(n['file'], 'sections/intro.tex')
        code, _ = self.request('POST', self.url + '/notes', '[1, 2]')
        self.assertEqual(code, 400)

    def test_note_on_stale_selection_is_refused(self):
        self.link()
        code, r = self.call('POST', '/notes', {'file': 'sections/intro.tex', 'start': 0, 'end': 5, 'quote': 'XXXXX',
                                               'text': 'x', 'author': 'Dries'}, ok=None)
        self.assertEqual(code, 422)
        code, r = self.call('POST', '/notes', {'file': '../secret.tex', 'start': 0, 'end': 1, 'quote': 'x',
                                               'text': 'x', 'author': 'Dries'}, ok=None)
        self.assertEqual(code, 422)

    @unittest.skipUnless(HAVE_TEX, 'latexmk, pdflatex and synctex are needed')
    def test_open_notes_carry_into_the_next_draft(self):
        self.link()
        keep = self.note('second paragraph', 'Still open.')
        done = self.note('inherited evidence', 'Resolved before saving.')
        self.call('POST', f'/notes/{done["id"]}/status', {'status': 'resolved'})
        self.save(INTRO.replace('calls for caution', 'qualifies it'))
        code, result = self.call('POST', '/promote', {})
        self.assertIsNone(result['warning'])
        self.url = self.base + '/' + result['document']['id'] + '/draft'
        notes = self.call('GET')[1]['notes']
        self.assertEqual([(n['id'], n['carried_from'], n['anchor']) for n in notes], [(keep['id'], 1, 'ok')])
        self.url = self.base + '/' + self.doc['id'] + '/draft'
        self.assertEqual(len(self.call('GET', '/history')[1]['notes']), 2)

    def test_styled_marks_strokes_and_delete(self):
        self.link()
        src = self.call('GET', '/file?path=sections/intro.tex')[1]['text']
        i = src.index('second paragraph')
        mark = {'file': 'sections/intro.tex', 'start': i, 'end': i + 16, 'quote': 'second paragraph', 'author': 'Dries'}
        code, r = self.call('POST', '/notes', {**mark, 'text': ''}, ok=None)
        self.assertEqual(code, 422)  # plain comments need text
        hl = self.call('POST', '/notes', {**mark, 'text': '', 'style': {'type': 'highlight', 'color': 'green'}, 'origin': 'pdf'})[1]
        self.assertEqual((hl['style'], hl['comments']), ({'type': 'highlight', 'color': 'green'}, []))
        rp = self.call('POST', '/notes', {**mark, 'text': 'Replacement: last paragraph', 'style': {'type': 'strikethrough', 'intent': 'replace'}})[1]
        self.assertEqual(rp['style'], {'type': 'strikethrough', 'intent': 'replace'})
        self.call('POST', f'/notes/{hl["id"]}/status', {'status': 'deleted'})
        self.assertEqual([n['id'] for n in self.call('GET')[1]['notes']], [rp['id']])
        st = self.call('POST', '/strokes', {'page': 1, 'color': '#1971c2', 'width': 2.5, 'points': [[10, 10], [20, 25]],
                                            'anchor': {'words': ['supplied', 'evidence'], 'context': ['drops', 'the'], 'dx': -2, 'dy': 9.5}})[1]
        self.assertEqual(st['anchor']['words'], ['supplied', 'evidence'])
        self.assertEqual(len(self.call('GET')[1]['strokes']), 1)
        code, _ = self.call('POST', '/strokes', {'page': 1, 'color': 'red', 'width': 2, 'points': [[1, 1]]}, ok=None)
        self.assertEqual(code, 422)
        code, _ = self.call('POST', '/strokes', {'page': 1, 'color': '#000000', 'width': 2, 'points': [[1, 1]],
                                                 'anchor': {'words': [], 'context': [], 'dx': 0, 'dy': 0}}, ok=None)
        self.assertEqual(code, 422)
        self.call('POST', f'/strokes/{st["id"]}/status', {'status': 'deleted'})
        self.assertEqual(self.call('GET')[1]['strokes'], [])

    # Regressions from the independent review (2026-11-07).
    def test_symlink_and_non_utf8_do_not_block_the_draft(self):
        self.link()
        outside = Path(self.temp.name) / 'outside.tex'
        outside.write_text('secret')
        (self.src / 'sections' / 'ln.tex').symlink_to(outside)
        (self.src / 'sections' / 'latin1.tex').write_bytes('caf\xe9'.encode('latin-1'))
        self.save(INTRO.replace('calls for caution', 'qualifies it'))
        status = self.call('GET')[1]
        self.assertEqual([c['new'] for c in status['changes']], ['qualifies it'])
        self.assertNotIn('sections/ln.tex', status['files'])
        self.assertEqual([p['file'] for p in status['problems']], ['sections/latin1.tex'])
        self.assertEqual(outside.read_text(), 'secret')

    def test_unicode_filename_is_listed(self):
        self.link()
        (self.src / 'sections' / 'é.tex').write_text('hello world\n')
        status = self.call('GET')[1]
        self.assertIn('sections/é.tex', status['files'])
        self.assertEqual([c['file'] for c in status['changes']], ['sections/é.tex'])

    def test_crlf_line_endings_survive_save_and_revert(self):
        (self.src / 'sections' / 'intro.tex').write_bytes(INTRO.replace('\n', '\r\n').encode())
        run(self.repo, 'git', 'commit', '-qam', 'crlf')
        self.base_commit = run(self.repo, 'git', 'rev-parse', 'HEAD')
        self.link()
        text = self.call('GET', '/file?path=sections/intro.tex')[1]['text']
        self.assertIn('\r\n', text)
        [c] = self.save(text.replace('calls for caution', 'qualifies it'))['changes']
        data = (self.src / 'sections' / 'intro.tex').read_bytes()
        self.assertEqual(data.count(b'\r\n'), INTRO.count('\n'))
        self.call('POST', f'/changes/{c["id"]}/revert')
        self.assertEqual((self.src / 'sections' / 'intro.tex').read_bytes(), INTRO.replace('\n', '\r\n').encode())

    def test_change_edited_again_after_undo_is_open(self):
        self.link()
        [c] = self.save(INTRO.replace('calls for caution', 'qualifies it'))['changes']
        self.save(INTRO)
        [c2] = self.save(INTRO.replace('calls for caution', 'qualifies it'))['changes']
        self.assertEqual((c2['id'], c2['status']), (c['id'], 'open'))

    def test_deleted_file_is_a_removal_and_can_be_reverted(self):
        self.link()
        (self.src / 'sections' / 'intro.tex').unlink()
        [c] = self.call('GET')[1]['changes']
        self.assertEqual((c['kind'], c['file']), ('removed', 'sections/intro.tex'))
        self.call('POST', f'/changes/{c["id"]}/revert')
        self.assertEqual((self.src / 'sections' / 'intro.tex').read_text(), INTRO)

    def test_relink_to_another_commit_starts_a_new_draft(self):
        self.link()
        self.note('second paragraph', 'Keep after re-linking.')
        self.save(INTRO.replace('calls for caution', 'qualifies it'))
        run(self.repo, 'git', 'commit', '-qam', 'second')
        second = run(self.repo, 'git', 'rev-parse', 'HEAD')
        status = self.call('POST', '/link', {'root': str(self.src), 'main': 'main.tex', 'commit': second})[1]
        self.assertEqual((status['source_commit'], status['changes']), (second, []))
        self.assertEqual([n['quote'] for n in status['notes']], ['second paragraph'])
        archived = list((self.folder / '.research-workbench' / 'drafts' / 'history').glob('*-relinked-*.json'))
        self.assertEqual(len(archived), 1)

    def test_missing_source_folder_shows_link_form(self):
        self.link()
        shutil.move(str(self.src), str(self.repo / 'moved'))
        status = self.call('GET')[1]
        self.assertFalse(status['linked'])
        self.assertIn('missing', status['error'])

    @unittest.skipUnless(HAVE_TEX, 'latexmk, pdflatex and synctex are needed')
    def test_already_committed_changes_make_no_empty_commit(self):
        self.link()
        self.save(INTRO.replace('calls for caution', 'qualifies it'))
        run(self.repo, 'git', 'commit', '-qam', 'committed by hand')
        head = run(self.repo, 'git', 'rev-parse', 'HEAD')
        code, result = self.call('POST', '/promote', {})
        self.assertEqual((result['commit'], result['new_commit']), (head, False))
        self.assertEqual(run(self.repo, 'git', 'rev-parse', 'HEAD'), head)
        self.assertEqual(result['document']['source_commit'], head)

    @unittest.skipUnless(HAVE_TEX, 'latexmk, pdflatex and synctex are needed')
    def test_failed_import_rolls_back_the_commit(self):
        self.link()
        self.save(INTRO.replace('calls for caution', 'qualifies it'))
        head = run(self.repo, 'git', 'rev-parse', 'HEAD')
        with patch.object(Project, 'import_pdf', side_effect=OSError('disk full')):
            code, r = self.call('POST', '/promote', {}, ok=None)
        self.assertEqual(code, 500)
        self.assertEqual(run(self.repo, 'git', 'rev-parse', 'HEAD'), head)
        self.assertEqual(run(self.repo, 'git', 'diff', '--cached', '--name-only'), '')
        self.assertIn('qualifies it', (self.src / 'sections' / 'intro.tex').read_text())
        self.assertEqual(len(self.call('GET')[1]['changes']), 1)


class RelocateTests(unittest.TestCase):
    def note(self, text, quote):
        i = text.index(quote)
        return {'start': i, 'end': i + len(quote), 'quote': quote, 'before': text[:i], 'after': text[i + len(quote):]}

    def test_follows_text_moved_by_an_edit_before_it(self):
        old = 'Alpha beta. The slope is steep here. Gamma.'
        n = self.note(old, 'slope is steep')
        new = 'Alpha beta and more words. The slope is steep here. Gamma.'
        s, e, a = relocate(new, n)
        self.assertEqual((new[s:e], a), ('slope is steep', 'ok'))

    def test_rewritten_passage_is_found_by_its_surroundings(self):
        old = 'Some words before the passage. The slope is steep here. Words after the passage.'
        n = self.note(old, 'The slope is steep here.')
        new = 'Some words before the passage. Slopes vary a lot. Words after the passage.'
        s, e, a = relocate(new, n)
        self.assertEqual((new[s:e].strip(), a), ('Slopes vary a lot.', 'edited'))

    def test_repeated_quote_keeps_its_occurrence(self):
        t = 'the a the b the c the d the e the f the g the h'
        i = [k for k in range(len(t)) if t.startswith('the', k)][4]
        n = {'start': i, 'end': i + 3, 'quote': 'the', 'before': t[:i], 'after': t[i + 3:]}
        self.assertEqual(relocate('X' * 83 + t, n), (i + 83, i + 86, 'ok'))
        # Text inserted just before it, at its old offset another 'the' appears: context still decides.
        self.assertEqual(relocate('the ' + t, n)[0], i + 4)

    # A comment on a phrase whose whole sentence is rewritten: the words right around it are gone too.
    P1 = 'Robots move slowly on the lunar surface. '
    S = 'The supervisor compares these slope layers with fixed limits before choosing a route. '
    P3 = 'Provenance offers another view of the same data.\n'

    def ctx_note(self, text, quote):
        i = text.index(quote)
        return {'start': i, 'end': i + len(quote), 'quote': quote, 'before': text[max(0, i - 300):i], 'after': text[i + len(quote):i + len(quote) + 200]}

    def test_rewritten_sentence_keeps_comment_on_new_sentence(self):
        n = self.ctx_note(self.P1 + self.S + self.P3, 'slope layers')
        for new_sentence in ['Before a route is chosen, a planner checks each layer against its limits.',
                             'A planner checks each layer. It uses fixed limits.']:
            new = self.P1 + new_sentence + ' ' + self.P3
            s, e, a = relocate(new, n)
            self.assertEqual((new[s:e], a), (new_sentence, 'edited'))

    def test_split_sentence_keeps_exact_phrase(self):
        n = self.ctx_note(self.P1 + self.S + self.P3, 'slope layers')
        new = self.P1 + 'The supervisor compares these slope layers with fixed limits. Then the supervisor chooses a route. ' + self.P3
        s, e, a = relocate(new, n)
        self.assertEqual((new[s:e], a), ('slope layers', 'ok'))

    def test_deleted_sentence_leaves_comment_in_place(self):
        n = self.ctx_note(self.P1 + self.S + self.P3, 'slope layers')
        new = self.P1 + self.P3
        s, e, a = relocate(new, n)
        self.assertEqual((s, e, a), (len(self.P1), len(self.P1), 'edited'))

    def test_quote_at_file_start_found_by_text_after_it(self):
        n = {'start': 0, 'end': 5, 'quote': 'Hello', 'before': '', 'after': ' world and more text'}
        s, e, a = relocate('Howdy world and more text', n)
        self.assertEqual(('Howdy world and more text'[s:e], a), ('Howdy', 'edited'))

    def test_lost_when_nothing_matches(self):
        n = self.note('Some words before. Quote here. After it.', 'Quote here.')
        self.assertEqual(relocate('Completely different text.', n)[2], 'lost')


# Run only the draft tests here, not the inherited editor tests a second time.
for name in [n for n in dir(test_editor.EditorTests) if n.startswith('test_')]:
    setattr(DraftTests, name, None)

if __name__ == '__main__':
    unittest.main()
