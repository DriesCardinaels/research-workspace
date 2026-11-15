"""Project-scoped GitHub targets and explicit, non-forced committed-source pushes."""
from research_workbench.domain.errors import RepositoryConflict
from research_workbench.infrastructure.filesystem.project_storage import PRIVATE_METADATA_DIRECTORIES
import json
import os
from pathlib import Path
import re
import subprocess
import time




class RepositorySync:
    def __init__(self, project):
        """Bind project-local settings. Pre: loaded Project; post: no network or Git writes."""
        self.project = project
        self.path = project.meta / 'github.json'

    @staticmethod
    def failure(args, result):
        """Classify Git failures without returning untrusted remote or credential-helper output.

        @param args: Internal Git argument list. @param result: Failed captured process result.
        @pre Result has a nonzero return code. @post No Git, credential or project changes occur.
        @return ValueError/RepositoryConflict with a fixed, actionable diagnostic.
        @throws None. Raw stdout/stderr and credential-bearing URLs are never interpolated.
        """
        output = (result.stderr + b'\n' + result.stdout).decode('utf-8', 'replace').lower()
        if any(term in output for term in ('non-fast-forward', 'fetch first', '[rejected]')):
            return RepositoryConflict('Remote changes must be integrated before pushing. Nothing was overwritten.')
        if 'host key verification failed' in output or 'remote host identification has changed' in output:
            return ValueError('GitHub SSH host-key verification failed. Verify the GitHub host key in the terminal used to start the workbench.')
        if 'permission denied (publickey' in output or 'no supported authentication methods' in output:
            return ValueError('GitHub rejected SSH authentication. The workbench server needs access to the correct SSH key or SSH agent. Test ssh -T git@github.com in the terminal used to start the server.')
        if 'authentication failed' in output or 'could not read username' in output:
            return ValueError('GitHub rejected HTTPS authentication. Configure the Git credential helper for the account that has repository access.')
        if 'could not resolve hostname' in output or 'could not resolve host:' in output:
            return ValueError('GitHub could not be resolved. Check DNS and the network connection.')
        if any(term in output for term in ('connection timed out', 'connection refused', 'network is unreachable', 'failed to connect', 'connection reset', 'no route to host')):
            return ValueError('GitHub could not be reached. Check the network, firewall and selected Git transport.')
        if 'repository not found' in output or 'does not appear to be a git repository' in output:
            return ValueError('The GitHub repository was not found or is not accessible to these credentials. Check the repository URL and account access.')
        if any(term in output for term in ('gh006', 'gh013', 'protected branch', 'repository rule', 'pre-receive hook declined')):
            return ValueError('GitHub rejected the push under repository rules. Check branch protection and the required pull-request workflow.')
        if 'write access' in output or 'access denied' in output or ('permission to ' in output and 'denied' in output):
            return ValueError('GitHub denied write access. The authenticated account or key needs permission to push to this repository.')
        if args and args[0] == 'subtree':
            return ValueError('Source history export failed. Check that Git subtree is installed and this source folder has committed history.')
        stages = {'push': 'Git push', 'rev-parse': 'Git source lookup', 'status': 'Git status',
                  'ls-tree': 'Git source inspection', 'log': 'Git history inspection'}
        return ValueError(stages.get(args[0] if args else '', 'Git operation') +
                          ' failed (exit ' + str(result.returncode) + '). Run the equivalent Git command in a terminal for its full diagnostic.')

    def run(self, root, *args, check=True):
        """Execute bounded, noninteractive Git and report sanitized failure categories.

        @param root: Authorized source repository. @param args: Internal Git arguments.
        @param check: Whether nonzero exit codes raise a classified error.
        @pre Arguments were validated by the repository operation.
        @post Exactly one command executes; no automatic retry, force push or credential prompt occurs.
        @return Captured CompletedProcess. @throws RepositoryConflict: Remote divergence.
        @throws ValueError: Authentication, transport, repository, local Git or timeout failure.
        """
        env = {**os.environ, 'GIT_TERMINAL_PROMPT': '0',
               'GIT_SSH_COMMAND': 'ssh -o BatchMode=yes -o ConnectTimeout=15'}
        try:
            result = subprocess.run(['git', *args], cwd=root, env=env, capture_output=True, timeout=120)
        except subprocess.TimeoutExpired:
            raise ValueError('Git operation timed out after 120 seconds. Check repository connectivity and credentials in the terminal used to start the server.') from None
        except OSError:
            raise ValueError('Git could not be started. Check that Git is installed and the source repository is accessible.') from None
        if check and result.returncode:
            raise self.failure(args, result)
        return result

    def load(self):
        """Read the saved target. Pre: project; post: settings or empty object.
        Symlinks, invalid JSON and IO failures propagate without remote access.
        """
        if self.path.is_symlink():
            raise ValueError('Repository settings cannot be a symbolic link.')
        return json.loads(self.path.read_text()) if self.path.exists() else {}

    def source(self, paper_id):
        """Resolve a live linked source. Pre: stable paper ID; post: active document/config.
        Missing/deleted/unlinked papers fail before any network operation.
        """
        doc = next((d for d in self.project.documents() if d['paper_id'] == paper_id), None)
        if not doc:
            raise ValueError('Select an active paper with linked LaTeX source.')
        cfg = self.project.drafts.config(doc)
        if not cfg or cfg.get('error'):
            raise ValueError('The selected paper needs a valid LaTeX source link.')
        return doc, cfg

    @staticmethod
    def url(value):
        """Validate an exact GitHub repository URL. Pre: string; post: credential-free URL.
        Other hosts, embedded credentials, query strings and option injection are rejected.
        """
        if not isinstance(value, str) or not re.fullmatch(r'(?:https://github\.com/|git@github\.com:)[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.-]+(?:\.git)?/?', value):
            raise ValueError('Use https://github.com/owner/repo or git@github.com:owner/repo.git, without credentials.')
        value = value.rstrip('/')
        name = value.rsplit('/', 1)[-1]
        if name in ('.', '..', '.git'):
            raise ValueError('Enter a repository name.')
        return value

    def status(self):
        """Describe the saved target and source choices. Pre: project; post: local status.
        No fetch, push, commits, remote configuration or credential prompts occur.
        """
        config = self.load()
        sources = []
        for doc in self.project.documents():
            cfg = self.project.drafts.config(doc)
            if cfg and not cfg.get('error'):
                sources.append({'paper_id': doc['paper_id'], 'name': doc['name'], 'root': str(cfg['root_path'])})
        result = {'linked': bool(config), 'sources': sources, **config}
        if config:
            try:
                _, cfg = self.source(config['paper_id'])
                result['head'] = self.run(cfg['top'], 'rev-parse', 'HEAD').stdout.decode().strip()
                prefix = str(cfg['root_path'].relative_to(cfg['top']))
                result['source_root'] = str(cfg['root_path'])
                result['scope'] = 'source folder' if prefix != '.' else 'source repository'
                result['uncommitted'] = bool(self.run(cfg['top'], 'status', '--porcelain', '--', prefix).stdout)
            except ValueError as error:
                result['error'] = str(error)
        return result

    def save(self, data):
        """Serialize link changes against pushes. Pre: proposed link; post: atomic settings.
        Concurrent publishing fails immediately instead of changing its reviewed target.
        """
        if not self.project.repository_lock.acquire(blocking=False):
            raise RepositoryConflict('Wait for the current push before changing its destination.')
        try:
            return self._save(data)
        finally:
            self.project.repository_lock.release()

    def _save(self, data):
        """Save a per-project destination without publishing. Pre: URL/branch/paper ID;
        post: atomic local link only. Invalid refs, source links and fields are rejected.
        """
        from research_workbench.infrastructure.filesystem.storage import atomic_existing as atomic, json_bytes
        if not isinstance(data, dict) or set(data) != {'url', 'branch', 'paper_id'}:
            raise ValueError('Send url, branch and paper_id only.')
        url = self.url(data['url'])
        _, cfg = self.source(data['paper_id'])
        branch = data['branch']
        if not isinstance(branch, str) or not branch or branch.startswith('-') or self.run(cfg['top'], 'check-ref-format', 'refs/heads/' + branch, check=False).returncode:
            raise ValueError('Enter a valid target branch.')
        self.load()  # Refuse symbolic-linked settings before writing.
        atomic(self.path, json_bytes({'url': url, 'branch': branch, 'paper_id': data['paper_id']}))
        return self.status()

    def push(self, data):
        """Push the reviewed source commit to exactly the saved GitHub branch.
        Pre: explicit expected URL, branch and HEAD; post: normal fast-forward push,
        or a conflict/error. Nested sources use subtree history; no parent files,
        automatic commits, force pushes or remote URL changes are performed.
        """
        from research_workbench.infrastructure.filesystem.storage import atomic_existing as atomic, json_bytes
        if not isinstance(data, dict) or set(data) != {'expected_url', 'expected_branch', 'expected_head'}:
            raise ValueError('Review the URL, branch and source HEAD before pushing.')
        lock = self.project.repository_lock
        if not lock.acquire(blocking=False):
            raise RepositoryConflict('A repository operation is already running.')
        try:
            config = self.load()
            if not config or (config.get('url'), config.get('branch')) != (data['expected_url'], data['expected_branch']):
                raise RepositoryConflict('The repository destination changed. Review it again.')
            self.url(config['url'])
            _, cfg = self.source(config['paper_id'])
            head = self.run(cfg['top'], 'rev-parse', 'HEAD').stdout.decode().strip()
            if not re.fullmatch('[a-f0-9]{40,64}', str(data['expected_head'])) or head != data['expected_head']:
                raise RepositoryConflict('Source commits changed. Review the latest commit before pushing.')
            prefix = str(cfg['root_path'].relative_to(cfg['top']))
            commit = head
            if prefix != '.':
                lines = self.run(cfg['top'], 'subtree', 'split', '--prefix=' + prefix, head).stdout.decode().strip().splitlines()
                commit = lines[-1] if lines else ''
                if not re.fullmatch('[a-f0-9]{40,64}', commit):
                    raise ValueError('The source folder has no committed history to push.')
            tracked = self.run(cfg['top'], 'ls-tree', '-r', '--name-only', commit).stdout.decode('utf-8', 'replace').splitlines()
            review_history = self.run(cfg['top'], 'log', '--format=', '--name-only', commit, '--',
                                      *(':(glob)**/' + name + '/**' for name in PRIVATE_METADATA_DIRECTORIES)).stdout.strip()
            if review_history or any(name in Path(path).parts for path in tracked for name in PRIVATE_METADATA_DIRECTORIES):
                raise ValueError('Committed review storage was found in the source tree. Remove it from Git tracking before publishing.')
            if self.load() != config or self.run(cfg['top'], 'rev-parse', 'HEAD').stdout.decode().strip() != head:
                raise RepositoryConflict('The link or source commits changed. Review them again.')
            self.run(cfg['top'], 'push', '--porcelain', '--', config['url'], commit + ':refs/heads/' + config['branch'])
            latest = self.load()
            if latest == config:
                atomic(self.path, json_bytes({**config, 'last_push': {'at': time.time(), 'source_head': head, 'pushed_commit': commit}}))
            return {'pushed': True, 'url': config['url'], 'branch': config['branch'], 'source_head': head, 'commit': commit}
        finally:
            lock.release()
