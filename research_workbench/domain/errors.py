"""Stable domain exceptions shared by application and transport adapters."""

class SourceError(ValueError):
    pass



class ConflictError(ValueError):
    def __init__(self, message, matches=None):
        """Initialize this owner and its documented dependencies.

        @param message: Public error description.
        @param matches: Optional detached conflicting document snapshots.
        @pre Inputs satisfy the operation description; dependencies are initialized.
        @post Public error message and optional conflict snapshots are retained.
        @return None
        @throws ValueError,OSError: Invalid initial state or IO failure where initialization requires storage.
        """
        super().__init__(message)
        self.matches = matches


class MarkupConflict(ValueError):
    """A stale selection or concurrent edit requires the caller to read again."""


class RepositoryConflict(ValueError):
    """The reviewed destination or source HEAD changed before a push."""

