"""Explicit loopback/process integration for the native recovery helper."""
from concurrent.futures import ThreadPoolExecutor
import errno
import http.client
import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time
import unittest

from test_native_recovery import NativeRecoveryFixture, ROOT
from research_workbench.native_host.recovery import ensure_server, probe
from research_workbench.application.sessions import App
from research_workbench.bootstrap import run
from research_workbench.transport.http.lifecycle import GracefulHTTPServer
from research_workbench.transport.http.routes import builtin_routes
from research_workbench.transport.http.server import Handler


class NativeRecoverySocketTests(NativeRecoveryFixture, unittest.TestCase):
    def setUp(self):
        """@param None. @pre Loopback sockets available. @post Isolated fixture and free port.
        @return None. @throws OSError: Fixture/socket setup failure.
        """
        super().setUp()
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            self.port = listener.getsockname()[1]

    def test_concurrent_launches_share_one_server_and_reuse_keeps_it_alive(self):
        """@param None. @pre Empty isolated settings and free loopback port.
        @post Competing native attempts start one real server; later attempts reuse it without signaling.
        @return None. @throws AssertionError: Duplicate startup, wrong identity or lifecycle failure.
        """
        with ThreadPoolExecutor(max_workers=2) as workers:
            futures = [workers.submit(ensure_server, self.root, self.port, settings=self.settings, spawn=self.spawn) for _ in range(2)]
            results = [future.result(timeout=20) for future in futures]
        self.assertEqual(len(self.children), 1)
        self.assertEqual(sorted(result['reused'] for result in results), [False, True])
        self.assertEqual(probe(self.port).state, 'ready')
        self.assertTrue(ensure_server(self.root, self.port, settings=self.settings, spawn=self.spawn)['reused'])
        self.assertIsNone(self.children[0].poll())
        self.assertEqual(len(self.children), 1)
    def test_sigterm_cancellation_reaps_unready_server(self):
        """@param None. @pre Native helper owns a synthetic sleeping server.
        @post SIGTERM returns JSON failure and child is gone; no PID-file process signaling occurs.
        @return None. @throws AssertionError: Orphaned child or unstructured error.
        """
        marker = self.root / 'fixture-child.pid'
        (self.root / 'research_workbench.py').write_text(
            'import os, pathlib, time\npathlib.Path(' + repr(str(marker)) + ').write_text(str(os.getpid()))\ntime.sleep(60)\n')
        helper = subprocess.Popen([sys.executable, '-m', 'research_workbench.native_host.recovery', '--root', str(self.root),
                                   '--port', str(self.port), '--timeout', '10'], cwd=ROOT,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.children.append(helper)
        deadline = time.monotonic() + 3
        while not marker.exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertTrue(marker.exists())
        child_pid = int(marker.read_text())
        helper.send_signal(signal.SIGTERM)
        out, err = helper.communicate(timeout=6)
        self.assertEqual(helper.returncode, 1, err)
        self.assertFalse(json.loads(out)['ok'])
        self.assertIn('canceled', json.loads(out)['error'])
        with self.assertRaises(ProcessLookupError):
            os.kill(child_pid, 0)
    def test_dripping_foreign_service_is_bounded_by_total_probe_deadline(self):
        """@param None. @pre TCP listener slowly sends an incomplete HTTP header.
        @post Probe returns occupied within the total deadline; fixture thread/socket close.
        @return None. @throws AssertionError: Per-byte timeout allowed an unbounded probe.
        """
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            listener.listen(1)
            port = listener.getsockname()[1]
            stopped = threading.Event()
            def drip():
                """@param None. @pre Listener active. @post Fixture connection closed.
                @return None. @throws None; peer closure is expected.
                """
                connection, _ = listener.accept()
                with connection:
                    try:
                        while not stopped.wait(0.02):
                            connection.sendall(b'H')
                    except OSError:
                        pass  # Fixture peer is expected to close at its deadline.
            thread = threading.Thread(target=drip)
            thread.start()
            started = time.monotonic()
            try:
                self.assertEqual(probe(port, timeout=0.15).state, 'occupied')
                self.assertLess(time.monotonic() - started, 0.8)
            finally:
                stopped.set()
                thread.join(timeout=2)
            self.assertFalse(thread.is_alive())
class ServerShutdownSocketTests(NativeRecoveryFixture, unittest.TestCase):
    def request(self, port, path, *, method='GET', token=None):
        """@param port,path,method,token: Fixture endpoint and optional local authorization.
        @pre Fixture listener active. @post Connection closes after complete response.
        @return tuple: Status/body bytes. @throws OSError,HTTPException: Transport failed.
        """
        connection = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
        try:
            headers = {'Origin': f'http://127.0.0.1:{port}'}
            if token is not None:
                headers['X-PDF-Token'] = token
            connection.request(method, path, b'{}' if method == 'POST' else None, headers)
            response = connection.getresponse()
            return response.status, response.read()
        finally:
            connection.close()

    def assert_port_is_owned(self, port):
        """@param port: Listener being drained. @pre Fixture owns this port.
        @post A replacement process could not bind before old work/cleanup finishes.
        @return None. @throws AssertionError: Port released prematurely.
        """
        with socket.socket() as candidate:
            candidate.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            with self.assertRaises(OSError) as result:
                candidate.bind(('127.0.0.1', port))
            self.assertEqual(result.exception.errno, errno.EADDRINUSE)

    def test_authenticated_shutdown_drains_mutation_and_cleanup_before_releasing_port(self):
        """@param None. @pre Real bootstrap/HTTP lifecycle with synthetic blocked save.
        @post Stop acknowledges; accepted work and App.close finish before port reuse/offline success.
        @return None. @throws AssertionError: Deadlock, premature cleanup, data loss or early restart window.
        """
        app = App(self.settings)
        entered, release_save = threading.Event(), threading.Event()
        cleanup_entered, release_cleanup = threading.Event(), threading.Event()
        closed, bound = threading.Event(), threading.Event()
        errors, servers = [], []
        original_close = app.close
        def close():
            """@param None. @pre Requests drained. @post Synthetic cleanup gate then real App cleanup.
            @return None. @throws RuntimeError: Test cleanup deadline expired.
            """
            cleanup_entered.set()
            if not release_cleanup.wait(timeout=5):
                raise RuntimeError('fixture cleanup wait expired')
            original_close()
            closed.set()
        app.close = close
        def save(app, raw):
            """@param app,raw: Authenticated fixture mutation. @pre Handler owns request.
            @post Synthetic save persists only after gate release. @return tuple.
            @throws RuntimeError: Test save deadline expired.
            """
            entered.set()
            if not release_save.wait(timeout=5):
                raise RuntimeError('fixture save wait expired')
            (self.root / 'saved.txt').write_text('complete')
            return 200, {'saved': True}
        routes = builtin_routes().register('POST', '/api/fixture/save', save)
        handler = type('ShutdownFixtureHandler', (Handler,), {'routes': routes})
        def factory(address, handler):
            """@param address,handler: Bootstrap transport inputs. @pre Disposable listener.
            @post Public host retained for cleanup. @return GracefulHTTPServer. @throws OSError: Bind failed.
            """
            server = GracefulHTTPServer(address, handler, idle_timeout=0.15)
            servers.append(server)
            bound.set()
            return server
        def serve():
            """@param None. @pre Fixture composition ready. @post Bootstrap result retained.
            @return None. @throws None; failures captured for assertion.
            """
            try:
                run(lambda settings: app, handler, argv=['--no-browser', '--port', '0'], server_factory=factory)
            except Exception as error:
                errors.append(error)
        host = threading.Thread(target=serve)
        host.start()
        try:
            self.assertTrue(bound.wait(timeout=2))
            server = servers[0]
            port = server.server_port
            with ThreadPoolExecutor(max_workers=1) as workers:
                pending = workers.submit(self.request, port, '/api/fixture/save', method='POST', token=app.token)
                try:
                    self.assertTrue(entered.wait(timeout=2))
                    status, raw = self.request(port, '/api/server/shutdown', method='POST', token=app.token)
                    self.assertEqual((status, json.loads(raw)), (202, {'stopping': True}))
                    self.assertFalse(cleanup_entered.is_set())
                    self.assert_port_is_owned(port)
                finally:
                    release_save.set()
                self.assertEqual(pending.result(timeout=3)[0], 200)
            self.assertTrue(cleanup_entered.wait(timeout=2))
            self.assertFalse(closed.is_set())
            self.assert_port_is_owned(port)
            release_cleanup.set()
            host.join(timeout=3)
            self.assertFalse(host.is_alive())
            self.assertTrue(closed.is_set())
            self.assertEqual(errors, [])
            self.assertEqual(probe(port).state, 'offline')
            self.assertEqual((self.root / 'saved.txt').read_text(), 'complete')
        finally:
            release_save.set()
            release_cleanup.set()
            if servers and host.is_alive():
                servers[0].shutdown()
            host.join(timeout=6)

    def test_idle_preconnected_client_has_bounded_drain_without_canceling_computation(self):
        """@param None. @pre Real listener and client that sends no HTTP bytes.
        @post Idle socket expires and server closes while client stays connected; no forced process stop.
        @return None. @throws AssertionError: Idle preconnect prevents shutdown indefinitely.
        """
        accepted = threading.Event()
        class NotifyingServer(GracefulHTTPServer):
            def process_request(self, request, address):
                """@param request,address: Accepted fixture socket. @pre Real serve loop.
                @post Production worker scheduled and acceptance signaled. @return None.
                @throws OSError,RuntimeError: Worker launch failed.
                """
                super().process_request(request, address)
                accepted.set()
        server = NotifyingServer(('127.0.0.1', 0), Handler, idle_timeout=0.7)
        host = threading.Thread(target=server.serve_forever)
        host.start()
        client = socket.create_connection(('127.0.0.1', server.server_port), timeout=2)
        client.settimeout(2)
        try:
            self.assertTrue(accepted.wait(timeout=1))
            server.shutdown()
            started = time.monotonic()
            server.close_after(None)
            self.assertLess(time.monotonic() - started, 2)
            self.assertEqual(client.recv(1), b'')
        finally:
            client.close()
            if host.is_alive():
                server.shutdown()
            host.join(timeout=3)
            server.server_close()


if __name__ == '__main__':
    unittest.main()
