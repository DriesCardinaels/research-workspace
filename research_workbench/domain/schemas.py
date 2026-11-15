"""HTTP request contracts without persistence or transport imports."""
import math

SCOPE = {'type': 'string', 'enum': ['auto', 'draft', 'pdf'],
         'description': 'auto uses the linked LaTeX draft for an active version, otherwise PDF review. Use the returned scope for subsequent calls.'}


TEXT = {'type': 'string', 'maxLength': 20000}


NUMBER = {'type': 'number', 'minimum': 0}


PAGE = {'type': 'integer', 'minimum': 1}


RECT = {'type': 'object', 'additionalProperties': False,
        'required': ['p', 'x', 'y', 'w', 'h'],
        'properties': {'p': PAGE, 'x': NUMBER, 'y': NUMBER,
                       'w': {'type': 'number', 'exclusiveMinimum': 0},
                       'h': {'type': 'number', 'exclusiveMinimum': 0}}}


CREATE_SCHEMA = {
    'type': 'object', 'additionalProperties': False, 'required': ['kind'],
    'properties': {
        'scope': SCOPE,
        'kind': {'type': 'string', 'enum': ['comment', 'highlight', 'strikethrough', 'replace', 'pen'], 'description': 'comment requires target and text; highlight/strikethrough require target; replace requires target and replacement; pen requires page, points, width and #RRGGBB color.'},
        'target': {'type': 'object', 'additionalProperties': False, 'properties': {
            'file': {'type': 'string', 'minLength': 1},
            'quote': TEXT,
            'start': {'type': 'integer', 'minimum': 0},
            'end': {'type': 'integer', 'minimum': 1},
            'occurrence': {'type': 'integer', 'minimum': 1},
            'rects': {'type': 'array', 'items': RECT, 'minItems': 1, 'maxItems': 5000}},
            'description': 'Draft: file plus exact source quote; optional Unicode code-point start/end or 1-based occurrence. PDF: quote plus scale-1, top-left rectangles (p is 1-based).'},
        'text': {**TEXT, 'description': 'Comment body. Required for comment; optional explanation for other text marks.'},
        'replacement': {**TEXT, 'description': 'Required for replace; stored as a replacement comment, never applied to source.'},
        'author': {'type': 'string', 'minLength': 1, 'maxLength': 60},
        'color': {'type': 'string', 'description': 'yellow, green, blue or pink for text; #RRGGBB for pen.'},
        'page': PAGE,
        'width': {'type': 'number', 'exclusiveMinimum': 0},
        'points': {'type': 'array', 'minItems': 1, 'maxItems': 5000,
                   'items': {'type': 'array', 'items': NUMBER, 'minItems': 2, 'maxItems': 2}},
        'anchor': {'type': 'object', 'additionalProperties': False,
                   'required': ['words', 'context', 'dx', 'dy'], 'properties': {
                       'words': {'type': 'array', 'minItems': 1, 'maxItems': 12, 'items': {'type': 'string', 'maxLength': 60}},
                       'context': {'type': 'array', 'maxItems': 12, 'items': {'type': 'string', 'maxLength': 60}},
                       'dx': {'type': 'number'}, 'dy': {'type': 'number'}}},
    },
}


def validate(value, schema, path='request'):
    """Validate the shared JSON-schema subset recursively.

    @param value: Input JSON value or bibliography field text.
    @param schema: Trusted shared JSON-schema subset.
    @param path: Validated filesystem target, route path or schema location as described above.
    @pre Inputs satisfy the operation description; dependencies are initialized.
    @post Input values and schemas remain unchanged.
    @return None
    @throws ValueError: Contract violation; KeyError: Unsupported schema type.

    Check our JSON-schema subset. Pre: a schema above; post: no mutations.
    Raises ValueError for invalid input; used by HTTP clients before persistence.
    """
    kind = schema['type']
    valid = {'object': isinstance(value, dict), 'array': isinstance(value, list),
             'string': isinstance(value, str), 'boolean': isinstance(value, bool),
             'integer': type(value) is int,
             'number': type(value) in (int, float) and math.isfinite(value)}[kind]
    if not valid:
        raise ValueError(f'{path} must be {kind}.')
    if 'enum' in schema and value not in schema['enum']:
        raise ValueError(f'{path} must be one of: {", ".join(schema["enum"])}.')
    if kind == 'object':
        fields = schema.get('properties', {})
        if schema.get('additionalProperties') is False and set(value) - set(fields):
            raise ValueError(f'{path}: unknown fields: {", ".join(sorted(set(value) - set(fields)))}.')
        for key in schema.get('required', []):
            if key not in value:
                raise ValueError(f'{path}.{key} is required.')
        for key in value.keys() & fields.keys():
            validate(value[key], fields[key], path + '.' + key)
    if kind == 'array':
        if len(value) < schema.get('minItems', 0) or len(value) > schema.get('maxItems', math.inf):
            raise ValueError(f'{path} has an invalid number of items.')
        for item in value:
            validate(item, schema['items'], path + '[]')
    if kind == 'string' and (len(value) < schema.get('minLength', 0) or len(value) > schema.get('maxLength', math.inf)):
        raise ValueError(f'{path} has an invalid length.')
    if kind in ('number', 'integer'):
        if value < schema.get('minimum', -math.inf) or value <= schema.get('exclusiveMinimum', -math.inf):
            raise ValueError(f'{path} is out of range.')


DIRECTORY_SCHEMA = {'type': 'object', 'additionalProperties': False,
    'required': ['folder_path', 'collection_name'], 'properties': {
        'folder_path': {'type': 'string', 'minLength': 1},
        'collection_name': {'type': 'string', 'minLength': 1, 'maxLength': 100},
        'recursive': {'type': 'boolean'},
        'duplicate_mode': {'type': 'string', 'enum': ['error', 'skip', 'separate']}}}

