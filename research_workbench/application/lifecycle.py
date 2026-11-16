"""Server lifecycle capability; transport requests never own server threads."""
import sys
import threading
import traceback


class ServerLifecycle:
    """Serialize graceful shutdown requests without importing an HTTP implementation."""

    def __init__(self, shutdown, *, worker_factory=threading.Thread):
        """Own one narrow graceful-stop operation without executing it.

        @param shutdown,worker_factory: No-argument server stop and injectable thread constructor.
        @pre Shutdown is safe from a separate thread and does not kill processes.
        @post State is ready; no work starts. @return None. @throws ValueError: Invalid callback.
        """
        if not callable(shutdown):
            raise ValueError('A graceful server shutdown operation is required.')
        self.__shutdown = shutdown
        self.__worker_factory = worker_factory
        self.__lock = threading.Lock()
        self.__state = 'ready'

    def snapshot(self):
        """Read detached shutdown progress without taking the application/project lock.

        @param None. @pre Initialized owner. @post No mutation or IO.
        @return dict: ready, stopping or failed state. @throws None.
        """
        with self.__lock:
            return {'state': self.__state}

    def request_shutdown(self):
        """Start one separate-thread shutdown, accepting repeated requests idempotently.

        @param None. @pre Caller has authorized the local mutation and decoded its payload.
        @post Server stops accepting requests; its owner drains active handlers before project cleanup.
        @return dict: Accepted stopping status. @throws RuntimeError,OSError: Worker could not start.
        """
        with self.__lock:
            if self.__state == 'stopping':
                return {'stopping': True}
            self.__state = 'stopping'
            try:
                worker = self.__worker_factory(target=self.__stop, name='workbench-shutdown', daemon=True)
                worker.start()
            except Exception:
                self.__state = 'failed'
                raise
        return {'stopping': True}

    def __stop(self):
        """Execute the bounded host stop capability and preserve a failed state for reporting.

        @param None. @pre Running on this owner's worker, never the serve_forever thread.
        @post Failure is recorded/logged once; host owns normal request draining and App.close.
        @return None. @throws None: Background failures are translated to state and local diagnostics.
        """
        try:
            self.__shutdown()
        except Exception as error:
            with self.__lock:
                self.__state = 'failed'
            for frame in traceback.extract_tb(error.__traceback__):
                print(f'File "{frame.filename}", line {frame.lineno}, in {frame.name}', file=sys.stderr)
            print('The local server could not shut down.', file=sys.stderr)
