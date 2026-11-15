"""Malformed build requests must fail before compilation or version creation."""
import json
import unittest
from unittest.mock import patch

import http_fixture
from test_editor import sample_pdf


class BuildRequestValidationTests(unittest.TestCase):
    setUp = http_fixture.setup
    tearDown = http_fixture.teardown

    def test_slow_routes_require_json_objects_before_any_build(self):
        """Pre: active fixture PDF; post: malformed requests return 400 without running a build.
        Exercises real handler dispatch, catching disconnect-causing AttributeError regressions.
        """
        doc = self.project.import_pdf('validation.pdf', sample_pdf())
        draft = self.base + '/' + doc['id'] + '/draft/'
        before = self.project.index_path.read_bytes()
        for action in ('compile-active', 'promote', 'compile', 'no-figures'):
            for value in (['invalid'], [], None, False, 12, 'invalid'):
                with self.subTest(action=action, value=value):
                    with patch.object(self.project.drafts, 'compile') as compile_paper, \
                         patch.object(self.project.drafts, 'compile_active_file') as compile_file, \
                         patch.object(self.project.drafts, 'compile_no_figures') as no_figures, \
                         patch.object(self.project.drafts, 'promote') as promote:
                        code, raw = http_fixture.request(self, 'POST', draft + action, json.dumps(value).encode())
                        self.assertEqual(code, 400, raw)
                        self.assertEqual(json.loads(raw)['error'], 'Send a JSON object.')
                        for operation in (compile_paper, compile_file, no_figures, promote):
                            operation.assert_not_called()
        self.assertEqual(self.project.index_path.read_bytes(), before)
