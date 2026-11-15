"""Run the regression suite without opening listening sockets.

Uses the same HTTP handlers, authorization, serialization and assertions as the
normal suite. Socket transport itself still requires the normal unittest run.
"""
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / 'tests')]
import http_fixture
import test_editor


def main():
    """Run existing tests with only the transport fixture replaced.

    @param: None; run this script from any directory.
    @pre: Normal test dependencies are installed.
    @post: Temporary test projects are removed; user settings are untouched.
    @return: Zero for success, one for failing assertions.
    @throws: Import or test-discovery errors.
    """
    with patch.object(test_editor.EditorTests, 'setUp', http_fixture.setup), \
            patch.object(test_editor.EditorTests, 'tearDown', http_fixture.teardown), \
            patch.object(test_editor.EditorTests, 'request', http_fixture.request):
        suite = unittest.defaultTestLoader.discover(str(ROOT / 'tests'))
        return 0 if unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful() else 1


if __name__ == '__main__':
    sys.exit(main())
