"""Project files, immutable document versions and atomic library-index ownership."""
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
import threading
import time
import uuid

from research_workbench.application.drafts import Drafts
from research_workbench.infrastructure.filesystem.latex_artifacts import LatexArtifacts
from research_workbench.application.review import merge_annotations
from research_workbench.domain.errors import ConflictError
from research_workbench.domain.pdf import MAX_PDF, valid_pdf
from research_workbench.extensions.filetypes import handlers as file_handlers
from research_workbench.infrastructure.filesystem.storage import atomic_existing as atomic, json_bytes
from research_workbench.infrastructure.filesystem.project_storage import metadata_directory

class Project:
    def __init__(self, folder, *, draft_factory=Drafts):
        """Initialize this owner and its documented dependencies.

        @param folder: Local project or destination directory.
        @param draft_factory: Public project => source/review owner constructor, default Drafts.
        @pre Caller owns the relevant mutation lock and has authorized the target.
        @post Managed directories and library state are loaded; supported legacy indexes are backed up before upgrade.
        @return None
        @throws ValueError,OSError: Invalid initial state or IO failure where initialization requires storage.
        """
        self.root = Path(folder).expanduser().resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.meta = metadata_directory(self.root)
        self.originals = self.root / 'originals'
        self.annotated = self.root / 'annotated'
        self.versions_root = self.root / 'versions'
        for p in (self.meta, self.originals, self.annotated, self.versions_root):
            if p.is_symlink():
                raise ValueError('Managed folders cannot be symbolic links.')
            p.mkdir(exist_ok=True)
        self.__draft_factory = draft_factory
        self.drafts = draft_factory(self)
        self.repository_lock = threading.Lock()
        self.source_compile_lock = threading.Lock()
        self.index_path = self.meta / 'library.json'
        if self.index_path.is_symlink():
            raise ValueError('The library index cannot be a symbolic link.')
        if self.index_path.exists():
            self.__index = json.loads(self.index_path.read_text())
            if self.__index.get('version') not in (1, 2) or not isinstance(self.__index.get('documents'), list):
                raise ValueError('Unsupported library format; existing files were kept.')
            if self.__index['version'] == 1:
                # Back up the exact old index before upgrading metadata only.
                backup = self.meta / ('library-v1-backup-' + uuid.uuid4().hex + '.json')
                with backup.open('xb') as f:
                    f.write(self.index_path.read_bytes())
                    f.flush()
                    os.fsync(f.fileno())
                for d in self.__index['documents']:
                    d.update(paper_id=d['id'], number=1, active=True, folder_id=None,
                             created=d.get('updated', time.time()))
                self.__index.update(version=2, folders=[])
                self.persist()
        else:
            self.__index = {'version': 2, 'documents': [], 'folders': []}
            self.persist()

    def file_path(self, rel, root=None):
        """Resolve an authorized existing project file.

        @param rel: Authorized relative source/project path.
        @param root: Optional explicitly authorized source root.
        @pre Caller owns the relevant mutation lock and has authorized the target.
        @post No file changes; symlink/traversal/managed paths are rejected.
        @return Path: Confined regular file
        @throws ValueError,FileNotFoundError,OSError: Unsafe or missing file.

        Resolve a project file. Pre: relative path; post: confined regular file.
        Raises ValueError for traversal/symlinks and FileNotFoundError when absent.
        Used by the tree opener; managed annotation and version files stay private.
        """
        if not isinstance(rel, str) or not rel or Path(rel).is_absolute():
            raise ValueError('Choose a relative project file.')
        parts = Path(rel).parts
        if not parts or any(x.startswith('.') or x == '..' for x in parts) or (root is None and parts[0] in ('versions', 'originals', 'annotated')):
            raise ValueError('That path is reserved or outside the project.')
        root = root or self.root
        path = root
        for part in parts:
            path = path / part
            if path.is_symlink():
                raise ValueError('Symbolic links cannot be opened from the project tree.')
        if not path.resolve().is_relative_to(root):
            raise ValueError('That file is outside the project.')
        if not path.is_file():
            raise FileNotFoundError('Project file not found.')
        return path

    def image_file(self, rel, source_document=None):
        """Read an explicitly registered image without creating a paper or altering its bytes.

        @param rel: Project-relative filename, or path within an authorized linked source root.
        @param source_document: Optional active linked paper identifying that root.
        @pre Caller holds the normal project read lock and passed host/origin checks.
        @post Files, annotations, Git and document/version records are unchanged.
        @return Tuple of exact image bytes and provider-declared MIME type.
        @throws ValueError: Unsupported format, signature mismatch, unsafe path or size above 50 MB.
        @throws FileNotFoundError/OSError: Missing/unreadable file or source configuration.
        """
        if not isinstance(rel, str) or not rel:
            raise ValueError('Choose a relative image file.')
        handler = file_handlers.resolve(rel)
        if not handler or not handler.preview_mime:
            raise ValueError('This file has no image preview provider.')
        root = None
        if source_document:
            cfg, _ = self.drafts.require(self.doc(source_document))
            root = cfg['root_path']
        path = self.file_path(rel, root)
        limit = 50 * 1024 * 1024
        if path.stat().st_size > limit:
            raise ValueError('Image previews must be at most 50 MB.')
        with path.open('rb') as source:
            raw = source.read(limit + 1)
        if len(raw) > limit or not raw.startswith(handler.preview_signature):
            raise ValueError('Image content does not match its format or exceeds 50 MB.')
        return raw, handler.preview_mime

    def text_file(self, rel, source_document=None, update=None):
        """Read or conflict-check and save an independently editable text file.

        @param rel: Relative path in the project or explicitly linked source root.
        @param source_document: Optional active paper identifying that source root.
        @param update: None for read; otherwise exact text and expected SHA object.
        @pre: Caller holds the application mutation lock; HTTP authorization succeeded.
        @post: Reads change nothing; successful writes replace only this file atomically.
        Linked LaTeX/BibTeX uses dedicated draft routes; standalone source remains editable.
        Review metadata and versions are unchanged by text saves.
        @return: File path, text and SHA for the saved snapshot.
        @throws ValueError: Invalid request, unsupported handler, encoding or path.
        @throws ConflictError: Stale SHA; FileNotFoundError: Missing target.
        @throws OSError: Read or atomic write failure; previous target remains on write failure.
        """
        if not isinstance(rel, str) or not rel:
            raise ValueError('Choose a relative text file.')
        handler = file_handlers.resolve(rel)
        if not handler or not handler.editable:
            raise ValueError('This file requires its dedicated editor or has no text handler.')
        root = None
        if source_document:
            if not isinstance(source_document, str):
                raise ValueError('Choose a linked source document.')
            cfg, _ = self.drafts.require(self.doc(source_document))
            root = cfg['root_path']
        path = self.file_path(rel, root)
        if handler.review:
            if source_document:
                raise ValueError('Use the linked draft editor to preserve review attribution.')
            for document in self.documents():
                cfg = self.drafts.config(document)
                if cfg and not cfg.get('error') and path.is_relative_to(cfg['root_path']):
                    raise ValueError('Use the linked draft editor to preserve review attribution.')
        if path.stat().st_size > 10 * 1024 * 1024:
            raise ValueError('Text files must be at most 10 MB.')
        raw = path.read_bytes()
        if b'\x00' in raw:
            raise ValueError('Binary files cannot be edited as text.')
        text = raw.decode('utf-8')
        digest = hashlib.sha256(raw).hexdigest()
        if update is not None:
            if (not isinstance(update, dict) or set(update) - {'path', 'source_document', 'text', 'sha'}
                    or not isinstance(update.get('text'), str) or not isinstance(update.get('sha'), str)):
                raise ValueError('Save requires text and the last read SHA.')
            if update['sha'] != digest:
                raise ConflictError('This file changed on disk. Your edits remain open; save was refused.', [])
            raw = update['text'].encode('utf-8')
            if len(raw) > 10 * 1024 * 1024 or b'\x00' in raw:
                raise ValueError('Save UTF-8 text without binary data, at most 10 MB.')
            # Existing draft helper preserves permissions while publishing a complete snapshot.
            from research_workbench.infrastructure.filesystem.storage import write_src
            write_src(path, update['text'])
            text = update['text']
            digest = hashlib.sha256(raw).hexdigest()
        return {'file': rel, 'text': text, 'sha': digest}

    def import_file(self, name, data, parent='', source_document=None):
        """Copy a file into the chosen project or linked-source directory without overwriting.

        @param name: Plain, visible filename; paths and reserved names are rejected.
        @param data: File bytes, at most 200 MB.
        @param parent,source_document: Existing relative destination and optional linked source owner.
        @pre: Project loaded and application mutation lock held.
        @post: One complete file is added; existing files and review data are retained.
        @return: Imported filename, relative path and file type for tree refresh.
        @throws ValueError: Invalid filename or size; ConflictError: name exists.
        @throws OSError: Staging or publication failed; no partial target is published.
        Related: tree() exposes imported files; open_pdf_file() creates PDF review versions when opened.
        """
        if (not isinstance(name, str) or not name.strip() or name.startswith('.')
                or '/' in name or '\\' in name or any(ord(c) < 32 for c in name)
                or name.casefold() in ('versions', 'originals', 'annotated', 'node_modules', '__pycache__')):
            raise ValueError('Choose a visible filename without directories or reserved names.')
        if not isinstance(data, bytes) or len(data) > MAX_PDF:
            raise ValueError('Maximum file size is 200 MB.')
        from research_workbench.application.entries import ProjectEntries
        _, directory = ProjectEntries(self, ConflictError).resolve(parent, source_document, directory=True)
        if name.lower().endswith('.pdf'):
            valid_pdf(data)
        target = directory / name
        if any(p.name.casefold() == name.casefold() for p in directory.iterdir()):
            raise ConflictError('A file with this name already exists. Rename it before importing.', [])
        fd, staged = tempfile.mkstemp(prefix='.import-', dir=directory)
        try:
            with os.fdopen(fd, 'wb') as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            try:
                os.link(staged, target)
            except FileExistsError:
                raise ConflictError('A file with this name already exists. Rename it before importing.', [])
        finally:
            os.unlink(staged)
        return {'name': name, 'path': str(Path(parent) / name), 'type': target.suffix.lower()[1:]}

    def create_entry(self, kind, name, parent='', source_document=None):
        """Create a real directory or initialize a file using its registered extension.

        @param kind: 'directory' or 'file'.
        @param name: One visible filename, including its extension for files.
        @param parent: Existing relative directory, or empty for the root.
        @param source_document: Optional active paper authorizing its linked source root.
        @pre: Caller holds the project mutation lock and passed HTTP authorization.
        @post: One entry is added; existing files, reviews and versions are preserved.
        @return: Name, relative path, kind and optional source document identity.
        @throws ValueError: Unsafe/reserved path, invalid kind or binary file type.
        @throws ConflictError: Name exists, including case variants.
        @throws FileNotFoundError/OSError: Parent absent or filesystem operation failed.
        Related: tree() refreshes navigation; file_handlers owns extension initialization.
        """
        reserved = {'versions', 'originals', 'annotated', 'node_modules', '__pycache__'}
        if kind not in ('directory', 'file'):
            raise ValueError('Choose file or directory.')
        if (not isinstance(name, str) or not name.strip() or name != name.strip()
                or name.startswith('.') or '/' in name or '\\' in name
                or any(ord(c) < 32 for c in name) or name.casefold() in reserved):
            raise ValueError('Choose a visible name without directories or reserved names.')
        if (not isinstance(parent, str) or Path(parent).is_absolute() or '\\' in parent
                or any(part.startswith('.') or part.casefold() in reserved for part in Path(parent).parts)):
            raise ValueError('Choose an existing relative directory outside managed data.')
        root = self.root
        if source_document is not None:
            if not isinstance(source_document, str) or not source_document:
                raise ValueError('Choose a linked source document.')
            document = self.doc(source_document)
            self.require_active(document)
            cfg, _ = self.drafts.require(document)
            root = cfg['root_path']
        directory = root
        for part in Path(parent).parts:
            directory = directory / part
            if directory.is_symlink():
                raise ValueError('Symbolic links cannot be creation destinations.')
        if not directory.resolve().is_relative_to(root.resolve()):
            raise ValueError('Destination is outside the project.')
        if not directory.is_dir():
            raise FileNotFoundError('Destination directory not found.')
        if any(entry.name.casefold() == name.casefold() for entry in directory.iterdir()):
            raise ConflictError('A file or directory with this name already exists.', [])
        target = directory / name
        try:
            if kind == 'directory':
                target.mkdir()
            else:
                handler = file_handlers.resolve(name)
                if handler and not handler.editable:
                    raise ValueError('Import this binary file type instead of creating an empty file.')
                raw = (handler.initial_text if handler else '').encode('utf-8')
                fd, staged = tempfile.mkstemp(prefix='.create-', dir=directory)
                try:
                    with os.fdopen(fd, 'wb') as stream:
                        stream.write(raw)
                        stream.flush()
                        os.fsync(stream.fileno())
                    os.link(staged, target)
                finally:
                    os.unlink(staged)
        except FileExistsError:
            raise ConflictError('A file or directory with this name already exists.', [])
        return {'name': name, 'path': (Path(parent) / name).as_posix(),
                'kind': kind, 'source_document': source_document}

    def tree(self):
        """Describe papers, linked source and project files without changing them.
        Pre: loaded project; post: JSON tree. Hidden/generated data and symlinks
        are omitted. Filesystem errors propagate; traversal is bounded.

        @param None: No explicit inputs.
        @pre Caller owns the relevant mutation lock and has authorized the target.
        @post Effects and output follow the operation description above; caller-owned input is retained unless explicitly documented.
        @return The computed value described above.
        @throws Validation/IO errors described above propagate; none for valid pure inputs.
        """
        budget = [5000]
        def scan(root, rel='', managed=False, depth=0, latex=False):
            """Build a bounded branch; pre: safe root; post: JSON nodes; IO errors propagate.

            @param root: Optional explicitly authorized source root.
            @param rel: Authorized relative source/project path.
            @param managed: Input used by the operation described above.
            @param depth: Input used by the operation described above.
            @param latex: Input used by the operation described above.
            @pre Caller owns the relevant mutation lock and has authorized the target.
            @post Effects and output follow the operation description above; caller-owned input is retained unless explicitly documented.
            @return The computed value described above.
            @throws Validation/IO errors described above propagate; none for valid pure inputs.
            """
            entries = []
            if depth > 20:
                return entries
            paths = sorted(root.iterdir(), key=lambda p: (not p.is_dir(), p.name.casefold()))
            tex_files = [p for p in paths if p.suffix.lower() == '.tex' and p.is_file()
                         and not p.is_symlink() and not p.name.startswith('.')]
            latex = latex or bool(tex_files)
            for path in paths:
                if budget[0] <= 0:
                    break
                if path.name.startswith('.') or path.is_symlink() or path.name in ('node_modules', '__pycache__'):
                    continue
                if managed and not rel and path.name in ('versions', 'originals', 'annotated'):
                    continue
                if latex and LatexArtifacts.hidden(path, tex_files):
                    continue
                budget[0] -= 1
                name = str(Path(rel) / path.name)
                if path.is_dir():
                    entries.append({'name': path.name, 'kind': 'folder', 'path': name,
                                    'children': scan(path, name, managed, depth + 1, latex)})
                elif path.is_file():
                    entries.append({'name': path.name, 'kind': 'file', 'path': name,
                                    'type': path.suffix.lower()[1:]})
            return entries
        papers = []
        # Source compilation creates managed review records, not additional source folders.
        generated = {d.get('paper_id', d['id']) for d in self.__index['documents'] if d.get('source_main')}
        sources = self.drafts.sources()
        for doc in self.documents():
            if doc.get('project_file') or doc.get('paper_id', doc['id']) in generated:
                continue
            children = [{'name': doc['name'], 'kind': 'pdf', 'document': doc['id']}]
            if doc['paper_id'] in sources:
                cfg = self.drafts.config(doc)
                try:
                    if cfg and not cfg.get('error'):
                        source = scan(cfg['root_path'])
                        children.insert(0, {'name': 'LaTeX source', 'kind': 'source', 'children': source})
                except OSError:
                    children.insert(0, {'name': 'Source folder unavailable', 'kind': 'unavailable'})
            papers.append({'name': Path(doc['name']).stem, 'kind': 'paper',
                           'document': doc['id'], 'children': children, 'folder_id': doc.get('folder_id')})
        grouped = []
        for folder in self.__index['folders']:
            grouped.append({'name': folder['name'], 'kind': 'folder', 'path': 'library:' + folder['id'],
                            'children': [p for p in papers if p['folder_id'] == folder['id']]})
        grouped.extend(p for p in papers if not p['folder_id'])
        if self.__index.get('project_paper_id') and len(papers) == 1 and self.doc(papers[0]['document'])['paper_id'] == self.__index['project_paper_id']:
            grouped = [{**entry, 'document': papers[0]['document']} if entry['kind'] == 'source' else entry
                       for entry in papers[0]['children']]
        local = scan(self.root, managed=True)
        linked = []
        for doc in self.documents():
            if doc['paper_id'] in sources:
                cfg = self.drafts.config(doc)
                if cfg and not cfg.get('error'):
                    linked.append((doc['id'], cfg['root_path']))
        def bind(entries):
            """Bind local source files to review tools; pre: scanned nodes; post: routing metadata.

            @param entries: Input used by the operation described above.
            @pre Caller owns the relevant mutation lock and has authorized the target.
            @post Effects and output follow the operation description above; caller-owned input is retained unless explicitly documented.
            @return The computed value described above.
            @throws Validation/IO errors described above propagate; none for valid pure inputs.
            """
            for entry in entries:
                if 'children' in entry:
                    bind(entry['children'])
                elif entry.get('type') == 'pdf':
                    reviewed = next((d for d in self.documents() if d.get('project_file') == entry['path']), None)
                    if reviewed:
                        entry['review_document'] = reviewed['id']
                elif entry.get('type') in ('tex', 'bib'):
                    path = self.root / entry['path']
                    for doc_id, root in linked:
                        if path.is_relative_to(root):
                            entry.update(source_document=doc_id, source_path=str(path.relative_to(root)))
                            break
        bind(local)
        return {'children': grouped + local, 'truncated': budget[0] <= 0}

    def open_pdf_file(self, rel, source_document=None):
        """Snapshot an on-disk PDF into versioned review storage.
        Pre: safe existing PDF; post: stable paper identity for unchanged bytes,
        a fresh version when bytes change. Validation/IO errors preserve old notes.

        @param rel: Authorized relative source/project path.
        @param source_document: Optional linked document identifying an authorized source root.
        @pre Caller owns the relevant mutation lock and has authorized the target.
        @post Effects and output follow the operation description above; caller-owned input is retained unless explicitly documented.
        @return The computed value described above.
        @throws Validation/IO errors described above propagate; none for valid pure inputs.
        """
        cfg = self.drafts.config(self.doc(source_document)) if source_document else None
        if source_document and (not cfg or cfg.get('error')):
            raise ValueError('Linked source folder is unavailable.')
        path = self.file_path(rel, cfg['root_path'] if cfg else None)
        identity = 'source:' + self.doc(source_document)['paper_id'] + ':' + rel if source_document else rel
        if path.suffix.lower() != '.pdf':
            raise ValueError('Choose a PDF file.')
        if path.stat().st_size > MAX_PDF:
            raise ValueError('PDFs must be smaller than 200 MB.')
        data = path.read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        previous = next((d for d in self.documents() if d.get('project_file') == identity), None)
        if previous and previous.get('project_file_sha') == digest:
            return previous
        doc = self.import_pdf(path.name, data, version_of=previous['id'] if previous else None, separate=previous is None)
        next_index = copy.deepcopy(self.__index)
        saved = next(d for d in next_index['documents'] if d['id'] == doc['id'])
        saved.update(project_file=identity, project_file_sha=digest)
        self.commit(next_index)
        return self.doc(doc['id'])

    def copy_paper_project(self, doc, folder):
        """Create an independent project with a paper's complete review history.
        Pre: existing active paper, absent destination and saved browser edits.
        Post: IDs, PDFs, exports, annotations, draft history and source link retained;
        original project unchanged. IO/conflict errors remove only staged copies.
        Callers register the result before recoverably removing the old paper.

        @param doc: Document snapshot containing exact version and paper identities.
        @param folder: Local project or destination directory.
        @pre Caller owns the relevant mutation lock and has authorized the target.
        @post Effects and output follow the operation description above; caller-owned input is retained unless explicitly documented.
        @return The computed value described above.
        @throws Validation/IO errors described above propagate; none for valid pure inputs.
        """
        self.require_active(doc)
        destination = Path(folder).expanduser().absolute()
        if destination.is_symlink() or destination.exists():
            raise ValueError('Choose a new project folder; existing folders are never overwritten.')
        destination = destination.resolve()
        destination.parent.mkdir(parents=True, exist_ok=True)
        stage = Path(tempfile.mkdtemp(prefix='.paper-project-', dir=destination.parent))
        before_index = self.index_path.read_bytes()
        observed = []
        def copy_file(source, target):
            """Stage exact file bytes. Pre: regular managed file; post: copy and digest.
            Symlinks or IO errors abort; recorded hashes detect concurrent edits.

            @param source: Input used by the operation described above.
            @param target: Input used by the operation described above.
            @pre Caller owns the relevant mutation lock and has authorized the target.
            @post Effects and output follow the operation description above; caller-owned input is retained unless explicitly documented.
            @return The computed value described above.
            @throws Validation/IO errors described above propagate; none for valid pure inputs.
            """
            if source.is_symlink() or not source.is_file():
                raise ValueError('Cannot copy a missing or symbolic-linked review file: ' + str(source))
            data = source.read_bytes()
            target.parent.mkdir(parents=True, exist_ok=True)
            atomic(target, data)
            observed.append((source, hashlib.sha256(data).digest()))
        try:
            target = Project(stage, draft_factory=self.__draft_factory)
            versions = copy.deepcopy(self.versions(doc))
            for version in versions:
                original = self.path(version, 'original')
                annotated = self.path(version, 'annotated')
                annotations = self.path(version, 'annotations')
                version.update(version_storage=True, folder_id=None)
                version.pop('project_file', None)
                version.pop('project_file_sha', None)
                copy_file(original, target.path(version, 'original'))
                copy_file(annotations, target.path(version, 'annotations'))
                if annotated.exists():
                    copy_file(annotated, target.path(version, 'annotated'))
            paper_id = doc['paper_id']
            state = self.drafts.state_path(paper_id)
            if state.exists():
                copy_file(state, target.drafts.state_path(paper_id))
            published = self.drafts.published(paper_id)
            if published.is_symlink():
                raise ValueError('Published draft storage cannot be a symbolic link.')
            if published.is_dir():
                for path in published.rglob('*'):
                    if path.is_symlink():
                        raise ValueError('Published draft files cannot be symbolic links.')
                    if path.is_file():
                        copy_file(path, target.drafts.published(paper_id) / path.relative_to(published))
            history = self.drafts.dir / 'history'
            if history.is_symlink():
                raise ValueError('Draft history cannot be a symbolic link.')
            if history.is_dir():
                for version in versions:
                    for path in history.glob(version['id'] + '*'):
                        copy_file(path, target.drafts.dir / 'history' / path.name)
            source = self.drafts.sources().get(paper_id)
            if source:
                source_root = (self.root / source['root']).resolve()
                cfg = {**source, 'root': os.path.relpath(source_root, destination)}
                atomic(target.drafts.sources_path, json_bytes({paper_id: cfg}))
            target.commit({'version': 2, 'folders': [], 'documents': versions,
                           'project_paper_id': paper_id,
                           'copied_from': {'folder': str(self.root), 'paper_id': paper_id}})
            if self.index_path.read_bytes() != before_index or any(
                    hashlib.sha256(path.read_bytes()).digest() != digest for path, digest in observed):
                raise ConflictError('The paper changed while copying. Save pending edits and retry.')
            if destination.exists():
                raise ConflictError('The destination appeared while copying. Existing files were kept.')
            os.rename(stage, destination)
            return Project(destination)
        finally:
            if stage.exists():
                shutil.rmtree(stage)

    def persist(self):
        """Publish the current library index atomically.

        @param None: No explicit inputs.
        @pre Caller owns the relevant mutation lock and has authorized the target.
        @post Complete index bytes are persisted; publication errors propagate.
        @return None
        @throws OSError: Failed atomic publication.
        """
        atomic(self.index_path, json_bytes(self.__index))

    def reload(self):
        """Reload a supported library index without losing the last readable state.

        @param None: No explicit inputs.
        @pre Caller owns the relevant mutation lock and has authorized the target.
        @post Valid index replaces memory; missing/invalid storage leaves memory intact.
        @return None
        @throws ValueError,OSError: Missing, malformed or unreadable index.

        Re-read library.json, which another process may have changed. Keeps the
        loaded index when the file on disk is missing or unreadable.
        """
        if self.index_path.is_symlink():
            raise ValueError('The library index cannot be a symbolic link.')
        try:
            index = json.loads(self.index_path.read_text())
        except FileNotFoundError:
            raise ValueError('library.json is missing on disk; the loaded library was kept.')
        except ValueError:
            raise ValueError('library.json on disk is not valid JSON; the loaded library was kept.')
        if index.get('version') != 2 or not isinstance(index.get('documents'), list) or not isinstance(index.get('folders'), list):
            raise ValueError('library.json on disk has an unsupported format; the loaded library was kept.')
        self.__index = index

    def commit(self, next_index):
        """Publish a prepared library transaction and retain no caller-owned containers.

        @param next_index: Detached replacement library index prepared by an owning transaction.
        @pre Caller owns the relevant mutation lock and has authorized the target.
        @post Success replaces disk/memory together; failure restores the old in-memory index.
        @return None
        @throws OSError: Failed atomic index publication.
        """
        previous = self.__index
        self.__index = copy.deepcopy(next_index)
        try:
            self.persist()
        except Exception:
            self.__index = previous
            raise

    @property
    def index(self):
        """Read the legacy index view as a detached snapshot.

        @param None: No inputs. @pre Project initialized. @post Internal state is private.
        @return dict: Snapshot; use commit for an intentional transaction.
        @throws None. Related: index_snapshot is the preferred explicit operation.
        """
        return self.index_snapshot()

    def index_snapshot(self):
        """Read detached library state for a coordinated application transaction.

        @param None: No inputs. @pre Caller holds the project mutation lock.
        @post No mutable index storage is exposed. @return dict: Deep snapshot.
        @throws None. Related: commit publishes an explicitly prepared replacement.
        """
        return copy.deepcopy(self.__index)

    def folders(self):
        """List virtual collections without exposing their mutable storage.

        @param None: No inputs. @pre Project initialized. @post Index unchanged.
        @return list: Deep snapshots of collection definitions. @throws None.
        """
        return copy.deepcopy(self.__index['folders'])

    def relocate_entries(self, source, destination):
        """Update standalone file associations after a confined filesystem move.

        @param source,destination: Validated project-relative old and new paths.
        @pre Caller holds the project mutation lock; disk move already succeeded.
        @post Matching association paths change together, or index remains unchanged.
        @return None. @throws OSError: Index publication failed; caller restores disk.
        Related: ProjectEntries coordinates disk rollback without editing this index.
        """
        updated = copy.deepcopy(self.__index)
        for doc in updated['documents']:
            for field in ('project_file', 'source_main'):
                value = doc.get(field)
                if value and (value == source or value.startswith(source + '/')):
                    doc[field] = destination + value[len(source):]
        if updated != self.__index:
            self.commit(updated)

    def documents(self, deleted=False):
        """List current paper versions with explicit deletion visibility.

        @param deleted: Whether to select or record recoverable deletion.
        @pre Caller owns the relevant mutation lock and has authorized the target.
        @post Private library records remain unchanged and unexposed.
        @return list[dict]: Detached active-version snapshots
        @throws None under the preconditions.
        """
        return copy.deepcopy([d for d in self.__index['documents']
                if d['active'] and bool(d.get('deleted_at')) == deleted])

    def versions(self, doc):
        """Read a paper version history in descending version order.

        @param doc: Document snapshot containing exact version and paper identities.
        @pre Caller owns the relevant mutation lock and has authorized the target.
        @post Private library records remain unchanged and unexposed.
        @return list[dict]: Detached version snapshots
        @throws KeyError: Missing paper identity.
        """
        return copy.deepcopy(sorted([d for d in self.__index['documents'] if d['paper_id'] == doc['paper_id']],
                      key=lambda d: d['number'], reverse=True))

    def set_deleted(self, doc, deleted):
        """Recoverably hide or restore every version of a paper.

        @param doc: Document snapshot containing exact version and paper identities.
        @param deleted: Whether to select or record recoverable deletion.
        @pre Caller owns the relevant mutation lock and has authorized the target.
        @post Deletion flags publish together; physical document files remain intact.
        @return None
        @throws OSError: Index publication failure.
        """
        next_index = copy.deepcopy(self.__index)
        for d in next_index['documents']:
            if d['paper_id'] == doc['paper_id']:
                if deleted:
                    d['deleted_at'] = time.time()
                else:
                    d.pop('deleted_at', None)
        self.commit(next_index)

    def folder(self, key):
        """Resolve a virtual collection by exact identity.

        @param key: Exact document or collection identity.
        @pre Caller owns the relevant mutation lock and has authorized the target.
        @post Private collection state remains unchanged.
        @return dict|None: Detached collection or Unfiled
        @throws ValueError: Collection not found.
        """
        if key is None:
            return None
        for f in self.__index['folders']:
            if f['id'] == key:
                return copy.deepcopy(f)
        raise ValueError('Folder not found.')

    def create_folder(self, name):
        """Create a unique named virtual collection.

        @param name: Proposed filename or collection name, validated by this operation.
        @pre Caller owns the relevant mutation lock and has authorized the target.
        @post Validated collection publishes atomically in the index.
        @return dict: New collection snapshot
        @throws ValueError,OSError: Invalid/duplicate name or publication failure.
        """
        if not isinstance(name, str) or not name.strip() or len(name.strip()) > 100:
            raise ValueError('Enter a folder name of 1–100 characters.')
        name = name.strip()
        if any(f['name'].casefold() == name.casefold() for f in self.__index['folders']):
            raise ValueError('A folder with that name already exists.')
        folder = {'id': uuid.uuid4().hex, 'name': name}
        next_index = copy.deepcopy(self.__index)
        next_index['folders'].append(folder)
        self.commit(next_index)
        return folder

    def move(self, doc, folder_id):
        """Move all versions of a paper into a virtual collection.

        @param doc: Document snapshot containing exact version and paper identities.
        @param folder_id: Exact collection identity, or None for Unfiled.
        @pre Caller owns the relevant mutation lock and has authorized the target.
        @post Folder associations publish together; physical files remain unchanged.
        @return dict: Updated document snapshot
        @throws ValueError,OSError: Missing collection or publication failure.
        """
        self.folder(folder_id)
        next_index = copy.deepcopy(self.__index)
        for d in next_index['documents']:
            if d['paper_id'] == doc['paper_id']:
                d['folder_id'] = folder_id
        self.commit(next_index)
        return self.doc(doc['id'])

    @staticmethod
    def import_name(name):
        """Normalize and validate a PDF basename.

        @param name: Proposed filename or collection name, validated by this operation.
        @pre Caller owns the relevant mutation lock and has authorized the target.
        @post Input remains unchanged; directory components are discarded.
        @return str: PDF basename
        @throws ValueError: Invalid filename or extension.
        """
        if not isinstance(name, str):
            raise ValueError('Choose a PDF filename.')
        name = Path(name.replace('\\', '/')).name
        if not name.lower().endswith('.pdf'):
            raise ValueError('Choose a file ending in .pdf.')
        return name

    def matches(self, name):
        """Find active papers with a matching normalized PDF filename.

        @param name: Proposed filename or collection name, validated by this operation.
        @pre Caller owns the relevant mutation lock and has authorized the target.
        @post Library remains unchanged.
        @return list[dict]: Matching snapshots, newest first
        @throws ValueError: Invalid PDF filename.
        """
        name = self.import_name(name).casefold()
        return sorted([d for d in self.documents() if d['name'].casefold() == name],
                      key=lambda d: d['created'], reverse=True)

    def require_active(self, doc):
        """Reject edits to archived document versions.

        @param doc: Document snapshot containing exact version and paper identities.
        @pre Caller owns the relevant mutation lock and has authorized the target.
        @post Library and files remain unchanged.
        @return None
        @throws ConflictError,ValueError,FileNotFoundError: Archived or invalid document.
        """
        if not self.doc(doc['id'])['active']:
            raise ConflictError('This is an older version. Its PDF and comments are preserved. Open the latest version to edit.')

    def doc(self, key, include_deleted=False):
        """Read a document without exposing the mutable library record.

        @param key,include_deleted: Exact document ID and recovery visibility.
        @pre Project initialized. @post No state changes.
        @return dict: Detached document snapshot.
        @throws ValueError,FileNotFoundError: Invalid or missing identity.
        """
        return copy.deepcopy(self.__document(key, include_deleted))

    def __document(self, key, include_deleted=False):
        """Compute document for the owning operation.

        @param key: Exact document or collection identity.
        @param include_deleted: Whether recoverably deleted documents are visible.
        @pre Caller owns the relevant mutation lock and has authorized the target.
        @post Effects and output follow the operation description above; caller-owned input is retained unless explicitly documented.
        @return The computed value described above.
        @throws Validation/IO errors described above propagate; none for valid pure inputs.
        """
        if not re.fullmatch('[a-f0-9]{32}', key):
            raise ValueError('Invalid document ID.')
        for d in self.__index['documents']:
            if d['id'] == key and (include_deleted or not d.get('deleted_at')):
                return d
        raise FileNotFoundError('Document not found.')

    def path(self, doc, kind):
        """Resolve an authorized managed document artifact path.

        @param doc: Document snapshot containing exact version and paper identities.
        @param kind: Requested managed artifact category.
        @pre Caller owns the relevant mutation lock and has authorized the target.
        @post No files change; unsafe managed paths are rejected.
        @return Path: Original, export or annotation location
        @throws ValueError: Invalid identity, filename or symlink.
        """
        if kind == 'annotations':
            p = self.meta / (doc['id'] + '.json')
        elif doc.get('version_storage'):
            if not re.fullmatch('[a-f0-9]{32}', doc['id']):
                raise ValueError('Invalid document ID.')
            parent = self.versions_root / doc['id']
            if self.versions_root.is_symlink() or parent.is_symlink():
                raise ValueError('Managed folders cannot be symbolic links.')
            p = parent / ('original.pdf' if kind == 'original' else 'annotated.pdf')
        else:
            name = doc['file']
            if Path(name).name != name or not name.lower().endswith('.pdf'):
                raise ValueError('Invalid library filename.')
            p = (self.originals if kind == 'original' else self.annotated) / name
        if p.is_symlink():
            raise ValueError('Managed files cannot be symbolic links.')
        return p

    def import_pdf(self, name, data, folder_id=None, version_of=None, separate=False, source_commit=None, source_main=None):
        """Import immutable PDF bytes as a new paper or explicit version.

        @param name: Proposed filename or collection name, validated by this operation.
        @param data: Complete validated payload or immutable input bytes.
        @param folder_id: Exact collection identity, or None for Unfiled.
        @param version_of: Exact active version to supersede, or None for a new paper.
        @param separate: Whether an explicitly separate paper may share a filename.
        @param source_commit: Optional full Git commit for source-linked imports.
        @param source_main: Optional authorized main source association.
        @pre Caller owns the relevant mutation lock and has authorized the target.
        @post Version/index publication completes together; failed staged imports are removed.
        @return dict: New document snapshot
        @throws ConflictError,ValueError,OSError: Duplicate, validation or publication failure.
        """
        valid_pdf(data)
        name = self.import_name(name)
        self.folder(folder_id)
        matches = self.matches(name)
        previous = None
        if version_of is not None:
            previous = self.doc(version_of)
            self.require_active(previous)
            if previous['name'].casefold() != name.casefold():
                raise ValueError('The selected paper has a different filename.')
        elif matches and not separate:
            raise ConflictError('A paper with this name already exists. Choose how to import it.', matches)
        key = uuid.uuid4().hex
        d = {'id': key, 'name': name, 'file': name, 'updated': time.time(),
             'created': time.time(), 'exported': False, 'export_stale': False,
             'paper_id': previous['paper_id'] if previous else key,
             'number': previous['number'] + 1 if previous else 1, 'active': True,
             'folder_id': previous['folder_id'] if previous else folder_id,
             'version_storage': True}
        if source_main is not None:
            source = self.file_path(source_main)
            if source.suffix.lower() != '.tex':
                raise ValueError('Source identity must name a LaTeX main file.')
            d['source_main'] = str(source.relative_to(self.root))
        if source_commit is not None:
            if not re.fullmatch('[0-9a-f]{40}', source_commit):
                raise ValueError('Invalid commit.')
            d['source_commit'] = source_commit
        storage = self.versions_root / key
        if self.versions_root.is_symlink():
            raise ValueError('Managed folders cannot be symbolic links.')
        annotations = self.path(d, 'annotations')
        storage.mkdir()  # Exclusive, unique storage; never replace an earlier PDF.
        annotations_created = False
        try:
            with self.path(d, 'original').open('xb') as f:
                f.write(data)
                f.flush()
                os.fsync(f.fileno())
            with annotations.open('xb') as f:
                annotations_created = True
                f.write(json_bytes({'version': 1, 'highlights': [], 'strokes': []}))
                f.flush()
                os.fsync(f.fileno())
            next_index = copy.deepcopy(self.__index)
            if previous:
                for old in next_index['documents']:
                    if old['paper_id'] == previous['paper_id']:
                        old['active'] = False
            next_index['documents'].append(d)
            self.commit(next_index)
        except Exception:
            # Only this new revision's files are removed after a failed import.
            shutil.rmtree(storage)
            if annotations_created:
                annotations.unlink()
            raise
        return d

    def set_source_commit(self, doc, commit):
        """Record the Git commit associated with a document PDF.

        @param doc: Document snapshot containing exact version and paper identities.
        @param commit: Full Git commit identity.
        @pre Caller owns the relevant mutation lock and has authorized the target.
        @post Validated commit publishes in the index.
        @return None
        @throws ValueError,OSError: Invalid commit or publication failure.

        Record the git commit a version's PDF was built from (used by LaTeX drafts).
        """
        if not re.fullmatch('[0-9a-f]{40}', commit or ''):
            raise ValueError('Invalid commit.')
        next_index = copy.deepcopy(self.__index)
        for d in next_index['documents']:
            if d['id'] == doc['id']:
                d['source_commit'] = commit
        self.commit(next_index)

    def annotations(self, d):
        """Read a document annotation snapshot from its owner storage.

        @param d: Document snapshot containing exact version identity.
        @pre Caller owns the relevant mutation lock and has authorized the target.
        @post Files and index remain unchanged.
        @return dict: Decoded annotations
        @throws ValueError,OSError: Invalid or unreadable annotations.
        """
        return json.loads(self.path(d, 'annotations').read_text())

    def save_annotations(self, d, data):
        """Validate and publish editable annotation data.

        @param d: Document snapshot containing exact version identity.
        @param data: Complete validated payload or immutable input bytes.
        @pre Caller owns the relevant mutation lock and has authorized the target.
        @post Annotations publish and the export becomes stale when appropriate.
        @return dict: Accepted annotation snapshot
        @throws ConflictError,MarkupConflict,ValueError,OSError: Stale/invalid data or failed write.
        """
        d = self.__document(d['id'])
        self.require_active(d)
        if isinstance(data, dict) and 'base' in data:
            data = dict(data)
            base = data.pop('base')
            data = merge_annotations(base, data, self.annotations(d))
        if not isinstance(data, dict) or not isinstance(data.get('highlights'), list) or not isinstance(data.get('strokes'), list):
            raise ValueError('Invalid annotation data.')
        for h in data['highlights']:
            if not isinstance(h, dict) or not isinstance(h.get('rects'), list) or not h['rects'] or not isinstance(h.get('text'), str):
                raise ValueError('Invalid highlight.')
            for r in h['rects']:
                if not all(isinstance(r.get(k), (int, float)) for k in ('p', 'x', 'y', 'w', 'h')) or r['p'] < 1:
                    raise ValueError('Invalid highlight coordinates.')
        for s in data['strokes']:
            if not isinstance(s, dict) or not isinstance(s.get('page'), int) or s['page'] < 1 or not isinstance(s.get('points'), list) or not s['points']:
                raise ValueError('Invalid pen stroke.')
            if not re.fullmatch(r'#[0-9a-fA-F]{6}', s.get('color', '')) or not isinstance(s.get('width'), (int,float)) or s['width'] <= 0:
                raise ValueError('Invalid pen style.')
            if not all(isinstance(p, list) and len(p) == 2 and all(isinstance(n, (int,float)) for n in p) for p in s['points']):
                raise ValueError('Invalid pen coordinates.')
        atomic(self.path(d, 'annotations'), json_bytes(data))
        d['updated'] = time.time()
        d['export_stale'] = bool(d['exported'])
        self.persist()
        return data

    def export(self, d, data):
        """Publish an annotated PDF for the active version.

        @param d: Document snapshot containing exact version identity.
        @param data: Complete validated payload or immutable input bytes.
        @pre Caller owns the relevant mutation lock and has authorized the target.
        @post PDF and export metadata update; original PDF remains unchanged.
        @return None
        @throws ConflictError,ValueError,OSError: Archived/invalid PDF or failed write.
        """
        d = self.__document(d['id'])
        self.require_active(d)
        valid_pdf(data)
        atomic(self.path(d, 'annotated'), data)
        d['exported'] = True
        d['export_stale'] = False
        d['updated'] = time.time()
        self.persist()
