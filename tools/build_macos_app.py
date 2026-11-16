#!/usr/bin/env python3
"""Build a local native Workbench app pointing to an existing source checkout."""
import argparse
import os
from pathlib import Path
import platform
import plistlib
import shutil
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[1]


def build_bundle(output, *, root=ROOT, python=sys.executable, port=8766, settings=None, icon=None):
    """Compile and atomically publish an absent app bundle without installing or changing another app.

    @param output,root,python,port,settings,icon: Destination and trusted local runtime configuration.
    @pre macOS, Swift compiler and Python 3.10+; output absent; icon optional .icns file.
    @post A signed local source-checkout host exists; staging is removed on failure.
    @return Path: Absolute app bundle. @throws ValueError,OSError,CalledProcessError,TimeoutExpired: Bad input/build.
    """
    output, root, python = Path(output).absolute(), Path(root).resolve(), Path(python).resolve()
    if platform.system() != 'Darwin':
        raise ValueError('The native Workbench host requires macOS and the Swift command-line tools.')
    if output.exists() or output.suffix != '.app':
        raise ValueError('Choose an absent output path ending in .app; existing applications are never overwritten.')
    if not (root / 'research_workbench.py').is_file() or not 1 <= port <= 65535:
        raise ValueError('A Workbench source checkout and valid loopback port are required.')
    subprocess.run([str(python), '-c', 'import sys; assert sys.version_info >= (3, 10), "Python 3.10+ required"'],
                   check=True, timeout=5, capture_output=True)
    if icon is not None and (Path(icon).suffix != '.icns' or not Path(icon).is_file()):
        raise ValueError('The optional icon must be an existing .icns file.')
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.workbench-build-', dir=output.parent) as temporary:
        staging = Path(temporary) / output.name
        executable = staging / 'Contents/MacOS/Research Workbench'
        resources = staging / 'Contents/Resources'
        executable.parent.mkdir(parents=True)
        resources.mkdir(parents=True)
        subprocess.run(['swiftc', '-swift-version', '5', '-target', platform.machine() + '-apple-macosx12.0',
                        '-module-cache-path', str(Path(temporary) / 'module-cache'),
                        '-framework', 'AppKit', '-framework', 'WebKit',
                        *map(str, sorted((ROOT / 'native/macos').glob('*.swift'))), '-o', str(executable)],
                       check=True, timeout=180)
        info = {
            'CFBundleExecutable': executable.name, 'CFBundleIdentifier': 'be.driescardinaels.research-workbench',
            'CFBundleName': 'Research Workbench', 'CFBundleDisplayName': 'Research Workbench',
            'CFBundlePackageType': 'APPL', 'CFBundleShortVersionString': '1.0', 'CFBundleVersion': '1',
            'LSMinimumSystemVersion': '12.0', 'NSHighResolutionCapable': True,
            'NSPrincipalClass': 'NSApplication',
            'NSAppTransportSecurity': {'NSAllowsLocalNetworking': True, 'NSAllowsArbitraryLoadsInWebContent': True},
            'WorkbenchRoot': str(root), 'WorkbenchPython': str(python), 'WorkbenchPort': port,
            'WorkbenchPath': os.environ.get('PATH', '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/Library/TeX/texbin'),
        }
        if settings is not None:
            info['WorkbenchSettings'] = str(Path(settings).resolve())
        if icon is not None:
            shutil.copyfile(icon, resources / 'Workbench.icns')
            info['CFBundleIconFile'] = 'Workbench.icns'
        for filename in ('LICENSE', 'NOTICE'):
            shutil.copyfile(ROOT / filename, resources / filename)
        with (staging / 'Contents/Info.plist').open('wb') as stream:
            plistlib.dump(info, stream)
        subprocess.run(['/usr/bin/codesign', '--force', '--sign', '-', str(staging)], check=True, timeout=30,
                       capture_output=True)
        staging.rename(output)
    return output


def main(argv=None):
    """Build an uninstalled local app from explicit source/runtime paths.

    @param argv: CLI arguments or None. @pre macOS with Swift/Python.
    @post New bundle printed; existing apps/settings/projects unchanged. @return None.
    @throws SystemExit: Bad CLI; ValueError,OSError,SubprocessError: Build failure.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'native/macos/build/Research Workbench.app')
    parser.add_argument('--root', type=Path, default=ROOT, help='Existing source checkout used at runtime')
    parser.add_argument('--python', type=Path, default=Path(sys.executable), help='Persistent Python 3.10+ executable')
    parser.add_argument('--port', type=int, default=8766)
    parser.add_argument('--settings', type=Path, help='Optional existing/new settings path; otherwise normal CLI default')
    parser.add_argument('--icon', type=Path, help='Optional existing .icns, copied into the new bundle')
    args = parser.parse_args(argv)
    print(build_bundle(args.output, root=args.root, python=args.python, port=args.port,
                       settings=args.settings, icon=args.icon))


if __name__ == '__main__':
    main()
