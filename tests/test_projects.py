"""Project registry, file-tree confinement and versioned PDF routing regressions."""
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

import http_fixture
from test_editor import sample_pdf
from research_workbench.launcher import App, Project
from research_workbench.infrastructure.filesystem.project_storage import LEGACY_METADATA_DIRECTORY


class ProjectStorageMigrationTests(unittest.TestCase):
    def test_previous_metadata_preserves_identity_and_annotation_bytes(self):
        """Pre: populated previous storage. Post: reopening migrates bytes and stable IDs intact.

        Raises AssertionError on regression; exercises Project's normal initialization.
        """
        with tempfile.TemporaryDirectory() as folder:
            first = Project(folder)
            document = first.import_pdf('paper.pdf', sample_pdf())
            first.save_annotations(document, {'version': 1, 'highlights': [], 'strokes': []})
            before = {str(p.relative_to(first.meta)): p.read_bytes()
                      for p in first.meta.rglob('*') if p.is_file()}
            old = first.root / LEGACY_METADATA_DIRECTORY
            first.meta.rename(old)
            reopened = Project(folder)
            self.assertEqual(reopened.meta.name, '.research-workbench')
            self.assertFalse(old.exists())
            self.assertEqual(reopened.doc(document['id'])['id'], document['id'])
            self.assertEqual({str(p.relative_to(reopened.meta)): p.read_bytes()
                              for p in reopened.meta.rglob('*') if p.is_file()}, before)
            self.assertEqual(Project(folder).documents(), reopened.documents())

    def test_conflicting_or_symlinked_storage_is_preserved_and_refused(self):
        """Pre: ambiguous or linked storage. Post: Project refuses without changing data.

        Raises AssertionError on regression; uses only temporary directories.
        """
        with tempfile.TemporaryDirectory() as folder:
            project = Project(folder)
            old = project.root / LEGACY_METADATA_DIRECTORY
            old.mkdir()
            sentinel = old / 'notes.json'
            sentinel.write_bytes(b'private notes')
            with self.assertRaisesRegex(ValueError, 'Two metadata'):
                Project(folder)
            self.assertEqual(sentinel.read_bytes(), b'private notes')
            sentinel.unlink()
            old.rmdir()
            old.symlink_to(project.meta, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, 'real directory'):
                Project(folder)
            self.assertTrue(old.is_symlink())


