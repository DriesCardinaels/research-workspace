"""Open-first LaTeX compilation and automatic, reusable source/PDF associations."""
import os
from pathlib import Path
import re
import shutil
import tempfile
import time

from research_workbench.domain.errors import SourceError
from research_workbench.domain.bibliography import strip_comments
from research_workbench.infrastructure.processes.git import git
from research_workbench.infrastructure.filesystem.storage import read_src


class StandaloneLatex:
    """Keep compilation outside the HTTP lock; publish only validated completed output."""

    def __init__(self, project, publication_lock, is_active=lambda: True):
        """@param project: Public project operations. @param publication_lock: Mutation lock.
        @param is_active: Registration check performed while publishing.
        @pre Project is loaded. @post No disk changes. @return Service.
        @throws None under normal operation.
        """
        self.__project = project
        self.__lock = publication_lock
        self.__active = is_active

    def status(self, relative):
        """Describe source for the existing split workspace before a PDF exists.

        @param relative: Project-relative LaTeX or BibTeX selection.
        @pre Selection is an independently editable UTF-8 source file.
        @post No document, PDF, Git repository or review state is created.
        @return Draft-shaped source status with explicit source_only capability.
        @throws ValueError/FileNotFoundError/OSError: Invalid or unreadable selection.
        """
        project = self.__project
        project.text_file(relative)  # Applies the same confinement and linked-review guard as saves.
        selected = project.file_path(relative)
        if selected.suffix.lower() not in ('.tex', '.bib'):
            raise ValueError('Choose a LaTeX or BibTeX file.')
        issue = None
        try:
            probe = relative if selected.suffix.lower() == '.tex' else str((selected.parent / 'main.tex').relative_to(project.root))
            _, main = self.target(probe)
        except (SourceError, FileNotFoundError, ValueError) as error:
            main, issue = selected, str(error)
        files, budget = [], 5000
        for directory, dirs, names in os.walk(main.parent, followlinks=False):
            folder = Path(directory)
            dirs[:] = sorted(name for name in dirs if not name.startswith('.')
                             and name not in ('node_modules', '__pycache__', 'versions', 'originals', 'annotated')
                             and not (folder / name).is_symlink()
                             and len((folder / name).relative_to(main.parent).parts) <= 20)
            for name in sorted(names):
                budget -= 1
                if budget < 0:
                    break
                path = folder / name
                if name.startswith('.') or path.is_symlink() or path.suffix.lower() not in ('.tex', '.bib'):
                    continue
                rel = str(path.relative_to(project.root))
                project.file_path(rel)
                files.append(rel)
            if budget < 0:
                break
        source_main = str(main.relative_to(project.root))
        document = next((doc for doc in project.documents() if doc.get('source_main') == source_main), None)
        return {'linked': False, 'source_only': True, 'main': source_main,
                'selected': relative, 'files': sorted(set(files + [relative])),
                'notes': [], 'changes': [], 'problems': [], 'builds': [], 'base_number': 0,
                'draft_pdf': bool(document and (project.drafts.published(document['paper_id']) / 'draft.pdf').is_file()),
                'document': document, 'root_error': issue}

    def citations(self, relative):
        """Reuse the existing citation analyzer for an unlinked source workspace.

        @param relative: Authorized source selection. @pre Source can be opened.
        @post Files and review history are unchanged. @return Completion/diagnostic data.
        @throws ValueError/FileNotFoundError/OSError: Invalid or unreadable source.
        """
        status = self.status(relative)
        project = self.__project
        texts = {name: read_src(project.file_path(name)) for name in status['files'] if name.endswith('.tex')}
        # Convert to the main folder's paths for declarations, then restore project identities.
        base = Path(status['main']).parent
        local = {str(Path(name).relative_to(base)): text for name, text in texts.items()}
        bibs = [str(Path(name).relative_to(base)) for name in status['files'] if name.endswith('.bib')]
        result = project.drafts.source_citations(project.root / base, Path(status['main']).name, local, bibs)
        for field in ('bib_files', 'missing_bib'):
            result[field] = [str(base / name) for name in result[field]]
        for entry in result['entries']:
            entry['bib'] = str(base / entry['bib'])
        for problem in result['problems']:
            problem['file'] = str(base / problem['file'])
        return result

    def target(self, relative):
        """Find the selected document, explicit TeX root, or nearest unambiguous main file.

        @param relative: Visible project-relative .tex filename.
        @pre None. @post No files are created or changed; all candidates use project confinement.
        @return Tuple of selected file and main file Paths.
        @throws ValueError/FileNotFoundError: Unsafe or missing file.
        @throws SourceError: Missing or ambiguous document root.
        """
        project = self.__project
        selected = project.file_path(relative)
        if selected.suffix.lower() != '.tex':
            raise SourceError('Choose a LaTeX .tex file to compile.')
        text = read_src(selected)
        directive = re.search(r'^\s*%\s*!\s*tex\s+root\s*=\s*(.+?)\s*$', text, re.I | re.M)
        if directive:
            raw = directive[1].strip().strip('"\'')
            if Path(raw).is_absolute():
                raise SourceError('The TeX root must be relative to the selected file.')
            rel = os.path.normpath(str(Path(relative).parent / raw))
            main = project.file_path(rel)
            if main.suffix.lower() != '.tex' or not self.__document(main):
                raise SourceError('The TeX root must name a document containing \\documentclass.')
            return selected, main
        if self.__document(selected):
            return selected, selected
        directory = selected.parent
        while directory.is_relative_to(project.root):
            default = directory / 'main.tex'
            if default.is_file():
                main = project.file_path(str(default.relative_to(project.root)))
                if self.__document(main):
                    return selected, main
            candidates = []
            for path in directory.glob('*.tex'):
                if path.name.startswith('.') or path.is_symlink():
                    continue
                path = project.file_path(str(path.relative_to(project.root)))
                if self.__document(path):
                    candidates.append(path)
            if len(candidates) == 1:
                return selected, candidates[0]
            if len(candidates) > 1:
                raise SourceError('Several LaTeX documents are possible. Open the intended main file or add % !TeX root = main.tex to this file.')
            if directory == project.root:
                break
            directory = directory.parent
        raise SourceError('No LaTeX document root found. Add \\documentclass to the main file or declare % !TeX root = main.tex.')

    @staticmethod
    def __document(path):
        """@param path: Confined text file. @pre Path exists.
        @post No changes. @return Whether it declares a document class.
        @throws SourceError/OSError: Read failure.
        """
        return bool(re.search(r'\\documentclass\b', strip_comments(read_src(path))))

    @staticmethod
    def __head(root):
        """@param root: Source directory. @pre Existing directory.
        @post Git index/branches are unchanged. @return HEAD commit or None.
        @throws SourceError/OSError: Git execution failure.
        """
        result = git(root, 'rev-parse', '--verify', 'HEAD', check=False)
        return result.stdout.decode().strip() if result.returncode == 0 else None

    def compile(self, relative):
        """Build, import once, and link the PDF to its source without creating Git commits.

        @param relative: Selected project-relative .tex file.
        @pre Shared source build lock serializes requests; registration remains active.
        @post Failed builds change no document records. Successful rebuilds reuse the active
        paper, retain original/version PDFs, and atomically publish its latest draft preview.
        Git-backed sources join the existing review workspace; other folders keep an editable
        source/preview association until a Git baseline is available.
        @return Build result, document, preview URL, source identity and linked status.
        @throws SourceError/OSError: Invalid target, unavailable compiler or publication failure.
        """
        project = self.__project
        with project.source_compile_lock:
            selected, main = self.target(relative)
            root, name = main.parent, main.name
            source_main = str(main.relative_to(project.root))
            if not selected.is_relative_to(root):
                raise SourceError('The selected file must be within its LaTeX root folder.')
            head = self.__head(root)
            started = time.time()
            with tempfile.TemporaryDirectory(prefix='workbench-latex-') as temporary:
                output = Path(temporary)
                ok, log, errors, pdf = project.drafts.latexmk(root, name, output, 'draft')
                result = {'ok': ok, 'log': log, 'errors': errors, 'main': source_main,
                          'seconds': round(time.time() - started, 1), 'at': time.time()}
                if not ok:
                    return result
                data = pdf.read_bytes()
                with self.__lock:
                    if not self.__active():
                        raise SourceError('Project was removed while compiling. No PDF was imported.')
                    if self.__head(root) != head:
                        raise SourceError('Git HEAD changed while compiling. Recompile to link the current source history.')
                    document = next((doc for doc in project.documents() if doc.get('source_main') == source_main), None)
                    if document is None:
                        for doc in project.documents():
                            cfg = project.drafts.config(doc)
                            if cfg and not cfg.get('error') and (cfg['root_path'] / cfg['main']).resolve() == main:
                                document = doc
                                break
                    if document is None:
                        document = project.import_pdf(main.stem + '.pdf', data, separate=True,
                                                      source_commit=head, source_main=source_main)
                    # A persisted source identity lets retries reuse the paper even if linking fails.
                    if head:
                        cfg = project.drafts.config(document)
                        if not cfg or cfg.get('error'):
                            project.drafts.link(document, str(root), name, head)
                    published = project.drafts.published(document['paper_id'])
                    published.mkdir(parents=True, exist_ok=True)
                    for filename in ('draft.synctex.gz', 'draft.pdf'):
                        source = output / filename
                        if source.is_file():
                            staged = published / ('.' + filename + '.tmp')
                            shutil.copyfile(source, staged)
                            os.replace(staged, published / filename)
                    document = project.doc(document['id'])
                    cfg = project.drafts.config(document)
                    linked = bool(cfg and not cfg.get('error') and document.get('source_commit'))
                    result.update(document=document, linked=linked,
                                  file=str(selected.relative_to(root)) if linked else relative,
                                  preview='/documents/' + document['id'] + ('/draft/pdf' if linked else '/source-preview'))
                    return result
