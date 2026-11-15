#!/usr/bin/env python3
"""Run reproducible regression, documentation and architecture checks."""
import argparse
import ast
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def documentation():
    """Verify maintained local documentation paths and directory ownership guides.

    @param None: Uses this installation. @pre Source tree is readable.
    @post No files change. @return None. @throws AssertionError: Missing guide/link/fence.
    """
    assert not any(path.stem.lower() == 'readme' for path in (ROOT / '.github').iterdir() if path.is_file()), 'A .github README overrides the product README on GitHub'
    directories = [ROOT / 'research_workbench', *sorted((ROOT / 'research_workbench').rglob('*')),
                   ROOT / 'extensions', ROOT / 'static/features', *sorted((ROOT / 'static/features').glob('*')),
                   ROOT / 'static/core', ROOT / 'static/editors', *sorted((ROOT / 'static/editors').glob('*'))]
    for directory in directories:
        if directory.is_dir() and '__pycache__' not in directory.parts:
            assert (directory / 'README.md').is_file(), f'Missing guide: {directory.relative_to(ROOT)}'
    guides = [ROOT / 'README.md', ROOT / 'CONTRIBUTING.md', ROOT / 'SECURITY.md',
              *sorted((ROOT / 'docs').glob('*.md')), *sorted((ROOT / '.github').rglob('*.md')),
              *sorted((ROOT / 'research_workbench').rglob('README.md')),
              *sorted((ROOT / 'extensions').rglob('README.md')),
              *sorted((ROOT / 'static/features').rglob('README.md')),
              *sorted((ROOT / 'static/editors').rglob('README.md')), ROOT / 'static/core/README.md',
              ROOT / 'static/README.md', ROOT / 'tests/README.md', ROOT / 'tools/README.md',
              *sorted((ROOT / 'tests/support').glob('README.md'))]
    for guide in guides:
        source = guide.read_text()
        assert source.count('```') % 2 == 0, f'Unbalanced fence: {guide}'
        for target in re.findall(r'\]\(([^)]+)\)', source):
            if '://' in target or target.startswith('#') or target.startswith('mailto:'):
                continue
            target = target.split('#')[0]
            assert (guide.parent / target).exists(), f'Broken link: {guide.relative_to(ROOT)} -> {target}'
    print(f'PASS: {len(guides)} maintained documentation files', flush=True)


def architecture():
    """Check dependency direction and removal of migrated private-state access.

    @param None: Uses production source. @pre Source tree is readable.
    @post No modules are executed or files changed. @return None.
    @throws AssertionError: Forbidden domain imports or migrated cross-module access.
    """
    allowed = {'copy', 'difflib', 'hashlib', 'math', 're', 'time', 'uuid'}
    for source in (ROOT / 'research_workbench/domain').glob('*.py'):
        for node in ast.walk(ast.parse(source.read_text())):
            if isinstance(node, ast.Import):
                names = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                names = [node.module or '']
            else:
                continue
            assert all(name.split('.')[0] in allowed or name.startswith('research_workbench.domain') for name in names), f'Domain IO dependency: {source}: {names}'
    for name in ('research_workbench/application/imports.py', 'research_workbench/application/entries.py',
                 'research_workbench/transport/http/projects.py'):
        text = (ROOT / name).read_text()
        assert not re.search(r'project\.index\b|project\.drafts\._', text), f'Private project-state coupling: {name}'
    core = (ROOT / 'static/toolbar.js').read_text()
    assert not re.search(r'class (CompileTool|PdfMarkTool|CloseOtherTabsTool)\b', core), 'Concrete feature leaked into Tool core'
    compatibility = {'research_workbench.launcher', 'drafts', 'markup', 'imports', 'project_entries', 'repository_sync',
                     'standalone_latex', 'source_archive', 'openalex', 'latex_artifacts', 'file_handlers'}
    for source in (ROOT / 'research_workbench').rglob('*.py'):
        for node in ast.walk(ast.parse(source.read_text())):
            if isinstance(node, ast.ImportFrom):
                assert node.module not in compatibility, f'Implementation imports a compatibility facade: {source}'
    server = ast.parse((ROOT / 'research_workbench/transport/http/server.py').read_text())
    assert not any(isinstance(node, ast.ImportFrom) and (node.module or '').startswith('research_workbench.application')
                   for node in ast.walk(server)), 'HTTP socket host imports feature implementation'
    diagnostics = (ROOT / 'static/bibliography-diagnostics.js').read_text()
    assert '/api/openalex/diagnose' not in diagnostics, 'Diagnostic controller hardcodes a provider implementation'
    for name in ('build-controller.js', 'save-queue.js'):
        text = (ROOT / 'static/editors/source' / name).read_text()
        assert not re.search(r'CodeMirror|document\.|fetch\(', text), 'Controller depends on editor/DOM/transport: ' + name
    workspace = (ROOT / 'static/workspace.js').read_text()
    assert not re.search(r'this\.files\s*=|this\.files\.(?:set|delete|clear)\(', workspace), 'Workspace mutates detached source membership'
    assert not re.search(r'entry\.(?:saved|sha|stale)\s*=|swapDoc\(entry\.doc\)', workspace), 'Workspace bypasses native buffer owner'
    assert not re.search(r'this\.cite(?:Pop|Ctx|Entries|List|Search|Index|Keymap)', workspace), 'Workspace owns citation popup state'
    popup = (ROOT / 'static/features/bibliography/popup.js').read_text()
    assert not re.search(r'Workspace|fetch\(|\.files\.get\(', popup), 'Citation popup reaches host/transport internals'
    app = (ROOT / 'static/app.js').read_text()
    assert 'draftView.replyDrafts' not in app and 'draftView.newNote' not in app, 'Shell bypasses review polling interface'
    for name in ('state.js', 'cards.js', 'panel.js'):
        text = (ROOT / 'static/features/review' / name).read_text()
        assert not re.search(r'CodeMirror|fetch\(|\.getSourceBuffers\(|\.files\.get\(', text), 'Review presentation reaches source/transport internals: ' + name
    buffers = (ROOT / 'static/editors/source/buffers.js').read_text()
    assert not re.search(r'fetch\(|document\.createElement|new window\.Workspace', buffers), 'Source owner constructs transport/UI'
    print('PASS: domain, transport, source/review ownership, controller and contribution checks', flush=True)


