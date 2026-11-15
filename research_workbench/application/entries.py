"""Confined filesystem operations for the project explorer (Python standard library)."""
from pathlib import Path
import shutil
import subprocess
import sys
import uuid


class ProjectEntries:
    """Keep disk entry mutations separate from virtual paper collections."""

    def __init__(self, project, conflict):
        """@param project,conflict: Owning project and HTTP conflict exception type.
        @pre Authorized caller. @post Service retains dependencies only.
        @return None. @throws None.
        """
        self.project, self.conflict = project, conflict

    def resolve(self, path, source_document=None, directory=False):
        """@param path,source_document,directory: Relative entry, linked owner, root permission.
        @pre Project loaded. @post Returns confined path without following symlinks.
        @return (root, entry). @throws ValueError,FileNotFoundError: Unsafe or missing entry.
        """
        root = self.project.root
        if source_document is not None:
            if not isinstance(source_document, str) or not source_document:
                raise ValueError('Choose a linked source document.')
            doc = self.project.doc(source_document)
            self.project.require_active(doc)
            cfg, _ = self.project.drafts.require(doc)
            root = cfg['root_path']
        reserved = {'versions', 'originals', 'annotated', 'node_modules', '__pycache__'}
        if (not isinstance(path, str) or (not path and not directory)
                or '\\' in path or Path(path).is_absolute()
                or any(not p or p.startswith('.') or p.casefold() in reserved
                       or p != p.strip() or any(ord(c) < 32 for c in p)
                       for p in path.split('/') if path)):
            raise ValueError('Choose a visible relative path outside managed data.')
        target = root
        for part in Path(path).parts:
            target /= part
            if target.is_symlink():
                raise ValueError('Symbolic links cannot be manipulated.')
        if not target.resolve().is_relative_to(root.resolve()):
            raise ValueError('Entry is outside the authorized root.')
        if not target.exists():
            raise FileNotFoundError('File or folder no longer exists.')
        if directory and not target.is_dir():
            raise ValueError('Move destination must be a folder.')
        return root, target

    def reveal(self, path='', source_document=None, document=None):
        """Reveal an authorized disk entry or managed PDF snapshot in macOS Finder.

        @param path,source_document,document: Relative entry, linked owner, or review PDF identity.
        @pre Authenticated request; project loaded. Empty path identifies its root.
        @post Finder selects the entry; files and project metadata remain unchanged.
        @return Dict confirming the revealed absolute path.
        @throws ValueError: Unsafe target, unsupported platform or Finder launch failure.
        @throws FileNotFoundError,OSError: Missing entry or unavailable system launcher.
        """
        if document is not None:
            if not isinstance(document, str) or not document or path or source_document is not None:
                raise ValueError('Choose one file or review document to reveal.')
            doc = self.project.doc(document)
            self.project.require_active(doc)
            target = self.project.path(doc, 'original')
            if not target.is_file():
                raise FileNotFoundError('Review PDF no longer exists.')
        else:
            _, target = self.resolve(path, source_document, directory=path == '')
        if sys.platform != 'darwin':
            raise ValueError('Show in Finder is available on macOS.')
        try:
            result = subprocess.run(['/usr/bin/open', '-R', str(target)],
                                    capture_output=True, timeout=10)
        except subprocess.TimeoutExpired:
            raise ValueError('Finder did not respond in time.')
        if result.returncode:
            raise ValueError('Could not show this entry in Finder.')
        return {'revealed': True, 'path': str(target)}

    def change(self, path, operation, destination=None, source_document=None):
        """Move/rename an entry or retain a deleted entry in private recovery storage.

        @param path,operation,destination,source_document: Source path, move/delete, full target, owner.
        @pre HTTP authorization and project mutation lock held.
        @post Move preserves contents; delete archives contents; collisions never overwrite.
        @return Operation and relative paths, plus recovery location for deletion.
        @throws ValueError: Unsafe paths, recursive moves or linked entry-point changes.
        @throws ConflictError: Destination occupied or compilation active.
        @throws FileNotFoundError,OSError: Missing entries or filesystem failure.
        Related: Project.tree refreshes the explorer after this service completes.
        """
        if operation not in ('move', 'delete'):
            raise ValueError('Choose move or delete.')
        if self.project.source_compile_lock.locked() or self.project.repository_lock.locked():
            raise self.conflict('Wait for compilation or repository synchronization to finish.', [])
        root, source = self.resolve(path, source_document)
        # Linked roots and configured entry points must remain valid for the review tools.
        for doc in self.project.documents():
            cfg = self.project.drafts.config(doc)
            if cfg and not cfg.get('error'):
                for protected in (cfg['root_path'], cfg['root_path'] / cfg['main']):
                    if protected == source or protected.is_relative_to(source):
                        raise ValueError('This entry contains a linked source root or main file. Change its source link first.')
        if operation == 'delete':
            trash = self.project.meta / 'trash'
            if trash.is_symlink():
                raise ValueError('Recovery directory cannot be a symbolic link.')
            trash.mkdir(exist_ok=True)
            recovery = trash / (uuid.uuid4().hex + '-' + source.name)
            shutil.move(str(source), str(recovery))
            return {'operation': operation, 'path': path, 'recovery_path': str(recovery)}
        if not isinstance(destination, str) or not destination or destination.endswith('/'):
            raise ValueError('Choose a destination filename.')
        parent, _, name = destination.rpartition('/')
        _, directory = self.resolve(parent, source_document, directory=True)
        if (not name.strip() or name != name.strip() or name.startswith('.') or '\\' in name
                or name.casefold() in {'versions', 'originals', 'annotated', 'node_modules', '__pycache__'}
                or any(ord(c) < 32 for c in name)):
            raise ValueError('Choose a visible filename outside managed data.')
        target = directory / name
        if source == target:
            return {'operation': operation, 'path': path, 'destination': destination}
        if target.is_relative_to(source):
            raise ValueError('A folder cannot be moved into itself or its descendants.')
        if any(p.name.casefold() == name.casefold() and p != source for p in directory.iterdir()):
            raise self.conflict('A file or folder with this name already exists.', [])
        source.rename(target)
        # Keep standalone PDF/source associations aligned with their new disk paths.
        try:
            if not source_document:
                self.project.relocate_entries(path, destination)
        except Exception:
            target.rename(source)
            raise
        return {'operation': operation, 'path': path, 'destination': destination}
