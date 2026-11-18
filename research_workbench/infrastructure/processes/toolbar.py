"""Bounded execution of installation-owned JavaScript toolbar functions using Node.js."""
import json
from pathlib import Path
import shutil
import subprocess


def run_toolbar(data):
    """Run shared browser algorithms without a browser or shell.

    @param data: JSON-compatible action/catalog input, never executable source.
    @pre Input size bounded by the application service.
    @post No project files are passed to or written by the worker.
    @return dict: Computed text/catalog. @throws ValueError,OSError: Missing Node,
    timeout, invalid source or worker failure. Related: SourceActions.
    """
    node = shutil.which('node')
    if not node:
        raise ValueError('Source toolbar actions require Node.js 18+ on PATH. Raw text and note APIs remain available.')
    try:
        result = subprocess.run([node, '--max-old-space-size=256', str(Path(__file__).with_name('source_tools.mjs'))],
                                input=json.dumps(data).encode(), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                timeout=10, check=False)
    except subprocess.TimeoutExpired as error:
        raise ValueError('Source toolbar computation timed out; no source was saved.') from error
    if result.returncode:
        raise ValueError('Source toolbar worker failed; no source was saved.')
    output = json.loads(result.stdout)
    if 'error' in output:
        raise ValueError(output['error'])
    return output
