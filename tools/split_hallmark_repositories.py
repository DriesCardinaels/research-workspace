#!/usr/bin/env python3
"""Prepare separate paper/prototype checkouts; retain the original working copy.

Uses Python 3's standard library, Git, and (with --push) GitHub CLI.
Run without flags to inspect; --apply creates checkouts; --push also publishes.
"""

import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

SOURCE = Path('/Users/driescardinaels/Projects/Research/eics2027-hallmark')
OWNER = 'Dries-Cardinaels'
IGNORE = '''# Local dependencies, builds and review material
.DS_Store
node_modules/
__pycache__/
*.pyc
.venv/
venv/
/build/
/dist/
/reviews/
/review-notes/
/supplementary/
/supplementary.zip
/video/
/submission/
/local-data/
'''


def run(*args, cwd=None, capture=False, env=None):
    """Run a checked command.

    @param args: Literal command arguments; cwd: optional working directory.
    @param capture: Capture stdout for inspection instead of streaming it.
    @param env: Optional complete environment for an external-data check.
    @pre: The executable and working directory exist.
    @post: The command's requested effects have completed on success.
    @return: Stripped captured stdout, or an empty string when streaming.
    @throws: CalledProcessError on failure; callers stop before further writes.
    """
    print(f'[{cwd or Path.cwd()}] {" ".join(map(str, args))}', flush=True)
    result = subprocess.run(args, cwd=cwd, check=True, text=True,
                            stdout=subprocess.PIPE if capture else None, env=env)
    return (result.stdout or '').strip()


def check_resume(kind, destination):
    """Verify that resuming will use an untouched checkout made by this script.

    @param kind: paper or prototype; destination: existing checkout path.
    @pre: The user explicitly selected --resume.
    @post: No files or Git state are changed.
    @return: None.
    @throws: RuntimeError for modified/unrelated checkouts; Git errors propagate.
    """
    if not (destination / '.git').is_dir():
        raise RuntimeError(f'Not a migration checkout: {destination}')
    repo = 'eics2027-hallmark' + ('-prototype' if kind == 'prototype' else '')
    expected = f'git@github-work:{OWNER}/{repo}.git'
    if run('git', 'remote', 'get-url', 'origin', cwd=destination,
           capture=True) != expected:
        raise RuntimeError(f'Unexpected remote in {destination}')
    subject = run('git', 'log', '-1', '--format=%s', cwd=destination, capture=True)
    if subject not in (f'Separate {kind} into its own repository',
                       'Repair standalone prototype migration'):
        raise RuntimeError(f'Checkout has subsequent commits: {destination}')
    if run('git', 'status', '--porcelain', '--untracked-files=all',
           cwd=destination, capture=True):
        raise RuntimeError(f'Checkout has local changes; preserving them: {destination}')


def verify(paper, prototype):
    """Install locked dependencies, build, and validate both migrated components.

    @param paper: Manuscript checkout; prototype: prototype checkout.
    @pre: Both checkouts were prepared or validated by check_resume.
    @post: Ignored dependencies/builds exist; source files remain unmodified.
    @return: None.
    @throws: CalledProcessError; publication must stop if any check fails.
    """
    run('npm', 'ci', '--include=dev', cwd=prototype)
    run('npm', 'run', 'build', cwd=prototype)
    environment = os.environ.copy()
    # Raw supplier files remain in the original, excluded local research tree.
    environment.setdefault('HALLMARK_NUUGAATSIAQ_SOURCE', str(
        SOURCE / 'demo/research/sources/nuugaatsiaq-20170619'))
    run('npm', 'test', cwd=prototype, env=environment)
    run('latexmk', cwd=paper)


def replace_known(path, old, new):
    """Apply a known migration adjustment once, rejecting unexpected file content.

    @param path: File to adjust; old/new: exact source fragments.
    @pre: Either the original or already-adjusted fragment exists exactly once.
    @post: File contains new; repeated calls leave it unchanged.
    @return: None.
    @throws: RuntimeError if neither fragment matches; OSError for file failures.
    """
    text = path.read_text()
    if new in text:
        return
    if text.count(old) != 1:
        raise RuntimeError(f'Unexpected source; refusing to patch {path}')
    path.write_text(text.replace(old, new, 1))


