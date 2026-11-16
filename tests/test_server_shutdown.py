"""Authenticated shutdown capability and application-owned lifecycle regressions."""
from contextlib import redirect_stderr
import io
import json
import threading
import unittest

import http_fixture
from research_workbench.application.lifecycle import ServerLifecycle


class ServerShutdownTests(unittest.TestCase):
    request = http_fixture.request

    def setUp(self):
        """@param None. @pre No user data needed. @post Fixture and owned thread seam initialized.
        @return None. @throws OSError: Temporary fixture failed.
        """
        http_fixture.setup(self)
        self.workers = []
        self.called = threading.Event()
        self.calls = []
        self.lifecycle = ServerLifecycle(self.shutdown, worker_factory=self.worker)
        self.app.bind_lifecycle(self.lifecycle)

    def tearDown(self):
        """@param None. @pre Fixture initialized. @post Owned workers/files cleaned on failure too.
        @return None. @throws AssertionError: Worker leaked; OSError: File cleanup failed.
        """
        try:
            for worker in self.workers:
                worker.join(timeout=2)
                self.assertFalse(worker.is_alive())
        finally:
            http_fixture.teardown(self)

    def worker(self, **options):
        """@param options: Public thread-constructor inputs. @pre Fixture owns target.
        @post Thread retained for teardown. @return Thread. @throws RuntimeError: Constructor failure.
        """
        worker = threading.Thread(**options)
        self.workers.append(worker)
        return worker

    def shutdown(self):
        """@param None. @pre Lifecycle worker only. @post Caller thread identity recorded.
        @return None. @throws None.
        """
        self.calls.append(threading.get_ident())
        self.called.set()

    def test_shutdown_rejects_missing_stale_and_foreign_authorization_before_work(self):
        """@param None. @pre Ready fixture lifecycle.
        @post Missing/stale tokens and foreign host/origin cannot schedule any shutdown.
        @return None. @throws AssertionError: Auth bypass or state mutation.
        """
        route = '/api/server/shutdown'
        self.assertEqual(self.request('POST', route, {}, token=False)[0], 403)
        for headers in ({'X-PDF-Token': 'stale'}, {'Origin': 'https://outside.example'}, {'Host': 'outside.example'}):
            self.assertEqual(self.request('POST', route, {}, headers=headers)[0], 403)
        self.assertEqual(self.workers, [])
        self.assertEqual(self.lifecycle.snapshot(), {'state': 'ready'})

    def test_shutdown_validates_body_then_runs_once_on_another_thread(self):
        """@param None. @pre Authenticated fixture.
        @post Only empty JSON schedules a stop; repeat requests acknowledge one separate worker.
        @return None. @throws AssertionError: Validation, idempotence or response failed.
        """
        route = '/api/server/shutdown'
        for body in ({'pid': 123}, [], b'invalid', b''):
            self.assertEqual(self.request('POST', route, body)[0], 400)
        self.assertEqual(self.workers, [])
        for _ in range(2):
            status, raw = self.request('POST', route, {})
            self.assertEqual((status, json.loads(raw)), (202, {'stopping': True}))
        self.assertTrue(self.called.wait(timeout=1))
        self.assertEqual(len(self.workers), 1)
        self.assertEqual(len(self.calls), 1)
        self.assertNotEqual(self.calls[0], threading.get_ident())
        self.assertEqual(self.lifecycle.snapshot(), {'state': 'stopping'})

    def test_status_is_small_local_only_and_independent_of_projects_and_application_lock(self):
        """@param None. @pre Bound lifecycle; project operations must remain unused.
        @post Status exposes only identity/token/state under common read authorization.
        @return None. @throws AssertionError: Project data leak, lock use or auth bypass.
        """
        self.app.lock = None
        status, raw = self.request('GET', '/api/server/status', token=False)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(raw), {'application': 'research-workbench', 'protocol': 1,
                                         'token': self.app.token, 'state': 'ready'})
        self.assertLess(len(raw), 512)
        self.assertEqual(self.request('GET', '/api/server/status', headers={'Origin': 'https://outside.example'})[0], 403)
        self.assertEqual(self.request('GET', '/api/server/status', headers={'Host': 'outside.example'})[0], 403)

    def test_worker_creation_failure_is_reported_and_can_retry(self):
        """@param None. @pre Thread seam fails once before scheduling work.
        @post Failure remains observable and a later request can start a fresh attempt.
        @return None. @throws AssertionError: False acceptance, leaked worker or permanent busy state.
        """
        attempts = []
        def flaky(**options):
            """@param options: Thread seam. @pre Fixture only. @post First call fails.
            @return Thread: Subsequent owned worker. @throws OSError: Synthetic resource failure.
            """
            attempts.append(True)
            if len(attempts) == 1:
                raise OSError('fixture thread unavailable')
            return self.worker(**options)
        lifecycle = ServerLifecycle(self.shutdown, worker_factory=flaky)
        with self.assertRaises(OSError):
            lifecycle.request_shutdown()
        self.assertEqual(lifecycle.snapshot(), {'state': 'failed'})
        self.assertEqual(lifecycle.request_shutdown(), {'stopping': True})
        self.assertTrue(self.called.wait(timeout=1))

    def test_background_shutdown_failure_is_recorded_without_leaking_callback_details(self):
        """@param None. @pre Callback raises in its owned worker.
        @post Failed state/log marker reported; exception contents remain out of public status.
        @return None. @throws AssertionError: Lost background failure or leaked value.
        """
        def fail():
            """@param None. @pre Fixture worker only. @post Raises before stopping.
            @return Never. @throws RuntimeError: Deliberate callback failure.
            """
            raise RuntimeError('fixture-private-value')
        lifecycle = ServerLifecycle(fail, worker_factory=self.worker)
        output = io.StringIO()
        with redirect_stderr(output):
            lifecycle.request_shutdown()
            self.workers[-1].join(timeout=2)
        self.assertEqual(lifecycle.snapshot(), {'state': 'failed'})
        self.assertNotIn('fixture-private-value', output.getvalue())
        self.assertIn('could not shut down', output.getvalue())

    def test_host_lifecycle_cannot_be_replaced_after_binding(self):
        """@param None. @pre Host composed once.
        @post Web/application code cannot replace its private host capability.
        @return None. @throws AssertionError: Second binding accepted.
        """
        with self.assertRaises(ValueError):
            self.app.bind_lifecycle(ServerLifecycle(self.shutdown))


if __name__ == '__main__':
    unittest.main()
