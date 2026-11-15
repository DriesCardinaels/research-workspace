# Project and session ownership

`projects.Project` owns project files, immutable PDF versions and its private
library index. `sessions.App` owns durable project registration, cached sessions,
settings, session token and the application lock. Neither imports HTTP handlers.

## Add an application operation

1. Put project content/version behavior on `Project`; put registration/session
   behavior on `App`. Keep request decoding/status codes in transport modules.
2. Accept exact IDs and expected revisions. Validate before external writes and
   preserve existing archived-version, path and conflict checks.
3. Use `index_snapshot()` to prepare a transaction and `commit(snapshot)` to publish
   it. `commit` copies its input and restores old memory if atomic publication fails.
   `folders()`, `documents()`, `versions()` and `doc()` return detached values.
   The legacy `index` property is also a snapshot; editing it does not persist.
4. Cross-module operations must not mutate index dictionaries or use private
   methods. `ProjectEntries` uses `relocate_entries` to coordinate rename rollback.
5. Hold the application lock for a short metadata transaction. Long Git/TeX work
   must retain existing per-project locks while releasing the application lock.
6. Document failure preservation and test through the public operation/HTTP fixture.

Metadata uses `.research-workbench/`, with automatic migration of previous storage.
Formats, stable UUIDs and existing v1 index backups remain unchanged. `persist()` is an owner operation, not a way to publish edits to
an external snapshot. Use `commit` for explicitly prepared transactions.

Source/review state belongs to `drafts.py`, with registered build execution in
[builds/](builds/README.md), version/build transactions in `draft_operations.py` and
source mapping in `source_mapping.py`. Root modules are compatibility imports;
production package code does not depend on them. Further UI/review extraction is tracked in
[the status document](../../docs/MIGRATION_STATUS.md). Tests belong in
`tests/test_projects.py`, `test_editor.py`, `test_project_entries.py` and
`test_modular_contracts.py`.


| Owner | Implementation |
| --- | --- |
| Draft review state and Git-source linkage | `drafts.py` |
| Incremental markup and annotation merging | `review.py` |
| Directory import transaction | `imports.py` |
| Confined explorer operations | `entries.py` |
| Repository destination and explicit push workflow | `repository.py` |
| Source-only compile/link workflow | `standalone.py` |
| Source archive snapshot/export | `source_archive.py` |

Server shutdown joins HTTP request threads before `App.close()` releases loaded
projects' isolated preview directories. Persistent project files, version history
and linked sources are retained. `Drafts.close()` refuses cleanup while a build lock
is active; callers must respect the shutdown precondition.
