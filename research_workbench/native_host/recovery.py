"""Bounded native startup; only a trusted local executable may call this module."""
import argparse
from dataclasses import dataclass
import fcntl
import json
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time


APPLICATION_ID = 'research-workbench'
HEALTH_PROTOCOL = 1


@dataclass(frozen=True)
class Health:
    """Detached readiness result; state is ready, offline or occupied."""
    state: str
    message: str = ''


class StartupError(RuntimeError):
    """An actionable native startup failure without project or credential contents."""


def probe(port, timeout=0.5):
    """Identify a ready Workbench without reading settings, following redirects or using proxies.

    @param port,timeout: Loopback port and positive socket timeout in seconds.
    @pre Port is 1..65535. @post At most 12288 wire bytes read under a total deadline; connection closes.
    @return Health: Verified ready, unreachable offline or occupied by another service.
    @throws ValueError: Invalid port/timeout; programming errors propagate.
    """
    if not 1 <= port <= 65535 or timeout <= 0:
        raise ValueError('A valid local port and positive timeout are required.')
    deadline = time.monotonic() + timeout
    connection = None
    connected = False
    try:
        connection = socket.create_connection(('127.0.0.1', port), timeout=timeout)
        connected = True
        connection.sendall(f'GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n'.encode('ascii'))
        wire = b''
        expected = None
        valid = False
        while len(wire) < 12288:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError('Health deadline expired.')
            connection.settimeout(remaining)
            part = connection.recv(min(4096, 12288 - len(wire)))
            if not part:
                break
            wire += part
            header, separator, raw = wire.partition(b'\r\n\r\n')
            if separator:
                lines = header.split(b'\r\n')
                fields = dict(line.split(b':', 1) for line in lines[1:])
                fields = {key.strip().lower(): value.strip() for key, value in fields.items()}
                expected = int(fields.get(b'content-length', b'-1'))
                valid = (len(header) <= 8192 and 0 <= expected <= 4096
                         and b'transfer-encoding' not in fields and lines[0].split(b' ')[1] == b'200')
                if not valid or len(raw) >= expected:
                    break
            elif len(wire) > 8192:
                break
        header, separator, raw = wire.partition(b'\r\n\r\n')
        if valid and separator and len(raw) == expected:
            try:
                value = json.loads(raw)
            except (ValueError, UnicodeError):
                value = None
            if value == {'application': APPLICATION_ID, 'protocol': HEALTH_PROTOCOL, 'status': 'ready'}:
                return Health('ready')
        return Health('occupied', 'Another service or an older Workbench is using this port. Close it or rebuild this app with another port.')
    except (OSError, ValueError, IndexError):
        if connected:
            return Health('occupied', 'The local port is occupied but did not answer the Workbench health check. Try again after it finishes starting.')
        return Health('offline', 'The local server is not running.')
    finally:
        if connection is not None:
            connection.close()


def stop_owned_child(child):
    """Reap only the server process created by this exact startup attempt.

    @param child: Popen owned by the caller. @pre Never a PID loaded from a file.
    @post Running child receives terminate then kill if needed; exited child is reaped.
    @return None. @throws OSError,TimeoutExpired: Cleanup failed; no other process is signaled.
    """
    if child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=2)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=2)
    else:
        child.wait()


