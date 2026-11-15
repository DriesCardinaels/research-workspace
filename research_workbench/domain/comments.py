"""Comment record creation independent of draft storage."""
import time
import uuid


def create_comment(text, author):
    """Create a normalized standalone thread message.

    @param text,author: Unicode message and optional author label.
    @pre Text is a string; the calling operation validated message requirements.
    @post A new record is returned; existing threads and storage remain unchanged.
    @return dict: New ID, stripped text/author and local timestamp.
    @throws AttributeError: Non-string message; callers validate input first.
    """
    if not isinstance(author, str) or not author.strip() or len(author) > 60:
        author = 'Author'
    return {'id': uuid.uuid4().hex[:12], 'text': text.strip(), 'author': author.strip(),
            'created_at': time.strftime('%Y-%m-%dT%H:%M:%S%z')}