def adjust_prototype_files(prototype):
    """Make the migrated prototype independently buildable and testable.

    @param prototype: Staging directory containing supported source files.
    @pre: Supported source fragments are available in a disposable directory.
    @post: Diagnostic module is bundled, external raw-data location is configurable,
        and display assertions use the established height-spread terminology.
    @return: None.
    @throws: RuntimeError for unexpected source; file errors propagate.
    """
    build = prototype / 'tools/build-standalone.mjs'
    replace_known(build, "'src/core/query.js', 'src/core/index.js'",
                  "'src/core/query.js', 'src/core/diagnostic.js', 'src/core/index.js'")
    # Parser-based removal keeps strings, regexes, and ASI-sensitive newlines intact.
    # This retains the existing 690 KiB page-size budget with diagnostics included.
    replace_known(build, "import { createHash } from 'node:crypto';", """import { createHash } from 'node:crypto';
import {parse} from 'acorn';

/** Remove comments from emitted modules without changing JavaScript semantics.
 * @param {string} source Original module source.
 * @pre Source is a valid ECMAScript module.
 * @post Original files are unchanged; line terminators remain intact.
 * @return {string} Source with comments replaced by whitespace.
 * @throws {SyntaxError} If the module cannot be parsed.
 */
function stripComments(source) {
  const comments=[];
  parse(source,{ecmaVersion:'latest',sourceType:'module',onComment:comments});
  let result='',offset=0;
  for(const {start,end} of comments){
    result+=source.slice(offset,start)+' '+source.slice(start,end).replace(/[^\\r\\n]/g,'');
    offset=end;
  }
  return result+source.slice(offset);
}""")
    replace_known(build, "let src = readFileSync(join(root, path), 'utf8');",
                  "let src = stripComments(readFileSync(join(root, path), 'utf8'));")
    prepare = prototype / 'tools/prepare-nuugaatsiaq-editor-data.mjs'
    replace_known(prepare,
                  "const source=resolve(root,'../demo/research/sources/nuugaatsiaq-20170619');",
                  "const source=resolve(process.env.HALLMARK_NUUGAATSIAQ_SOURCE || "
                  "resolve(root,'local-data/nuugaatsiaq-20170619'));")
    test = prototype / 'tests/nuugaatsiaq-editor.test.mjs'
    replace_known(test, "import {readFileSync,mkdtempSync,rmSync} from 'node:fs';",
                  "import {readFileSync,mkdtempSync,rmSync,existsSync} from 'node:fs';")
    replace_known(test, "import {join} from 'node:path';",
                  "import {join,resolve} from 'node:path';\n"
                  "import {fileURLToPath} from 'node:url';")
    replace_known(test,
                  "test('Nuugaatsiaq preparation is offline, deterministic and preserves every native DEM/mask/matchtag sample',async()=>{",
                  """// Raw supplier downloads are optional; retained-fixture tests below always run.
const sourceDirectory=process.env.HALLMARK_NUUGAATSIAQ_SOURCE ||
 resolve(fileURLToPath(new URL('../local-data/nuugaatsiaq-20170619/',import.meta.url)));
const missingRawSources=Object.values(m.rasters).some(asset=>!existsSync(join(sourceDirectory,asset.source)));
test('Nuugaatsiaq preparation is offline, deterministic and preserves every native DEM/mask/matchtag sample',{
 skip: !process.env.HALLMARK_NUUGAATSIAQ_SOURCE && missingRawSources
  ? 'Set HALLMARK_NUUGAATSIAQ_SOURCE to verify optional original supplier downloads' : false,
},async()=>{""")
    replace_known(prototype / 'tests/combined-overview.test.mjs',
                  "new RegExp(branch));", "new RegExp(branch==='roughness'?'height spread':branch));")
    replace_known(prototype / 'tests/step-inspector.test.mjs',
                  "new RegExp(branch,'i'));", "new RegExp(branch==='roughness'?'height spread':branch,'i'));")
    replace_known(prototype / 'tests/interaction-rendering.test.mjs',
                  '/Roughness · analysis cell row 10, col 12/',
                  '/Height spread · analysis cell row 10, col 12/')
    ignore = prototype / '.gitignore'
    if '/local-data/' not in ignore.read_text().splitlines():
        ignore.write_text(ignore.read_text() + '\n/local-data/\n')
    readme = prototype / 'README.md'
    if 'HALLMARK_NUUGAATSIAQ_SOURCE' not in readme.read_text():
        with readme.open('a') as output:
            output.write('\n## Original supplier downloads\n\n'
                         'Run `npm ci --include=dev`, `npm run build`, then `npm test`. '
                         'The retained-fixture tests need no external downloads. '
                         'To also run the raw Nuugaatsiaq extraction check, set '
                         '`HALLMARK_NUUGAATSIAQ_SOURCE` to the directory containing '
                         '`dem-2km.tif`, `mask-2km.tif`, and `matchtag-2km.tif`. '
                         'Alternatively place those files in ignored '
                         '`local-data/nuugaatsiaq-20170619/`.\n')


