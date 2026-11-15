"""Project metadata naming and lossless migration from the historical directory."""

METADATA_DIRECTORY = '.research-workbench'
LEGACY_METADATA_DIRECTORY = '.pdf-editor'
PRIVATE_METADATA_DIRECTORIES = (METADATA_DIRECTORY, LEGACY_METADATA_DIRECTORY)


def metadata_directory(root):
    """Resolve metadata storage, moving the previous directory only when safe.

    @param root: Authorized existing project root as a Path.
    @pre Caller serializes project initialization; root is a real directory.
    @post Legacy-only metadata is renamed intact; conflicting directories are untouched.
    @return Path: Canonical metadata directory, created later by Project.
    @throws ValueError: Symlink, non-directory or ambiguous parallel storage.
    @throws OSError: Rename failed; no merge or deletion is attempted.
    Related: Project constructs all metadata owners from the returned path.
    """
    current = root / METADATA_DIRECTORY
    legacy = root / LEGACY_METADATA_DIRECTORY
    for path in (current, legacy):
        if path.is_symlink() or (path.exists() and not path.is_dir()):
            raise ValueError('Managed metadata must be a real directory.')
    if legacy.exists():
        if current.exists():
            raise ValueError('Two metadata directories exist. Resolve the duplicate before opening this project; both were kept.')
        legacy.rename(current)
    return current
