"""Named imports: real handlers, duplicate policy and transactional preservation."""
import json
from pathlib import Path
import unittest
from unittest.mock import patch

import http_fixture
from research_workbench.launcher import Project
from test_editor import sample_pdf


class DirectoryImportTests(unittest.TestCase):
    setUp = http_fixture.setup
    tearDown = http_fixture.teardown
    request = http_fixture.request

    def directory(self):
        """Create a selected directory. Pre: fixture; post: two nested PDFs and ignored text."""
        root = Path(self.temp.name) / 'reading'
        (root / 'nested').mkdir(parents=True)
        (root / 'one.pdf').write_bytes(sample_pdf())
        (root / 'nested' / 'two.PDF').write_bytes(sample_pdf())
        (root / 'notes.txt').write_text('ignore')
        return root

    def upload(self, root, status=201, **options):
        """Call the real batch route. Pre: directory; post: decoded response; failures assert."""
        code, body = self.request('POST', '/api/projects/' + self.key + '/imports/directory',
            {'folder_path': str(root), 'collection_name': 'Related work', **options})
        self.assertEqual(code, status, body)
        return json.loads(body)

    def test_recursive_named_collection_and_reopen(self):
        """Nested PDFs land in one durable named collection with independent annotations."""
        root = self.directory()
        result = self.upload(root)
        self.assertEqual(result['imported'], 2)
        self.assertEqual(result['folder']['name'], 'Related work')
        reopened = Project(self.folder)
        self.assertEqual(len(reopened.documents()), 2)
        self.assertEqual({d['folder_id'] for d in reopened.documents()}, {result['folder']['id']})
        self.assertEqual(len({d['paper_id'] for d in reopened.documents()}), 2)
        self.assertTrue((root / 'one.pdf').exists())
        self.assertEqual(self.upload(root, duplicate_mode='skip')['imported'], 0)
        self.assertEqual(len(reopened.index['folders']), 1)

    def test_duplicate_failure_does_not_create_collection_or_partial_papers(self):
        """Duplicate defaults never silently archive existing versions or partially import."""
        root = self.directory()
        original = self.project.import_pdf('one.pdf', sample_pdf())
        before = self.project.index_path.read_bytes()
        result = self.upload(root, status=409)
        self.assertTrue(result['matches'])
        self.assertEqual(self.project.index_path.read_bytes(), before)
        self.assertTrue(self.project.doc(original['id'])['active'])
        result = self.upload(root, duplicate_mode='separate')
        self.assertEqual(result['imported'], 2)
        self.assertEqual(len(self.project.documents()), 3)
        self.assertTrue(self.project.doc(original['id'])['active'])

    def test_bad_pdf_rolls_back_and_symlinks_are_ignored(self):
        """A bad file aborts the batch before publication; symlinks never import external data."""
        root = self.directory()
        (root / 'bad.pdf').write_bytes(b'not a PDF')
        before = self.project.index_path.read_bytes()
        self.upload(root, status=400)
        self.assertEqual(self.project.index_path.read_bytes(), before)
        self.assertEqual(list(self.project.versions_root.iterdir()), [])
        (root / 'bad.pdf').unlink()
        (root / 'outside.pdf').symlink_to(root / 'one.pdf')
        result = self.upload(root, recursive=False)
        self.assertEqual(result['imported'], 1)
        self.assertEqual(result['papers'][0]['name'], 'one.pdf')

    def test_commit_failure_cleans_only_new_files(self):
        """Final index write failure preserves existing papers and removes staged imports."""
        root = self.directory()
        original = self.project.import_pdf('keep.pdf', sample_pdf())
        before = self.project.index_path.read_bytes()
        real_commit = Project.commit
        def fail_destination(instance, index):
            """Fail only publication. Pre: index; post: fixture exception or normal staged commit."""
            if instance is self.project:
                raise OSError('fixture disk failure')
            return real_commit(instance, index)
        with patch.object(Project, 'commit', fail_destination):
            self.upload(root, status=500)
        self.assertEqual(self.project.index_path.read_bytes(), before)
        self.assertEqual([p.name for p in self.project.versions_root.iterdir()], [original['id']])
        self.assertTrue(self.project.path(original, 'annotations').exists())

    def test_unknown_options_and_unauthed_calls_are_rejected(self):
        """Batch imports share the API's token and strict request validation."""
        root = self.directory()
        self.upload(root, status=400, unknown=True)
        code, _ = self.request('POST', '/api/projects/' + self.key + '/imports/directory',
                              {'folder_path': str(root), 'collection_name': 'Research'}, token=False)
        self.assertEqual(code, 403)
        self.assertEqual(self.project.documents(), [])


