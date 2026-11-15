# Filesystem and startup-lock adapters

`project_storage.metadata_directory(root)` owns the `.research-workbench/` name
and automatically renames previous metadata storage intact. Conflicting directories,
symlinks and non-directory metadata paths are refused without merging or deleting.
`PRIVATE_METADATA_DIRECTORIES` covers both generations for source-publishing guards.

`storage.atomic_write(path, bytes, create_parents=True)` writes a same-directory
temporary file, flushes/fsyncs, then replaces the target and cleans the temporary
file. `atomic_existing` requires the parent to exist. `read_src` preserves UTF-8
and newline spelling; `write_src` retains an existing file's permission mode.
`json_bytes` rejects nonfinite JSON; `sha` creates exact text revisions.

## Add storage behavior

Keep confinement and permissions with the owning public operation. These primitives
do not make an arbitrary caller-supplied path safe. Validate the authorized root,
managed paths and symlinks before calling them. Specify parent creation explicitly.
Never silently recover from a partial write by reporting success. Document mode,
newline, durability and cleanup effects in every method contract.

Tests must use temporary directories, assert original bytes survive failed replace,
check revision/mode/newline behavior and avoid real project settings. Existing
`tests/test_file_handlers.py`, `test_project_entries.py` and project-removal tests
exercise these adapters through public application/transport operations.


`artifacts.publish_artifacts` stages build outputs and backup copies before replacing
published artifacts. Required files and symlinks are validated first; absent optional
outputs remove stale published copies. A failed replacement restores prior files;
failed recovery retains backups instead of deleting the recovery evidence.

`latex_artifacts.LatexArtifacts` owns generated-output classification used by explorer
and source ZIP export. It inspects existing entry types without changing any files.
The root module of the same name is a compatibility import only.
