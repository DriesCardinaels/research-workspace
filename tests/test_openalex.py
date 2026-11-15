"""Bibliography settings, read-only checks, transport limits and authentication."""
import io
import json
import os
from urllib.error import HTTPError
import unittest
from unittest.mock import patch, MagicMock

import http_fixture
from openalex import OpenAlex, entries

WORK = {'id':'https://openalex.org/W123', 'display_name':'A Known Paper', 'doi':'https://doi.org/10.1234/example',
        'publication_year':2026, 'authorships':[{'author':{'display_name':'Jane Doe'}}],
        'primary_location':{'source':{'display_name':'Journal'}}, 'biblio':{'volume':'2','issue':'3','first_page':'10','last_page':'20'}}
BIB = '@article{k, title={A {Known} Paper}, author={Jane Doe}, year={2025}, doi={10.1234/example}, journal={Journal}, volume={2}, number={3}, pages={10--20}}'


class OpenAlexTests(unittest.TestCase):
    setUp = http_fixture.setup
    tearDown = http_fixture.teardown
    request = http_fixture.request

    def api(self, method, path, data=None, expected=200, **kwargs):
        """Exercise real HTTP handler. Pre: fixture; post: decoded status-checked response."""
        code, raw = self.request(method, path, data, **kwargs)
        self.assertEqual(code, expected, raw)
        return json.loads(raw)

    def test_private_settings_roundtrip_clear_and_auth(self):
        """Keys persist privately, are redacted, and mutations require local authentication."""
        url='/api/settings/openalex'
        self.assertFalse(self.api('GET',url)['configured'])
        self.api('PUT',url,{'api_key':'secret'},expected=403,token=False)
        result=self.api('PUT',url,{'api_key':'secret'})
        self.assertNotIn('secret',json.dumps(result))
        self.assertEqual(os.stat(self.app.openalex.path).st_mode & 0o777,0o600)
        self.assertTrue(OpenAlex(self.app.openalex.path).status()['configured'])
        self.api('PUT',url,{'api_key':'bad\nkey'},expected=400)
        self.api('PUT',url,{'api_key':'invalid-🔒'},expected=400)
        self.assertFalse(self.api('PUT',url,{'api_key':''})['configured'])

    def test_comparison_reports_each_field_and_preserves_source(self):
        """Exact DOI match does not imply all metadata matches; missing values remain explicit."""
        response=MagicMock();response.__enter__.return_value=io.BytesIO(json.dumps(WORK).encode())
        opener=MagicMock();opener.open.return_value=response
        self.app.openalex.save({'api_key':'private'})
        with patch('research_workbench.infrastructure.metadata.openalex.build_opener',return_value=opener):
            result=self.api('POST','/api/openalex/check',{'text':BIB,'key':'k'})
        request=opener.open.call_args.args[0]
        self.assertTrue(request.full_url.startswith('https://api.openalex.org/works/'))
        self.assertNotIn('private',request.full_url)
        self.assertEqual(request.get_header('Authorization'),'Bearer private')
        statuses={c['field']:c['status'] for c in result['works'][0]['comparison']}
        self.assertEqual(statuses['year'],'review')
        self.assertEqual(statuses['title'],'matches')
        self.assertEqual(statuses['pages'],'matches')
        self.assertEqual(len(statuses),8)
        self.assertEqual(result['lookup'],'doi')
        self.assertFalse(self.project.documents())
        self.assertEqual(entries({'text':BIB})[0]['fields']['year'],'2025')

    def test_invalid_ambiguous_and_empty_entries_make_no_network_request(self):
        """Unsafe or ambiguous lookup inputs fail before external requests."""
        with patch('research_workbench.infrastructure.metadata.openalex.build_opener') as network:
            self.api('POST','/api/openalex/check',{'text':BIB+BIB,'key':'k'},expected=400)
            self.api('POST','/api/openalex/check',{'text':BIB,'key':'absent'},expected=400)
            self.api('POST','/api/openalex/search',{'query':''},expected=400)
            self.api('POST','/api/bibliography/entries',{'text':12},expected=400)
            network.assert_not_called()
        self.assertEqual(self.api('POST','/api/bibliography/entries',{'text':''}),{'entries':[]})

    def test_parser_keeps_nested_fields_and_ignores_commented_entries(self):
        """Only top-level fields/entries participate; parenthesis and escaped quotes are supported."""
        text = '% @article{fake,title={Ignore}}\n@comment{ @article{alsofake,title={Ignore}} }\n'
        text += '@article(real, title={A title with year = {wrong}}, year=2026, author="Doe, Jane", doi="10.1234/a")'
        parsed = entries({'text':text})
        self.assertEqual([e['key'] for e in parsed],['real'])
        self.assertEqual(parsed[0]['fields']['year'],'2026')
        self.assertEqual(parsed[0]['fields']['title'],'A title with year = wrong')

    def test_search_limits_and_errors_are_sanitized(self):
        """User queries cannot change host; provider errors cannot echo secrets or URLs."""
        response=MagicMock();response.__enter__.return_value=io.BytesIO(json.dumps({'results':[WORK]*9}).encode())
        opener=MagicMock();opener.open.return_value=response
        with patch('research_workbench.infrastructure.metadata.openalex.build_opener',return_value=opener):
            result=self.api('POST','/api/openalex/search',{'query':'https://evil.invalid/?api_key=hello'})
        self.assertEqual(len(result['works']),5)
        self.assertTrue(opener.open.call_args.args[0].full_url.startswith('https://api.openalex.org/works?search='))
        for code in (401,403,429,500):
            opener.open.side_effect=HTTPError('https://private.invalid/secret',code,'secret',{},None)
            with patch('research_workbench.infrastructure.metadata.openalex.build_opener',return_value=opener):
                result=self.api('POST','/api/openalex/search',{'query':'paper'},expected=400)
            self.assertNotIn('secret',json.dumps(result))

    def test_diagnostics_flag_year_at_the_source_value_without_a_key(self):
        """A DOI identity permits field warnings; family/given order is not a mismatch."""
        bib = BIB.replace('author={Jane Doe}', 'author={Doe, Jane}')
        response = MagicMock()
        response.__enter__.return_value = io.BytesIO(json.dumps(WORK).encode())
        opener = MagicMock()
        opener.open.return_value = response
        with patch('research_workbench.infrastructure.metadata.openalex.build_opener', return_value=opener):
            result = self.api('POST', '/api/openalex/diagnose', {'text': bib, 'key': 'k'})
        self.assertIsNone(opener.open.call_args.args[0].get_header('Authorization'))
        self.assertEqual(result['state'], 'matched')
        self.assertEqual([w['code'] for w in result['warnings']], ['openalex-year'])
        warning = result['warnings'][0]
        self.assertEqual(bib[warning['start']:warning['end']], '{2025}')
        self.assertIn('2026', warning['message'])
        self.assertEqual(warning['url'], WORK['id'])

    def test_diagnostics_distinguish_missing_and_uncertain_work_identity(self):
        """Weak/ambiguous searches never manufacture field-level year mismatches."""
        bib = BIB.replace(', doi={10.1234/example}', '')
        candidate = OpenAlex.work({**WORK, 'display_name': 'An Entirely Different Study'})
        for works, expected, code in [([], 'not-found', 'openalex-not-found'),
                                      ([candidate], 'uncertain', 'openalex-identity'),
                                      ([OpenAlex.work(WORK)] * 2, 'uncertain', 'openalex-identity')]:
            with patch.object(self.app.openalex, 'search', return_value={'lookup': 'search', 'works': works}):
                result = self.api('POST', '/api/openalex/diagnose', {'text': bib, 'key': 'k'})
            self.assertEqual(result['state'], expected)
            self.assertEqual([w['code'] for w in result['warnings']], [code])

    def test_diagnostics_accept_distinct_title_match_and_do_not_flag_missing_remote_fields(self):
        """A strong unique title match can flag year, while unavailable fields stay unverified."""
        bib = BIB.replace(', doi={10.1234/example}', '')
        work = OpenAlex.work({**WORK, 'biblio': {}})
        with patch.object(self.app.openalex, 'search', return_value={'lookup': 'search', 'works': [work]}):
            result = self.api('POST', '/api/openalex/diagnose', {'text': bib, 'key': 'k'})
        self.assertEqual(result['state'], 'matched')
        self.assertEqual([w['code'] for w in result['warnings']], ['openalex-year'])

    def test_parser_ranges_preserve_unicode_crlf_and_duplicate_occurrences(self):
        """Each duplicate and field has its own code-point range in the original source."""
        text = '% 😀 comment\r\n' + BIB + '\r\n' + BIB
        parsed = self.api('POST', '/api/bibliography/entries', {'text': text})['entries']
        self.assertEqual(len(parsed), 2)
        self.assertNotEqual(parsed[0]['start'], parsed[1]['start'])
        for entry in parsed:
            self.assertEqual(text[entry['start']:entry['end']], BIB)
            self.assertEqual(text[entry['key_start']:entry['key_end']], 'k')
            location = entry['field_ranges']['year']
            self.assertEqual(text[location['start']:location['end']], '{2025}')

    def test_inter_field_comments_cannot_close_a_record_or_create_entries(self):
        """Comment punctuation cannot corrupt source positions or inject phantom references."""
        text = '@article{k, % } @book{fake,\n title={Known}, year={2025}}'
        parsed = entries({'text': text})
        self.assertEqual([entry['key'] for entry in parsed], ['k'])
        location = parsed[0]['field_ranges']['year']
        self.assertEqual(text[location['start']:location['end']], '{2025}')

    def test_unexpanded_macros_do_not_receive_false_metadata_mismatch_warnings(self):
        """A bare macro is unresolved source, not a contradictory publication year."""
        bib = BIB.replace('year={2025}', 'year=publicationYear')
        with patch.object(self.app.openalex, 'search', return_value={'lookup': 'doi', 'works': [OpenAlex.work(WORK)]}):
            result = self.api('POST', '/api/openalex/diagnose', {'text': bib, 'key': 'k'})
        self.assertEqual(result['state'], 'matched')
        self.assertEqual(result['warnings'], [])

    def test_diagnostics_auth_and_input_errors_make_no_provider_request(self):
        """Background checking retains the existing mutation authorization and validation."""
        with patch('research_workbench.infrastructure.metadata.openalex.build_opener') as network:
            self.api('POST', '/api/openalex/diagnose', {'text': BIB, 'key': 'k'}, expected=403, token=False)
            self.api('POST', '/api/openalex/diagnose', {'text': BIB + BIB, 'key': 'k'}, expected=400)
            self.api('POST', '/api/openalex/diagnose', {'text': ''}, expected=400)
            network.assert_not_called()
