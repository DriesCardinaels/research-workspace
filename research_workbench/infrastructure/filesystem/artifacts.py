"""Stage complete build artifacts and restore prior publications on write failure."""
from pathlib import Path
import os
import shutil
import tempfile


def publish_artifacts(source, destination, names, *, optional=()):
    """Publish a build artifact set with rollback for a failed replacement.

    @param source,destination,names: Isolated output, authorized publication folder and basenames.
    @param optional: Declared optional files; missing optional artifacts remove stale publications.
    @pre Caller validated paths and owns the publication lock; build completed successfully.
    @post Existing artifacts survive a staging/publication failure; temporary files are cleaned.
    @return None. @throws OSError: Publication/rollback failed. If rollback fails, staged backups remain.
    This provides per-file atomic replacement and failure rollback, not crash-atomic directory swaps.
    """
    source, destination = Path(source), Path(destination)
    names = tuple(names)
    if (not names or len(set(names)) != len(names) or not set(optional).issubset(names)
            or any(not isinstance(name, str) or not name or Path(name).name != name
                   or name in ('.', '..') or '\\' in name for name in names)):
        raise ValueError('Artifact names must be unique safe basenames.')
    if source.is_symlink() or destination.is_symlink():
        raise ValueError('Build artifact directories cannot be symbolic links.')
    for name in names:
        if (source / name).is_symlink() or (destination / name).is_symlink():
            raise ValueError('Build artifacts cannot be symbolic links.')
        if name not in optional and not (source / name).is_file():
            raise FileNotFoundError('Successful build did not produce ' + name)
    destination.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix='.publication-', dir=destination))
    changed, previous, retain = [], set(), False
    try:
        selected = [name for name in names if (source / name).is_file()]
        for name in names:
            if name in selected:
                shutil.copyfile(source / name, stage / ('new-' + name))
            if (destination / name).exists():
                shutil.copyfile(destination / name, stage / ('old-' + name))
                previous.add(name)
        try:
            for name in names:
                if name in selected:
                    os.replace(stage / ('new-' + name), destination / name)
                    changed.append(name)
                elif name in previous:
                    (destination / name).unlink()
                    changed.append(name)
        except Exception:
            try:
                for name in reversed(changed):
                    if name in previous:
                        os.replace(stage / ('old-' + name), destination / name)
                    else:
                        (destination / name).unlink(missing_ok=True)
            except Exception as error:
                retain = True
                raise OSError('Artifact restoration failed; recovery copies remain at ' + str(stage)) from error
            raise
    finally:
        if not retain:
            shutil.rmtree(stage)
