#!/usr/bin/env python3
"""Public launcher interface for Research Workbench (Python 3.10+, standard library)."""
# Legacy script imports remain available while implementations have explicit owners.
from http.server import ThreadingHTTPServer
import os
import uuid
from pathlib import Path

from research_workbench.application.drafts import Drafts
from research_workbench.infrastructure.metadata.openalex import OpenAlex
from research_workbench.application.projects import Project
from research_workbench.application.sessions import App
from research_workbench.domain.errors import ConflictError, SourceError
from research_workbench.domain.pdf import MAX_PDF, valid_pdf
from research_workbench.extensions.filetypes import handlers as file_handlers
from research_workbench.infrastructure.filesystem.storage import atomic_existing as atomic, json_bytes
from research_workbench.resources import ROOT as HERE
from research_workbench.transport.http.server import Handler, MAX_BODY

def main(argv=None):
    """Launch the application through its explicit composition root.

    @param argv: Optional argument list; None uses process arguments.
    @pre Loopback networking is available.
    @post Server resources close when serving stops; projects keep their data.
    @return None. @throws SystemExit: Invalid arguments or port unavailable.
    """
    from research_workbench.bootstrap import main as launch
    return launch(argv)


if __name__ == '__main__':
    main()