def repair_prototype(prototype):
    """Stage and commit known standalone fixes without partially patching source.

    @param prototype: Clean migration checkout, validated by the caller.
    @pre: No user changes are present; Git identity is configured.
    @post: Adjustments are committed, or unexpected source leaves files untouched.
    @return: None.
    @throws: RuntimeError for unsupported source; file/Git errors propagate.
    """
    names = ('tools/build-standalone.mjs', 'tools/prepare-nuugaatsiaq-editor-data.mjs',
             'tests/nuugaatsiaq-editor.test.mjs', 'tests/combined-overview.test.mjs',
             'tests/step-inspector.test.mjs', 'tests/interaction-rendering.test.mjs',
             '.gitignore', 'README.md')
    with tempfile.TemporaryDirectory(prefix='hallmark-repair-') as folder:
        stage = Path(folder)
        for name in names:
            target = stage / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(prototype / name, target)
        adjust_prototype_files(stage)
        changed = [name for name in names
                   if (stage / name).read_bytes() != (prototype / name).read_bytes()]
        for name in changed:
            shutil.copy2(stage / name, prototype / name)
    if changed:
        run('git', 'add', '--all', cwd=prototype)
        run('git', 'commit', '-m', 'Repair standalone prototype migration', cwd=prototype)


def files_under(relative):
    """Select current tracked and unignored files beneath a source directory.

    @param relative: Repository-relative directory.
    @pre: SOURCE is a Git working copy.
    @post: No source files are changed; build/review folders are excluded.
    @return: Sorted existing file paths relative to SOURCE.
    @throws: CalledProcessError when Git cannot enumerate the source.
    """
    raw = subprocess.run(['git', 'ls-files', '-z', '--cached', '--others',
                          '--exclude-standard', '--', relative], cwd=SOURCE,
                         check=True, stdout=subprocess.PIPE).stdout
    excluded = {'build', 'dist', 'reviews', 'review-notes', 'node_modules',
                '__pycache__', '.venv', 'venv', '.git'}
    return sorted({Path(p.decode()) for p in raw.split(b'\0') if p
                   and not (excluded & set(Path(p.decode()).parts))
                   and (SOURCE / p.decode()).is_file()})


