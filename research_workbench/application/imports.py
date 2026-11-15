"""Named, transactional local PDF directory imports (standard library only)."""
from research_workbench.domain.schemas import DIRECTORY_SCHEMA, validate

import copy
import os
from pathlib import Path
import shutil
import tempfile
import uuid



def import_directory(project, data):
    """Import a directory into one named collection, with one final index commit.
    Pre: App.lock held and explicit local path; post: PDFs/notes retained separately,
    or no index changes on failure. Duplicate behavior is explicit; symlinks are skipped.
    Validation/IO/conflict errors propagate; source files are never modified.
    """
    from research_workbench.application.projects import Project
    from research_workbench.domain.errors import ConflictError
    validate(data, DIRECTORY_SCHEMA)
    root = Path(data['folder_path']).expanduser()
    if not root.is_absolute() or root.is_symlink() or not root.is_dir():
        raise ValueError('Choose an absolute local directory, not a symbolic link.')
    root = root.resolve()
    name = data['collection_name'].strip()
    if not name:
        raise ValueError('Enter a collection name.')
    mode = data.get('duplicate_mode', 'error')
    candidates, skipped, seen, conflicts = [], [], set(), []
    total = scanned = 0
    def walk_error(error):
        """Abort unreadable directory scans instead of reporting an incomplete successful import."""
        raise error
    for parent, dirs, files in os.walk(root, followlinks=False, onerror=walk_error):
        dirs[:] = sorted(d for d in dirs if not d.startswith('.') and d not in ('originals', 'annotated', 'versions') and not (Path(parent) / d).is_symlink())
        for filename in sorted(files):
            scanned += 1
            if scanned > 20000:
                raise ValueError('Directory scanning is limited to 20,000 files. Choose a smaller folder.')
            path = Path(parent) / filename
            if filename.startswith('.') or path.is_symlink() or path.suffix.lower() != '.pdf':
                continue
            relative = str(path.relative_to(root))
            size = path.stat().st_size
            if size > 200 * 1024 * 1024:
                raise ValueError(relative + ': maximum PDF size is 200 MB.')
            matches = project.matches(filename)
            duplicate = bool(matches) or filename.casefold() in seen
            if duplicate and mode == 'error':
                conflicts.append({'path': relative, 'matches': matches})
            if duplicate and mode == 'skip':
                skipped.append({'path': relative, 'reason': 'matching filename'})
                continue
            seen.add(filename.casefold())
            total += size
            candidates.append((path, relative))
            if len(candidates) > 500 or total > 1024 * 1024 * 1024:
                raise ValueError('Import at most 500 PDFs and 1 GB per batch.')
        if data.get('recursive', True) is False:
            break
    if conflicts:
        raise ConflictError('Matching filenames found. Choose skip or separate explicitly; no files were imported.', conflicts)
    existing = next((f for f in project.folders() if f['name'].casefold() == name.casefold()), None)
    if not candidates:
        if skipped:
            return {'folder': existing, 'papers': [], 'skipped': skipped, 'imported': 0}
        raise ValueError('No PDFs were found in that directory.')
    folder = existing or {'id': uuid.uuid4().hex, 'name': name}
    moved = []
    with tempfile.TemporaryDirectory(prefix='.directory-import-', dir=project.meta) as temp:
        staged = Project(temp)
        initial = staged.index_snapshot()
        initial['folders'] = [folder]
        staged.commit(initial)
        papers = []
        for path, relative in candidates:
            if path.is_symlink() or not path.resolve().is_relative_to(root):
                raise ValueError('A PDF changed into a symbolic link during import.')
            doc = staged.import_pdf(path.name, path.read_bytes(), folder_id=folder['id'], separate=True)
            papers.append({**doc, 'imported_from': relative})
        try:
            for doc in papers:
                storage = project.versions_root / doc['id']
                notes = project.meta / (doc['id'] + '.json')
                if storage.exists() or notes.exists() or project.versions_root.is_symlink():
                    raise ValueError('Import storage changed. Retry the import.')
                os.rename(staged.versions_root / doc['id'], storage)
                moved.append(storage)
                os.rename(staged.path(doc, 'annotations'), notes)
                moved.append(notes)
            next_index = project.index_snapshot()
            if not existing:
                next_index['folders'].append(folder)
            next_index['documents'].extend(papers)
            project.commit(next_index)
        except Exception:
            for path in reversed(moved):
                if path.is_dir():
                    shutil.rmtree(path)
                else:
                    path.unlink(missing_ok=True)
            raise
    return {'folder': folder, 'papers': papers, 'skipped': skipped, 'imported': len(papers)}