def ensure_server(root, port=8766, *, settings=None, timeout=15, probe_server=probe,
                  spawn=subprocess.Popen, clock=time.monotonic, pause=time.sleep):
    """Reuse or start one verified local server behind a cross-process startup lock.

    @param root,port,settings,timeout: Trusted checkout, loopback port, optional settings and 0..60s bound.
    @param probe_server,spawn,clock,pause: Narrow IO/time seams for deterministic failure tests.
    @pre Python 3.10+ on macOS/Unix; root contains the normal research_workbench.py entry point.
    @post Shared servers survive; failed owned children are reaped; lock always releases.
    @return dict: Ready URL and whether an existing process was reused. Successful child survives caller exit.
    @throws StartupError: Busy port/lock, timeout or failed startup; ValueError,OSError: Invalid inputs/IO.
    """
    root = Path(root).resolve()
    if not (root / 'research_workbench.py').is_file():
        raise ValueError('The configured Workbench checkout is missing. Rebuild the app for its current folder.')
    if not 1 <= port <= 65535 or not 0 < timeout <= 60:
        raise ValueError('A valid port and startup timeout up to 60 seconds are required.')
    deadline = clock() + timeout
    child = None
    ready = False
    # Shared with the PDF Editor plugin's startup guard. Never unlink a flock file.
    with (root / '.plugin-start.lock').open('a') as lock:
        try:
            while True:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if clock() >= deadline:
                        raise StartupError('Another launch is still starting the server. Try Launch Server again shortly.')
                    pause(min(0.1, max(0, deadline - clock())))
            health = probe_server(port, timeout=min(0.5, max(0.01, deadline - clock())))
            if clock() >= deadline:
                raise StartupError('Server startup timed out. Try Launch Server again.')
            if health.state == 'ready':
                return {'url': f'http://127.0.0.1:{port}', 'reused': True}
            if health.state != 'offline':
                raise StartupError(health.message)
            if clock() >= deadline:
                raise StartupError('Server startup timed out. Try Launch Server again.')
            arguments = [sys.executable, str(root / 'research_workbench.py'), '--no-browser', '--port', str(port)]
            if settings is not None:
                arguments.extend(['--settings', str(Path(settings).resolve())])
            with (root / '.native-server.log').open('ab') as log:
                child = spawn(arguments, cwd=root, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                              start_new_session=True, close_fds=True)
            while clock() < deadline:
                health = probe_server(port, timeout=min(0.5, max(0.01, deadline - clock())))
                if health.state == 'ready' and clock() < deadline:
                    if child.poll() is not None:
                        child.wait()
                    ready = True
                    return {'url': f'http://127.0.0.1:{port}', 'reused': False}
                if child.poll() is not None:
                    raise StartupError('The server could not start. See .native-server.log in the Workbench folder, fix the error and try again.')
                pause(min(0.1, max(0, deadline - clock())))
            raise StartupError('The server did not become ready in time. This launch was stopped. See .native-server.log and try again.')
        finally:
            if child is not None and not ready:
                stop_owned_child(child)
            fcntl.flock(lock, fcntl.LOCK_UN)


def main(argv=None):
    """Report one native-only startup result as bounded JSON, with a failure exit code.

    @param argv: CLI arguments or None for process arguments. @pre Trusted native caller.
    @post Exactly one result is printed; no browser opens and no HTTP launch route is added.
    @return int: Zero when ready, one on expected failure. @throws SystemExit: Bad CLI.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--port', type=int, default=8766)
    parser.add_argument('--settings', type=Path)
    parser.add_argument('--timeout', type=float, default=15)
    args = parser.parse_args(argv)
    previous = signal.signal(signal.SIGTERM, cancel_startup)
    try:
        try:
            result = {'ok': True, **ensure_server(args.root, args.port, settings=args.settings, timeout=args.timeout)}
        except (StartupError, ValueError, OSError, subprocess.TimeoutExpired) as error:
            print(json.dumps({'ok': False, 'error': str(error)}), flush=True)
            return 1
    finally:
        signal.signal(signal.SIGTERM, previous)
    print(json.dumps(result), flush=True)
    return 0


def cancel_startup(signum, frame):
    """Convert native watchdog cancellation into normal owned-child cleanup.

    @param signum,frame: Signal-handler inputs, unused. @pre Main helper process only.
    @post Stack unwinds through ensure_server's finally blocks. @return Never.
    @throws StartupError: Explicit startup cancellation.
    """
    raise StartupError('Server startup was canceled. Try Launch Server again.')


if __name__ == '__main__':
    sys.exit(main())
