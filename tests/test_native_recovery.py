"""Native-only startup, bounded readiness and process ownership regressions."""
import fcntl
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

import http_fixture
from research_workbench.native_host.recovery import Health, StartupError, ensure_server, main


ROOT = Path(__file__).resolve().parents[1]


class HealthRouteTests(unittest.TestCase):
    setUp = http_fixture.setup
    tearDown = http_fixture.teardown
    request = http_fixture.request

    def test_health_has_identity_without_private_data_and_keeps_authorization(self):
        """@param None. @pre Production in-process HTTP fixture.
        @post Health needs no token or application lock; host/origin guards still apply.
        @return None. @throws AssertionError: Identity, isolation or auth regression.
        """
        code, raw = self.request('GET', '/api/health', token=False)
        self.assertEqual((code, json.loads(raw)), (200, {'application': 'research-workbench', 'protocol': 1, 'status': 'ready'}))
        self.assertNotIn(self.app.token.encode(), raw)
        self.assertEqual(self.request('GET', '/api/health', headers={'Host': 'outside.example'})[0], 403)
        self.assertEqual(self.request('GET', '/api/health', headers={'Origin': 'https://outside.example'})[0], 403)
        self.assertEqual(self.request('POST', '/api/health', {}, token=False)[0], 403)
        self.assertEqual(self.request('POST', '/api/health', {})[0], 404)


class NativeRecoveryFixture:
    def setUp(self):
        """@param None. @pre No user data needed. @post Isolated checkout/settings and child list.
        @return None. @throws OSError: Temporary setup failed.
        """
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / 'research_workbench.py').write_text((ROOT / 'research_workbench.py').read_text())
        (self.root / 'research_workbench').symlink_to(ROOT / 'research_workbench', target_is_directory=True)
        self.settings = self.root / 'settings.json'
        self.children = []
        self.port = 8766

    def tearDown(self):
        """@param None. @pre Setup complete. @post Only owned fixture children/files removed.
        @return None. @throws OSError,TimeoutExpired: Cleanup failure.
        """
        for child in self.children:
            if child.poll() is None:
                child.terminate()
            child.wait(timeout=5)
        self.temp.cleanup()

    def spawn(self, arguments, **options):
        """Launch production bootstrap with synthetic checkout and capture owned process handles.

        @param arguments,options: Literal recovery launch inputs. @pre Fixture root only.
        @post Owned handle retained for teardown. @return Popen. @throws OSError: Launch failed.
        """
        child = subprocess.Popen(arguments, env={**os.environ, 'PYTHONPATH': str(ROOT)}, **options)
        self.children.append(child)
        return child
class NativeRecoveryTests(NativeRecoveryFixture, unittest.TestCase):
    def test_wrong_service_is_not_started_over_or_signaled(self):
        """@param None. @pre Health reports another service.
        @post No launch occurs and caller gets a retryable port reason.
        @return None. @throws AssertionError: Foreign process was disturbed.
        """
        with patch('subprocess.Popen') as spawn:
            with self.assertRaisesRegex(StartupError, 'occupied'):
                ensure_server(self.root, self.port, probe_server=lambda *args, **kwargs: Health('occupied', 'port occupied'), spawn=spawn)
            spawn.assert_not_called()

    def test_timeout_terminates_only_owned_unready_child(self):
        """@param None. @pre Fixture child starts but never serves HTTP.
        @post Failed child is reaped, lock reusable and settings untouched.
        @return None. @throws AssertionError: Timeout leak or mutation.
        """
        (self.root / 'research_workbench.py').write_text('import time\ntime.sleep(60)\n')
        with self.assertRaisesRegex(StartupError, 'ready in time'):
            ensure_server(self.root, self.port, settings=self.settings, timeout=0.3, spawn=self.spawn, probe_server=lambda *a, **kw: Health('offline'))
        self.assertIsNotNone(self.children[0].poll())
        self.assertFalse(self.settings.exists())
        with (self.root / '.plugin-start.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.flock(lock, fcntl.LOCK_UN)

    def test_failed_child_reports_failure_without_waiting_for_full_deadline(self):
        """@param None. @pre Synthetic launcher exits immediately.
        @post Failure is actionable, child reaped and log retained.
        @return None. @throws AssertionError: False success or missing evidence.
        """
        (self.root / 'research_workbench.py').write_text('raise RuntimeError("synthetic startup failure")\n')
        with self.assertRaisesRegex(StartupError, 'native-server.log'):
            ensure_server(self.root, self.port, timeout=2, spawn=self.spawn, probe_server=lambda *a, **kw: Health('offline'))
        self.assertIsNotNone(self.children[0].poll())
        self.assertIn('synthetic startup failure', (self.root / '.native-server.log').read_text())

    def test_busy_startup_lock_has_bounded_failure_and_no_child(self):
        """@param None. @pre Another caller owns the shared startup lock.
        @post Launch fails within bound without process creation or lock-file deletion.
        @return None. @throws AssertionError: Duplicate child or unbounded wait.
        """
        with (self.root / '.plugin-start.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(StartupError, 'Another launch'):
                ensure_server(self.root, self.port, timeout=0.1, spawn=self.spawn)
        self.assertEqual(self.children, [])
        self.assertTrue((self.root / '.plugin-start.lock').exists())
    def test_readiness_after_deadline_is_rejected(self):
        """@param None. @pre Slow probe returns ready after caller's bound.
        @post No process is spawned and expired readiness is not accepted.
        @return None. @throws AssertionError: Deadline bypass.
        """
        def delayed(*args, **kwargs):
            """@param args,kwargs: Probe seam. @pre Fixture. @post Time elapses.
            @return Health: Late ready. @throws None.
            """
            time.sleep(0.03)
            return Health('ready')
        with self.assertRaises(StartupError):
            ensure_server(self.root, self.port, timeout=0.01, probe_server=delayed, spawn=self.spawn)
        self.assertEqual(self.children, [])

    def test_main_translates_cleanup_timeout_and_restores_signal_handler(self):
        """@param None. @pre Injected cleanup failure; no child is started.
        @post Structured CLI failure and prior SIGTERM handler restored.
        @return None. @throws AssertionError: Uncaught failure or signal mutation.
        """
        previous = signal.getsignal(signal.SIGTERM)
        with patch('research_workbench.native_host.recovery.ensure_server', side_effect=subprocess.TimeoutExpired('fixture', 2)), \
                patch('builtins.print') as output:
            self.assertEqual(main(['--root', str(self.root)]), 1)
        self.assertFalse(json.loads(output.call_args.args[0])['ok'])
        self.assertEqual(signal.getsignal(signal.SIGTERM), previous)
if __name__ == '__main__':
    unittest.main()
