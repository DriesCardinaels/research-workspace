"""Export a consistent source/PDF snapshot without changing project files or review state."""
import io
import os
from pathlib import Path
import shutil
import tempfile
import zipfile

from research_workbench.domain.errors import SourceError
from research_workbench.infrastructure.filesystem.latex_artifacts import LatexArtifacts


class SourceArchive:
    """Copy project inputs first; build that exact snapshot and package it with its PDF."""
    MAX_FILES = 10000
    MAX_BYTES = 200 * 1024 * 1024
    PRIVATE_DIRS = frozenset(('versions', 'originals', 'annotated', 'node_modules', '__pycache__'))
    BUILD_DIRS = LatexArtifacts.BUILD_DIRS
    OUTPUT_SUFFIXES = LatexArtifacts.OUTPUT_SUFFIXES

    def __init__(self, compiler):
        """@param compiler: Existing latexmk(root, main, output, jobname) operation.
        @pre Compiler returns the normal draft build tuple. @post No files are read or written.
        @return SourceArchive service. @throws None.
        """
        self.__compiler = compiler

    def create(self, root, main):
        """Package source inputs and a freshly compiled PDF, preserving relative paths.

        @param root: Authorized project/source root. @param main: Root-relative .tex document.
        @pre Caller has saved open buffers and validated access to the source root.
        @post Only temporary files are written; originals, Git and review/version metadata stay intact.
        PDF output is generated from the exact source bytes placed in the archive.
        @return ZIP bytes, with the compiled PDF beside its main .tex file.
        @throws SourceError: Failed build or export limits. ValueError: Unsafe main path.
        @throws OSError: Snapshot/compiler/archive failure. Temporary data is always cleaned up.
        """
        root = Path(root).resolve()
        main = Path(main)
        if main.is_absolute() or '..' in main.parts or main.suffix.lower() != '.tex':
            raise ValueError('Choose a relative LaTeX main file for export.')
        if not (root / main).resolve().is_relative_to(root) or not (root / main).is_file():
            raise ValueError('Export main file is outside the source folder or missing.')
        with tempfile.TemporaryDirectory(prefix='workbench-source-export-') as temporary:
            snapshot, output = Path(temporary) / 'source', Path(temporary) / 'output'
            snapshot.mkdir(); output.mkdir()
            total, count, paths = 0, 0, []
            for directory, dirs, names in os.walk(root, followlinks=False):
                directory = Path(directory)
                dirs[:] = sorted(name for name in dirs if not name.startswith('.')
                                 and name not in self.PRIVATE_DIRS | self.BUILD_DIRS
                                 and not (directory / name).is_symlink())
                for name in sorted(names):
                    path = directory / name
                    relative = path.relative_to(root)
                    if (path.is_symlink() or not path.is_file()
                            or (name.startswith('.') and name != '.latexmkrc')
                            or name.endswith(self.OUTPUT_SUFFIXES)
                            or relative == main.with_suffix('.pdf')):
                        continue
                    if not path.resolve().is_relative_to(root):
                        raise ValueError('Export input escapes the source folder.')
                    count += 1
                    original_size = path.stat().st_size
                    total += original_size
                    if count > self.MAX_FILES or total > self.MAX_BYTES:
                        raise SourceError('Source export exceeds 10,000 files or 200 MB.')
                    target = snapshot / relative
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(path, target)
                    # Account for a file growing while being copied; export limits remain enforced.
                    total += target.stat().st_size - original_size
                    if total > self.MAX_BYTES:
                        raise SourceError('Source export exceeds 200 MB.')
                    paths.append(relative)
            if main not in paths:
                raise SourceError('The selected main file is excluded from the source archive.')
            ok, log, errors, pdf = self.__compiler(snapshot / main.parent, main.name, output, 'export')
            if not ok:
                raise SourceError('Source ZIP was not created because compilation failed. ' +
                                  ('\n'.join(errors) or log)[-2000:])
            if total + Path(pdf).stat().st_size > self.MAX_BYTES:
                raise SourceError('Source ZIP exceeds 200 MB including its compiled PDF.')
            archive = io.BytesIO()
            with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as zipped:
                for relative in paths:
                    zipped.write(snapshot / relative, relative.as_posix())
                zipped.write(pdf, main.with_suffix('.pdf').as_posix())
            return archive.getvalue()