def vendor():
    """Verify shipped dependency bytes against the checked-in local inventory.

    @param None: Uses static/vendor/manifest.json. @pre Bundled assets are readable.
    @post No files change; unknown upstream versions remain explicitly unknown.
    @return None. @throws AssertionError: Missing/extra asset, symlink or digest mismatch.
    """
    root = ROOT / 'static/vendor'
    manifest = json.loads((root / 'manifest.json').read_text())
    assert manifest['schemaVersion'] == 1, 'Unsupported vendor inventory'
    for dependency in manifest['dependencies']:
        folder = root / dependency['name']
        assert folder.resolve().is_relative_to(root.resolve()), 'Unsafe vendor directory'
        actual = {str(path.relative_to(root)) for path in folder.rglob('*') if path.is_file()}
        assert actual == set(dependency['files']), 'Vendor file inventory differs: ' + dependency['name']
        assert dependency['licenseFile'] in actual, 'Missing dependency license: ' + dependency['name']
        for name, digest in dependency['files'].items():
            path = root / name
            assert not path.is_symlink() and path.resolve().is_relative_to(root.resolve()), 'Unsafe vendor asset'
            assert hashlib.sha256(path.read_bytes()).hexdigest() == digest, 'Vendor digest changed: ' + name
    print('PASS: bundled dependency file inventory, licenses and SHA-256 digests', flush=True)


def run(arguments):
    """Run one checked command without shell interpolation.

    @param arguments: Literal executable and argument list.
    @pre Command is available. @post Command completes before another starts.
    @return None. @throws CalledProcessError,OSError: Command failed or missing.
    """
    print('RUN: ' + ' '.join(map(str, arguments)), flush=True)
    subprocess.run(list(map(str, arguments)), cwd=ROOT, check=True)


def main(argv=None):
    """Select deterministic checks or explicit integration checks.

    @param argv: CLI arguments; None uses sys.argv. @pre Python 3.10+; Node for JS.
    @post All selected checks run successfully or execution stops at the first failure.
    @return None. @throws AssertionError,CalledProcessError: A selected check failed.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('python', 'javascript', 'docs', 'architecture', 'vendor', 'integration'):
        parser.add_argument('--' + name, action='store_true')
    args = parser.parse_args(argv)
    default = not any(vars(args).values())
    if args.docs or default:
        documentation()
    if args.architecture or default:
        architecture()
    if args.vendor or default:
        vendor()
    if args.python or default:
        run([sys.executable, 'tests/run_inprocess.py'])
    if args.javascript or default:
        run(['node', '-e', 'if (Number(process.versions.node.split(".")[0]) < 26) { console.error("JavaScript checks require Node.js 26+ for bundled PDF.js 6.1.200; found " + process.version); process.exit(1); }'])
        for test in sorted((ROOT / 'tests').glob('test_*.mjs')):
            run(['node', '--experimental-vm-modules', test])
    if args.integration:
        run([sys.executable, '-m', 'unittest', 'discover', '-s', 'tests', '-v'])


if __name__ == '__main__':
    main()
