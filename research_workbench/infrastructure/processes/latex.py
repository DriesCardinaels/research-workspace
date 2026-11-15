"""Bounded LaTeX process execution independent of draft/review storage."""
import os
from pathlib import Path
import re
import signal
import subprocess

from research_workbench.domain.errors import SourceError

COMPILE_TIMEOUT = 300

def run_latexmk(cwd, main, outdir, jobname):
    """Build one main file with shell escape disabled and bounded execution.

    @param cwd: Authorized working directory for the subprocess.
    @param main: Authorized main source filename.
    @param outdir: Isolated build output directory.
    @param jobname: Validated output artifact basename.
    @pre Inputs satisfy the operation description; dependencies are initialized.
    @post Build output is isolated in outdir; timed-out process groups are stopped.
    @return tuple: Success flag, bounded log, errors and candidate PDF path
    @throws SourceError: Missing compiler or timeout; OSError: Process setup failure.
    """
    cmd = ['latexmk', '-pdf', '-synctex=1', '-interaction=nonstopmode', '-halt-on-error', '-file-line-error',
           '-outdir=' + str(outdir), '-jobname=' + jobname,
           '-pdflatex=pdflatex -no-shell-escape %O %S', main]
    try:
        proc = subprocess.Popen(cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                stdin=subprocess.DEVNULL, start_new_session=True)
    except FileNotFoundError:
        raise SourceError('latexmk was not found. Install TeX Live or MacTeX.')
    try:
        output, _ = proc.communicate(timeout=COMPILE_TIMEOUT)
    except subprocess.TimeoutExpired:
        # latexmk starts pdflatex and bibtex as children; stop the whole group.
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.communicate()
        raise SourceError(f'The build took longer than {COMPILE_TIMEOUT} seconds and was stopped.')
    result = subprocess.CompletedProcess(cmd, proc.returncode, output, b'')
    log = (result.stdout + result.stderr).decode('utf-8', 'replace')
    errors = [l for l in log.splitlines() if re.search(r':\d+: |^! ', l)][:20]
    pdf = Path(outdir) / (jobname + '.pdf')
    return result.returncode == 0 and pdf.exists(), log[-6000:], errors, pdf
