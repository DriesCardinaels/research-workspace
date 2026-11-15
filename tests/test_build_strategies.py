"""Registered build/mapping contracts and publication failure preservation."""
from contextlib import nullcontext, redirect_stdout
import io
from types import SimpleNamespace
from pathlib import Path
import os
import tempfile
import unittest
from unittest.mock import patch

from research_workbench.application.builds import BuildPlan, BuildRequest, BuildService, BuildVariantRegistry, builtin_variants
from research_workbench.application.source_mapping import SourceMapping
from research_workbench.domain.errors import SourceError
from research_workbench.transport.http.routes import RouteRegistry
from research_workbench.infrastructure.filesystem.artifacts import publish_artifacts
from research_workbench.bootstrap import run
from research_workbench.application.projects import Project
from research_workbench.application.drafts import Drafts


class BuildStrategyTests(unittest.TestCase):
    def setUp(self):
        """@param None: Isolated test. @pre Writable temporary storage.
        @post Synthetic source/output locations created. @return None. @throws OSError: Fixture failure.
        """
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.request = BuildRequest(self.root, 'main.tex', self.root / 'build', self.root / 'published', 'paper')
        self.calls = []

    def compiler(self, root, main, output, job):
        """@param root,main,output,job: Captured build invocation.
        @pre Isolated output exists. @post Synthetic successful artifacts written.
        @return tuple: Compiler contract. @throws OSError: Fixture write failure.
        """
        self.calls.append((root, main, job))
        (output / (job + '.pdf')).write_bytes(b'new-pdf')
        (output / (job + '.synctex.gz')).write_bytes(b'new-map')
        (output / (job + '.log')).write_text('Output written on result.pdf (3 pages, 10 bytes).')
        return True, 'build log', [], output / (job + '.pdf')

    def test_independent_variant_uses_shared_execution_without_a_core_switch(self):
        """@param None: Synthetic custom strategy. @pre Fresh registry.
        @post New plan builds/publishes through the same executor with no project/route changes.
        @return None. @throws AssertionError: Extension seam failed.
        """
        registry = BuildVariantRegistry().register('poster', lambda req: BuildPlan(
            req.source_root, 'poster.tex', req.output, req.publication, 'poster', ('poster.pdf',),
            metadata=lambda ok: {'target': 'poster'}))
        result = BuildService(registry, self.compiler, lambda key: nullcontext()).run('poster', self.request)
        self.assertTrue(result['ok'])
        self.assertEqual(result['pages'], 3)
        self.assertEqual(result['target'], 'poster')
        self.assertEqual(self.calls, [(self.root, 'poster.tex', 'poster')])
        self.assertEqual((self.request.publication / 'poster.pdf').read_bytes(), b'new-pdf')
        with self.assertRaises(ValueError):
            registry.register('poster', lambda req: None)

    def test_project_composition_accepts_an_independent_variant_and_shared_compiler(self):
        """@param None: Custom plan registry/compiler. @pre Isolated project path.
        @post Real project source owner uses injected behavior without implementation edits.
        @return None. @throws AssertionError: Construction bypassed the contribution seam.
        """
        registry = BuildVariantRegistry().register('poster', lambda req: BuildPlan(
            req.source_root, req.main, req.output, req.publication, 'poster', ('poster.pdf',)))
        project = Project(self.root / 'project', draft_factory=lambda owner: Drafts(
            owner, build_variants=registry, compiler=self.compiler))
        self.addCleanup(project.drafts.close)
        result = project.drafts.builds.run('poster', self.request)
        self.assertTrue(result['ok'])
        self.assertEqual(self.calls[0][2], 'poster')
        self.assertEqual(project.drafts.latexmk, self.compiler)

    def test_failed_compiler_does_not_publish_candidate_bytes(self):
        """@param None: Existing publication and failed compiler. @pre Isolated storage.
        @post Prior PDF remains exact and failure metadata is returned.
        @return None. @throws AssertionError: Failed build published.
        """
        self.request.publication.mkdir()
        (self.request.publication / 'draft.pdf').write_bytes(b'last-good')
        compiler = lambda *args: (False, 'bad source', ['syntax'], None)
        result = BuildService(builtin_variants(), compiler, lambda key: nullcontext()).run('paper', self.request)
        self.assertFalse(result['ok'])
        self.assertEqual((self.request.publication / 'draft.pdf').read_bytes(), b'last-good')

    def test_second_artifact_replacement_failure_restores_the_first_artifact(self):
        """@param None: Existing matching PDF/map and injected replacement error.
        @pre Both old artifacts exist. @post PDF and map both retain prior bytes; stage cleaned.
        @return None. @throws AssertionError: Partial publication or recovery loss.
        """
        publication = self.request.publication
        publication.mkdir()
        for name in ('draft.pdf', 'draft.synctex.gz'):
            (publication / name).write_bytes(('old-' + name).encode())
        replace = os.replace

        def fail_pdf(source, target):
            """@param source,target: Staged artifact and destination. @pre Test publication.
            @post Map publishes before PDF fails; rollback replacements remain permitted.
            @return None. @throws OSError: Deliberate second-artifact failure.
            """
            if Path(source).name == 'new-draft.pdf':
                raise OSError('fixture publication failure')
            return replace(source, target)

        with patch('research_workbench.infrastructure.filesystem.artifacts.os.replace', side_effect=fail_pdf):
            with self.assertRaises(OSError):
                BuildService(builtin_variants(), self.compiler, lambda key: nullcontext()).run('paper', self.request)
        for name in ('draft.pdf', 'draft.synctex.gz'):
            self.assertEqual((publication / name).read_bytes(), ('old-' + name).encode())
        self.assertEqual(sorted(p.name for p in publication.iterdir()), ['draft.pdf', 'draft.synctex.gz'])

    def test_invalid_variant_or_artifact_plan_has_no_execution_effects(self):
        """@param None: Invalid plans. @pre No output directories.
        @post Compiler never runs and no output is created.
        @return None. @throws AssertionError: Validation happened after effects.
        """
        registry = BuildVariantRegistry().register('unsafe', lambda req: BuildPlan(
            req.source_root, req.main, req.output, req.publication, 'safe', ('../escape.pdf',)))
        service = BuildService(registry, self.compiler, lambda key: nullcontext())
        for variant in ('unknown', 'unsafe'):
            with self.assertRaises(ValueError):
                service.run(variant, self.request)
        self.assertEqual(self.calls, [])
        self.assertFalse(self.request.output.exists())

    def test_required_artifacts_and_symlinks_are_rejected_and_stale_optional_maps_are_removed(self):
        """@param None: Isolated publication. @pre Synthetic old PDF/map.
        @post Missing/unsafe candidates preserve old bytes; successful mapless builds remove stale maps.
        @return None. @throws AssertionError: Invalid artifact publication.
        """
        source, target = self.request.output, self.request.publication
        source.mkdir(); target.mkdir()
        (target / 'draft.pdf').write_bytes(b'old')
        (target / 'draft.synctex.gz').write_bytes(b'old-map')
        with self.assertRaises(FileNotFoundError):
            publish_artifacts(source, target, ('draft.pdf',))
        self.assertEqual((target / 'draft.pdf').read_bytes(), b'old')
        secret = self.root / 'private'
        secret.write_bytes(b'private')
        (source / 'draft.pdf').symlink_to(secret)
        with self.assertRaises(ValueError):
            publish_artifacts(source, target, ('draft.pdf',))
        (source / 'draft.pdf').unlink()
        (source / 'draft.pdf').write_bytes(b'new')
        publish_artifacts(source, target, ('draft.synctex.gz', 'draft.pdf'), optional=('draft.synctex.gz',))
        self.assertEqual((target / 'draft.pdf').read_bytes(), b'new')
        self.assertFalse((target / 'draft.synctex.gz').exists())

    def test_shutdown_joins_server_before_releasing_application_resources(self):
        """@param None: Injected server lifecycle. @pre No network listener.
        @post Server and application close in order even after a serving failure.
        @return None. @throws AssertionError: Lost cleanup or incorrect ordering.
        """
        events = []
        def fail():
            """@param None: Fixture callback. @pre Serving started. @post Raises.
            @return Never. @throws RuntimeError: Deliberate transport failure.
            """
            raise RuntimeError('fixture serving failure')
        app = SimpleNamespace(close=lambda: events.append('app-close'))
        server = SimpleNamespace(server_port=8766, serve_forever=fail,
                                 server_close=lambda: events.append('server-close'))
        with redirect_stdout(io.StringIO()), self.assertRaises(RuntimeError):
            run(lambda settings: app, object, argv=['--no-browser'], server_factory=lambda address, handler: server)
        self.assertEqual(events, ['server-close', 'app-close'])

    def test_source_mapping_uses_injected_query_and_rejects_escaped_results(self):
        """@param None: Synthetic map results. @pre Authorized source fixture.
        @post Paths remain confined; rectangles retain existing coordinate conversion.
        @return None. @throws AssertionError: Mapping policy changed.
        """
        source = self.root / 'main.tex'
        source.write_text('source')
        mapping = SourceMapping(self.root, self.root / 'published', lambda rel: self.root / rel,
                                lambda args: (f'Input:{source}\nLine:4\n', None))
        self.assertEqual(mapping.from_pdf(1, 2, 3), {'file': 'main.tex', 'line': 4})
        mapping = SourceMapping(self.root, self.root / 'published', lambda rel: self.root / rel,
                                lambda args: ('Input:/outside/private.tex\nLine:4\n', None))
        with self.assertRaises(SourceError):
            mapping.from_pdf(1, 2, 3)
        mapping = SourceMapping(self.root, self.root / 'published', lambda rel: self.root / rel,
                                lambda args: ('Output:a\nPage:2\nh:10\nv:20\nW:30\nH:5\n', None))
        self.assertEqual(mapping.to_pdf('main.tex', 4), [{'page': 2, 'x': 10, 'y': 15, 'w': 30, 'h': 5}])

    def test_route_families_use_exact_precedence_longest_prefix_and_segment_boundaries(self):
        """@param None: Independent exact/prefix contributions. @pre Empty registry.
        @post URL families extend dispatch without intercepting unrelated paths.
        @return None. @throws AssertionError: Ambiguous or mutable routing.
        """
        registry = RouteRegistry()
        registry.register_prefix('GET', '/api/example', lambda app, request: (200, request))
        registry.register_prefix('GET', '/api/example/nested', lambda app, request: (201, request))
        registry.register('GET', '/api/example/exact', lambda app, raw: (202, {}))
        query = {'key': ['value']}
        status, request = registry.dispatch('GET', '/api/example/file', None, query=query)
        query['key'].append('mutated')
        self.assertEqual(status, 200)
        self.assertEqual(request.query['key'], ('value',))
        with self.assertRaises(TypeError):
            request.query['key'] = ('other',)
        self.assertEqual(registry.dispatch('GET', '/api/example/nested/file', None)[0], 201)
        self.assertEqual(registry.dispatch('GET', '/api/example/exact', None)[0], 202)
        self.assertIsNone(registry.dispatch('GET', '/api/examples', None))
        with self.assertRaises(ValueError):
            registry.register_prefix('GET', '/api/example', lambda app, request: (200, {}))
