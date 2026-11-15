"""Explicit file handling capabilities, independent of UI and draft persistence."""
from dataclasses import dataclass
import copy
import json
from pathlib import Path
import re


@dataclass(frozen=True)
class FileHandler:
    """Immutable permissions; importing never implies editing, review or compilation."""
    id: str
    extensions: tuple
    editable: bool = False
    review: bool = False
    prose: bool = False
    preview_mime: str | None = None
    preview_signature: bytes = b''
    initial_text: str = ''


class FileHandlerRegistry:
    """Resolve file capabilities without exposing mutable registry storage."""

    def __init__(self):
        """Initialize this owner and its documented dependencies.

        @param None: No explicit inputs.
        @pre Inputs satisfy the operation description; dependencies are initialized.
        @post Private registry storage is initialized.
        @return None
        @throws ValueError,OSError: Invalid initial state or IO failure where initialization requires storage.
        """
        self.__handlers = {}
        self.__extensions = {}
        self.__descriptors = {}

    def register(self, handler, descriptor=None):
        """Register explicit file permissions.

        @param handler: Immutable FileHandler definition.
        @param descriptor: Optional trusted browser metadata; copied and validated before registration.
        @pre: ID and extensions are unique.
        @post: All extensions register together; invalid input changes nothing.
        @return: This registry.
        @throws ValueError: Invalid or duplicate definition.
        """
        if (not isinstance(handler, FileHandler) or not isinstance(handler.id, str) or not handler.id.strip() or not isinstance(handler.extensions, tuple)
                or not handler.extensions or any(not isinstance(ext, str) or not re.fullmatch(r'\.[a-z0-9]+', ext) for ext in handler.extensions)
                or not isinstance(handler.initial_text, str)
                or any(type(flag) is not bool for flag in (handler.editable, handler.review, handler.prose))):
            raise ValueError('Invalid file handler.')
        if (not isinstance(handler.preview_signature, bytes)
                or (handler.preview_mime is None and handler.preview_signature)
                or (handler.preview_mime is not None and (not isinstance(handler.preview_mime, str)
                    or not re.fullmatch(r'image/[a-z0-9.+-]+', handler.preview_mime)
                    or not handler.preview_signature))):
            raise ValueError('Image preview requires an explicit MIME type and binary signature.')
        if handler.id in self.__handlers or len(set(handler.extensions)) != len(handler.extensions) or any(ext in self.__extensions for ext in handler.extensions):
            raise ValueError('File handler id or extension already registered.')
        public = copy.deepcopy(descriptor or {
            'id': handler.id, 'label': handler.id, 'extensions': list(handler.extensions),
            'adapter': 'text' if handler.editable else 'image' if handler.preview_mime else 'pdf',
            'kind': 'text' if handler.editable else 'image' if handler.preview_mime else 'pdf',
            'capabilities': {'text': handler.editable, 'image': bool(handler.preview_mime), 'sourceReview': handler.review},
            **({'mime': handler.preview_mime} if handler.preview_mime else {}),
        })
        validate_descriptor(public, handler)
        self.__descriptors[handler.id] = public
        self.__handlers[handler.id] = handler
        self.__extensions.update((ext, handler) for ext in handler.extensions)
        return self

    def resolve(self, name):
        """@param name: Filename. @pre None. @post No changes.
        @return Immutable handler or None. @throws TypeError: Non-path input.
        """
        return self.__extensions.get(Path(name).suffix.lower())


    def catalog(self):
        """Read public browser metadata without granting client-side permissions.

        @param None: No arguments. @pre Registry initialized.
        @post Private registry and descriptors remain unchanged.
        @return dict: Versioned, detached catalog in registration order.
        @throws None.
        """
        return {'schemaVersion': 1, 'types': copy.deepcopy(list(self.__descriptors.values()))}


def validate_descriptor(descriptor, handler):
    """Validate trusted presentation against authoritative file permissions.

    @param descriptor,handler: Browser metadata and immutable permission definition.
    @pre No registration has been published.
    @post Inputs are unchanged. @return None.
    @throws ValueError: Invalid metadata, unsupported fields or contradictory permissions.
    """
    keys = {'id', 'label', 'extensions', 'adapter', 'kind', 'mode', 'mime',
            'toolbarAreas', 'standaloneToolbarAreas', 'capabilities'}
    if (not isinstance(descriptor, dict) or set(descriptor) - keys
            or descriptor.get('id') != handler.id
            or descriptor.get('extensions') != list(handler.extensions)
            or any(not isinstance(descriptor.get(key), str) or not descriptor[key].strip()
                   for key in ('label', 'adapter', 'kind'))):
        raise ValueError('Invalid filetype descriptor identity or adapter.')
    capabilities = descriptor.get('capabilities', {})
    if not isinstance(capabilities, dict) or any(not isinstance(key, str) or type(value) is not bool for key, value in capabilities.items()):
        raise ValueError('Filetype capabilities must be boolean metadata.')
    if (bool(capabilities.get('text')) != handler.editable
            or bool(capabilities.get('sourceReview')) != handler.review
            or bool(capabilities.get('image')) != bool(handler.preview_mime)
            or descriptor.get('mime') != handler.preview_mime):
        raise ValueError('Filetype capabilities disagree with server permissions.')
    for key in ('toolbarAreas', 'standaloneToolbarAreas'):
        if key in descriptor and (not isinstance(descriptor[key], list)
                or any(not isinstance(area, str) or not area.strip() for area in descriptor[key])):
            raise ValueError('Toolbar areas must contain names.')
    if 'mode' in descriptor and (not isinstance(descriptor['mode'], str) or not descriptor['mode'].strip()):
        raise ValueError('Filetype mode must be nonblank text.')


def load_registry(path):
    """Load a trusted inert catalog, publishing nothing on malformed input.

    @param path: JSON catalog chosen by application composition, never a request path.
    @pre Installed catalog is readable; all definitions use schemaVersion 1.
    @post New independent registry is built; existing registries/files are untouched.
    @return FileHandlerRegistry: Validated backend permissions and public descriptors.
    @throws OSError,ValueError,TypeError: Unreadable, invalid or ambiguous catalog.
    """
    catalog = json.loads(Path(path).read_text(encoding='utf-8'))
    if (not isinstance(catalog, dict) or set(catalog) != {'schemaVersion', 'types'}
            or type(catalog['schemaVersion']) is not int or catalog['schemaVersion'] != 1
            or not isinstance(catalog['types'], list)):
        raise ValueError('Unsupported filetype catalog.')
    registry = FileHandlerRegistry()
    for entry in catalog['types']:
        if not isinstance(entry, dict):
            raise ValueError('Filetype entries must be objects.')
        descriptor = {key: value for key, value in entry.items() if key != 'permissions'}
        permissions = entry.get('permissions', {})
        if not isinstance(permissions, dict) or set(permissions) - {'editable', 'review', 'prose', 'preview_mime', 'preview_signature', 'initial_text'}:
            raise ValueError('Unsupported backend file permissions.')
        permissions = dict(permissions)
        if 'preview_signature' in permissions:
            permissions['preview_signature'] = bytes.fromhex(permissions['preview_signature'])
        extensions = entry.get('extensions')
        if not isinstance(extensions, list):
            raise ValueError('Filetypes require explicit extensions.')
        handler = FileHandler(entry.get('id'), tuple(extensions), **permissions)
        registry.register(handler, descriptor)
    return registry


handlers = load_registry(Path(__file__).resolve().parents[2] / 'extensions' / 'filetypes.json')
