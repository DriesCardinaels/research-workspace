"""Registered project/document route family, independent of response/socket handling."""
import base64
import json

from research_workbench.application.imports import import_directory
from research_workbench.application.review import Markup
from research_workbench.application.entries import ProjectEntries
from research_workbench.application.repository import RepositorySync
from research_workbench.application.draft_operations import DraftOperations
from research_workbench.domain.errors import ConflictError
from research_workbench.infrastructure.filesystem.storage import json_bytes


class ProjectRoutes:
    """Translate project request paths into public application operations."""

    def __init__(self, app, method):
        """@param app,method: Application owner and authorized HTTP method.
        @pre Handler already validated host/origin/token. @post Only dependencies retained.
        @return None. @throws None.
        """
        self.__app, self.__method = app, method

    def dispatch(self, path, raw=b'', query=None):
        """Dispatch one project request with short metadata locks and detached output.

        @param path,raw,query: Parsed path, complete bounded bytes and query parameter tuples.
        @pre Authentication and body-size checks completed before this call.
        @post No response/socket writes occur; builds execute outside the application lock.
        @return tuple: Status/body/optional MIME. @throws Exception: Caller translates operation failures.
        """
        if self.__method != 'GET':
            return self.mutate(path, raw)
        with self.__app.lock:
            code, result, *mime = self.get_project(path, query)
            if isinstance(result, (dict, list)):
                result = json_bytes(result)
        return code, result, *mime

    def get_project(self, path, query=None):
        """Route a project read to the owning public operation.

        @param path: Validated filesystem target, route path or schema location as described above.
        @param query: Parsed query parameter lists.
        @pre Inputs satisfy the operation description; dependencies are initialized.
        @post Read-only snapshot/artifact is produced under the caller lock.
        @return tuple: Status, body and optional MIME type
        @throws ValueError,FileNotFoundError,SourceError,OSError: Invalid or unreadable target.
        """
        parts = path.strip('/').split('/')
        project = self.project(parts)
        if len(parts) == 5 and parts[3] == 'latex' and parts[4] in ('source', 'citations'):
            from research_workbench.application.standalone import StandaloneLatex
            service = StandaloneLatex(project, self.__app.lock)
            selected = ((query or {}).get('path') or [''])[0]
            operation = service.status if parts[4] == 'source' else service.citations
            return (200, operation(selected))
        if len(parts) == 4 and parts[3] == 'image-file':
            q = query or {}
            raw, mime = project.image_file((q.get('path') or [''])[0], (q.get('source_document') or [None])[0])
            return (200, raw, mime)
        if len(parts) == 4 and parts[3] == 'text-file':
            q = query or {}
            return (200, project.text_file((q.get('path') or [''])[0], (q.get('source_document') or [None])[0]))
        if len(parts) == 4 and parts[3] == 'github':
            return (200, RepositorySync(project).status())
        if len(parts) == 4 and parts[3] == 'tree':
            return (200, project.tree())
        if len(parts) == 7 and parts[3] == 'documents' and parts[5:] == ['markup', 'revision']:
            scope = ((query or {}).get('scope') or ['auto'])[0]
            return (200, Markup(project, project.doc(parts[4]), scope).revision())
        if len(parts) == 6 and parts[3] == 'documents' and parts[5] == 'markup':
            scope = ((query or {}).get('scope') or ['auto'])[0]
            return (200, Markup(project, project.doc(parts[4]), scope).read())
        if len(parts) >= 6 and parts[3] == 'documents' and parts[5] == 'draft':
            return self.get_draft(project, project.doc(parts[4]), parts[6:], query or {})
        if len(parts) == 4 and parts[3] == 'folders':
            return (200, project.folders())
        if len(parts) == 4 and parts[3] in ('documents', 'deleted'):
            return (200, project.documents(deleted=parts[3] == 'deleted'))
        if len(parts) == 6 and parts[3] == 'documents':
            d = project.doc(parts[4])
            kind = parts[5]
            if kind == 'source-preview-annotations':
                if not d.get('source_main'):
                    raise FileNotFoundError('Source preview not found.')
                return (200, {'version': 1, 'highlights': [], 'strokes': []})
            if kind == 'source-preview':
                if not d.get('source_main'):
                    raise FileNotFoundError('Source preview not found.')
                return (200, (project.drafts.published(d['paper_id']) / 'draft.pdf').read_bytes(), 'application/pdf')
            if kind == 'versions':
                return (200, project.versions(d))
            if kind == 'annotations':
                return (200, project.annotations(d))
            if kind in ('original', 'annotated'):
                return (200, project.path(d, kind).read_bytes(), 'application/pdf')
        raise FileNotFoundError('Route not found.')


    def get_draft(self, project, d, rest, query):
        """Route a draft read to its public source/review operation.

        @param project: Input used by the operation described above.
        @param d: Document snapshot containing exact version identity.
        @param rest: Remaining route path segments.
        @param query: Parsed query parameter lists.
        @pre Inputs satisfy the operation description; dependencies are initialized.
        @post No source text is modified.
        @return tuple: Status, body and optional MIME type
        @throws ValueError,FileNotFoundError,SourceError,OSError: Invalid or unreadable draft.
        """
        drafts = project.drafts
        q = lambda k: (query.get(k) or [''])[0]
        if rest == []:
            return (200, drafts.status(d))
        if rest == ['citations']:
            return (200, drafts.citations(d))
        if rest == ['history']:
            path = drafts.dir / 'history' / (d['id'] + '.json')
            return (200, json.loads(path.read_text()) if path.is_file() else None)
        if rest == ['file']:
            return (200, drafts.read_file(d, q('path')))
        if rest == ['pdf']:
            return (200, drafts.draft_pdf(d), 'application/pdf')
        if rest == ['active-file', 'pdf']:
            return (200, drafts.active_file_pdf(d, q('path')), 'application/pdf')
        if rest == ['no-figures', 'pdf']:
            return (200, drafts.no_figures_pdf(d), 'application/pdf')
        if rest == ['synctex', 'edit']:
            return (200, drafts.pdf_to_source(d, int(q('page')), float(q('x')), float(q('y'))))
        if rest == ['synctex', 'view']:
            return (200, drafts.source_to_pdf(d, q('path'), int(q('line'))))
        raise FileNotFoundError('Route not found.')


    def project(self, parts):
        """Resolve an already opened project session.

        @param parts: Parsed route segments including exact project/document IDs.
        @pre Inputs satisfy the operation description; dependencies are initialized.
        @post No project folder is opened or created.
        @return Project: Existing public application owner
        @throws FileNotFoundError: Unknown or expired session.
        """
        if len(parts) < 3 or parts[:2] != ['api', 'projects'] or parts[2] not in self.__app.projects:
            raise FileNotFoundError('Project session expired. Reopen the project folder.')
        return self.__app.projects[parts[2]]


    def mutate(self, path, raw):
        """Authorize and dispatch mutations with bounded body and deliberate lock scope.

        @param None: No explicit inputs.
        @pre Inputs satisfy the operation description; dependencies are initialized.
        @post One matching operation runs; long builds do not retain the application lock.
        @return None
        @throws PermissionError,ValueError,FileNotFoundError,OSError: Authorization or operation failure.
        """
        app = self.__app
        parts = path.strip('/').split('/')
        if self.__method == 'POST' and ((len(parts) == 5 and parts[3:] == ['latex', 'archive'])
                or (len(parts) == 7 and parts[3] == 'documents' and parts[5:] == ['draft', 'archive'])):
            data = json.loads(raw or b'{}')
            with app.lock:
                project = self.project(parts)
                if len(parts) == 5:
                    if not isinstance(data, dict) or set(data) != {'path'} or not isinstance(data['path'], str):
                        raise ValueError('Source export requires only a relative main path.')
                    from research_workbench.application.standalone import StandaloneLatex
                    _, main_file = StandaloneLatex(project, app.lock).target(data['path'])
                    source_root, main = project.root, str(main_file.relative_to(project.root))
                else:
                    if data != {}:
                        raise ValueError('Linked source export accepts an empty object.')
                    document = project.doc(parts[4])
                    project.require_active(document)
                    cfg, _ = project.drafts.require(document)
                    source_root, main = cfg['root_path'], cfg['main']
            from research_workbench.application.source_archive import SourceArchive
            archive = SourceArchive(project.drafts.latexmk).create(source_root, main)
            return (200, archive, 'application/zip')
        if len(parts) == 5 and parts[3:] == ['latex', 'compile'] and self.__method == 'POST':
            data = json.loads(raw or b'{}')
            if not isinstance(data, dict) or set(data) != {'path'} or not isinstance(data['path'], str):
                raise ValueError('Compile requires only a relative source path.')
            with app.lock:
                project = self.project(parts)
            from research_workbench.application.standalone import StandaloneLatex
            service = StandaloneLatex(project, app.lock, lambda: app.projects.get(parts[2]) is project)
            return (200, service.compile(data['path']))
        if len(parts) == 5 and parts[3:] == ['github', 'push'] and self.__method == 'POST':
            with app.lock:
                project = self.project(parts)
            return (200, RepositorySync(project).push(json.loads(raw)))
        if len(parts) == 7 and parts[3] == 'documents' and parts[5] == 'draft' and parts[6] in ('compile', 'compile-active', 'no-figures', 'promote') and self.__method == 'POST':
            # LaTeX builds can take a minute; they must not hold the library lock.
            return self.slow_draft(parts, raw)
        # Snapshot under the lock; a paused PDF download must not hold the library lock.
        with app.lock:
            code, body, *content_type = self.mutate_project(path, raw)
            if isinstance(body, (dict, list)):
                body = json_bytes(body)
        return (code, body, *content_type)


    def slow_draft(self, parts, raw):
        """Validate a build request before starting external work.
        Pre: authenticated POST; post: object input dispatched or HTTP 400 via handle_error.
        Validation failures never compile, commit, or change project state.

        @param parts: Parsed route segments including exact project/document IDs.
        @param raw: Complete request body bytes.
        @pre Inputs satisfy the operation description; dependencies are initialized.
        @post Effects and output follow the operation description above; caller-owned input is retained unless explicitly documented.
        @return The computed value described above.
        @throws Validation/IO errors described above propagate; none for valid pure inputs.
        """
        data = json.loads(raw or b'{}')
        if not isinstance(data, dict):
            raise ValueError('Send a JSON object.')
        app = self.__app
        with app.lock:
            project = self.project(parts)
            d = project.doc(parts[4])
            project.require_active(d)
        result = DraftOperations(app.lock).run(project, d, parts[6], data)
        return (201 if parts[6] == 'promote' else 200, result)


    def mutate_draft(self, project, d, rest, data):
        """Dispatch a validated draft mutation through public owner operations.

        @param project: Input used by the operation described above.
        @param d: Document snapshot containing exact version identity.
        @param rest: Remaining route path segments.
        @param data: Complete validated payload or immutable input bytes.
        @pre Inputs satisfy the operation description; dependencies are initialized.
        @post Only the requested source/review operation changes state.
        @return tuple: Status and operation result
        @throws ValueError,FileNotFoundError,SourceError,OSError: Invalid or failed operation.
        """
        drafts = project.drafts
        if rest == ['link'] and self.__method == 'POST':
            return (200, drafts.link(d, data.get('root'), data.get('main'), data.get('commit')))
        project.require_active(d)
        if rest == ['file'] and self.__method == 'PUT':
            return (200, drafts.write_file(d, data.get('path'), data.get('text'), data.get('sha')))
        if rest == ['notes'] and self.__method == 'POST':
            return (201, drafts.add_note(d, data.get('file'), data.get('start'), data.get('end'), data.get('quote'),
                                         data.get('text'), data.get('author'), data.get('origin'), data.get('style')))
        if rest == ['writing', 'ignores'] and self.__method == 'POST':
            return (200, drafts.set_writing_ignore(d, data.get('key'), data.get('rule'), data.get('file'), data.get('text'), data.get('ignored') is not False))
        if rest == ['strokes'] and self.__method == 'POST':
            return (201, drafts.add_stroke(d, data))
        if len(rest) == 3 and rest[0] == 'strokes' and rest[2] == 'status' and self.__method == 'POST':
            return (200, drafts.set_stroke_status(d, rest[1], data.get('status')))
        if len(rest) == 3 and rest[0] == 'notes' and self.__method == 'POST':
            if rest[2] == 'comments':
                return (201, drafts.reply_note(d, rest[1], data.get('text'), data.get('author')))
            if rest[2] == 'status':
                return (200, drafts.set_note_status(d, rest[1], data.get('status')))
        if len(rest) == 3 and rest[0] == 'changes' and self.__method == 'POST':
            if rest[2] == 'status':
                return (200, drafts.set_status(d, rest[1], data.get('status')))
            if rest[2] == 'revert':
                return (200, drafts.revert(d, rest[1]))
            if rest[2] == 'comments':
                return (201, drafts.comment(d, rest[1], data.get('text'), data.get('author')))
        raise FileNotFoundError('Route not found.')


    def mutate_project(self, path, raw):
        """Dispatch a locked project mutation through public owner operations.

        @param path: Validated filesystem target, route path or schema location as described above.
        @param raw: Complete request body bytes.
        @pre Inputs satisfy the operation description; dependencies are initialized.
        @post Only the requested project operation changes state.
        @return tuple: Status, body and optional MIME
        @throws ValueError,FileNotFoundError,ConflictError,OSError: Invalid or failed operation.
        """
        app = self.__app
        if path == '/api/projects' and self.__method == 'POST':
            key, project = app.choose(json.loads(raw)['folder'])
            return (200, {'id': key, 'folder': str(project.root), 'documents': project.documents(), 'folders': project.folders()})
        parts = path.strip('/').split('/')
        if len(parts) == 3 and parts[:2] == ['api', 'projects'] and self.__method == 'DELETE':
            return (200, app.remove_project(parts[2]))
        project = self.project(parts)
        if len(parts) == 5 and parts[3:] == ['entries', 'reveal'] and self.__method == 'POST':
            data = json.loads(raw)
            if not isinstance(data, dict) or set(data) - {'path', 'source_document', 'document'}:
                raise ValueError('Send a relative path or review document to reveal.')
            return (200, ProjectEntries(project, ConflictError).reveal(**data))
        if len(parts) == 4 and parts[3] == 'entries' and self.__method == 'POST':
            data = json.loads(raw)
            if (not isinstance(data, dict) or set(data) - {'kind', 'name', 'parent', 'source_document'}
                    or not {'kind', 'name'} <= set(data)):
                raise ValueError('Creation requires kind, name and an optional destination.')
            return (201, project.create_entry(**data))
        if len(parts) == 4 and parts[3] == 'entries' and self.__method == 'PATCH':
            data = json.loads(raw)
            if (not isinstance(data, dict) or set(data) - {'path', 'operation', 'destination', 'source_document'}
                    or not {'path', 'operation'} <= set(data)):
                raise ValueError('Send an entry path, operation and optional destination.')
            return (200, ProjectEntries(project, ConflictError).change(**data))
        if len(parts) == 4 and parts[3] == 'text-file' and self.__method == 'PUT':
            data = json.loads(raw)
            if not isinstance(data, dict):
                raise ValueError('Send a JSON object.')
            return (200, project.text_file(data.get('path'), data.get('source_document'), data))
        if len(parts) == 4 and parts[3] == 'github' and self.__method == 'PUT':
            if project.repository_lock.locked():
                raise RepositoryConflict('Wait for the current push to finish before changing its destination.')
            return (200, RepositorySync(project).save(json.loads(raw)))
        if len(parts) == 5 and parts[3:] == ['imports', 'directory'] and self.__method == 'POST':
            return (201, import_directory(project, json.loads(raw)))
        if len(parts) == 5 and parts[3:] == ['imports', 'file'] and self.__method == 'POST':
            from research_workbench.application.review import validate
            data = json.loads(raw)
            if isinstance(data, dict) and data.get('source_document') is None:
                data.pop('source_document', None)
            validate(data, {'type': 'object', 'additionalProperties': False,
                           'required': ['name', 'data'], 'properties': {
                               'name': {'type': 'string', 'minLength': 1},
                               'data': {'type': 'string'},
                               'parent': {'type': 'string'},
                               'source_document': {'type': 'string', 'minLength': 1}}})
            return (201, project.import_file(data['name'], base64.b64decode(data['data'], validate=True),
                                             data.get('parent', ''), data.get('source_document')))
        if len(parts) == 4 and parts[3] == 'open-file' and self.__method == 'POST':
            data = json.loads(raw)
            return (200, project.open_pdf_file(data['path'], data.get('source_document')))
        if len(parts) >= 6 and parts[3] == 'documents' and parts[5] == 'markup':
            data = json.loads(raw or b'{}')
            if not isinstance(data, dict):
                raise ValueError('Send a JSON object.')
            markup = Markup(project, project.doc(parts[4]), data.get('scope', 'auto'))
            if len(parts) == 6 and self.__method == 'POST':
                return (201, markup.create(data))
            if len(parts) == 8 and self.__method == 'POST':
                return (200, markup.mutate(parts[6], parts[7], data))
            if len(parts) == 7 and self.__method == 'DELETE':
                return (200, markup.mutate(parts[6], 'status', {**data, 'status': 'deleted'}))
            raise FileNotFoundError('Markup route not found.')
        if len(parts) >= 6 and parts[3] == 'documents' and parts[5] == 'draft':
            data = json.loads(raw or b'{}')
            if not isinstance(data, dict):
                raise ValueError('Send a JSON object.')
            return self.mutate_draft(project, project.doc(parts[4]), parts[6:], data)
        if len(parts) == 4 and parts[3] == 'reload' and self.__method == 'POST':
            project.reload()
            return (200, {'documents': project.documents(), 'folders': project.folders()})
        if len(parts) == 4 and parts[3] == 'folders' and self.__method == 'POST':
            return (201, project.create_folder(json.loads(raw)['name']))
        if len(parts) == 4 and parts[3] == 'import-check' and self.__method == 'POST':
            return (200, project.matches(json.loads(raw)['name']))
        if len(parts) == 6 and parts[3] == 'documents' and parts[5] == 'folder' and self.__method == 'PUT':
            return (200, project.move(project.doc(parts[4]), json.loads(raw).get('folder_id')))
        if len(parts) == 5 and parts[3] == 'documents' and self.__method == 'DELETE':
            d = project.doc(parts[4])
            project.set_deleted(d, True)
            return (200, {'deleted': d['id']})
        if len(parts) == 6 and parts[3] == 'documents' and parts[5] == 'restore' and self.__method == 'POST':
            d = project.doc(parts[4], include_deleted=True)
            project.set_deleted(d, False)
            return (200, project.doc(d['id']))
        if len(parts) == 4 and parts[3] == 'documents' and self.__method == 'POST':
            data = json.loads(raw)
            pdf = base64.b64decode(data['data'], validate=True)
            return (201, project.import_pdf(data['name'], pdf, folder_id=data.get('folder_id'), version_of=data.get('version_of'), separate=data.get('separate') is True))
        if len(parts) == 6 and parts[3] == 'documents' and self.__method == 'PUT':
            d = project.doc(parts[4])
            if parts[5] == 'annotations':
                data = json.loads(raw)
                saved = project.save_annotations(d, data)
                if isinstance(data, dict) and 'base' in data:
                    return (200, {**project.doc(d['id']), 'annotations': saved})
            elif parts[5] == 'annotated':
                project.export(d, raw)
            else:
                raise FileNotFoundError('Route not found.')
            return (200, project.doc(d['id']))
        raise FileNotFoundError('Route not found.')