class ProjectNavigationTests(unittest.TestCase):
    setUp = http_fixture.setup
    tearDown = http_fixture.teardown
    request = http_fixture.request

    def call(self, method, suffix, data=None, status=200):
        """Call a project route. Pre: fixture; post: decoded response or assertion failure."""
        code, body = self.request(method, '/api/projects/' + self.key + suffix, data)
        self.assertEqual(code, status, body)
        return json.loads(body)

    def test_registry_survives_restart_and_old_settings(self):
        """Old last-folder settings migrate; registration deduplicates and IDs survive restarts."""
        other = Path(self.temp.name) / 'other'
        second, _ = self.app.choose(str(other))
        self.app.choose(str(self.folder / '..' / 'project'))
        restarted = App(self.app.settings)
        self.assertEqual(len(restarted.project_list()), 2)
        self.assertEqual(restarted.choose(str(other))[0], second)
        self.assertEqual(restarted.choose(str(self.folder))[0], self.key)
        self.app.settings.write_text(json.dumps({'last_folder': str(self.folder)}))
        migrated = App(self.app.settings)
        self.assertEqual(migrated.project_list()[0]['id'], self.key)
        migrated.choose(str(other))
        self.assertEqual(len(App(self.app.settings).project_list()), 2)

    def test_unavailable_project_is_not_recreated_by_listing(self):
        """Listing saved projects must not recreate disconnected/moved folders."""
        shutil.rmtree(self.folder)
        code, body = self.request('GET', '/api/projects')
        self.assertEqual(code, 200)
        self.assertFalse(json.loads(body)[0]['available'])
        self.assertFalse(self.folder.exists())

    def test_nested_tree_preserves_folders_and_hides_private_data(self):
        """The tree shows source and reading directories without exposing managed or linked files."""
        reading = self.folder / 'Reading' / 'Methods'
        reading.mkdir(parents=True)
        (reading / 'evidence.pdf').write_bytes(sample_pdf())
        (self.folder / 'main.tex').write_text('Text')
        (self.folder / '.secret').write_text('private')
        (self.folder / 'escape').symlink_to(Path(self.temp.name), target_is_directory=True)
        tree = self.call('GET', '/tree')
        names = [x['name'] for x in tree['children']]
        self.assertEqual(names, ['Reading', 'main.tex'])
        self.assertEqual(tree['children'][0]['children'][0]['children'][0]['path'], 'Reading/Methods/evidence.pdf')
        self.assertFalse(tree['truncated'])

    def test_disk_pdf_reuses_review_and_versions_changed_bytes(self):
        """Repeated opens preserve notes; changed PDFs get new isolated version annotations."""
        path = self.folder / 'reading.pdf'
        path.write_bytes(sample_pdf())
        first = self.call('POST', '/open-file', {'path': path.name})
        notes = {'version': 1, 'highlights': [], 'strokes': []}
        self.project.save_annotations(first, notes)
        again = self.call('POST', '/open-file', {'path': path.name})
        self.assertEqual(first['id'], again['id'])
        self.assertEqual(Project(self.folder).annotations(first), notes)
        path.write_bytes(sample_pdf().replace(b'Research Workbench test document', b'Research Workbench next document'))
        second = self.call('POST', '/open-file', {'path': path.name})
        self.assertEqual(second['number'], 2)
        self.assertEqual(second['paper_id'], first['paper_id'])
        self.assertFalse(self.project.doc(first['id'])['active'])
        self.assertEqual(self.project.path(first, 'original').read_bytes(), sample_pdf())
        self.assertEqual(self.project.annotations(first), notes)
        self.assertEqual(self.call('POST', '/open-file', {'path': path.name})['id'], second['id'])

    def test_open_file_rejects_traversal_symlinks_and_invalid_pdf(self):
        """Malformed targets cannot escape roots or add a corrupt PDF to the library."""
        outside = Path(self.temp.name) / 'outside.pdf'
        outside.write_bytes(sample_pdf())
        (self.folder / 'link.pdf').symlink_to(outside)
        (self.folder / 'bad.pdf').write_bytes(b'invalid')
        for rel in ('.', '../outside.pdf', str(outside), 'link.pdf', '.research-workbench/library.json', 'bad.pdf'):
            self.call('POST', '/open-file', {'path': rel}, status=400)
        self.assertEqual(self.project.documents(), [])

    def test_linked_sources_and_source_pdfs_route_to_their_root(self):
        """Linked TeX routes retain review context; source PDFs use the authorized source root."""
        source = self.folder / 'Source'
        source.mkdir()
        (source / 'main.tex').write_text('A passage')
        (source / 'references.pdf').write_bytes(sample_pdf())
        for command in [('init', '-q'), ('add', '.'), ('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture')]:
            subprocess.run(['git', '-C', str(source), *command], check=True, capture_output=True)
        commit = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
        paper = self.project.import_pdf('paper.pdf', sample_pdf())
        self.project.drafts.link(paper, str(source), 'main.tex', commit)
        tree = self.call('GET', '/tree')
        source_branch = next(x for x in tree['children'] if x['name'] == 'Source')
        tex = next(x for x in source_branch['children'] if x['type'] == 'tex')
        self.assertEqual(tex['source_document'], paper['id'])
        self.assertEqual(tex['source_path'], 'main.tex')
        doc = self.call('POST', '/open-file', {'path': 'references.pdf', 'source_document': paper['id']})
        self.assertEqual(self.project.path(doc, 'original').read_bytes(), sample_pdf())
        self.assertEqual(self.call('POST', '/open-file', {'path': 'references.pdf', 'source_document': paper['id']})['id'], doc['id'])
        self.call('POST', '/open-file', {'path': '../reading.pdf', 'source_document': paper['id']}, status=400)

    def test_independent_project_retains_every_version_and_review_record(self):
        """An isolated project keeps stable IDs, source links, exported PDFs and draft history."""
        first = self.project.import_pdf('paper.pdf', sample_pdf())
        self.project.export(first, sample_pdf())
        second = self.project.import_pdf('paper.pdf', sample_pdf(), version_of=first['id'])
        state = self.project.drafts.state_path(first['paper_id'])
        state.parent.mkdir(parents=True, exist_ok=True)
        notes = {'notes': [{'id': 'stable-note', 'comments': [{'text': 'Keep this thread'}]}]}
        state.write_text(json.dumps(notes))
        published = self.project.drafts.published(first['paper_id'])
        published.mkdir(parents=True)
        (published / 'draft.pdf').write_bytes(sample_pdf())
        history = state.parent / 'history'
        history.mkdir()
        (history / (first['id'] + '.json')).write_text(json.dumps(notes))
        (history / (first['id'] + '-draft.pdf')).write_bytes(sample_pdf())
        sources = {first['paper_id']: {'root': '../source', 'main': 'main.tex'}}
        self.project.drafts.sources_path.write_text(json.dumps(sources))
        before = self.project.index_path.read_bytes()
        target_path = Path(self.temp.name) / 'projects' / 'paper'
        target = self.project.copy_paper_project(second, target_path)
        self.assertEqual(self.project.index_path.read_bytes(), before)
        self.assertEqual([v['id'] for v in target.versions(second)], [second['id'], first['id']])
        self.assertEqual(target.path(target.doc(first['id']), 'original').read_bytes(), sample_pdf())
        self.assertEqual(target.path(target.doc(first['id']), 'annotated').read_bytes(), sample_pdf())
        self.assertEqual(target.annotations(target.doc(second['id'])), self.project.annotations(second))
        self.assertEqual(json.loads(target.drafts.state_path(first['paper_id']).read_text()), notes)
        self.assertEqual((target.drafts.dir / 'history' / (first['id'] + '.json')).read_text(), json.dumps(notes))
        self.assertEqual((target.drafts.dir / 'history' / (first['id'] + '-draft.pdf')).read_bytes(), sample_pdf())
        self.assertEqual((target.drafts.published(first['paper_id']) / 'draft.pdf').read_bytes(), sample_pdf())
        cfg = target.drafts.sources()[first['paper_id']]
        self.assertEqual((target.root / cfg['root']).resolve(), (self.project.root / '../source').resolve())
        self.assertEqual(target.index['project_paper_id'], first['paper_id'])
        self.assertEqual(target.tree()['children'][0]['kind'], 'pdf')

    def test_independent_project_never_overwrites_or_leaves_partial_copies(self):
        """Existing destinations and missing review files preserve all original data."""
        doc = self.project.import_pdf('paper.pdf', sample_pdf())
        target = Path(self.temp.name) / 'separate'
        target.mkdir()
        (target / 'keep.txt').write_text('preserve')
        with self.assertRaises(ValueError):
            self.project.copy_paper_project(doc, target)
        self.assertEqual((target / 'keep.txt').read_text(), 'preserve')
        self.project.path(doc, 'annotations').unlink()
        absent = Path(self.temp.name) / 'absent'
        with self.assertRaises(ValueError):
            self.project.copy_paper_project(doc, absent)
        self.assertFalse(absent.exists())
        self.assertEqual(list(Path(self.temp.name).glob('.paper-project-*')), [])
        self.assertTrue(self.project.path(doc, 'original').exists())


if __name__ == '__main__':
    unittest.main()