class ProjectFileImportTests(unittest.TestCase):
    """Exercise general imports through authenticated handlers and the real filesystem."""
    setUp = http_fixture.setup
    tearDown = http_fixture.teardown
    request = http_fixture.request

    def upload(self, name, content=b'example', token=True, **options):
        """POST bytes; pre: fixture ready; post: response returned; handler errors stay real."""
        import base64
        return self.request('POST', '/api/projects/' + self.key + '/imports/file',
                            {'name': name, 'data': base64.b64encode(content).decode(), **options}, token=token)

    def test_arbitrary_files_preserve_bytes_and_appear_in_tree(self):
        """TeX, bibliography, binary, extensionless and unfamiliar files remain intact."""
        for name in ('main.tex', 'references.bib', 'data.csv', 'image.webp', 'LICENSE', 'asset.custom'):
            with self.subTest(name=name):
                payload = b'\x00\xffcontents\n'
                code, body = self.upload(name, payload)
                self.assertEqual(code, 201, body)
                self.assertEqual((self.folder / name).read_bytes(), payload)
                self.assertIn(name, [entry['name'] for entry in self.project.tree()['children']])
        self.assertEqual(self.project.documents(), [])

    def test_pdf_and_markdown_import_at_destination_without_wrapper(self):
        """@pre Existing destination. @post Both file types stay there across PDF review creation.
        @return None. @throws AssertionError: Placement, content or tree regression.
        """
        (self.folder / 'Reading').mkdir()
        for name, payload in (('paper.pdf', sample_pdf()), ('notes.md', b'# Notes')):
            code, body = self.upload(name, payload, parent='Reading', source_document=None)
            self.assertEqual(code, 201, body)
            self.assertEqual(json.loads(body)['path'], 'Reading/' + name)
            self.assertEqual((self.folder / 'Reading' / name).read_bytes(), payload)
        self.assertEqual(self.project.documents(), [], 'review snapshots are created only when opening a PDF')
        tree = self.project.tree()['children']
        self.assertEqual([entry['name'] for entry in tree], ['Reading'])
        self.assertEqual({entry['kind'] for entry in tree[0]['children']}, {'file'})
        reviewed = self.project.open_pdf_file('Reading/paper.pdf')
        self.assertEqual(reviewed['project_file'], 'Reading/paper.pdf')
        self.assertEqual(len(self.project.tree()['children']), 1, 'reviewing must not duplicate the PDF in the tree')
        self.assertEqual(self.upload('paper.pdf', sample_pdf(), parent='Reading')[0], 409)
        self.assertEqual(self.upload('broken.pdf', b'invalid', parent='Reading')[0], 400)
        self.assertFalse((self.folder / 'Reading/broken.pdf').exists())

    def test_linked_source_import_uses_its_destination_root(self):
        """@pre Compiled linked source and nested folder. @post Import uses the linked root.
        @return None. @throws AssertionError: Source owner or relative destination regression.
        """
        import test_standalone_latex as fixture
        fixture.StandaloneLatexTests.git_source(self)
        with patch.object(self.project.drafts, 'latexmk', side_effect=fixture.StandaloneLatexTests.build):
            code, body = self.request('POST', '/api/projects/' + self.key + '/latex/compile', {'path': 'main.tex'})
        self.assertEqual(code, 200, body)
        doc = json.loads(body)['document']['id']
        (self.folder / 'figures').mkdir()
        code, body = self.upload('figure.pdf', sample_pdf(), parent='figures', source_document=doc)
        self.assertEqual(code, 201, body)
        self.assertTrue((self.folder / 'figures/figure.pdf').is_file())
        self.assertEqual(self.upload('notes.md', parent='figures', source_document='missing')[0], 400)

    def test_import_destination_confinement_and_legacy_pdf_tree(self):
        """@pre Imported review and untrusted destinations. @post Flat review tree and safe imports.
        @return None. @throws AssertionError: Wrapping, traversal or symlink regression.
        """
        doc = self.project.import_pdf('existing.pdf', sample_pdf())
        tree = self.project.tree()['children']
        self.assertEqual([(entry['name'], entry['kind']) for entry in tree], [('existing.pdf', 'pdf')])
        self.assertEqual(tree[0]['document'], doc['id'])
        outside = Path(self.temp.name) / 'outside'
        outside.mkdir()
        (self.folder / 'link').symlink_to(outside)
        for parent in ('../outside', 'link', 'versions', '.research-workbench', '/tmp'):
            self.assertEqual(self.upload('notes.md', parent=parent)[0], 400)
        self.assertEqual(self.upload('notes.md', parent='missing')[0], 404)
        self.assertEqual(list(outside.iterdir()), [])

    def test_duplicates_and_symlinks_never_overwrite(self):
        """Duplicate filenames, including case variants and links, retain existing bytes."""
        self.assertEqual(self.upload('main.tex', b'original')[0], 201)
        for name in ('main.tex', 'MAIN.TEX'):
            self.assertEqual(self.upload(name, b'replacement')[0], 409)
        external = Path(self.temp.name) / 'external.tex'
        external.write_bytes(b'external')
        (self.folder / 'link.tex').symlink_to(external)
        self.assertEqual(self.upload('link.tex')[0], 409)
        self.assertEqual(external.read_bytes(), b'external')
        self.assertEqual((self.folder / 'main.tex').read_bytes(), b'original')

    def test_invalid_names_encoding_and_missing_auth_are_rejected(self):
        """Traversal, hidden/internal targets and malformed bodies cannot write files."""
        for name in ('../escape.tex', '/absolute.tex', 'dir/file.tex', 'dir\\file.tex',
                     '.research-workbench', 'versions', 'node_modules', '', 'bad\x00name.tex'):
            with self.subTest(name=name):
                self.assertEqual(self.upload(name)[0], 400)
        route = '/api/projects/' + self.key + '/imports/file'
        self.assertEqual(self.request('POST', route, {'name': 'bad.tex', 'data': '!not-base64'})[0], 400)
        self.assertEqual(self.upload('private.tex', token=False)[0], 403)
        self.assertFalse((self.folder / 'bad.tex').exists())
        self.assertFalse((self.folder / 'private.tex').exists())

    def test_failed_publication_removes_staging_file(self):
        """Filesystem failure leaves neither the target nor a staged partial file."""
        before = set(self.folder.iterdir())
        with patch('research_workbench.launcher.os.link', side_effect=OSError('disk failure')):
            self.assertEqual(self.upload('main.tex')[0], 500)
        self.assertEqual(set(self.folder.iterdir()), before)
