"""LaTeX build-artifact classification; filtering never changes files on disk."""
from pathlib import Path


class LatexArtifacts:
    """Share generated directory/suffix identities between tree presentation and ZIP export."""
    BUILD_DIRS = frozenset(('build', '_build'))
    OUTPUT_SUFFIXES = ('.aux', '.blg', '.fdb_latexmk', '.fls', '.log', '.out', '.synctex.gz',
                       '.toc', '.lof', '.lot', '.nav', '.snm', '.vrb', '.xdv', '.dvi')

    @classmethod
    def hidden(cls, path, tex_files):
        """Classify generated output inside an already identified LaTeX source subtree.

        @param path: Existing filesystem entry. @param tex_files: TeX filenames in its parent.
        @pre Caller identified this subtree as LaTeX; tex_files contains Path objects.
        @post No source, build output or directory is changed.
        @return True for build folders, auxiliary files and PDFs beside same-stem TeX files.
        Figure PDFs without matching TeX source remain visible.
        @throws OSError: Filesystem inspection failure.
        """
        path = Path(path)
        if path.is_dir():
            return path.name in cls.BUILD_DIRS
        return (path.name.lower().endswith(cls.OUTPUT_SUFFIXES)
                or (path.suffix.lower() == '.pdf' and any(p.stem == path.stem for p in tex_files)))
