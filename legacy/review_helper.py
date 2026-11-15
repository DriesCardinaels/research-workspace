#!/usr/bin/env python3
"""Review Helper: a local, offline, guided peer-review coach.

Usage:
    python3 review_helper.py [path/to/paper.pdf] [--port 8765] [--no-browser]

Serves the UI on http://127.0.0.1:<port> only. Nothing is sent anywhere:
no network calls, no CDNs, no telemetry. Reviews are stored in ./reviews/.
"""

import argparse
import json
import mimetypes
import os
import socket
import sys
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

import review_core as core

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, "static")
MAX_PDF_BYTES = 200 * 1024 * 1024

# PDF.js ships ES modules and WASM decoders; browsers need exact MIME types.
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("application/octet-stream", ".bcmap")
mimetypes.add_type("application/octet-stream", ".pfb")


class App:
    def __init__(self, reviews_dir, default_pdf=""):
        self.form, self.flow = core.load_config(HERE)
        self.store = core.Store(reviews_dir)
        self.default_pdf = default_pdf
        self.lock = threading.Lock()

    def payload(self, state):
        return {"state": state, "eval": core.evaluate(state, self.form, self.flow)}


class Handler(BaseHTTPRequestHandler):
    app = None  # set in main()
    server_version = "ReviewHelper/1.0"

    def log_message(self, fmt, *args):  # keep the terminal quiet
        if os.environ.get("REVIEW_HELPER_DEBUG"):
            super().log_message(fmt, *args)

    # -- helpers
    def _send(self, code, body, ctype="application/json; charset=utf-8", extra=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        elif isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        if "Cache-Control" not in (extra or {}):
            self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _error(self, code, msg):
        self._send(code, {"error": msg})

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}") if n else {}

    def _paper(self, raw):
        pid = core.sanitize_paper_id(unquote(raw))
        if not pid or not self.app.store.exists(pid):
            return None
        return pid

    # -- routes
    def do_GET(self):
        path = urlparse(self.path).path
        app = self.app
        if path in ("/", "/index.html"):
            return self._static("index.html")
        if path.startswith("/static/"):
            return self._static(path[len("/static/"):])
        if path == "/api/config":
            return self._send(200, {"form": app.form, "flow": app.flow, "default_pdf": app.default_pdf})
        if path == "/api/papers":
            out = []
            for s in app.store.list():
                ev = core.evaluate(s, app.form, app.flow)
                cur = next((x for x in ev["steps"] if x["id"] == s.get("current", {}).get("step")), None)
                out.append({
                    "paper_id": s["meta"]["paper_id"],
                    "title": s["meta"].get("title", ""),
                    "updated_at": s["meta"].get("updated_at"),
                    "current_step": cur["title"] if cur else "",
                    "pcs_filled": ev["pcs_filled"],
                    "pcs_total": ev["pcs_total"],
                })
            return self._send(200, out)
        parts = path.strip("/").split("/")
        if len(parts) >= 3 and parts[:2] == ["api", "papers"]:
            pid = self._paper(parts[2])
            if not pid:
                return self._error(404, "unknown paper")
            state = app.store.load(pid)
            if len(parts) == 3:
                return self._send(200, app.payload(state))
            if parts[3] == "review.md":
                md = core.export_markdown(state, app.form, app.flow)
                return self._send(200, md, "text/markdown; charset=utf-8",
                                  {"Content-Disposition": 'attachment; filename="review-%s.md"' % pid})
            if parts[3] == "pcs.txt":
                return self._send(200, core.pcs_text(state, app.form), "text/plain; charset=utf-8")
            if parts[3] == "pdf":
                return self._pdf(state)
            if parts[3] == "annotations":
                return self._send(200, app.store.load_annotations(pid))
            if parts[3] == "annotated.pdf":
                ap = app.store.annotated_pdf_path(pid)
                if not os.path.isfile(ap):
                    return self._error(404, "No annotated PDF exported yet")
                with open(ap, "rb") as f:
                    return self._send(200, f.read(), "application/pdf",
                                      {"Content-Disposition": 'inline; filename="annotated-%s.pdf"' % pid})
        return self._error(404, "not found")

    def do_POST(self):
        path = urlparse(self.path).path
        app = self.app
        try:
            body = self._body()
        except ValueError:
            return self._error(400, "invalid JSON")
        if path == "/api/papers":
            pid = core.sanitize_paper_id(body.get("paper_id", ""))
            if not pid:
                return self._error(400, "Paper ID is required (letters, digits, . _ -)")
            with app.lock:
                if app.store.exists(pid):
                    return self._error(409, "A review for this paper ID already exists")
                state = core.new_state(pid, app.form, body.get("title", ""), body.get("pdf_path") or app.default_pdf)
                state = core.apply_update(None, state, app.form, app.flow)
                app.store.save(state, app.form, app.flow)
            return self._send(201, app.payload(state))
        parts = path.strip("/").split("/")
        if len(parts) == 4 and parts[:2] == ["api", "papers"] and parts[3] == "compose":
            if not self._paper(parts[2]):
                return self._error(404, "unknown paper")
            try:
                text = core.compose(body.get("state") or {}, body.get("kind", ""), app.form, app.flow)
            except ValueError as e:
                return self._error(400, str(e))
            return self._send(200, {"text": text})
        return self._error(404, "not found")

    def do_PUT(self):
        path = urlparse(self.path).path
        app = self.app
        parts = path.strip("/").split("/")
        if len(parts) == 4 and parts[:2] == ["api", "papers"] and parts[3] in ("annotations", "annotated.pdf"):
            pid = self._paper(parts[2])
            if not pid:
                return self._error(404, "unknown paper")
            n = int(self.headers.get("Content-Length") or 0)
            if n > MAX_PDF_BYTES:
                return self._error(413, "too large")
            raw = self.rfile.read(n) if n else b""
            if parts[3] == "annotated.pdf":
                try:
                    with app.lock:
                        app.store.save_annotated_pdf(pid, raw)
                except ValueError as e:
                    return self._error(400, str(e))
                return self._send(200, {"path": app.store.annotated_pdf_path(pid)})
            try:
                data = json.loads(raw or b"{}")
            except ValueError:
                return self._error(400, "invalid JSON")
            with app.lock:
                ann = app.store.save_annotations(pid, data, app.form, app.flow)
            return self._send(200, {"updated_at": ann["updated_at"], "highlights": len(ann["highlights"]), "strokes": len(ann["strokes"])})
        if len(parts) == 3 and parts[:2] == ["api", "papers"]:
            pid = self._paper(parts[2])
            if not pid:
                return self._error(404, "unknown paper")
            try:
                body = self._body()
            except ValueError:
                return self._error(400, "invalid JSON")
            incoming = body.get("state")
            if not isinstance(incoming, dict):
                return self._error(400, "missing state")
            with app.lock:
                old = app.store.load(pid)
                incoming.setdefault("meta", {})["paper_id"] = pid
                state = core.apply_update(old, incoming, app.form, app.flow)
                app.store.save(state, app.form, app.flow, force_backup=bool(body.get("force_backup")))
            return self._send(200, app.payload(state))
        return self._error(404, "not found")

    # -- files
    def _static(self, rel):
        full = os.path.realpath(os.path.join(STATIC, rel))
        if not full.startswith(os.path.realpath(STATIC) + os.sep) or not os.path.isfile(full):
            return self._error(404, "not found")
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        cache = {"Cache-Control": "max-age=86400"} if "/vendor/" in full else None
        with open(full, "rb") as f:
            self._send(200, f.read(), ctype, cache)

    def _pdf(self, state):
        p = os.path.expanduser((state.get("meta", {}).get("pdf_path") or "").strip())
        if not p.lower().endswith(".pdf") or not os.path.isfile(p):
            return self._error(404, "PDF not found")
        with open(p, "rb") as f:
            self._send(200, f.read(), "application/pdf")


def free_port(start):
    for port in range(start, start + 50):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            # match the server (allow_reuse_address) so a port that only has
            # TIME_WAIT leftovers from a previous run counts as free
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise SystemExit("No free port found near %d" % start)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Guided, offline peer-review coach (IEEE VR 2027).")
    ap.add_argument("pdf", nargs="?", default="", help="optional path to the paper PDF")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--reviews", default=os.path.join(HERE, "reviews"), help="where reviews are stored")
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args(argv)

    pdf = os.path.abspath(os.path.expanduser(args.pdf)) if args.pdf else ""
    if pdf and not os.path.isfile(pdf):
        print("Warning: PDF not found: %s" % pdf, file=sys.stderr)
    Handler.app = App(args.reviews, pdf)
    port = free_port(args.port)
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    url = "http://127.0.0.1:%d/" % port
    print("Review Helper running at %s (offline; Ctrl+C to stop)" % url)
    print("Reviews are saved in %s" % os.path.abspath(args.reviews))
    if not args.no_browser:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
