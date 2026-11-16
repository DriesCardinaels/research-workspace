"""Project registration, settings and loaded sessions; no HTTP dependency."""
import json
from pathlib import Path
import secrets
import threading
import uuid

from research_workbench.infrastructure.metadata.openalex import OpenAlex
from research_workbench.application.projects import Project
from research_workbench.infrastructure.filesystem.storage import atomic_existing as atomic, json_bytes
from research_workbench.resources import ROOT as HERE

class App:
    def __init__(self, settings=None, *, project_factory=Project, provider_factory=OpenAlex):
        """Initialize this owner and its documented dependencies.

        @param settings: Optional local settings-file path.
        @param project_factory,provider_factory: Public project and metadata-owner constructors.
        @pre Inputs satisfy the operation description; dependencies are initialized.
        @post Settings and cached registrations load without opening project folders.
        @return None
        @throws ValueError,OSError: Invalid initial state or IO failure where initialization requires storage.
        """
        self.settings = Path(settings or HERE / '.settings.json')
        self.__project_factory = project_factory
        self.openalex = provider_factory(self.settings.with_name(self.settings.stem + '-openalex.json'))
        self.projects = {}
        self.lock = threading.RLock()
        self.token = secrets.token_urlsafe(32)
        self.__lifecycle = None
        self.last_folder = ''
        self.saved_projects = []
        try:
            settings_data = json.loads(self.settings.read_text())
            self.last_folder = settings_data.get('last_folder', '')
            self.saved_projects = settings_data.get('projects', [])
            if not isinstance(self.saved_projects, list):
                self.saved_projects = []
        except (OSError, ValueError):
            pass
        if self.last_folder:
            self.last_folder = str(Path(self.last_folder).expanduser().resolve())
        normalized = {}
        for entry in self.saved_projects:
            if isinstance(entry, dict) and isinstance(entry.get('folder'), str) and entry['folder'].strip():
                folder = str(Path(entry['folder']).expanduser().resolve())
                normalized[folder] = {'folder': folder}
        self.saved_projects = list(normalized.values())
        if self.last_folder and self.last_folder not in normalized:
            self.saved_projects.append({'folder': self.last_folder})

    def project_list(self):
        """List registered project roots without opening them.

        @param None: No explicit inputs.
        @pre Inputs satisfy the operation description; dependencies are initialized.
        @post No folders are created; unavailable projects remain listed.
        @return list[dict]: Registration/availability snapshots
        @throws OSError: Root availability inspection failed.

        List registered roots without opening or creating them.
        Pre: settings loaded; post: stable IDs and availability for the sidebar.
        No file contents are read; unavailable projects remain registered.
        """
        return [{**p, 'id': uuid.uuid5(uuid.NAMESPACE_URL, p['folder']).hex,
                 'name': Path(p['folder']).name or p['folder'],
                 'available': Path(p['folder']).is_dir()} for p in self.saved_projects]

    def save_settings(self):
        """Publish project registrations and selected root atomically.

        @param None: No explicit inputs.
        @pre Inputs satisfy the operation description; dependencies are initialized.
        @post Settings persist without changing project files.
        @return None
        @throws OSError: Settings publication failed.

        Atomically persist registered projects and active root.
        Pre: valid settings path; post: restart restores project selection.
        IO errors propagate to callers; project contents are stored separately.
        """
        atomic(self.settings, json_bytes({'last_folder': self.last_folder, 'projects': self.saved_projects}))

    def choose(self, folder):
        """Open or create a local project and register its stable identity.

        @param folder: Local project or destination directory.
        @pre Inputs satisfy the operation description; dependencies are initialized.
        @post Project is cached and registration persists.
        @return tuple: Stable ID and public Project owner
        @throws ValueError,OSError: Invalid root or failed project/settings publication.

        Open/register a local project. Pre: nonempty path; post: stable ID,
        durable registry and loaded Project. IO/format errors propagate.
        Existing PDF versions and source links are reused without migration.
        """
        if not isinstance(folder, str) or not folder.strip():
            raise ValueError('Enter or choose a project folder.')
        root = str(Path(folder).expanduser().resolve())
        key = uuid.uuid5(uuid.NAMESPACE_URL, root).hex
        project = self.projects.get(key) or self.__project_factory(root)
        self.projects[key] = project
        if not any(p.get('folder') == root for p in self.saved_projects):
            self.saved_projects.append({'folder': root})
        self.last_folder = root
        self.save_settings()
        return key, project

    def remove_project(self, project_id):
        """Forget one project registration without opening or deleting its folder.

        @param project_id: Stable ID from project_list(), including unavailable roots.
        @pre: Caller holds the application lock and HTTP mutations are authorized.
        @post: Settings no longer list the project; its cached session expires.
        Source files, PDFs, annotations, versions and repository data remain unchanged.
        If settings publication fails, memory and cached sessions remain unchanged.
        @return: Removed ID and the remaining project list.
        @throws FileNotFoundError: ID is not registered.
        @throws OSError: Atomic settings publication failed; the removal is rolled back.
        """
        entry = next((item for item in self.project_list() if item['id'] == project_id), None)
        if entry is None:
            raise FileNotFoundError('Project is not registered.')
        previous_projects, previous_folder = self.saved_projects, self.last_folder
        self.saved_projects = [item for item in previous_projects if item['folder'] != entry['folder']]
        if self.last_folder == entry['folder']:
            self.last_folder = ''
        try:
            self.save_settings()
        except Exception:
            self.saved_projects, self.last_folder = previous_projects, previous_folder
            raise
        self.projects.pop(project_id, None)
        return {'removed': project_id, 'projects': self.project_list()}

    def close(self):
        """Release project-owned temporary preview storage during application shutdown.

        @param None: No arguments. @pre Server has joined request threads.
        @post Loaded projects retain persistent files; their temporary previews are removed.
        @return None. @throws OSError,SourceError: Cleanup failed or a build is still active.
        """
        for project in list(self.projects.values()):
            project.drafts.close()

    def bind_lifecycle(self, lifecycle):
        """Bind the host's shutdown capability once during composition, before requests are accepted.

        @param lifecycle: ServerLifecycle-compatible snapshot/request_shutdown owner.
        @pre Startup composition only; application is not serving yet.
        @post One private capability is installed; settings/project state is unchanged.
        @return None. @throws ValueError: Already bound or invalid capability.
        """
        if self.__lifecycle is not None or not callable(getattr(lifecycle, 'request_shutdown', None)) or not callable(getattr(lifecycle, 'snapshot', None)):
            raise ValueError('A server lifecycle can be bound once at startup.')
        self.__lifecycle = lifecycle

    def server_status(self):
        """Read bounded local lifecycle/session data without inspecting projects or taking their lock.

        @param None. @pre Local read has passed host/origin authorization.
        @post No settings/projects are read or changed.
        @return dict: Application identity, current token and detached stop state.
        @throws ValueError: Host has not supplied shutdown support.
        """
        if self.__lifecycle is None:
            raise ValueError('This server does not support native shutdown. Restart it with the current launcher.')
        return {'application': 'research-workbench', 'protocol': 1, 'token': self.token, **self.__lifecycle.snapshot()}

    def request_shutdown(self):
        """Request graceful host shutdown through its private lifecycle capability.

        @param None. @pre Authenticated local mutation; no application/project lock held.
        @post No project data changes; active requests finish before application cleanup.
        @return dict: Accepted stopping status. @throws ValueError: Missing support; RuntimeError,OSError: Startup failed.
        """
        if self.__lifecycle is None:
            raise ValueError('This server does not support native shutdown. Restart it with the current launcher.')
        return self.__lifecycle.request_shutdown()
