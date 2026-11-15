# Archived review workflow tests

Run `python3 -m unittest discover -s legacy/tests -v` from the repository root.
`test_review.py` imports the archived `review_core.py` and its form/flow configuration.
These tests are separate from the active application's `tests/` discovery.

For a legacy-only behavior change, add synthetic states with the existing
`fresh`, `put`, `ans` and assertion helpers; exercise public workflow evaluation
and persistence results. Keep fixtures deterministic, use temporary storage and
never read actual submitted manuscripts or review directories. Describe helper
pre/postconditions, parameters, results and exceptions. Do not import active
application internals into this archive.
