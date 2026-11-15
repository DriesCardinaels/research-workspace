"""Source/PDF mapping with explicit query and source-authorization capabilities."""
from pathlib import Path
import re
from research_workbench.domain.errors import SourceError


class SourceMapping:
    """Translate mapping results without importing a draft, project or HTTP owner."""

    def __init__(self, source_root, publication, source_file, query):
        """@param source_root,publication,source_file,query: Authorized root/artifacts, path validator and query callable.
        @pre Callers supplied the linked document's public capabilities.
        @post Dependencies retained; no process runs. @return None. @throws None.
        """
        self.__root, self.__publication = Path(source_root).resolve(), Path(publication)
        self.__source_file, self.__query = source_file, query

    def from_pdf(self, page, x, y):
        """Translate one PDF point, rejecting results outside the authorized source root.

        @param page,x,y: One-based page and PDF coordinates.
        @pre Linked source/publication selected by caller. @post Files unchanged.
        @return dict: Relative source filename and line. @throws SourceError,OSError,ValueError: Missing/invalid mapping.
        """
        pdf = self.__publication / 'draft.pdf'
        text, _ = self.__query(['edit', '-o', f'{int(page)}:{float(x):.2f}:{float(y):.2f}:{pdf}'])
        found = dict(re.findall(r'^(Input|Line|Column):(.*)$', text, re.M))
        if 'Input' not in found:
            raise SourceError('No source position found there.')
        path = Path(found['Input']).resolve()
        if not path.is_relative_to(self.__root):
            raise SourceError('That text comes from a file outside the source folder.')
        relative = str(path.relative_to(self.__root))
        self.__source_file(relative)
        return {'file': relative, 'line': int(found['Line'])}

    def to_pdf(self, relative, line):
        """Translate an authorized source line into all returned PDF rectangles.

        @param relative,line: Relative source identity and one-based line.
        @pre Caller-supplied source validator rejects unsafe paths.
        @post Files unchanged. @return list: PDF rectangles.
        @throws SourceError,OSError,ValueError: Unsafe source, invalid query or malformed mapping.
        """
        path = self.__source_file(relative)
        pdf = self.__publication / 'draft.pdf'
        text, _ = self.__query(['view', '-i', f'{int(line)}:0:{path}', '-o', str(pdf)])
        boxes = []
        for block in text.split('Output:')[1:]:
            values = dict(re.findall(r'^(Page|h|v|W|H):(.*)$', block, re.M))
            if {'Page', 'h', 'v', 'W', 'H'} <= values.keys():
                x, y, width, height = (float(values[key]) for key in ('h', 'v', 'W', 'H'))
                boxes.append({'page': int(values['Page']), 'x': x, 'y': y - height, 'w': width, 'h': height})
        return boxes
