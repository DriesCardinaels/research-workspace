"""Registered image reads and JSON edits use existing confinement/import/save contracts."""
import base64
import json
from pathlib import Path
import unittest
from unittest.mock import patch
from urllib.parse import urlencode

import http_fixture
from file_handlers import FileHandler, FileHandlerRegistry

PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC1sAAAAASUVORK5CYII=')
JPEG_HEADER = b'\xff\xd8\xff\xe0fixture transport bytes'


class ImageJsonTests(unittest.TestCase):
    setUp = http_fixture.setup
    tearDown = http_fixture.teardown
    request = http_fixture.request

    def get(self, route, path, status=200):
        """@param route,path,status: Read request. @pre Fixture ready.
        @post Real HTTP status checked. @return Bytes. @throws AssertionError: Contract mismatch.
        """
        code, body = self.request('GET', '/api/projects/' + self.key + '/' + route + '?' + urlencode({'path': path}))
        self.assertEqual(code, status, body[:200]); return body

    def test_image_formats_return_exact_bytes_without_creating_papers(self):
        """@pre Registered PNG/JPG/JPEG bytes. @post Reads are byte-exact and records stay unchanged."""
        index = self.project.index_path.read_bytes()
        for name, data, mime in [('figure.PNG', PNG, 'image/png'), ('figure.jpg', JPEG_HEADER, 'image/jpeg'), ('figure.JPEG', JPEG_HEADER, 'image/jpeg')]:
            (self.folder / name).write_bytes(data)
            self.assertEqual(self.get('image-file', name), data)
            self.assertEqual(self.project.image_file(name)[1], mime)
            self.get('text-file', name, 400)
        self.assertEqual(index, self.project.index_path.read_bytes())
        self.assertEqual(self.project.documents(), [])

    def test_image_paths_signatures_and_read_only_permissions(self):
        """@pre Unsafe/misnamed images. @post Hidden/outside/symlink/non-image reads and writes fail."""
        (self.folder / 'safe.png').write_bytes(PNG)
        (self.folder / 'fake.jpg').write_bytes(PNG)
        (self.folder / '.hidden.png').write_bytes(PNG)
        (self.folder / 'image.txt').write_bytes(PNG)
        outside = Path(self.temp.name) / 'outside.png'; outside.write_bytes(PNG)
        (self.folder / 'link.png').symlink_to(outside)
        for path in ['../outside.png', str(outside), 'link.png', '.hidden.png', 'fake.jpg', 'image.txt', 'originals/private.png']:
            self.get('image-file', path, 400)
        self.get('image-file', 'missing.png', 404)
        with (self.folder / 'large.png').open('wb') as image:
            image.write(PNG); image.truncate(50 * 1024 * 1024 + 1)
        self.get('image-file', 'large.png', 400)
        code, _ = self.request('PUT', '/api/projects/' + self.key + '/text-file', {'path': 'safe.png', 'text': 'corrupt', 'sha': 'invalid'})
        self.assertEqual(code, 400)
        self.assertEqual((self.folder / 'safe.png').read_bytes(), PNG)

    def test_json_roundtrips_exactly_and_preserves_conflicting_work(self):
        """@pre JSON with large numbers/duplicate keys. @post Text saves never round/reformat data."""
        original = '{"n":900719925474099312345,"key":1,"key":2}\r\n'
        (self.folder / 'data.JSON').write_bytes(original.encode())
        index = self.project.index_path.read_bytes()
        read = json.loads(self.get('text-file', 'data.JSON'))
        self.assertEqual(read['text'], original)
        edited = '{"draft":'  # Incomplete work remains saveable; validation is an explicit Tool.
        code, _ = self.request('PUT', '/api/projects/' + self.key + '/text-file', {'path': 'data.JSON', 'text': edited, 'sha': read['sha']})
        self.assertEqual(code, 200)
        code, _ = self.request('PUT', '/api/projects/' + self.key + '/text-file', {'path': 'data.JSON', 'text': 'stale', 'sha': read['sha']})
        self.assertEqual(code, 409)
        self.assertEqual((self.folder / 'data.JSON').read_text(), edited)
        self.assertEqual(index, self.project.index_path.read_bytes())

    def test_images_in_linked_source_roots_remain_readable(self):
        """@pre Linked LaTeX source. @post Image preview respects the same source root and traversal guard."""
        import test_standalone_latex as source_fixture
        source_fixture.StandaloneLatexTests.git_source(self)
        (self.folder / 'figures').mkdir()
        (self.folder / 'figures/plot.png').write_bytes(PNG)
        with patch.object(self.project.drafts, 'latexmk', side_effect=source_fixture.StandaloneLatexTests.build):
            code, body = self.request('POST', '/api/projects/' + self.key + '/latex/compile', {'path': 'main.tex'})
        self.assertEqual(code, 200)
        document = json.loads(body)['document']['id']
        query = urlencode({'path': 'figures/plot.png', 'source_document': document})
        code, body = self.request('GET', '/api/projects/' + self.key + '/image-file?' + query)
        self.assertEqual(code, 200); self.assertEqual(body, PNG)
        query = urlencode({'path': '../outside.png', 'source_document': document})
        code, _ = self.request('GET', '/api/projects/' + self.key + '/image-file?' + query)
        self.assertEqual(code, 400)

    def test_new_formats_import_through_existing_route(self):
        """@pre Generic file import. @post JPG/PNG/JSON retain exact bytes and create no PDF records."""
        for name, data in [('new.png', PNG), ('new.jpg', JPEG_HEADER), ('new.json', b'{"value": 42}\n')]:
            code, _ = self.request('POST', '/api/projects/' + self.key + '/imports/file', {'name': name, 'data': base64.b64encode(data).decode()})
            self.assertEqual(code, 201)
            self.assertEqual((self.folder / name).read_bytes(), data)
        self.assertEqual(self.project.documents(), [])

    def test_preview_provider_can_be_added_without_route_changes(self):
        """@pre Independently registered image extension. @post The generic read endpoint supports it."""
        registry = FileHandlerRegistry().register(FileHandler('custom', ('.customimage',), preview_mime='image/png', preview_signature=b'\x89PNG\r\n\x1a\n'))
        (self.folder / 'new.customimage').write_bytes(PNG)
        with patch('research_workbench.application.projects.file_handlers', registry):
            self.assertEqual(self.get('image-file', 'new.customimage'), PNG)
        with self.assertRaises(ValueError):
            FileHandlerRegistry().register(FileHandler('bad', ('.bad',), preview_mime='text/html', preview_signature=b'<'))
        with self.assertRaises(ValueError):
            FileHandlerRegistry().register(FileHandler('bad', ('.bad',), preview_mime='image/png'))
