"""Concurrent HTTP ownership: retain the listener until requests and application cleanup finish."""
from http.server import HTTPServer
import threading


class GracefulHTTPServer(HTTPServer):
    """Use non-daemon request workers with explicit drain-before-port-release ordering."""

    def __init__(self, server_address, handler, *, worker_factory=threading.Thread, idle_timeout=10):
        """Bind one HTTP listener and initialize private request ownership.

        @param server_address,handler,worker_factory,idle_timeout: Bind/handler, thread seam and positive idle IO bound.
        @pre Authorized loopback address; handler implements BaseHTTPRequestHandler; timeout is seconds.
        @post Listener bound; no request worker exists. @return None. @throws OSError: Bind failure.
        """
        self.__condition = threading.Condition()
        self.__active = 0
        self.__worker_factory = worker_factory
        if idle_timeout <= 0:
            raise ValueError('A positive idle request timeout is required.')
        self.__idle_timeout = idle_timeout
        super().__init__(server_address, handler)

    def process_request(self, request, client_address):
        """Transfer an accepted socket to an owned non-daemon request worker.

        @param request,client_address: Accepted socket and peer address from serve_forever.
        @pre Serve loop owns acceptance. @post Active work is counted before it can start.
        @return None. @throws RuntimeError,OSError: Worker launch failure; count is restored.
        """
        with self.__condition:
            self.__active += 1
        try:
            request.settimeout(self.__idle_timeout)
            worker = self.__worker_factory(target=self.__serve_request, args=(request, client_address),
                                          name='workbench-request', daemon=False)
            worker.start()
        except Exception:
            with self.__condition:
                self.__active -= 1
                self.__condition.notify_all()
            raise

    def __serve_request(self, request, client_address):
        """Finish all handler work and socket cleanup before publishing that it drained.

        @param request,client_address: Owned request transport. @pre Count incremented before worker start.
        @post Socket shutdown finishes before active count decreases, even on handler failure.
        @return None. @throws None for normal handler errors; BaseException propagates after cleanup.
        """
        try:
            try:
                self.finish_request(request, client_address)
            except Exception:
                self.handle_error(request, client_address)
        finally:
            try:
                self.shutdown_request(request)
            finally:
                with self.__condition:
                    self.__active -= 1
                    self.__condition.notify_all()

    def drain_requests(self):
        """Wait for accepted handlers without releasing the port to a second application.

        @param None. @pre Acceptance stopped; caller is not a request worker.
        @post No active handler or request-socket cleanup remains; listener stays bound.
        @return None. @throws None; active saves/builds determine the wait duration.
        """
        with self.__condition:
            self.__condition.wait_for(lambda: self.__active == 0)

    def close_after(self, cleanup):
        """Drain requests, release application resources, then make the port reusable.

        @param cleanup: No-argument application cleanup callback or None.
        @pre Serve loop stopped; composition owner calls outside a request thread.
        @post Listener closes after drained cleanup, including when cleanup raises.
        @return None. @throws Exception: Cleanup/transport failure; listener still closes.
        """
        try:
            self.drain_requests()
            if cleanup:
                cleanup()
        finally:
            super().server_close()

    def server_close(self):
        """Close an application-free host after all accepted request work has drained.

        @param None. @pre Acceptance stopped; not called from a request worker.
        @post Listener releases after request cleanup. @return None. @throws OSError: Close failure.
        """
        self.close_after(None)
