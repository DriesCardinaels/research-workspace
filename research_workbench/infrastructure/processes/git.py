"""Bounded Git execution shared by source and standalone build workflows."""
import subprocess

from research_workbench.domain.errors import SourceError

def git(cwd, *args, input=None, check=True):
    """Execute bounded Git arguments without shell interpolation.

    @param cwd: Authorized working directory for the subprocess.
    @param input: Optional bytes sent to the process stdin.
    @param check: Raise when the subprocess returns a nonzero status.
    @param args: Literal command arguments; no shell interpolation.
    @pre Inputs satisfy the operation description; dependencies are initialized.
    @post Only the requested Git operation runs.
    @return CompletedProcess: Captured bytes and status
    @throws SourceError: Checked Git failure; TimeoutExpired,OSError: Process failure.
    """
    result = subprocess.run(['git', *args], cwd=cwd, input=input, capture_output=True, timeout=120)
    if check and result.returncode:
        raise SourceError('git ' + args[0] + ' failed: ' + result.stderr.decode('utf-8', 'replace').strip())
    return result


def git_text(cwd, *args):
    """Read UTF-8 output from a successful Git operation.

    @param cwd: Authorized working directory for the subprocess.
    @param args: Literal command arguments; no shell interpolation.
    @pre Inputs satisfy the operation description; dependencies are initialized.
    @post Requested Git operation completes.
    @return str: Stripped decoded stdout
    @throws SourceError,TimeoutExpired,OSError,UnicodeError: Git or decoding failure.
    """
    return git(cwd, *args).stdout.decode('utf-8').strip()

