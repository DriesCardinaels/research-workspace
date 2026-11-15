"""Compatibility imports; new code uses research_workbench.application.review."""
from research_workbench.application.review import (
    Markup, MarkupConflict, merge_annotations, SCOPE, TEXT, NUMBER, PAGE, RECT, CREATE_SCHEMA, validate
)

__all__ = ['Markup', 'MarkupConflict', 'merge_annotations', 'SCOPE', 'TEXT', 'NUMBER', 'PAGE', 'RECT', 'CREATE_SCHEMA', 'validate']
