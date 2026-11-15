"""Pure LaTeX build transformations; no filesystem or process access."""
import re
from research_workbench.domain.errors import SourceError

NO_FIGURES_ENVS = ('figure', 'figure*', 'teaserfigure')  # tables stay


NO_FIGURES_NOTE = 'Research Workbench: removed '


UNSAFE_TEX_NAME = re.compile(r'[\\{}%#~^$&]')


def no_figures_wrapper(main):
    """Build a wrapper that discards figure floats without rewriting manuscript source.

    @param main: Authorized literal main filename, without TeX-special characters.
    @pre Target TeX runtime supports the existing begin-document hook.
    @post Inputs unchanged; each removed environment emits a parseable log note.
    @return str: Complete wrapper text. @throws SourceError: Unsafe main filename.
    """
    if UNSAFE_TEX_NAME.search(main):
        raise SourceError('The main file name contains a LaTeX special character, so it cannot be built without figures.')
    lines = ['% Written by the Research Workbench (Hide images). The paper is read as it is; its files are not changed.',
             '\\makeatletter',
             '\\def\\researchworkbench@removed#1{\\typeout{' + NO_FIGURES_NOTE + '#1}}',
             '\\AddToHook{begindocument/end}{%']
    for env in NO_FIGURES_ENVS:
        lines.append(f'  \\@ifundefined{{{env}}}{{}}{{\\RenewDocumentEnvironment{{{env}}}{{+b}}{{\\researchworkbench@removed{{{env}}}}}{{}}}}%')
    lines += ['}', '\\makeatother', f'\\input{{{main}}}', '']
    return '\n'.join(lines)

