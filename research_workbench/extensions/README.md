# Trusted extension metadata

`filetypes.py` implements `FileHandler`, `FileHandlerRegistry`, `load_registry` and
the built-in `handlers` registry. The root `file_handlers.py` only re-exports this
public interface for compatibility. File-type identities and permissions have one
inert source: [extensions/filetypes.json](../../extensions/filetypes.json).

## Add a type

Follow the [catalog guide](../../extensions/README.md). Add metadata there when
using an existing text/source/PDF/image adapter; no route or explorer edits are
needed. New executable behavior belongs in an authored adapter and explicit browser
composition. The backend remains authoritative for actual file permissions.

`load_registry(path)` builds a new registry and rejects unsupported versions,
duplicates or capabilities that contradict permissions. `register(handler,
descriptor=None)` supports programmatic trusted contributions. `resolve(name)`
returns an immutable permission value; `catalog()` returns a detached browser-safe
snapshot. Browser metadata never grants a server permission.

Run `python3 tests/run_inprocess.py` and `node tests/test_filetype_catalog.mjs`.
`tests/test_modular_contracts.py` proves a fixture `.notes` type can read/save
through the existing production routes without adding a new handler.
