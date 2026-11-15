"""Exact source IO and atomic publication, shared by settings and draft storage."""
import hashlib
import json
import os
from pathlib import Path
import tempfile

from research_workbench.domain.errors import SourceError

def atomic_write(path, data, *, create_parents=True):
    """Publish complete bytes with a same-directory atomic replacement.

    @param path: Validated filesystem target, route path or schema location as described above.
    @param data: Complete validated payload or immutable input bytes.
    @param create_parents: Whether missing parent directories may be created.
    @pre Inputs satisfy the operation description; dependencies are initialized.
    @post Target is replaced after flush/fsync; temporary files are cleaned on failure.
    @return None
    @throws OSError: Directory, write, replace or cleanup failure.
    """
    path = Path(path)
    if create_parents:
        path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix='.' + path.name, dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def json_bytes(data):
    """Serialize a JSON value for durable, readable storage.

    @param data: Complete validated payload or immutable input bytes.
    @pre Inputs satisfy the operation description; dependencies are initialized.
    @post Input is unchanged; nonfinite numbers are rejected.
    @return bytes: UTF-8 JSON
    @throws ValueError,TypeError: Unsupported or nonfinite JSON values.
    """
    return json.dumps(data, ensure_ascii=False, allow_nan=False, indent=2).encode('utf-8')


def read_src(path):
    """Read exact UTF-8 source without newline translation.

    @param path: Validated filesystem target, route path or schema location as described above.
    @pre Inputs satisfy the operation description; dependencies are initialized.
    @post Source bytes are unchanged.
    @return str: Exact decoded source
    @throws SourceError: Non-UTF-8 content; OSError: Read failure.

    Read a source file exactly (no newline translation).
    """
    try:
        return Path(path).read_bytes().decode('utf-8')
    except UnicodeDecodeError:
        raise SourceError(f'{Path(path).name} is not UTF-8 text; it is skipped.')


def write_src(path, text):
    """Atomically replace source text while retaining existing permissions.

    @param path: Validated filesystem target, route path or schema location as described above.
    @param text: Exact Unicode source/message; newline spelling is significant.
    @pre Inputs satisfy the operation description; dependencies are initialized.
    @post UTF-8 bytes replace the source; existing file mode is restored.
    @return None
    @throws OSError,UnicodeError: Publication, encoding or mode failure.
    """
    path = Path(path)
    mode = path.stat().st_mode & 0o7777 if path.exists() else None
    atomic_write(path, text.encode('utf-8'))
    if mode is not None:
        os.chmod(path, mode)


def sha(text):
    """Calculate an optimistic revision for exact source text.

    @param text: Exact Unicode source/message; newline spelling is significant.
    @pre Inputs satisfy the operation description; dependencies are initialized.
    @post Input is unchanged.
    @return str: SHA-256 hex digest
    @throws TypeError,AttributeError: Non-string text.
    """
    return hashlib.sha256(text.encode('utf-8')).hexdigest()



def atomic_existing(path, data):
    """Publish a managed file without silently creating missing directories.

    @param path,data: Validated target in an existing parent and complete bytes.
    @pre Caller holds the owning mutation lock and validated confinement.
    @post Target is atomically replaced or retains old bytes; parents are unchanged.
    @return None. @throws OSError: Missing parent or failed publication.
    """
    return atomic_write(path, data, create_parents=False)
