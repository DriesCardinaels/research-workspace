"""Application composition: CLI, loopback server and deterministic shutdown."""
import argparse
from http.server import ThreadingHTTPServer
import webbrowser


def run(application_factory, handler, *, argv=None, server_factory=ThreadingHTTPServer):
    """Compose the local application without embedding feature behavior.

    @param application_factory,handler: Application constructor and HTTP handler type.
    @param argv: Explicit arguments or None for sys.argv.
    @param server_factory: Injectable loopback transport constructor.
    @pre Factories implement the existing App and HTTP server interfaces.
    @post Server closes after success, interruption or failure; data is retained.
    @return None. @throws SystemExit: Bad CLI or unavailable port; other failures propagate.
    """
    parser = argparse.ArgumentParser(description='Research Workbench local research editor')
    parser.add_argument('--project', help='Project folder to open initially')
    parser.add_argument('--port', type=int, default=8766)
    parser.add_argument('--no-browser', action='store_true')
    parser.add_argument('--settings', help='Settings file; defaults to .settings.json in the installation')
    args = parser.parse_args(argv)
    app = application_factory(args.settings)
    if args.project:
        app.choose(args.project)
    try:
        server = server_factory(('127.0.0.1', args.port), handler)
    except OSError as error:
        parser.exit(1, f'Cannot start on port {args.port}: {error}. Try --port {args.port + 1}\n')
    server.app = app
    url = f'http://127.0.0.1:{server.server_port}'
    print(f'Research Workbench: {url}\nPress Ctrl+C to stop.', flush=True)
    try:
        if not args.no_browser:
            webbrowser.open(url)
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        try:
            server.server_close()
        finally:
            close = getattr(app, 'close', None)
            if close:
                close()


def main(argv=None):
    """Compose the built-in application independently of compatibility launchers.

    @param argv: Optional command arguments. @pre Source installation assets are present.
    @post Server and project resources close after serving stops.
    @return None. @throws SystemExit,OSError: Invalid CLI or startup/shutdown failure.
    """
    from research_workbench.application.sessions import App
    from research_workbench.transport.http.server import Handler
    return run(App, Handler, argv=argv)
