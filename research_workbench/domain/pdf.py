"""Input validation for immutable imported PDF bytes."""
MAX_PDF = 200 * 1024 * 1024

def valid_pdf(data):
    """Validate imported PDF framing and the 200 MB limit.

    @param data: Complete validated payload or immutable input bytes.
    @pre Inputs satisfy the operation description; dependencies are initialized.
    @post Bytes remain unchanged.
    @return None
    @throws ValueError: Incomplete PDF or size limit exceeded.
    """
    if not data.startswith(b'%PDF-') or b'%%EOF' not in data[-4096:]:
        raise ValueError('This file is not a complete PDF.')
    if len(data) > MAX_PDF:
        raise ValueError('PDFs must be smaller than 200 MB.')
