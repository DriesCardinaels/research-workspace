"""Built-in LaTeX strategies; adding a variant does not change the shared executor."""
from pathlib import Path
import re

from research_workbench.domain.errors import SourceError
from research_workbench.domain.latex import NO_FIGURES_NOTE, no_figures_wrapper
from research_workbench.domain.bibliography import strip_comments
from research_workbench.infrastructure.filesystem.storage import read_src
from .service import BuildPlan, BuildVariantRegistry


def paper(request):
    """Plan the full draft PDF and matching source map.

    @param request: Authorized paper source and artifact directories. @pre Linked source exists.
    @post No IO or mutation. @return BuildPlan: Paper build and PDF/SyncTeX publication.
    @throws None under the preconditions.
    """
    return BuildPlan(request.source_root, request.main, request.output, request.publication,
                     'draft', ('draft.synctex.gz', 'draft.pdf'), optional_artifacts=('draft.synctex.gz',))


def active_file(request):
    """Plan an isolated preview after validating the source is a complete document.

    @param request: Authorized selected .tex file and isolated preview directories.
    @pre Caller confined the existing source file and validated its identity.
    @post Source files unchanged. @return BuildPlan: Preview-only publication.
    @throws SourceError,OSError: Fragment, invalid UTF-8 or unreadable source.
    """
    text = strip_comments(read_src(request.source_root / request.file))
    if not re.search(r'\\documentclass(?:\s*\[[^\]]*\])?\s*\{', text):
        raise SourceError('The active file is a LaTeX fragment, not a standalone document. '
                          'Compile the paper with Recompile, or add a document class and document environment.')
    return BuildPlan(request.source_root, './' + request.file, request.output, request.publication,
                     'active-file', ('active-file.pdf',), metadata=lambda ok: {'file': request.file})


def no_figures(request):
    """Plan the figure-free build without changing the manuscript or draft output.

    @param request: Authorized paper root/main and isolated figure-free artifact location.
    @pre Source main is safe to include in a literal TeX wrapper.
    @post Only a later prepare operation writes a temporary wrapper.
    @return BuildPlan: Independent figure-free PDF and removal metadata.
    @throws SourceError: Unsafe main filename.
    """
    text = no_figures_wrapper(request.main)
    wrapper = request.publication / 'no-figures.tex'

    def prepare():
        """@param None: Captured trusted wrapper/text. @pre Output parent exists.
        @post Isolated wrapper is current; source files unchanged. @return None.
        @throws OSError: Wrapper publication failed.
        """
        if not wrapper.is_file() or wrapper.read_text() != text:
            wrapper.write_text(text)

    return BuildPlan(request.source_root, str(wrapper), request.output, request.publication,
                     'no-figures', ('no-figures.pdf',), prepare=prepare,
                     metadata=lambda ok: {'removed': removed_floats(request.output / 'no-figures.log') if ok else None})


def removed_floats(path):
    """Read figure-removal notes from an optional completed build log.

    @param path: Figure-free TeX log. @pre Build finished.
    @post Files unchanged. @return dict: Environment => removal count.
    @throws None: Unreadable logs return an empty result.
    """
    try:
        text = Path(path).read_text('utf-8', 'replace')
    except OSError:
        return {}
    counts = {}
    for environment in re.findall('^' + re.escape(NO_FIGURES_NOTE) + r'(\S+)$', text, re.M):
        counts[environment] = counts.get(environment, 0) + 1
    return counts


def builtin_variants():
    """Compose fresh built-in strategies without any process or filesystem effects.

    @param None: No arguments. @pre Implementations imported.
    @post Independent registry contains the existing three variants.
    @return BuildVariantRegistry: Built-in composition. @throws ValueError: Duplicate definition.
    """
    return BuildVariantRegistry().register('paper', paper).register('active-file', active_file).register('no-figures', no_figures)
