"""Read-only bibliography checks against the OpenAlex works API (stdlib only)."""
import difflib
import json
import os
from pathlib import Path
import re
import tempfile
import unicodedata
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, build_opener, HTTPRedirectHandler

from research_workbench.domain.bibliography import parse_bib


def entries(data):
    """Parse submitted BibTeX. Pre: text <=2 MB; post: metadata only, no disk/network writes.
    Invalid input raises ValueError; the source editor remains authoritative.
    """
    if not isinstance(data, dict):
        raise ValueError('Expected a JSON object.')
    text = data.get('text')
    if not isinstance(text, str) or len(text.encode('utf-8')) > 2_000_000:
        raise ValueError('Provide bibliography text of at most 2 MB.')
    return parse_bib(text, detailed=True)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        """Refuse redirects. Pre: upstream redirect; post: credentials never leave API host.
        HTTPError propagates to the sanitized request handler.
        """
        return None


class OpenAlex:
    def __init__(self, path):
        """Bind private settings path. Pre: local app path; post: no credential read yet."""
        self.path = Path(path)

    def key(self):
        """Read optional key. Pre: local settings; post: server-only credential or empty string.
        Missing file is normal; malformed settings raise ValueError.
        """
        if not self.path.exists():
            return ''
        return json.loads(self.path.read_text()).get('api_key', '')

    def status(self):
        """Return redacted configuration. Pre: readable settings; post: no secret returned."""
        return {'configured': bool(self.key()), 'provider': 'OpenAlex'}

    def save(self, data):
        """Replace or clear key atomically. Pre: api_key string; post: mode 0600 settings.
        ValueError rejects invalid keys; filesystem failures propagate, never returning the key.
        """
        if not isinstance(data, dict) or set(data) != {'api_key'} or not isinstance(data['api_key'], str):
            raise ValueError('Provide api_key; an empty string clears it.')
        key = data['api_key'].strip()
        if not key.isascii() or len(key) > 512 or any(c.isspace() or ord(c) < 32 for c in key):
            raise ValueError('Invalid API key.')
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, name = tempfile.mkstemp(dir=self.path.parent, prefix='.openalex-')
        try:
            with os.fdopen(fd, 'w') as out:
                json.dump({'api_key': key}, out)
                out.flush()
                os.fsync(out.fileno())
            os.replace(name, self.path)
        finally:
            if os.path.exists(name):
                os.unlink(name)
        return self.status()

    def search(self, data):
        """Find up to five works by DOI or query. Pre: explicit query; post: public metadata.
        Uses only api.openalex.org, bounded response/time, no retries or source writes.
        Network/auth/rate errors become sanitized ValueErrors without credentials.
        """
        if not isinstance(data, dict):
            raise ValueError('Expected a JSON object.')
        query = data.get('query')
        if not isinstance(query, str) or not 1 <= len(query.strip()) <= 1000:
            raise ValueError('Enter a title or DOI (1–1000 characters).')
        query = query.strip()
        doi = re.sub(r'^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)', '', query, flags=re.I)
        exact = bool(re.fullmatch(r'10\.\d{4,9}/\S+', doi))
        path = '/works/' + quote('https://doi.org/' + doi, safe='') if exact else '/works?' + urlencode({'search': query, 'per_page': 5})
        headers = {'Accept': 'application/json', 'User-Agent': 'ResearchDesk/1.0'}
        key = self.key()
        if key:
            headers['Authorization'] = 'Bearer ' + key
        try:
            with build_opener(NoRedirect()).open(Request('https://api.openalex.org' + path, headers=headers), timeout=20) as response:
                raw = response.read(2_000_001)
            if len(raw) > 2_000_000:
                raise ValueError('OpenAlex response exceeds the size limit.')
            payload = json.loads(raw)
        except HTTPError as exc:
            if exc.code == 404:
                return {'works': [], 'lookup': 'doi' if exact else 'search'}
            messages = {401: 'OpenAlex rejected the API key. Update Settings.', 403: 'OpenAlex access denied. Check key activation in Settings.', 429: 'OpenAlex rate limit reached. Try again later.'}
            raise ValueError(messages.get(exc.code, 'OpenAlex request failed. Try again later.')) from None
        except (URLError, TimeoutError, OSError, json.JSONDecodeError):
            raise ValueError('OpenAlex is unavailable or returned an invalid response.') from None
        if not isinstance(payload, dict) or (not exact and not isinstance(payload.get('results'), list)):
            raise ValueError('OpenAlex returned an invalid response.')
        works = [payload] if exact else payload['results']
        return {'works': [self.work(w) for w in works[:5] if isinstance(w, dict)], 'lookup': 'doi' if exact else 'search'}

    @staticmethod
    def work(work):
        """Select comparison fields. Pre: API work; post: compact metadata, safe OpenAlex ID link.
        Missing provider fields remain empty and cannot count as verified.
        """
        identifier = work.get('id') or ''
        if not re.fullmatch(r'https://openalex\.org/W\d+', identifier):
            identifier = ''
        bib = work.get('biblio') or {}
        first, last = bib.get('first_page') or '', bib.get('last_page') or ''
        return {'url': identifier, 'title': work.get('display_name') or '', 'doi': work.get('doi') or '',
                'year': str(work.get('publication_year') or ''),
                'authors': [(a.get('author') or {}).get('display_name', '') for a in work.get('authorships', [])],
                'venue': (((work.get('primary_location') or {}).get('source') or {}).get('display_name') or ''),
                'volume': bib.get('volume') or '', 'number': bib.get('issue') or '',
                'pages': first + ('--' + last if last and last != first else '')}

    def check(self, data):
        """Compare one unambiguous BibTeX key to candidates. Pre: explicit text/key; post: no edits.
        DOI lookup is exact; title search always needs human match review. Missing fields and
        author-name formatting remain visible. ValueError rejects absent/duplicate keys.
        """
        matches = [e for e in entries(data) if e['key'] == data.get('key')]
        if len(matches) != 1:
            raise ValueError('Select a unique bibliography key.')
        entry = matches[0]
        fields = entry['fields']
        query = fields.get('doi') or fields.get('title')
        if not query:
            raise ValueError('This reference needs a DOI or title before lookup.')
        result = self.search({'query': query})
        for work in result['works']:
            comparisons = []
            for field in ('title', 'doi', 'year', 'authors', 'venue', 'volume', 'number', 'pages'):
                local = ' and '.join(entry['authors']) if field == 'authors' else (fields.get('journal') or fields.get('booktitle') or '') if field == 'venue' else fields.get(field, '')
                remote = ' and '.join(work['authors']) if field == 'authors' else work[field]
                a, b = normalized(local), normalized(remote)
                state = 'missing locally' if not a else 'unavailable in OpenAlex' if not b else 'matches' if a == b else 'review'
                if field == 'authors' and a and b and a != b:
                    state = 'review names/order'
                comparisons.append({'field': field, 'local': local, 'openalex': remote, 'status': state})
            work['comparison'] = comparisons
            work['title_similarity'] = round(difflib.SequenceMatcher(None, normalized(fields.get('title', '')), normalized(work['title'])).ratio(), 3)
        return {**result, 'entry': entry, 'warning': 'OpenAlex metadata can be incomplete or incorrect. Confirm the work identity and review differences; no entries were changed.'}

    def diagnose(self, data):
        """Produce conservative inline diagnostics for one complete bibliography entry.

        @param data: Submitted text and unique key, as accepted by check().
        @pre: Local authentication is enforced by the caller; entry has a DOI or title.
        @post: No files change; field warnings require an exact DOI or distinct title match.
        @return: Match state and warnings with code-point source ranges and provider links.
        @throws ValueError: Invalid/duplicate key, invalid input, or provider failure.
        """
        result = self.check(data)
        entry, works = result['entry'], result['works']

        def warning(code, message, field=None, work=None):
            """Build a source diagnostic without trusting provider offsets.

            @param code: Stable suppression rule. @param message: Plain warning text.
            @param field: Optional local field. @param work: Optional matched work.
            @pre: Entry ranges were produced by the local parser.
            @post: No state changes. @return: JSON-compatible warning record.
            @throws KeyError: Parser omitted required range metadata.
            """
            location = entry['field_ranges'].get(field, {})
            return {'code': code, 'field': field, 'key': entry['key'], 'message': message,
                    'start': location.get('start', entry['key_start']),
                    'end': location.get('end', entry['key_end']),
                    'url': (work or {}).get('url', '')}

        if not works:
            return {'state': 'not-found', 'warnings': [warning('openalex-not-found',
                    'No OpenAlex match found. This reference may still be valid.')]}
        ranked = sorted(works, key=lambda work: work['title_similarity'], reverse=True)
        candidate = ranked[0]
        doi = normalized(entry['fields'].get('doi', ''))
        identified = (bool(doi) and doi == normalized(candidate.get('doi', ''))) if result['lookup'] == 'doi' else (
            candidate['title_similarity'] >= 0.94 and
            (len(ranked) == 1 or candidate['title_similarity'] - ranked[1]['title_similarity'] >= 0.05))
        if not identified:
            return {'state': 'uncertain', 'warnings': [warning('openalex-identity',
                    'OpenAlex could not identify this work confidently. Review the candidate before comparing fields.', work=candidate)]}
        warnings = []
        for comparison in candidate['comparison']:
            if not comparison['status'].startswith('review'):
                continue
            field, local, remote = comparison['field'], comparison['local'], comparison['openalex']
            if field == 'authors':
                # BibTeX commonly uses “Family, Given”; OpenAlex uses “Given Family”.
                if len(entry['authors']) == len(candidate['authors']) and all(
                        sorted(re.findall(r'\w+', a.casefold())) == sorted(re.findall(r'\w+', b.casefold()))
                        for a, b in zip(entry['authors'], candidate['authors'])):
                    continue
            local_field = 'author' if field == 'authors' else (
                'journal' if 'journal' in entry['fields'] else 'booktitle') if field == 'venue' else field
            location = entry['field_ranges'].get(local_field)
            expression = data['text'][location['start']:location['end']].strip() if location else ''
            # Unexpanded BibTeX macros cannot be compared to provider strings reliably.
            if expression and not (expression.startswith(('{', '"')) or expression.isdigit()):
                continue
            warnings.append(warning('openalex-' + field,
                f'Possible {field} mismatch: bibliography “{local}”; OpenAlex “{remote}”.', local_field, candidate))
        return {'state': 'matched', 'warnings': warnings}


def normalized(value):
    """Normalize typography for comparison. Pre: metadata text; post: punctuation/case ignored.
    DOI URL prefixes are removed; this is comparison, never source rewriting.
    """
    value = re.sub(r'https?://(?:dx\.)?doi\.org/|^doi:\s*', '', str(value), flags=re.I)
    return ''.join(c for c in unicodedata.normalize('NFKD', value).casefold() if c.isalnum())
