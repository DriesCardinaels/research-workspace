"""Project-scoped GitHub destinations and committed-source-only pushes without network."""
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

import http_fixture
from repository_sync import RepositorySync, RepositoryConflict
from test_editor import sample_pdf


class RepositorySyncTests(unittest.TestCase):
    setUp = http_fixture.setup
    tearDown = http_fixture.teardown
    request = http_fixture.request

    def git(self, *args):
        """Run fixture Git. Pre: repo; post: stdout; command failures fail the test."""
        return subprocess.check_output(['git', '-C', str(self.repo), *args], text=True).strip()

    def linked(self, nested=True):
        """Make a real repository and source link. Pre: setup; post: configured sync helper."""
        self.repo = Path(self.temp.name) / 'repo'
        self.source = self.repo / 'paper' if nested else self.repo
        self.source.mkdir(parents=True)
        (self.source / 'main.tex').write_text('Committed paper')
        (self.repo / 'unrelated.txt').write_text('Must never leave the parent repository')
        self.git('init', '-q', '-b', 'main')
        self.git('config', 'user.name', 'Fixture')
        self.git('config', 'user.email', 'fixture@example.invalid')
        self.git('add', '.')
        self.git('commit', '-qm', 'base')
        self.doc = self.project.import_pdf('paper.pdf', sample_pdf())
        self.project.drafts.link(self.doc, str(self.source), 'main.tex', self.git('rev-parse', 'HEAD'))
        self.sync = RepositorySync(self.project)
        self.config = {'url': 'https://github.com/example/paper.git', 'branch': 'main', 'paper_id': self.doc['paper_id']}
        return self.sync.save(self.config)

    def reviewed(self, status):
        """Build exact reviewed push arguments. Pre: linked status; post: no destination ambiguity."""
        return {'expected_url': status['url'], 'expected_branch': status['branch'], 'expected_head': status['head']}

    def test_link_is_persistent_local_and_never_changes_remotes(self):
        """Saving a target does no network operation and keeps existing Git configuration."""
        state = self.linked()
        self.assertTrue(state['linked'])
        self.assertEqual(self.git('remote'), '')
        self.assertEqual(RepositorySync(self.project).status()['url'], self.config['url'])
        code, body = self.request('GET', '/api/projects/' + self.key + '/github')
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(body)['paper_id'], self.doc['paper_id'])

    def test_nested_push_exports_only_source_and_keeps_branch_and_index(self):
        """A real subtree split excludes sibling files and pushes an explicit normal refspec."""
        status = self.linked()
        before = self.git('rev-parse', 'HEAD')
        before_index = self.git('write-tree')
        original = self.sync.run
        network = []
        def capture(root, *args, **kwargs):
            """Intercept only the network push. Pre: Git call; post: real local Git otherwise."""
            if args[0] == 'push':
                network.append(args)
                return subprocess.CompletedProcess(args, 0, b'ok', b'')
            return original(root, *args, **kwargs)
        with patch.object(self.sync, 'run', capture):
            result = self.sync.push(self.reviewed(status))
        self.assertEqual(self.git('ls-tree', '-r', '--name-only', result['commit']), 'main.tex')
        self.assertEqual(self.git('rev-parse', 'HEAD'), before)
        self.assertEqual(self.git('write-tree'), before_index)
        self.assertEqual(network[0], ('push', '--porcelain', '--', self.config['url'], result['commit'] + ':refs/heads/main'))
        self.assertEqual(self.git('remote'), '')

    def test_stale_destination_and_head_do_not_push(self):
        """An exact reviewed destination/HEAD is required for external publication."""
        state = self.linked()
        with self.assertRaises(RepositoryConflict):
            self.sync.push({**self.reviewed(state), 'expected_url': 'https://github.com/example/other'})
        (self.source / 'main.tex').write_text('New committed paper')
        self.git('add', '.')
        self.git('commit', '-qm', 'new')
        with self.assertRaises(RepositoryConflict):
            self.sync.push(self.reviewed(state))

    def test_credentials_foreign_urls_invalid_branches_and_tokens_rejected(self):
        """Only clean GitHub targets and valid branch refs are accepted through HTTP."""
        self.linked()
        for url in ('file:///tmp/repo', 'https://token@github.com/a/b', 'https://evil.example/a/b', 'git@github.com:a/b\n--mirror'):
            with self.assertRaises(ValueError):
                self.sync.save({**self.config, 'url': url})
        with self.assertRaises(ValueError):
            self.sync.save({**self.config, 'branch': 'main:other'})
        code, _ = self.request('PUT', '/api/projects/' + self.key + '/github', self.config, token=False)
        self.assertEqual(code, 403)

    def test_review_data_in_history_is_not_published(self):
        """Deleting a tracked review file is insufficient: its historical contents stay private."""
        self.assert_private_history_blocked('.research-workbench')

    def test_previous_review_data_in_history_is_not_published(self):
        """Pre: previous-format review commits. Post: publication remains refused after deletion."""
        from research_workbench.infrastructure.filesystem.project_storage import LEGACY_METADATA_DIRECTORY
        self.assert_private_history_blocked(LEGACY_METADATA_DIRECTORY)

    def assert_private_history_blocked(self, directory):
        """Verify private history cannot be pushed through the public repository operation.

        @param directory: Managed metadata basename. @pre Fresh synthetic Git fixture.
        @post Deleted metadata remains blocked from publication; no remote write occurs.
        @throws AssertionError: Publication guard did not refuse the historical data.
        """
        self.linked(nested=False)
        private = self.source / directory
        private.mkdir()
        (private / 'notes.json').write_text('{"private":"review"}')
        self.git('add', '.')
        self.git('commit', '-qm', 'accidental review data')
        self.git('rm', '-qr', directory)
        self.git('commit', '-qm', 'remove review data')
        state = self.sync.status()
        with self.assertRaisesRegex(ValueError, 'review storage'):
            self.sync.push(self.reviewed(state))

    def test_remote_rejection_never_retries_with_force(self):
        """GitHub divergence surfaces a conflict; no force retry can overwrite remote work."""
        state = self.linked(nested=False)
        failed = subprocess.CompletedProcess([], 1, b'', b'! [rejected] main -> main (fetch first)')
        with patch('research_workbench.application.repository.subprocess.run', return_value=failed) as run:
            with self.assertRaises(RepositoryConflict):
                self.sync.run(self.repo, 'push', '--', self.config['url'], 'HEAD:refs/heads/main')
        self.assertEqual(run.call_count, 1)
        self.assertNotIn('--force', run.call_args.args[0])

    def test_git_failure_diagnostics_identify_the_stage_without_exposing_output(self):
        """@pre Controlled Git failures. @post Specific safe messages replace generic credential advice."""
        sync = RepositorySync(self.project)
        for stderr, stdout, expected in [
            (b'git@github.com: Permission denied (publickey).', b'', 'SSH authentication'),
            (b'Host key verification failed.', b'', 'host-key verification'),
            (b'Could not resolve hostname github.com', b'', 'resolved'),
            (b'Connection timed out', b'', 'reached'),
            (b'ERROR: Repository not found.', b'', 'not found'),
            (b'Authentication failed for https://secret-token@github.com/private/repo', b'', 'HTTPS authentication'),
            (b'Permission to owner/repo denied to account.', b'', 'write access'),
            (b'GH013: Repository rule violations', b'', 'repository rules'),
            (b'', b'! [rejected] main -> main (fetch first)', 'Remote changes'),
        ]:
            with self.subTest(expected=expected), patch('research_workbench.application.repository.subprocess.run', return_value=subprocess.CompletedProcess([], 128, stdout, stderr)):
                with self.assertRaises(ValueError) as error:
                    sync.run(self.folder, 'push', '--', 'git@github.com:example/repo.git', 'HEAD:refs/heads/main')
                self.assertIn(expected, str(error.exception))
                self.assertNotIn('secret-token', str(error.exception))
                self.assertNotIn('owner/repo', str(error.exception))

    def test_git_timeout_reports_a_bounded_operation_without_remote_output(self):
        """@pre Timed-out Git with sensitive captured stderr. @post Timeout is actionable and sanitized."""
        with patch('research_workbench.application.repository.subprocess.run', side_effect=subprocess.TimeoutExpired('git', 120, stderr=b'secret-token')):
            with self.assertRaisesRegex(ValueError, 'timed out') as error:
                RepositorySync(self.project).run(self.folder, 'push')
        self.assertNotIn('secret-token', str(error.exception))
