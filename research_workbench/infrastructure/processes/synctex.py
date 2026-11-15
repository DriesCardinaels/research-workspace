"""Bounded SyncTeX execution independent of project/review implementation."""
from pathlib import Path
import subprocess
from research_workbench.domain.errors import SourceError


def query_synctex(publication, arguments):
    """Execute a source/PDF mapping query against an existing published draft.

    @param publication,arguments: Authorized artifact folder and literal CLI arguments.
    @pre Caller validated the source/document scope; query is read-only.
    @post Published files unchanged. @return tuple: Decoded output and PDF path.
    @throws FileNotFoundError,SourceError,OSError,TimeoutExpired: Missing map or failed process.
    """
    publication = Path(publication)
    if not (publication / 'draft.synctex.gz').is_file():
        raise FileNotFoundError('No SyncTeX data yet. Click Compile.')
    result = subprocess.run(['synctex', *arguments], capture_output=True, timeout=30, cwd=publication)
    if result.returncode:
        raise SourceError('SyncTeX failed: ' + result.stderr.decode('utf-8', 'replace').strip()[:300])
    return result.stdout.decode('utf-8', 'replace'), publication / 'draft.pdf'
