"""Extension contracts proven through production registries and transports."""
import contextlib
import io
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import http_fixture
from research_workbench.launcher import Handler
from research_workbench.extensions.filetypes import load_registry
from research_workbench.transport.http.routes import RouteRegistry

ROOT = Path(__file__).resolve().parents[1]


class ModularContractTests(unittest.TestCase):
    setUp = http_fixture.setup
    tearDown = http_fixture.teardown
    request = http_fixture.request

    def test_bootstrap_assets_resolve_through_production_http_routes(self):
        """@param None: Production HTML and fixture transport. @pre Loaded application.
        @post Every ordered startup script/style resolves from the relocated resource root.
        @return None. @throws AssertionError: Missing asset or catalog/load ordering.
        """
        code, raw = self.request('GET', '/')
        self.assertEqual(code, 200)
        html = raw.decode('utf-8')
        scripts = re.findall(r'<script src="([^"]+)"', html)
        self.assertLess(next(i for i, path in enumerate(scripts) if path.startswith('/api/file-types.js')),
                        next(i for i, path in enumerate(scripts) if path.startswith('/static/filetype-adapters.js')))
        self.assertLess(next(i for i, path in enumerate(scripts) if path.startswith('/static/editors/source/projection.js')),
                        next(i for i, path in enumerate(scripts) if path.startswith('/static/workspace.js')))
        for path in [*scripts, *re.findall(r'<link[^>]+href="([^"]+)"', html)]:
            code, body = self.request('GET', path)
            self.assertEqual(code, 200, path)
            self.assertTrue(body, path)
        code, body = self.request('GET', '/api/file-types.js')
        self.assertEqual(code, 200)
        self.assertTrue(body.startswith(b'window.WorkbenchFileTypeCatalog = '))
        self.assertNotIn(b'preview_signature', body)

    def test_catalog_extension_uses_existing_text_routes_and_returns_snapshots(self):
        """@param None: Fixture-owned paths. @pre Isolated project.
        @post New metadata opens/saves without changing routing or built-in registrations.
        @return None. @throws AssertionError: Extension seam or snapshot isolation failed.
        """
        catalog = json.loads((ROOT / 'extensions/filetypes.json').read_text())
        catalog['types'].append({'id': 'notes', 'label': 'Notes', 'extensions': ['.notes'],
                                'adapter': 'text', 'kind': 'text', 'capabilities': {'text': True},
                                'permissions': {'editable': True}, 'toolbarAreas': ['text.actions']})
        path = Path(self.temp.name) / 'catalog.json'
        path.write_text(json.dumps(catalog))
        registry = load_registry(path)
        public = registry.catalog()
        public['types'][-1]['extensions'].append('.unsafe')
        self.assertEqual(registry.catalog()['types'][-1]['extensions'], ['.notes'])
        self.assertIsNone(registry.resolve('file.unsafe'))
        (self.folder / 'one.notes').write_text('original')
        route = '/api/projects/' + self.key + '/text-file'
        with patch('research_workbench.application.projects.file_handlers', registry), \
                patch('research_workbench.transport.http.routes.handlers', registry):
            code, raw = self.request('GET', '/api/file-types')
            self.assertEqual(code, 200)
            self.assertEqual(json.loads(raw)['types'][-1]['id'], 'notes')
            code, raw = self.request('GET', route + '?path=one.notes')
            self.assertEqual(code, 200)
            snapshot = json.loads(raw)
            code, raw = self.request('PUT', route, {'path': 'one.notes', 'text': 'changed', 'sha': snapshot['sha']})
            self.assertEqual(code, 200, raw)
        self.assertEqual((self.folder / 'one.notes').read_text(), 'changed')
        self.assertEqual(self.project.documents(), [])

    def test_catalog_rejects_duplicate_and_contradictory_permissions(self):
        """@param None: Synthetic catalog. @pre No user storage.
        @post Ambiguous or dishonest catalogs are rejected before publication.
        @return None. @throws AssertionError: Invalid catalog accepted.
        """
        catalog = json.loads((ROOT / 'extensions/filetypes.json').read_text())
        path = Path(self.temp.name) / 'catalog.json'
        catalog['types'].append(catalog['types'][0])
        path.write_text(json.dumps(catalog))
        with self.assertRaises(ValueError):
            load_registry(path)
        catalog['types'].pop()
        catalog['types'][1]['permissions']['editable'] = False
        path.write_text(json.dumps(catalog))
        with self.assertRaises(ValueError):
            load_registry(path)

    def test_http_route_extension_retains_authorization_and_error_boundary(self):
        """@param None: Fixture request. @pre Isolated registry and project.
        @post Extension executes only after auth; unexpected errors return a redacted reply.
        @return None. @throws AssertionError: Authorization bypass or exception leak.
        """
        calls = []
        routes = RouteRegistry().register('POST', '/api/fixture', lambda app, raw: (201, {'received': calls.append(raw) is None}))
        with patch.object(Handler, 'routes', routes):
            code, _ = self.request('POST', '/api/fixture', {}, token=False)
            self.assertEqual(code, 403)
            self.assertEqual(calls, [])
            code, raw = self.request('POST', '/api/fixture', {})
            self.assertEqual(code, 201)
            self.assertTrue(json.loads(raw)['received'])
        routes.register('GET', '/api/failure', self.fail_route)
        with patch.object(Handler, 'routes', routes), contextlib.redirect_stderr(io.StringIO()):
            code, raw = self.request('GET', '/api/failure')
        self.assertEqual(code, 500)
        self.assertNotIn(b'private-value', raw)
        with self.assertRaises(ValueError):
            routes.register('POST', '/api/fixture', lambda app, raw: (200, {}))

    @staticmethod
    def fail_route(app, raw):
        """@param app,raw: Unused fixture input. @pre Request already authorized.
        @post Raises before mutation. @return Never. @throws RuntimeError: Deliberate fixture failure.
        """
        raise RuntimeError('private-value')

    def test_registered_prefix_routes_remain_behind_authorization(self):
        """@param None: New URL family. @pre Isolated registry and production Handler.
        @post Missing tokens/foreign origins cannot reach the contribution.
        @return None. @throws AssertionError: Prefix route bypassed the shared guard.
        """
        calls = []
        routes = RouteRegistry().register_prefix('POST', '/api/custom',
            lambda app, request: (200, {'path': request.path, 'called': calls.append(request.path) is None}))
        with patch.object(Handler, 'routes', routes):
            self.assertEqual(self.request('POST', '/api/custom/item', {}, token=False)[0], 403)
            self.assertEqual(self.request('POST', '/api/custom/item', {}, headers={'Origin': 'https://outside.example'})[0], 403)
            self.assertEqual(calls, [])
            code, body = self.request('POST', '/api/custom/item', {})
            self.assertEqual(code, 200)
            self.assertEqual(json.loads(body)['path'], '/api/custom/item')
        self.assertEqual(calls, ['/api/custom/item'])

    def test_application_shutdown_releases_preview_storage_without_touching_project_data(self):
        """@param None: Loaded project with synthetic temporary preview.
        @pre No build owns a lock. @post Only preview directories disappear; persistent files remain.
        @return None. @throws AssertionError: Resource leak or project data loss.
        """
        drafts = self.project.drafts
        preview = drafts.no_figures_dir('a' * 32)
        preview.mkdir(parents=True)
        (preview / 'no-figures.pdf').write_bytes(b'temporary')
        before = self.project.index_path.read_bytes()
        self.app.close(); self.app.close()
        self.assertFalse(preview.exists())
        self.assertEqual(self.project.index_path.read_bytes(), before)


    def test_index_transaction_does_not_expose_or_retain_mutable_snapshots(self):
        """@param None: Isolated library. @pre Loaded fixture.
        @post Snapshot mutations cannot alter live state before or after commit.
        @return None. @throws AssertionError: Mutable state leaked across public operations.
        """
        state = self.project.index_snapshot()
        state['folders'].append({'id': 'a' * 32, 'name': 'Collection'})
        self.assertEqual(self.project.folders(), [])
        self.project.commit(state)
        state['folders'][0]['name'] = 'Mutated elsewhere'
        self.assertEqual(self.project.folders()[0]['name'], 'Collection')
        self.project.index['folders'].clear()
        self.assertEqual(len(self.project.folders()), 1)
