# Domain rules and shared contracts

This directory imports no transport, project persistence, filesystem or subprocess
implementations. Its output can be exercised without a running editor.

| Module | Public operations |
| --- | --- |
| `bibliography.py` | `parse_bib`, `cite_uses`, `bib_declared`, `strip_comments` |
| `review.py` | `word_changes`, `relocate`, `line_of` |
| `comments.py` | `create_comment` produces normalized message records |
| `schemas.py` | `CREATE_SCHEMA`, `DIRECTORY_SCHEMA`, `SCOPE`, `validate` |
| `pdf.py` | `MAX_PDF`, `valid_pdf` |
| `errors.py` | `SourceError`, `ConflictError` shared across owners/transports |

## Add a rule

Implement a deterministic operation over explicit input values, return a fresh
result, and document inputs, preconditions, mutation, result and exceptions. Keep
underscore helpers private to this implementation. Cross-language source ranges
are Unicode code points, not JavaScript UTF-16 offsets. Comments normalize author
and time metadata at creation; existing records are never mutated by that factory.

New shared request fields belong in a schema here when HTTP clients need
them. Validation is an interface check; data-specific invariants remain with the
owning operation. Preserve existing request shapes and error behavior unless the
change deliberately versions that contract.

Use synthetic parser/diff/anchor cases in `tests/test_drafts.py`, schema/markup
checks in `tests/test_markup.py`, and the public extension tests in
`tests/test_modular_contracts.py`. `python3 tools/check.py --architecture` prohibits
IO dependencies in this directory. Historical imports from `drafts` and `markup`
remain compatibility exports, not the preferred location for new code.
