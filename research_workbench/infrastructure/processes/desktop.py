"""Native desktop operations; unsupported platforms retain explicit path entry."""
import subprocess
import sys


def choose_folder():
    """Ask the macOS folder picker for an explicit local project root.

    @param None: User selects a path in the native UI. @pre Local authenticated caller.
    @post No application/project files change. @return dict: Folder or cancelled flag.
    @throws ValueError,OSError: Unsupported platform, timeout or unavailable native process.
    """
    if sys.platform != 'darwin':
        raise ValueError('Enter the folder path in the box on this computer.')
    try:
        result = subprocess.run(['osascript', '-e', 'POSIX path of (choose folder with prompt "Choose a PDF project folder")'],
                                capture_output=True, text=True, timeout=120)
    except subprocess.TimeoutExpired as error:
        raise ValueError('Folder selection timed out. You can enter a path instead.') from error
    return {'cancelled': True} if result.returncode else {'folder': result.stdout.strip()}