def prepare(kind, relative, destination, files):
    """Create an independent checkout from the selected current source files.

    @param kind: paper or prototype; relative: source directory.
    @param destination: New checkout directory; files: selected source paths.
    @pre: Destination does not exist; originals remain available.
    @post: A local commit contains only this component and its ignore rules.
    @return: None.
    @throws: OSError or CalledProcessError; original checkout stays untouched.
    """
    if kind == 'paper':
        # Keep existing published ancestry, so publishing needs no force push.
        run('git', 'clone', '--no-hardlinks', '--no-checkout', str(SOURCE),
            str(destination))
        run('git', 'read-tree', '--empty', cwd=destination)
        run('git', 'remote', 'set-url', 'origin',
            f'git@github-work:{OWNER}/eics2027-hallmark.git', cwd=destination)
    else:
        destination.mkdir()
        run('git', 'init', '-b', 'main', cwd=destination)
        run('git', 'remote', 'add', 'origin',
            f'git@github-work:{OWNER}/eics2027-hallmark-prototype.git',
            cwd=destination)
    for source in files:
        target = destination / source.relative_to(relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(SOURCE / source, target, follow_symlinks=False)
    ignore = destination / '.gitignore'
    previous = ignore.read_text() if ignore.exists() else ''
    ignore.write_text(previous + '\n' + IGNORE)
    if kind == 'prototype':
        # Retain the documented route rule required by the existing test suite.
        docs = destination / 'docs'
        docs.mkdir(exist_ok=True)
        for name in ('paper-route-rule.md', 'lunar-evidence-cases.md'):
            shutil.copy2(SOURCE / 'demo/research' / name, docs / name)
        test = destination / 'tests/paper-configuration.test.mjs'
        test.write_text(test.read_text().replace(
            '../../demo/research/paper-route-rule.md', '../docs/paper-route-rule.md'))
        readme = destination / 'README.md'
        readme.write_text(readme.read_text().replace(
            '../demo/research/paper-route-rule.md', 'docs/paper-route-rule.md').replace(
            '../demo/research/lunar-evidence-cases.md', 'docs/lunar-evidence-cases.md'))
    run('git', 'add', '--all', cwd=destination)
    run('git', 'commit', '-m', f'Separate {kind} into its own repository',
        cwd=destination)


def main():
    """Inspect, prepare, and optionally publish the two component repositories.

    @pre: Git is installed; --push additionally requires authorized gh and SSH.
    @post: Originals remain untouched; publishing occurs only with --push.
    @return: None; print destination paths and outcomes.
    @throws: RuntimeError on unsafe destinations; subprocess errors on failure.
    """
    global SOURCE
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--push', action='store_true')
    parser.add_argument('--resume', action='store_true',
                        help='Validate and reuse checkouts from an interrupted run')
    parser.add_argument('--source', type=Path, default=SOURCE,
                        help='Original combined checkout; it remains untouched')
    parser.add_argument('--output-dir', type=Path,
                        help='Parent directory for the two new checkouts')
    args = parser.parse_args()
    SOURCE = args.source.expanduser().resolve()
    output_dir = (args.output_dir or SOURCE.parent).expanduser().resolve()
    plans = [
        ('paper', Path('demo/paper'), output_dir / 'eics2027-hallmark-paper'),
        ('prototype', Path('prototype'), output_dir / 'eics2027-hallmark-prototype'),
    ]
    selected = [(kind, path, dest, files_under(str(path)))
                for kind, path, dest in plans]
    for kind, path, dest, files in selected:
        if not files:
            raise RuntimeError(f'No source files found in {path}')
        if dest == SOURCE or SOURCE in dest.parents:
            raise RuntimeError('Destinations must be outside the original checkout')
        print(f'{kind}: {len(files)} files from {path}/ -> {dest}', flush=True)
        if dest.exists():
            if args.resume:
                check_resume(kind, dest)
            else:
                raise RuntimeError(f'Destination exists: {dest}. Use --resume to '
                                   'validate and reuse migration checkouts.')
    if not (args.apply or args.push):
        print('Inspection only. Use --apply to create checkouts or --push to publish.')
        return
    output_dir.mkdir(parents=True, exist_ok=True)
    for kind, path, dest, files in selected:
        if not dest.exists():
            prepare(kind, path, dest, files)
    repair_prototype(selected[1][2])
    # Verify the independently usable components before either push.
    verify(selected[0][2], selected[1][2])
    if args.push:
        run('gh', 'auth', 'status')
        name = f'{OWNER}/eics2027-hallmark-prototype'
        check = subprocess.run(['gh', 'repo', 'view', name],
                               stdout=subprocess.DEVNULL)
        if check.returncode:
            run('gh', 'repo', 'create', name, '--private')
        for _, _, dest, _ in selected:
            run('git', 'push', '-u', 'origin', 'HEAD:main', cwd=dest)
            print(f'Published {dest.name}', flush=True)


if __name__ == '__main__':
    try:
        main()
    except subprocess.CalledProcessError as error:
        print(f'Stopped: {error.cmd} exited with status {error.returncode}. '
              'Existing checkouts are preserved; use --resume after fixing the error.',
              file=sys.stderr)
        sys.exit(error.returncode)
    except (RuntimeError, OSError) as error:
        print(f'Stopped: {error}', file=sys.stderr)
        sys.exit(1)
