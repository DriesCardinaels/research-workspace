#!/usr/bin/env python3
"""Run real HTTP workflows in a retained test project: python3 tools/validate_api.py.

Uses Python's standard library and installed Git, latexmk, SyncTeX and pdftotext.
Separate settings/server/project protect the user's running editor and papers.
"""
import argparse
import base64
import http.client
from http.server import ThreadingHTTPServer
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
import time
import traceback
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.parse import urlencode

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / 'tests')]
from research_workbench.launcher import App, Handler, Project
from test_editor import sample_pdf


class QuietHandler(Handler):
    def log_message(self, *args):
        """Omit routine access logs; the validator records every request and status."""


class Validation:
    def __init__(self, output):
        """Start isolated storage/server. Pre: absent output path; post: fixture-only loopback API.
        Setup errors propagate. close() must release the server after success or failure.
        """
        self.output = output.resolve()
        self.output.mkdir(parents=True, exist_ok=False)
        self.app = App(self.output / 'settings.json')
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), QuietHandler)
        self.server.app = self.app
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.token, self.requests, self.checks, self.boundaries = '', [], [], []
        self.started = time.time()
        self.folder, self.source = self.output / 'project', self.output / 'source'

    def close(self):
        """Stop this test server. Pre: initialized fixture; post: socket and thread released."""
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def check(self, condition, label):
        """Assert observable behavior. Pre: boolean result; post: evidence or immediate failure."""
        self.checks.append({'check': label, 'passed': bool(condition)})
        if not condition:
            raise AssertionError(label)

    def call(self, method, path, data=None, expected=200, token=True, headers=None):
        """Call real HTTP transport. Pre: fixture route; post: status-checked JSON/bytes.
        Transport/status errors propagate. Request bodies and credentials are never logged.
        """
        body = json.dumps(data).encode() if isinstance(data, (dict, list)) else data
        h = {'Content-Type': 'application/json', **(headers or {})}
        if token:
            h['X-PDF-Token'] = self.token
        con = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=150)
        started = time.monotonic()
        accepted = [expected] if isinstance(expected, int) else list(expected)
        record = {'method': method, 'path': path, 'expected': accepted}
        try:
            con.request(method, path, body, h)
            response = con.getresponse()
            raw = response.read()
            record['status'] = response.status
            value = json.loads(raw) if 'application/json' in response.getheader('Content-Type', '') else raw
            if response.status not in accepted:
                raise AssertionError(f'{method} {path}: expected {accepted}, received {response.status}: {value!r}')
            return value
        except Exception as error:
            record['failure'] = type(error).__name__
            raise
        finally:
            record['seconds'] = round(time.monotonic() - started, 3)
            self.requests.append(record)
            con.close()

    def git(self, *args, root=None):
        """Run real Git only in fixture storage. Pre: trusted args; post: captured output or failure."""
        return subprocess.run(['git', '-C', str(root or self.source), *args], check=True,
                              capture_output=True, text=True, timeout=120).stdout.strip()

    def upload(self, name, **options):
        """Import a PDF through HTTP. Pre: selected project; post: actual persisted document."""
        return self.call('POST', self.p + '/documents',
                         {'name': name, 'data': base64.b64encode(sample_pdf()).decode(), **options}, 201)

    def pdf_text(self, data, name):
        """Independently inspect a generated PDF. Pre: PDF bytes; post: retained artifact and text."""
        path = self.output / name
        path.write_bytes(data)
        return subprocess.run(['pdftotext', str(path), '-'], capture_output=True, text=True,
                              check=True, timeout=30).stdout

    def setup_project(self):
        """Validate project/security/assets. Pre: isolated server; post: registered empty project."""
        config = self.call('GET', '/api/config', token=False)
        self.token = config['token']
        self.check(not config['projects'], 'No user projects in test settings')
        self.call('GET', '/api/config', headers={'Host': 'foreign.example'}, expected=403)
        self.call('POST', '/api/projects', {'folder': str(self.folder)}, token=False, expected=403)
        self.call('POST', '/api/projects', {}, headers={'Origin': 'https://foreign.example'}, expected=403)
        project = self.call('POST', '/api/projects', {'folder': str(self.folder)})
        self.p = '/api/projects/' + project['id']
        self.check(len(self.call('GET', '/api/projects')) == 1, 'Project registration and discovery')
        self.call('GET', self.p + '/tree')
        for asset in ('/', '/static/toolbar.js', '/static/toolbar.css', '/static/bibliography.js', '/static/bibliography.css'):
            self.check(bool(self.call('GET', asset)), 'Asset served: ' + asset)
        for path in ('/static/../research_workbench.py', '/static/../../etc/passwd', '/api/projects/missing/tree'):
            self.call('GET', path, expected=404)
        self.call('POST', '/api/projects', b'{broken', expected=400)
        self.call('GET', '/api/markup/schema')

    def pdf_workflows(self):
        """Validate PDF review/version/import/recovery. Pre: project; post: linked-workflow candidate."""
        folder = self.call('POST', self.p + '/folders', {'name': 'Validation'}, 201)
        self.check(self.call('GET', self.p + '/folders')[0]['id'] == folder['id'], 'Folder creation/listing')
        self.call('POST', self.p + '/folders', {'name': ''}, expected=400)
        doc = self.upload('validation.pdf', folder_id=folder['id'])
        self.d = self.p + '/documents/' + doc['id']
        self.check(self.call('GET', self.d + '/original') == sample_pdf(), 'Original PDF byte preservation')
        self.check(bool(self.call('POST', self.p + '/import-check', {'name': 'validation.pdf'})), 'Duplicate detection')
        self.call('POST', self.p + '/documents', {'name': 'bad.pdf', 'data': base64.b64encode(b'bad').decode()}, expected=400)
        self.call('POST', self.p + '/documents', {'name': 'validation.pdf', 'data': base64.b64encode(sample_pdf()).decode()}, expected=409)
        target = {'quote': 'Research Workbench test document', 'rects': [{'p': 1, 'x': 60, 'y': 52, 'w': 180, 'h': 22}]}
        revision = self.call('GET', self.d + '/markup/revision?scope=pdf')
        marks = []
        for kind, color in [('highlight', c) for c in ('yellow', 'green', 'blue', 'pink')] + [('comment', 'yellow'), ('strikethrough', 'yellow'), ('replace', 'yellow')]:
            marks.append(self.call('POST', self.d + '/markup', {'scope': 'pdf', 'kind': kind, **({'color': color} if kind in ('highlight', 'comment') else {}),
                'target': target, 'text': 'Fixture review', **({'replacement': 'Improved wording'} if kind == 'replace' else {})}, 201))
        for mark in marks:
            self.call('POST', self.d + '/markup/' + mark['id'] + '/comments', {'scope': 'pdf', 'text': 'Validated reply'})
        pen = self.call('POST', self.d + '/markup', {'scope': 'pdf', 'kind': 'pen', 'page': 1, 'color': '#1971c2', 'width': 2, 'points': [[10, 10], [20, 20]]}, 201)
        self.check(len(self.call('GET', self.d + '/markup?scope=pdf')['items']) == 8, 'All PDF markup kinds and highlight colors')
        self.check(self.call('GET', self.d + '/markup/revision?scope=pdf') != revision, 'Markup revision polling detects changes')
        self.call('DELETE', self.d + '/markup/' + pen['id'], {'scope': 'pdf'})
        self.check(len(self.call('GET', self.d + '/markup?scope=pdf')['items']) == 7, 'Eraser deletes only its target')
        self.call('POST', self.d + '/markup', {'scope': 'pdf', 'kind': 'highlight', 'target': {'rects': [{'p': 0}]}}, expected=400)
        base = self.call('GET', self.d + '/annotations')
        self.call('PUT', self.d + '/annotations', {**base, 'base': base})
        self.call('PUT', self.d + '/annotated', sample_pdf())
        self.check(self.call('GET', self.d + '/annotated') == sample_pdf(), 'Export upload/download byte preservation')
        self.call('POST', self.d + '/markup/' + marks[0]['id'] + '/comments', {'scope': 'pdf', 'text': 'Later reply'})
        self.check(self.call('GET', self.p + '/documents')[0]['export_stale'], 'Editing marks invalidates saved exports')
        base = self.call('GET', self.d + '/annotations')
        edited = json.loads(json.dumps(base)); edited['highlights'][0]['text'] = 'Winner'
        self.call('PUT', self.d + '/annotations', {**edited, 'base': base})
        stale = json.loads(json.dumps(base)); stale['highlights'][0]['text'] = 'Stale loser'
        self.call('PUT', self.d + '/annotations', {**stale, 'base': base}, expected=409)
        self.check(self.call('GET', self.d + '/annotations')['highlights'][0]['text'] == 'Winner', 'Concurrent conflict preserves the saved winner')
        self.document = self.upload('validation.pdf', version_of=doc['id'])
        self.call('PUT', self.d + '/annotations', base, expected=409)
        self.check(len(self.call('GET', self.d + '/versions')) == 2, 'Archived version history preserved')
        self.d = self.p + '/documents/' + self.document['id']
        self.call('PUT', self.d + '/folder', {'folder_id': None})
        self.call('DELETE', self.d)
        self.check(len(self.call('GET', self.p + '/deleted')) == 1, 'Recoverable deletion')
        self.call('POST', self.d + '/restore', {})
        self.check(len(self.call('GET', self.d + '/versions')) == 2, 'Recovery restores every version')
        reading = self.output / 'reading'; reading.mkdir()
        for name in ('one.pdf', 'two.pdf'):
            (reading / name).write_bytes(sample_pdf())
        batch = {'folder_path': str(reading), 'collection_name': 'Reading', 'recursive': True}
        self.check(self.call('POST', self.p + '/imports/directory', batch, 201)['imported'] == 2, 'Named collection directory import')
        self.call('POST', self.p + '/imports/directory', batch, expected=409)
        self.check(len(self.call('POST', self.p + '/imports/directory', {**batch, 'duplicate_mode': 'skip'}, 201)['skipped']) == 2, 'Directory duplicate-skip is non-destructive')
        (self.folder / 'disk.pdf').write_bytes(sample_pdf())
        disk = self.call('POST', self.p + '/open-file', {'path': 'disk.pdf'})
        self.check(self.call('POST', self.p + '/open-file', {'path': 'disk.pdf'})['id'] == disk['id'], 'Repeated disk-PDF opening retains its review')
        self.call('POST', self.p + '/open-file', {'path': '../settings.json'}, expected=400)
        self.call('POST', self.p + '/reload', {})

    def source_workflows(self):
        """Validate source/change/note APIs. Pre: PDF fixture; post: actual Git-linked LaTeX project."""
        self.source.mkdir(); (self.source / 'sections').mkdir()
        self.intro = 'Evidence supports this statement.\\cite{known}\n\nA second paragraph remains unchanged.\n'
        self.bib = '@article{known, title={Evidence}, author={Doe, Jane}, journal={Fixture Journal}, year={2026}}\n'
        main = ('\\documentclass{article}\n\\begin{document}\n\\input{sections/intro}\n'
                '\\begin{figure}[h]\\centering Fixture figure marker\\caption{Fixture figure}\\end{figure}\n'
                '\\begin{table}[h]\\centering Fixture table marker\\caption{Fixture table}\\end{table}\n'
                '\\bibliographystyle{plain}\n\\bibliography{references}\n\\end{document}\n')
        for name, text in {'main.tex': main, 'sections/intro.tex': self.intro, 'references.bib': self.bib,
            'standalone.tex': '\\documentclass{article}\n\\begin{document}Standalone fixture preview.\\end{document}\n'}.items():
            (self.source / name).write_text(text)
        for args in [('init', '-q', '-b', 'main'), ('config', 'user.name', 'API Validator'), ('config', 'user.email', 'validator@example.invalid'), ('config', 'commit.gpgsign', 'false'), ('add', '.'), ('commit', '-qm', 'Fixture baseline')]:
            self.git(*args)
        self.q = self.d + '/draft'
        linked = self.call('POST', self.q + '/link', {'root': str(self.source), 'main': 'main.tex', 'commit': self.git('rev-parse', 'HEAD')})
        self.check(linked['linked'] and 'references.bib' in linked['files'], 'Bibliography advertised as editable source')
        self.check(self.call('GET', self.d + '/markup')['scope'] == 'draft', 'Auto markup scope selects linked source')
        self.call('GET', self.q + '/history')
        bibliography = self.call('GET', self.q + '/file?path=references.bib')
        edited_bib = self.bib.replace('2026', '2025')
        self.call('PUT', self.q + '/file', {'path': 'references.bib', 'sha': bibliography['sha'], 'text': edited_bib})
        self.call('PUT', self.q + '/file', {'path': 'references.bib', 'sha': bibliography['sha'], 'text': 'stale bibliography'}, expected=422)
        saved_bib = self.call('GET', self.q + '/file?path=references.bib')
        self.check(saved_bib['text'] == edited_bib, 'Bibliography saves persist exact text and reject stale writes')
        self.call('PUT', self.q + '/file', {'path': 'references.bib', 'sha': saved_bib['sha'], 'text': self.bib})
        cites = self.call('GET', self.q + '/citations')
        self.check(not cites['problems'] and len(cites['entries']) == 1, 'Citations resolve against the declared bibliography')
        self.check(self.call('POST', '/api/bibliography/entries', {'text': self.bib})['entries'][0]['key'] == 'known', 'Bibliography metadata parsing')
        self.call('POST', '/api/bibliography/entries', {'text': 123}, expected=400)
        current = self.call('GET', self.q + '/file?path=sections/intro.tex')
        changed = self.intro.replace('supports', 'strongly supports')
        self.check(self.call('PUT', self.q + '/file', {'path': 'sections/intro.tex', 'sha': current['sha'], 'text': changed})['changes'], 'Source saves produce tracked changes')
        self.call('PUT', self.q + '/file', {'path': 'sections/intro.tex', 'sha': current['sha'], 'text': 'stale'}, expected=422)
        self.check((self.source / 'sections/intro.tex').read_text() == changed, 'Stale source saves cannot overwrite current text')
        self.call('GET', self.q + '/file?path=../settings.json', expected=422)
        change = self.call('GET', self.q)['changes'][0]
        route = self.q + '/changes/' + change['id']
        self.call('POST', route + '/comments', {'text': 'Evidence checked', 'author': 'Validator'}, 201)
        for status in ('accepted', 'open'):
            self.call('POST', route + '/status', {'status': status})
        self.call('POST', route + '/revert', {})
        self.check((self.source / 'sections/intro.tex').read_text() == self.intro, 'Change revert restores exact source')
        note = self.call('POST', self.q + '/notes', {'file': 'sections/intro.tex', 'start': 0, 'end': 8, 'quote': 'Evidence', 'text': 'Legacy note', 'author': 'Validator'}, 201)
        self.call('POST', self.q + '/notes/' + note['id'] + '/comments', {'text': 'Reply', 'author': 'Validator'}, 201)
        for status in ('resolved', 'open'):
            self.call('POST', self.q + '/notes/' + note['id'] + '/status', {'status': status})
        for kind in ('comment', 'highlight', 'strikethrough', 'replace'):
            mark = self.call('POST', self.d + '/markup', {'scope': 'draft', 'kind': kind, 'target': {'file': 'sections/intro.tex', 'quote': 'Evidence'}, 'text': 'Review', **({'replacement': 'The evidence'} if kind == 'replace' else {})}, 201)
            route = self.d + '/markup/' + mark['id']
            self.call('POST', route + '/comments', {'scope': 'draft', 'text': 'Source reply'})
            for status in ('resolved', 'open'):
                self.call('POST', route + '/status', {'scope': 'draft', 'status': status})
            self.call('DELETE', route, {'scope': 'draft'})
        stroke = self.call('POST', self.q + '/strokes', {'page': 1, 'color': '#1971c2', 'width': 2, 'points': [[10, 10], [20, 20]]}, 201)
        for status in ('deleted', 'open'):
            self.call('POST', self.q + '/strokes/' + stroke['id'] + '/status', {'status': status})
        self.call('POST', self.q + '/writing/ignores', {'key': 'fixture123', 'rule': 'long', 'file': 'sections/intro.tex', 'text': 'Fixture sentence.'})
        self.check(len(self.call('GET', self.q)['writing_ignores']) == 1, 'Writing ignores persist')
        self.call('POST', self.q + '/writing/ignores', {'key': 'fixture123', 'rule': 'long', 'ignored': False})
        self.check(not self.call('GET', self.q)['writing_ignores'], 'Writing ignores can be removed')

    def builds(self):
        """Run actual TeX/SyncTeX. Pre: linked source; post: independently verified PDF artifacts."""
        self.check(self.call('POST', self.q + '/compile', {})['ok'], 'Real full-paper LaTeX compilation')
        full = self.call('GET', self.q + '/pdf')
        text = self.pdf_text(full, 'compiled.pdf')
        self.check('Fixture figure marker' in text and 'Fixture table marker' in text, 'Compiled PDF contains figure and table')
        positions = self.call('GET', self.q + '/synctex/view?path=sections/intro.tex&line=1')
        self.check(bool(positions), 'Real source-to-PDF SyncTeX geometry')
        point = positions[0]
        reverse = self.call('GET', self.q + '/synctex/edit?' + urlencode({'page': point['page'], 'x': point['x'], 'y': point['y']}))
        self.check(reverse['file'] == 'sections/intro.tex', 'Real bidirectional SyncTeX round-trip')
        self.check(self.call('POST', self.q + '/compile-active', {'path': 'standalone.tex'})['ok'], 'Real active-file compilation')
        self.check('Standalone fixture preview' in self.pdf_text(self.call('GET', self.q + '/active-file/pdf?path=standalone.tex'), 'standalone.pdf'), 'Requested standalone PDF is served')
        self.call('POST', self.q + '/compile-active', {'path': 'sections/intro.tex'}, expected=422)
        self.check(self.call('POST', self.q + '/no-figures', {})['ok'], 'Real figure-free compilation')
        stripped = self.pdf_text(self.call('GET', self.q + '/no-figures/pdf'), 'without-figures.pdf')
        self.check('Fixture figure marker' not in stripped and 'Fixture table marker' in stripped, 'Figure-free PDF removes figures but preserves tables')
        self.check(self.call('GET', self.q + '/pdf') == full, 'Derived previews preserve the full draft PDF')
        for action in ('compile-active', 'promote'):
            self.call('POST', self.q + '/' + action, ['invalid body'], expected=400)

    def providers(self):
        """Verify provider integration. Pre: private test settings; post: cleared key and honest live result."""
        self.check(not self.call('GET', '/api/settings/openalex')['configured'], 'OpenAlex settings start empty')
        saved = self.call('PUT', '/api/settings/openalex', {'api_key': 'fixture-key'})
        self.check(saved['configured'] and 'api_key' not in saved, 'Settings do not return API keys')
        self.call('PUT', '/api/settings/openalex', {'api_key': 'bad key'}, expected=400)
        self.call('PUT', '/api/settings/openalex', {'api_key': ''})
        self.call('POST', '/api/openalex/search', {'query': ''}, expected=400)
        self.call('POST', '/api/openalex/check', {'text': self.bib, 'key': 'absent'}, expected=400)
        work = {'id': 'https://openalex.org/W1', 'display_name': 'Evidence', 'publication_year': 2026,
                'authorships': [{'author': {'display_name': 'Jane Doe'}}], 'biblio': {}, 'primary_location': {'source': {'display_name': 'Fixture Journal'}}}
        class Upstream:
            def open(upstream, request, timeout):
                """Substitute only external HTTP transport; preserve real search/comparison logic."""
                return io.BytesIO(json.dumps({'results': [work]}).encode())
        with patch('research_workbench.infrastructure.metadata.openalex.build_opener', return_value=Upstream()):
            self.check(len(self.call('POST', '/api/openalex/search', {'query': 'Evidence'})['works']) == 1, 'Search parses controlled upstream metadata')
            result = self.call('POST', '/api/openalex/check', {'text': self.bib, 'key': 'known'})
            self.check(any(c['status'] == 'matches' for c in result['works'][0]['comparison']), 'Real field-by-field bibliography comparison')
        for status in (401, 403, 429):
            with patch('research_workbench.infrastructure.metadata.openalex.build_opener') as opener:
                opener.return_value.open.side_effect = HTTPError('https://api.openalex.org', status, 'fixture', {}, None)
                self.call('POST', '/api/openalex/search', {'query': 'Evidence'}, expected=400)
        # Public DOI only, with no key and no user bibliography/source transmitted.
        live = self.call('POST', '/api/openalex/search', {'query': '10.1038/nature12373'}, expected=(200, 400))
        matched = next((work for work in live.get('works', []) if work.get('doi', '').casefold().removeprefix('https://doi.org/') == '10.1038/nature12373'), None)
        if live.get('works'):
            self.check(matched is not None and live.get('lookup') == 'doi', 'Live OpenAlex result matches the requested DOI exactly')
        self.boundaries.append({'service': 'OpenAlex live lookup', 'verified': matched is not None,
            'detail': live.get('error', 'Public DOI metadata returned'), 'doi': (matched or {}).get('doi'), 'title': (matched or {}).get('title')})
        # Native folder UI is substituted at its OS boundary for unattended API testing.
        if sys.platform == 'darwin':
            for code, value in ((0, str(self.folder) + '\n'), (1, '')):
                with patch('research_workbench.launcher.subprocess.run', return_value=subprocess.CompletedProcess([], code, value, '')):
                    result = self.call('POST', '/api/choose-folder', {})
                    self.check(bool(result.get('folder') if code == 0 else result.get('cancelled')), 'Native chooser API ' + ('selection' if code == 0 else 'cancellation'))
        self.boundaries.append({'service': 'Native folder chooser', 'verified': False, 'detail': 'OS selection/cancellation substituted; HTTP handler tested'})

    def repository(self):
        """Validate actual local pushes through HTTP. Pre: fixture Git; post: no external publication."""
        remote = self.output / 'receiver.git'
        subprocess.run(['git', 'init', '--bare', '-q', str(remote)], check=True, capture_output=True)
        target = 'https://github.com/api-validation/fixture.git'
        self.git('config', 'url.' + remote.as_uri() + '.insteadOf', target)
        self.call('GET', self.p + '/github')
        config = {'url': target, 'branch': 'main', 'paper_id': self.document['paper_id']}
        state = self.call('PUT', self.p + '/github', config)
        expected = {'expected_url': target, 'expected_branch': 'main', 'expected_head': state['head']}
        self.call('POST', self.p + '/github/push', {**expected, 'expected_head': '0' * 40}, expected=409)
        result = self.call('POST', self.p + '/github/push', expected)
        self.check(result['pushed'] and self.git('rev-parse', 'refs/heads/main', root=remote) == state['head'], 'Real Git push transfers the exact reviewed commit into a local receiver')
        self.check(not self.git('remote'), 'Push never changes source remote configuration')
        self.call('PUT', self.p + '/github', {**config, 'url': 'https://secret@github.com/a/b'}, expected=400)
        self.boundaries.append({'service': 'GitHub', 'verified': False, 'detail': 'Real push verified against local bare Git receiver; no GitHub account/credentials used'})

    def promotion(self):
        """Validate actual version commit/build/history. Pre: fixture source; post: retained complete project."""
        current = self.call('GET', self.q + '/file?path=sections/intro.tex')
        self.call('PUT', self.q + '/file', {'path': 'sections/intro.tex', 'sha': current['sha'], 'text': self.intro.replace('supports', 'validates')})
        (self.source / 'unrelated.txt').write_text('Do not commit.\n')
        old_head = self.git('rev-parse', 'HEAD')
        saved = self.call('POST', self.q + '/promote', {'note': 'Real API validation'}, 201)
        self.check(saved['document']['number'] == 3 and saved['commit'] != old_head, 'Version promotion builds a real new commit')
        self.check('unrelated.txt' not in self.git('ls-tree', '-r', '--name-only', 'HEAD').splitlines(), 'Promotion excludes unrelated untracked files')
        self.check('validates' in self.git('show', 'HEAD:sections/intro.tex'), 'Promoted commit contains exact saved source')
        self.check(self.call('GET', self.q + '/history') is not None, 'Old draft review history archived')
        self.call('POST', self.d + '/markup', {'scope': 'draft', 'kind': 'comment', 'target': {'file': 'sections/intro.tex', 'quote': 'Evidence'}, 'text': 'Archived write'}, expected=409)
        latest = self.p + '/documents/' + saved['document']['id']
        self.check(any(n['quote'] == 'Evidence' and n['status'] == 'open' for n in self.call('GET', latest + '/draft')['notes']), 'Open comments carry into the new draft')
        self.check(self.call('GET', latest + '/original').startswith(b'%PDF'), 'Promoted original is a built PDF')
        self.check(len(self.call('GET', latest + '/versions')) == 3, 'All three versions remain accessible')
        self.call('POST', self.p + '/reload', {})
        self.check(bool(Project(self.folder).documents()), 'Persisted project reopens independently')
        self.check(bool(App(self.output / 'settings.json').project_list()), 'Project registry survives a new application instance')

    def report(self, failure):
        """Write credential-free evidence. Pre: run ended; post: durable JSON trace and coverage list."""
        normalized = sorted({r['method'] + ' ' + re.sub(r'[a-f0-9]{12,64}', '{id}', r['path'].split('?')[0]) for r in self.requests})
        result = {'passed': failure is None, 'seconds': round(time.time() - self.started, 2), 'test_project': str(self.folder),
                  'assertions': self.checks, 'requests': self.requests, 'coverage': normalized, 'external_boundaries': self.boundaries,
                  'failure': failure, 'user_projects_modified': False, 'python_version': sys.version.split()[0]}
        text = json.dumps(result, indent=2).replace(self.token, '<REDACTED>') if self.token else json.dumps(result, indent=2)
        (self.output / 'report.json').write_text(text)
        summary = ['# API validation', '', 'Result: **' + ('PASS' if failure is None else 'FAIL') + '**', '',
                   f'- HTTP requests checked: {len(self.requests)}', f'- Semantic assertions: {len(self.checks)}',
                   f'- Duration: {result["seconds"]} seconds', f'- Python: {result["python_version"]} (standard library only)',
                   '- Real LaTeX compilation, PDF text extraction, SyncTeX and local Git push.',
                   '- Separate server, settings and project; user projects were not modified.', '',
                   'Test project: `' + str(self.folder) + '`', '', '## External boundaries', '',
                   '| Integration | Live verification | Evidence |', '| --- | --- | --- |']
        summary += ['| ' + b['service'] + ' | ' + ('Yes' if b['verified'] else 'Boundary substituted') + ' | ' + b['detail'] + ' |' for b in self.boundaries]
        summary += ['', '## Assertions', ''] + ['- ' + ('PASS' if c['passed'] else 'FAIL') + ': ' + c['check'] for c in self.checks]
        summary += ['', '## Method/path coverage', '', '```text', *normalized, '```', '',
                    'Full request/status trace: [report.json](report.json).']
        if failure:
            summary += ['', '## Failure', '', '```text', failure, '```']
        (self.output / 'report.md').write_text('\n'.join(summary).replace(self.token, '<REDACTED>') if self.token else '\n'.join(summary))
        return result


def main():
    """Run ordered API validation. Pre: required binaries; post: report, test project and exit code."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'work' / 'api-validation' / time.strftime('%Y%m%d-%H%M%S'))
    args = parser.parse_args()
    run = Validation(args.output)
    failure = None
    try:
        for name in ('setup_project', 'pdf_workflows', 'source_workflows', 'builds', 'providers', 'repository', 'promotion'):
            print('Running ' + name, flush=True)
            getattr(run, name)()
            print('PASS ' + name, flush=True)
    except Exception:
        failure = traceback.format_exc()
    finally:
        run.close()
        result = run.report(failure)
    print(json.dumps({'passed': result['passed'], 'assertions': len(result['assertions']), 'requests': len(result['requests']), 'routes': len(result['coverage']), 'report': str(run.output / 'report.json'), 'failure': failure, 'boundaries': result['external_boundaries']}, indent=2))
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
