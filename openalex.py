"""Compatibility imports; new code uses research_workbench.infrastructure.metadata.openalex."""
from research_workbench.infrastructure.metadata.openalex import (
    OpenAlex, NoRedirect, entries, normalized
)

__all__ = ['OpenAlex', 'NoRedirect', 'entries', 'normalized']
