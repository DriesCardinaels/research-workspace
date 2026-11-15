"""LaTeX drafts for the Research Workbench.

A draft is the working tree of a paper's LaTeX source, compared with the commit
of the paper's active (base) version. Changes are computed from that diff, so
edits made in this editor, in another editor or by an AI tool all show up. The
editor's own saves are logged, which lets each change say who made it.

Nothing here creates a library version until `promote` is called: it commits
the changed .tex and .bib files, builds the PDF from that commit and imports it.
"""
# Compatibility exports: implementations have one owner in research_workbench.
from research_workbench.domain.errors import SourceError
from research_workbench.domain.bibliography import strip_comments, cite_uses, bib_declared, parse_bib
from research_workbench.domain.review import word_changes, line_of, relocate
from research_workbench.domain.comments import create_comment
from research_workbench.domain.latex import NO_FIGURES_ENVS, NO_FIGURES_NOTE, UNSAFE_TEX_NAME, no_figures_wrapper
from research_workbench.application.builds import BuildRequest, BuildService, builtin_variants
from research_workbench.application.builds.service import log_pages
from research_workbench.application.builds.variants import removed_floats
from research_workbench.application.source_mapping import SourceMapping
from research_workbench.infrastructure.processes.synctex import query_synctex
from research_workbench.infrastructure.filesystem.storage import atomic_write as _atomic, json_bytes as _json, read_src, write_src, sha
from research_workbench.infrastructure.processes.git import git, git_text
from research_workbench.infrastructure.processes.latex import COMPILE_TIMEOUT, run_latexmk

import copy
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from research_workbench.extensions.filetypes import handlers as file_handlers

SOURCE_SUFFIX = '.tex'
EDITOR = 'editor'
OUTSIDE = 'outside the editor'

# -- Hide images: a second build of the working tree without its figures, to see the page count








class Drafts:
    """Draft state for the papers in one Research Workbench project."""

    def __init__(self, project, *, build_variants=None, compiler=None):
        """Create the source/review owner with replaceable build contributions.

        @param project: Public project owner. @param build_variants: Optional trusted plan registry.
        @param compiler: Optional bounded compiler callable; default retains the latexmk compatibility seam.
        @pre Project paths are authorized; supplied contributions implement their public interfaces.
        @post No build runs; all compile/export paths use the same injected compiler.
        @return None. @throws TypeError: Non-callable compiler dependency.
        """
        if compiler is not None:
            if not callable(compiler):
                raise TypeError('Compiler must be callable.')
            self.latexmk = compiler
        self.project = project
        self.dir = project.meta / 'drafts'
        self.sources_path = project.meta / 'sources.json'
        self.builds = BuildService(build_variants if build_variants is not None else builtin_variants(),
                                   lambda *args: self.latexmk(*args), self.lock)
        self.build_locks = {}
        self.locks_guard = threading.Lock()
        self.active_file_tmp = None
        self.no_figures_tmp = None  # TemporaryDirectory for Hide images builds, removed when the server stops

    def close(self):
        """Release isolated preview directories after all build requests stop.

        @param None: Project lifecycle shutdown. @pre Server request threads have completed.
        @post Active-file/figure-free temporary files are removed; manuscripts/history remain intact.
        @return None. @throws SourceError: A build still owns a lock; OSError: Cleanup failed.
        """
        with self.locks_guard:
            if any(lock.locked() for lock in self.build_locks.values()):
                raise SourceError('Wait for active builds before closing preview storage.')
            for name in ('active_file_tmp', 'no_figures_tmp'):
                directory = getattr(self, name)
                if directory is not None:
                    directory.cleanup()
                    setattr(self, name, None)

    # -- configuration
    def sources(self):
        if self.sources_path.exists():
            return json.loads(self.sources_path.read_text())
        return {}

    def config(self, doc):
        cfg = self.sources().get(doc['paper_id'])
        if not cfg:
            return None
        root = (self.project.root / cfg['root']).resolve()
        if not root.is_dir():
            return {**cfg, 'root_path': root, 'error': f'The linked source folder is missing: {root}. Link it again.'}
        top = git(root, 'rev-parse', '--show-toplevel', check=False)
        if top.returncode:
            return {**cfg, 'root_path': root, 'error': 'The linked source folder is no longer in a git repository. Link it again.'}
        return {**cfg, 'root_path': root, 'top': Path(top.stdout.decode().strip()).resolve()}

    def link(self, doc, root, main, commit):
        self.project.require_active(doc)
        if not isinstance(root, str) or not root.strip():
            raise SourceError('Enter the folder that holds the LaTeX source.')
        root_path = Path(root).expanduser()
        if not root_path.is_absolute():
            root_path = self.project.root / root_path
        root_path = root_path.resolve()
        if not root_path.is_dir():
            raise SourceError('Source folder not found: ' + str(root_path))
        if not isinstance(main, str) or not main.endswith(SOURCE_SUFFIX):
            raise SourceError('The main file must be a .tex file.')
        main_path = (root_path / main).resolve()
        if not main_path.is_relative_to(root_path) or not main_path.is_file():
            raise SourceError('Main file not found in the source folder.')
        if git(root_path, 'rev-parse', '--show-toplevel', check=False).returncode:
            raise SourceError('The source folder is not inside a git repository.')
        if not isinstance(commit, str) or not re.fullmatch(r'[0-9a-fA-F]{4,40}', commit.strip()):
            raise SourceError('Enter the commit this version was built from (a commit hash).')
        full = git(root_path, 'rev-parse', '--verify', '--quiet', commit.strip() + '^{commit}', check=False)
        if full.returncode:
            raise SourceError('Commit not found: ' + commit)
        full = full.stdout.decode().strip()
        if git(root_path, 'merge-base', '--is-ancestor', full, 'HEAD', check=False).returncode:
            raise SourceError('That commit is not part of the current branch history.')
        rel = os.path.relpath(root_path, self.project.root)
        sources = self.sources()
        sources[doc['paper_id']] = {'root': rel, 'main': str(main_path.relative_to(root_path))}
        _atomic(self.sources_path, _json(sources))
        self.project.set_source_commit(doc, full)
        return self.status(self.project.doc(doc['id']))

    def require(self, doc):
        cfg = self.config(doc)
        if not cfg:
            raise SourceError('Link this paper to its LaTeX source first.')
        if cfg.get('error'):
            raise SourceError(cfg['error'])
        active = self.active_version(doc)
        if not active.get('source_commit'):
            raise SourceError('The latest version has no source commit. Link the source again.')
        return cfg, active

    def active_version(self, doc):
        return next(v for v in self.project.versions(doc) if v['active'])

    # -- state file
    def state_path(self, paper_id):
        if not re.fullmatch('[a-f0-9]{32}', paper_id):
            raise ValueError('Invalid paper ID.')
        return self.dir / (paper_id + '.json')

    def load_state(self, doc, active):
        path = self.state_path(doc['paper_id'])
        if path.exists():
            state = json.loads(path.read_text())
            if state.get('base_version_id') == active['id'] and state.get('base_commit') == active['source_commit']:
                return state
            # A new version was imported some other way, or the source was re-linked
            # to another commit: keep the old draft history, start a new draft.
            relinked = state.get('base_version_id') == active['id']
            self.archive_state(doc['paper_id'], state, suffix='-relinked-' + str(int(time.time())) if relinked else '')
            if relinked:
                # Comments refer to source text, not to the commit: keep the open ones.
                fresh = self.load_state(doc, active)
                fresh['notes'] = [n for n in state.get('notes', []) if n.get('status') == 'open']
                return fresh
        return {'version': 1, 'paper_id': doc['paper_id'], 'base_version_id': active['id'],
                'base_number': active['number'], 'base_commit': active['source_commit'],
                'created_at': time.time(), 'records': [], 'saves': [], 'builds': []}

    def save_state(self, state):
        _atomic(self.state_path(state['paper_id']), _json(state))

    def archive_state(self, paper_id, state, suffix=''):
        target = self.dir / 'history' / (state['base_version_id'] + suffix + '.json')
        state = {**state, 'archived_at': time.time()}
        _atomic(target, _json(state))
        path = self.state_path(paper_id)
        if path.exists():
            path.unlink()
        return target

    # -- files
    def source_file(self, cfg, rel):
        if not isinstance(rel, str) or not (file_handlers.resolve(rel) and file_handlers.resolve(rel).review):
            raise SourceError('Only .tex and .bib files can be opened.')
        path = (cfg['root_path'] / rel).resolve()
        if not path.is_relative_to(cfg['root_path']):
            raise SourceError('That file is outside the source folder.')
        if (cfg['root_path'] / rel).is_symlink():
            raise SourceError('Linked files cannot be edited here.')
        return path

    def repo_rel(self, cfg, path):
        return str(Path(path).resolve().relative_to(cfg['top']))

    def base_text(self, cfg, commit, rel):
        path = self.source_file(cfg, rel)
        result = git(cfg['top'], 'show', commit + ':' + self.repo_rel(cfg, path), check=False)
        return result.stdout.decode('utf-8') if result.returncode == 0 else ''

    @staticmethod
    def _names(raw):
        return [n for n in raw.decode('utf-8', 'surrogateescape').split('\0') if n]

    def _usable(self, cfg, f):
        # Symlinks are never read or written here; they are left out, not an error.
        handler = file_handlers.resolve(f)
        return bool(handler and handler.review) and not (cfg['root_path'] / f).is_symlink()

    def editable_files(self, cfg):
        listed = self._names(git(cfg['root_path'], 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.').stdout)
        return sorted({f for f in listed if self._usable(cfg, f) and (cfg['root_path'] / f).is_file()})

    def tex_files(self, cfg):
        """List TeX inputs only. Pre: linked config; post: bibliography excluded from prose analysis.
        Git errors propagate; editable_files also supplies bibliography buffers to status.
        """
        return [f for f in self.editable_files(cfg) if f.endswith(SOURCE_SUFFIX)]

    def changed_files(self, cfg, commit):
        """Changed, new and deleted .tex and .bib files relative to `commit`."""
        out = self._names(git(cfg['root_path'], 'diff', '--name-only', '-z', '--relative', commit, '--', '.').stdout)
        untracked = self._names(git(cfg['root_path'], 'ls-files', '-z', '--others', '--exclude-standard', '--', '.').stdout)
        return sorted({f for f in out + untracked if self._usable(cfg, f)})

    def read_file(self, doc, rel):
        cfg, active = self.require(doc)
        path = self.source_file(cfg, rel)
        if not path.is_file():
            raise FileNotFoundError(f'{rel} does not exist in the working tree.')
        text = read_src(path)
        return {'file': rel, 'text': text, 'sha': sha(text)}

    def write_file(self, doc, rel, text, expected_sha):
        cfg, active = self.require(doc)
        if not isinstance(text, str):
            raise SourceError('Invalid file content.')
        path = self.source_file(cfg, rel)
        if not path.is_file():
            raise SourceError('Only existing files can be saved.')
        current = read_src(path)
        if sha(current) != expected_sha:
            raise SourceError('This file changed on disk since you opened it. Reload it before saving; your text is still in the editor.')
        state = self.load_state(doc, active)
        self._refresh(cfg, state, by=OUTSIDE)  # attribute earlier outside edits first
        write_src(path, text)
        state['saves'].append({'at': time.time(), 'file': rel, 'sha_before': expected_sha, 'sha_after': sha(text)})
        self._refresh(cfg, state, by=EDITOR, files={rel})
        self._anchor_notes(cfg, state, files={rel})
        self.save_state(state)
        return {'file': rel, 'sha': sha(text), 'changes': self.present(state),
                'notes': [n for n in state['notes'] if n.get('status') != 'deleted']}

    # -- changes
    def _refresh(self, cfg, state, by, files=None):
        """Recompute hunks and merge them into stored records.

        Each record keeps its id, status and comment thread while its base
        range overlaps the new hunk, so editing a passage twice keeps one
        record with a history of wordings.
        """
        now = time.time()
        commit = state['base_commit']
        changed = self.changed_files(cfg, commit)
        # An editor save only touches its own file; other files keep their attribution.
        scope = set(files) if files is not None else set(changed) | {r['file'] for r in state['records'] if r['present']}
        problems = {p['file']: p for p in state.get('problems', []) if p['file'] not in scope}
        for rel in sorted(scope):
            path = cfg['root_path'] / rel
            try:
                new = read_src(self.source_file(cfg, rel)) if path.is_file() else ''
                old = self.base_text(cfg, commit, rel)
            except SourceError as e:
                # One unreadable file must not block the draft; its records stay as they were.
                problems[rel] = {'file': rel, 'error': str(e)}
                continue
            hunks = word_changes(old, new) if rel in changed else []
            mine = [r for r in state['records'] if r['file'] == rel and r['present']]
            claimed = set()
            for h in hunks:
                overlapping = [r for r in mine if r['id'] not in claimed and
                               h['base_start'] <= r['base_end'] and r['base_start'] <= h['base_end']]
                # Keep the record that overlaps the most; others joined into this hunk are merged into it.
                overlapping.sort(key=lambda r: -(min(h['base_end'], r['base_end']) - max(h['base_start'], r['base_start'])))
                rec = overlapping[0] if overlapping else None
                for other in overlapping[1:]:
                    claimed.add(other['id'])
                    other.update(present=False, status='merged', merged_into=rec['id'])
                    other['history'].append({'at': now, 'text': other['new'], 'by': by, 'note': 'merged into a neighboring change'})
                    rec['comments'] += [{**c, 'from_change': other['id']} for c in other['comments']]
                if rec is None:
                    rec = next((r for r in state['records'] if r['file'] == rel and not r['present'] and
                                r['status'] == 'undone' and r['base_start'] == h['base_start'] and
                                r['old'] == h['old']), None)
                    if rec is not None:
                        rec['status'] = 'open'  # edited again after going back to the base text
                if rec is None:
                    rec = {'id': uuid.uuid4().hex[:12], 'file': rel, 'status': 'open', 'comments': [],
                           'history': [], 'created_at': now}
                    state['records'].append(rec)
                claimed.add(rec['id'])
                kind = 'replaced' if h['old'].strip() and h['new'].strip() else 'added' if h['new'].strip() else 'removed'
                rec.update(present=True, kind=kind, base_start=h['base_start'], base_end=h['base_end'],
                           old=h['old'], new=h['new'], new_start=h['new_start'], new_end=h['new_end'],
                           line=line_of(new, h['new_start']), end_line=line_of(new, max(h['new_start'], h['new_end'] - 1)),
                           before=new[max(0, h['new_start'] - 300):h['new_start']],
                           after=new[h['new_end']:h['new_end'] + 200])
                if not rec['history'] or rec['history'][-1]['text'] != h['new']:
                    rec['history'].append({'at': now, 'text': h['new'], 'by': by})
                    if rec['status'] == 'accepted':
                        rec['status'] = 'open'  # a new wording needs a new look
            for r in mine:
                if r['id'] not in claimed:
                    r['present'] = False
                    if r['status'] != 'reverted':
                        r['status'] = 'undone'
                        r['history'].append({'at': now, 'text': r['old'], 'by': by, 'note': 'back to the base text'})
        state['problems'] = sorted(problems.values(), key=lambda p: p['file'])

    # -- comments anchored in the source (shown in the source and on the PDF)
    def _anchor_notes(self, cfg, state, files=None):
        texts = {}
        for note in state.setdefault('notes', []):
            if files is not None and note['file'] not in files:
                continue
            if note['file'] not in texts:
                try:
                    path = self.source_file(cfg, note['file'])
                    texts[note['file']] = read_src(path) if path.is_file() else None
                except SourceError:
                    texts[note['file']] = None
            text = texts[note['file']]
            if text is None:
                note['anchor'] = 'lost'
                continue
            start, end, anchor = relocate(text, note)
            note.update(start=start, end=end, anchor=anchor, line=line_of(text, start),
                        end_line=line_of(text, max(start, end - 1)), current=text[start:end] if anchor != 'lost' else '')
            if anchor == 'ok':
                note['before'] = text[max(0, start - 300):start]
                note['after'] = text[end:end + 200]

    @staticmethod
    def _style(style):
        """Mark style from the PDF tools: highlight (color), strikethrough, or replacement."""
        if not isinstance(style, dict):
            return None
        kind = style.get('type')
        if kind not in ('highlight', 'strikethrough'):
            return None
        out = {'type': kind}
        if kind == 'highlight' and style.get('color') in ('yellow', 'green', 'blue', 'pink'):
            out['color'] = style['color']
        if kind == 'strikethrough' and style.get('intent') == 'replace':
            out['intent'] = 'replace'
        return out

    def add_note(self, doc, rel, start, end, quote, text, author, origin, style=None):
        cfg, active = self.require(doc)
        style = self._style(style)
        text = text if isinstance(text, str) else ''
        # A highlight or suggested removal may stand without words; a comment needs text.
        if (not text.strip() and not style) or len(text) > 20000:
            raise SourceError('Enter a comment.')
        if origin not in ('source', 'pdf'):
            origin = 'source'
        path = self.source_file(cfg, rel)
        rel = str(path.relative_to(cfg['root_path']))  # canonical form, e.g. './main.tex' -> 'main.tex'
        src = read_src(path)
        if not (isinstance(start, int) and isinstance(end, int) and 0 <= start < end <= len(src)):
            raise SourceError('Select the text to comment on.')
        if src[start:end] != quote:
            raise SourceError('The source changed since you selected this text. Select it again.')
        state = self.load_state(doc, active)
        now = time.strftime('%Y-%m-%dT%H:%M:%S%z')
        note = {'id': uuid.uuid4().hex[:12], 'file': rel, 'start': start, 'end': end, 'quote': quote,
                'before': src[max(0, start - 300):start], 'after': src[end:end + 200],
                'line': line_of(src, start), 'end_line': line_of(src, end - 1), 'current': quote,
                'anchor': 'ok', 'status': 'open', 'origin': origin, 'created_at': now,
                'comments': [create_comment(text, author)] if text.strip() else []}
        if style:
            note['style'] = style
        state.setdefault('notes', []).append(note)
        self.save_state(state)
        return note

    def find_note(self, state, note_id):
        for n in state.get('notes', []):
            if n['id'] == note_id:
                return n
        raise FileNotFoundError('Comment not found.')

    def reply_note(self, doc, note_id, text, author):
        cfg, active = self.require(doc)
        if not isinstance(text, str) or not text.strip() or len(text) > 20000:
            raise SourceError('Enter a comment.')
        state = self.load_state(doc, active)
        note = self.find_note(state, note_id)
        note['comments'].append(create_comment(text, author))
        self.save_state(state)
        return note

    def set_note_status(self, doc, note_id, status):
        cfg, active = self.require(doc)
        if status not in ('open', 'resolved', 'deleted'):
            raise SourceError('Unknown status.')
        state = self.load_state(doc, active)
        note = self.find_note(state, note_id)
        note['status'] = status
        note['resolved_at' if status == 'resolved' else 'reopened_at'] = time.strftime('%Y-%m-%dT%H:%M:%S%z')
        self.save_state(state)
        return note

    # -- pen strokes on the draft PDF, anchored to the source line under their first point
    def add_stroke(self, doc, stroke):
        cfg, active = self.require(doc)
        ok = (isinstance(stroke, dict) and isinstance(stroke.get('points'), list) and 0 < len(stroke['points']) <= 5000
              and all(isinstance(q, list) and len(q) == 2 and all(isinstance(v, (int, float)) for v in q) for q in stroke['points'])
              and re.fullmatch(r'#[0-9a-fA-F]{6}', str(stroke.get('color', ''))) and isinstance(stroke.get('width'), (int, float))
              and isinstance(stroke.get('page'), int) and stroke['page'] >= 1)
        if not ok:
            raise SourceError('Invalid pen stroke.')
        # Anchor: the printed words nearest the stroke's first point, plus its offset from the first word.
        anchor = stroke.get('anchor')
        if anchor is not None:
            words = lambda k: isinstance(anchor.get(k), list) and len(anchor[k]) <= 12 and all(isinstance(w, str) and len(w) <= 60 for w in anchor[k])
            if not (isinstance(anchor, dict) and words('words') and anchor['words'] and words('context')
                    and all(isinstance(anchor.get(k), (int, float)) for k in ('dx', 'dy'))):
                raise SourceError('Invalid stroke anchor.')
            anchor = {k: anchor[k] for k in ('words', 'context', 'dx', 'dy')}
        state = self.load_state(doc, active)
        item = {'id': uuid.uuid4().hex[:12], 'page': stroke['page'], 'color': stroke['color'], 'width': float(stroke['width']),
                'points': stroke['points'], 'anchor': anchor, 'status': 'open', 'created_at': time.strftime('%Y-%m-%dT%H:%M:%S%z')}
        state.setdefault('strokes', []).append(item)
        self.save_state(state)
        return item

    def set_stroke_status(self, doc, stroke_id, status):
        cfg, active = self.require(doc)
        if status not in ('open', 'deleted'):
            raise SourceError('Unknown status.')
        state = self.load_state(doc, active)
        for item in state.get('strokes', []):
            if item['id'] == stroke_id:
                item['status'] = status
                self.save_state(state)
                return item
        raise FileNotFoundError('Pen stroke not found.')

    def set_writing_ignore(self, doc, key, rule, file, text, ignored=True):
        """'Ignore here' for a writing mark: keyed by rule and sentence, so any edit to the sentence ends it."""
        cfg, active = self.require(doc)
        if not (isinstance(key, str) and re.fullmatch(r'[0-9a-z]{1,16}', key) and isinstance(rule, str) and re.fullmatch(r'[a-z-]{1,24}', rule)):
            raise SourceError('Invalid writing mark.')
        state = self.load_state(doc, active)
        items = [x for x in state.get('writing_ignores', []) if x['key'] != key]
        if ignored:
            items.append({'key': key, 'rule': rule, 'file': str(file)[:300] if file else None,
                          'text': str(text)[:300] if text else '', 'at': time.strftime('%Y-%m-%dT%H:%M:%S%z')})
        state['writing_ignores'] = items[-2000:]
        self.save_state(state)
        return {'writing_ignores': state['writing_ignores']}

    def carry_notes(self, doc, notes, from_version):
        """Start the new version's draft with the open comments of the previous draft."""
        cfg, active = self.require(doc)
        state = self.load_state(doc, active)
        state['notes'] = [{**n, 'carried_from': from_version} for n in notes]
        self._anchor_notes(cfg, state)
        self.save_state(state)

    def present(self, state):
        recs = [r for r in state['records'] if r['present']]
        return sorted(recs, key=lambda r: (r['file'], r['new_start']))

    def status(self, doc):
        cfg = self.config(doc)
        active = self.active_version(doc)
        out = {'linked': bool(cfg), 'source_commit': active.get('source_commit'), 'base_version_id': active['id'],
               'base_number': active['number']}
        if not cfg:
            return out
        out.update(root=str(cfg['root_path']), main=cfg['main'])
        out.update(library=str(self.project.root), state_file=str(self.state_path(doc['paper_id'])),
                   draft_pdf_path=str(self.published(doc['paper_id']) / 'draft.pdf'))
        if cfg.get('error'):
            out.update(linked=False, error=cfg['error'])
            return out
        if not active.get('source_commit'):
            out['linked'] = False
            return out
        state = self.load_state(doc, active)
        self._refresh(cfg, state, by=OUTSIDE)
        self._anchor_notes(cfg, state)
        self.save_state(state)
        build = self.published(doc['paper_id']) / 'draft.pdf'
        out.update(files=self.editable_files(cfg), changes=self.present(state), problems=state.get('problems', []),
                   notes=[n for n in state.get('notes', []) if n.get('status') != 'deleted'],
                   strokes=[x for x in state.get('strokes', []) if x.get('status') == 'open'],
                   writing_ignores=state.get('writing_ignores', []),
                   inactive=[r for r in state['records'] if not r['present']],
                   saves=len(state['saves']), builds=state['builds'][-5:],
                   draft_pdf=build.exists(), head=git_text(cfg['root_path'], 'rev-parse', 'HEAD'))
        return out

    def find(self, state, change_id):
        for r in state['records']:
            if r['id'] == change_id:
                return r
        raise FileNotFoundError('Change not found.')

    def set_status(self, doc, change_id, status):
        cfg, active = self.require(doc)
        if status not in ('open', 'accepted'):
            raise SourceError('Use Revert to undo a change.')
        state = self.load_state(doc, active)
        self._refresh(cfg, state, by=OUTSIDE)
        rec = self.find(state, change_id)
        if not rec['present']:
            raise SourceError('This change is no longer in the source.')
        rec['status'] = status
        self.save_state(state)
        return rec

    def revert(self, doc, change_id):
        cfg, active = self.require(doc)
        state = self.load_state(doc, active)
        self._refresh(cfg, state, by=OUTSIDE)
        rec = self.find(state, change_id)
        if not rec['present']:
            raise SourceError('This change is no longer in the source.')
        path = self.source_file(cfg, rec['file'])
        text = read_src(path) if path.is_file() else ''  # a deleted file is restored
        if text[rec['new_start']:rec['new_end']] != rec['new']:
            raise SourceError('The source changed. Reload and try again.')
        updated = text[:rec['new_start']] + rec['old'] + text[rec['new_end']:]
        write_src(path, updated)
        state['saves'].append({'at': time.time(), 'file': rec['file'], 'sha_before': sha(text),
                               'sha_after': sha(updated), 'revert': rec['id']})
        rec['status'] = 'reverted'
        rec['history'].append({'at': time.time(), 'text': rec['old'], 'by': EDITOR, 'note': 'reverted'})
        rec['present'] = False
        self._refresh(cfg, state, by=EDITOR, files={rec['file']})
        self._anchor_notes(cfg, state, files={rec['file']})
        self.save_state(state)
        return rec

    def comment(self, doc, change_id, text, author):
        cfg, active = self.require(doc)
        if not isinstance(text, str) or not text.strip() or len(text) > 20000:
            raise SourceError('Enter a comment.')
        if not isinstance(author, str) or not author.strip() or len(author) > 60:
            author = 'Author'
        state = self.load_state(doc, active)
        rec = self.find(state, change_id)
        item = {'id': uuid.uuid4().hex[:12], 'text': text.strip(), 'author': author.strip(),
                'created_at': time.strftime('%Y-%m-%dT%H:%M:%S%z')}
        rec['comments'].append(item)
        self.save_state(state)
        return rec

    # -- builds
    # -- citations
    def citations(self, doc):
        """Bib entries for completion, and cite keys in the .tex files that are empty or not in the .bib."""
        cfg, active = self.require(doc)
        root = cfg['root_path']
        files = self.tex_files(cfg)
        texts = {f: read_src(root / f) for f in files}
        bib_files = self._names(git(root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.bib').stdout)
        return self.source_citations(root, cfg['main'], texts, bib_files)

    @staticmethod
    def source_citations(root, main, texts, bib_files):
        """Analyze bibliography and citation data for a source workspace independently of Git.

        @param root: Validated source directory. @param main: Relative main filename.
        @param texts: Mapping of relative TeX filenames to source text.
        @param bib_files: Safe relative bibliography filenames for undeclared fallback.
        @pre Callers confine all supplied paths to root.
        @post Source, Git history and review state are unchanged.
        @return Existing citation payload used by completion and diagnostics.
        @throws OSError/SourceError: Source or bibliography read failure.
        """
        files = list(texts)
        names = []
        for f in [main] + [f for f in files if f != main]:
            for n in bib_declared(texts.get(f, '')):
                if n not in names:
                    names.append(n)
        declared = bool(names)
        if not declared:  # no \bibliography: use every .bib file in the source folder
            names = sorted(bib_files)
        bibs, entries, missing = [], [], []
        for n in names:
            path = (root / n)
            if not path.resolve().is_relative_to(root) or path.is_symlink() or not path.is_file():
                missing.append(n)
                continue
            bibs.append(n)
            for e in parse_bib(read_src(path)):
                entries.append({**e, 'bib': n})
        known, dupes = set(), set()
        for e in entries:
            (dupes if e['key'] in known else known).add(e['key'])
        problems = []
        for f in files:
            for u in cite_uses(texts[f]):
                if not u['key']:
                    problems.append({**u, 'file': f, 'kind': 'empty'})
                elif u['key'] not in known:
                    problems.append({**u, 'file': f, 'kind': 'unknown'})
        return {'bib_files': bibs, 'missing_bib': missing, 'declared': declared,
                'entries': sorted(entries, key=lambda e: e['key'].lower()), 'duplicates': sorted(dupes), 'problems': problems}

    def build_dir(self, paper_id):
        self.state_path(paper_id)  # validates the id
        return self.dir / paper_id

    def lock(self, paper_id):
        with self.locks_guard:
            return self.build_locks.setdefault(paper_id, threading.Lock())

    latexmk = staticmethod(run_latexmk)

    def compile(self, doc):
        """@param doc: Active linked version. @pre Source ownership validated by require.
        @post Successful draft artifacts publish; failed builds retain the previous PDF.
        @return dict: Existing build result. @throws SourceError,OSError: Invalid source or failed publication.
        """
        cfg, active = self.require(doc)
        return self.builds.run('paper', BuildRequest(cfg['root_path'], cfg['main'],
            self.build_dir(doc['paper_id']), self.published(doc['paper_id']), doc['paper_id']))

    # Standalone previews never publish into the paper draft or record a paper build.
    def active_file_target(self, doc, rel):
        cfg, active = self.require(doc)
        if not isinstance(rel, str) or Path(rel).is_absolute() or '..' in Path(rel).parts:
            raise SourceError('Choose a .tex file inside the linked source folder.')
        path = self.source_file(cfg, rel)
        if not path.is_file():
            raise SourceError('The selected source file was not found.')
        rel = str(path.relative_to(cfg['root_path']))
        self.state_path(doc['paper_id'])
        with self.locks_guard:
            if self.active_file_tmp is None:
                self.active_file_tmp = tempfile.TemporaryDirectory(prefix='research-workbench-active-file-')
        base = Path(self.active_file_tmp.name) / doc['paper_id'] / sha(rel)
        return cfg, rel, base

    def compile_active_file(self, doc, rel):
        """@param doc,rel: Active version and confined standalone source path.
        @pre Linked source exists. @post Preview is isolated from paper history/draft PDF.
        @return dict: Preview result. @throws SourceError,OSError: Invalid fragment or build/publication failure.
        """
        cfg, rel, base = self.active_file_target(doc, rel)
        return self.builds.run('active-file', BuildRequest(cfg['root_path'], cfg['main'],
            base / 'build', base, doc['paper_id'] + '/active-file/' + sha(rel), file=rel))

    def active_file_pdf(self, doc, rel):
        cfg, rel, base = self.active_file_target(doc, rel)
        path = base / 'active-file.pdf'
        if not path.is_file():
            raise FileNotFoundError('No preview PDF for this file yet. Choose Compile active file.')
        return path.read_bytes()

    # -- Hide images: the working tree built without figures, in a temporary folder outside the
    #    library and the source folder. The draft, its PDF, the build history and versions are not touched.
    def no_figures_dir(self, paper_id):
        self.state_path(paper_id)  # validates the id
        with self.locks_guard:
            if self.no_figures_tmp is None:
                self.no_figures_tmp = tempfile.TemporaryDirectory(prefix='research-workbench-no-figures-')
        return Path(self.no_figures_tmp.name) / paper_id

    def compile_no_figures(self, doc):
        """@param doc: Active linked version. @pre Authorized source root.
        @post Figure-free preview never changes source files, draft PDF or build history.
        @return dict: Variant result. @throws SourceError,OSError: Invalid main or build/publication failure.
        """
        cfg, active = self.require(doc)
        base = self.no_figures_dir(doc['paper_id'])
        return self.builds.run('no-figures', BuildRequest(cfg['root_path'], cfg['main'],
            base / 'build', base, doc['paper_id'] + '/no-figures'))

    def no_figures_pdf(self, doc):
        path = self.no_figures_dir(doc['paper_id']) / 'no-figures.pdf'
        if not path.is_file():
            raise FileNotFoundError('No PDF without figures yet. Turn on Hide images.')
        return path.read_bytes()

    def record_build(self, doc, result):
        cfg, active = self.require(doc)
        state = self.load_state(doc, active)
        state['builds'] = (state['builds'] + [{k: result[k] for k in ('ok', 'at', 'seconds')}])[-20:]
        self.save_state(state)

    def published(self, paper_id):
        return self.build_dir(paper_id) / 'published'

    def draft_pdf(self, doc):
        path = self.published(doc['paper_id']) / 'draft.pdf'
        if not path.is_file():
            raise FileNotFoundError('No draft PDF yet. Click Compile.')
        return path.read_bytes()

    def synctex(self, doc, args):
        """@param doc,args: Linked version and literal SyncTeX arguments.
        @pre Authorized document. @post Source/artifacts unchanged.
        @return tuple: Decoded process output and draft PDF path.
        @throws SourceError,FileNotFoundError,OSError: Missing map or process failure.
        """
        return query_synctex(self.published(doc['paper_id']), args)

    def pdf_to_source(self, doc, page, x, y):
        """@param doc,page,x,y: Active version and PDF point.
        @pre Source link authorized. @post No files change; escaped source targets are rejected.
        @return dict: Relative file and source line. @throws SourceError,OSError: Missing/invalid mapping.
        """
        cfg, active = self.require(doc)
        return SourceMapping(cfg['root_path'], self.published(doc['paper_id']),
            lambda rel: self.source_file(cfg, rel), lambda args: self.synctex(doc, args)).from_pdf(page, x, y)

    def source_to_pdf(self, doc, rel, line):
        """@param doc,rel,line: Active version, confined source path and source line.
        @pre Source link authorized. @post No files change.
        @return list: PDF bounding boxes. @throws SourceError,OSError: Invalid source or mapping failure.
        """
        cfg, active = self.require(doc)
        return SourceMapping(cfg['root_path'], self.published(doc['paper_id']),
            lambda path: self.source_file(cfg, path), lambda args: self.synctex(doc, args)).to_pdf(rel, line)

    # -- promotion
    def promote(self, doc, message_note=''):
        """Commit the changed .tex and .bib files, build that commit and import it as the next version.

        Steps that can fail before anything is written: missing source link,
        no changes, base commit not in history, commit failure. The build runs
        on a clean export of the new commit, so the version matches git.
        """
        cfg, active = self.require(doc)
        state = self.load_state(doc, active)
        self._refresh(cfg, state, by=OUTSIDE)
        changes = self.present(state)
        if not changes:
            raise SourceError('There are no changes to save as a new version.')
        if git(cfg['root_path'], 'merge-base', '--is-ancestor', state['base_commit'], 'HEAD', check=False).returncode:
            raise SourceError('The base commit is no longer part of the current branch. Check git first.')
        files = sorted({r['file'] for r in changes})
        repo_paths = [self.repo_rel(cfg, cfg['root_path'] / f) for f in files]
        lines = [f'Draft for v{active["number"] + 1}: {len(changes)} change(s) in {", ".join(files)}', '']
        outside = [r for r in changes if any(h['by'] == OUTSIDE for h in r['history'])]
        for r in changes:
            old = ' '.join(r['old'].split())[:160]
            new = ' '.join(r['new'].split())[:160]
            lines.append(f'- {r["file"]}:{r["line"]} {r["kind"]}: "{old}" -> "{new}"')
        if outside:
            lines += ['', f'{len(outside)} change(s) were made outside the Research Workbench (another editor or an AI tool).']
        lines += ['', f'Base: v{active["number"]} ({state["base_commit"][:7]}). Committed by the Research Workbench draft workflow.']
        if message_note:
            lines += ['', str(message_note)[:2000]]
        head = git_text(cfg['top'], 'rev-parse', 'HEAD')
        if git(cfg['top'], 'symbolic-ref', '-q', 'HEAD', check=False).returncode:
            raise SourceError('The repository is not on a branch (detached HEAD). Check out a branch first.')
        with self.lock(doc['paper_id']), tempfile.TemporaryDirectory(prefix='research-workbench-build-') as tmp:
            # 1. Make the commit object with a private index: HEAD plus exactly these files.
            #    Nothing in the user's index or branch changes yet.
            env = {**os.environ, 'GIT_INDEX_FILE': str(Path(tmp) / 'index')}
            def g(*args, input=None):
                r = subprocess.run(['git', *args], cwd=cfg['top'], env=env, input=input, capture_output=True, timeout=120)
                if r.returncode:
                    raise SourceError('git ' + args[0] + ' failed: ' + r.stderr.decode('utf-8', 'replace').strip())
                return r.stdout.decode('utf-8').strip()
            g('read-tree', head)
            g('add', '-A', '--', *repo_paths)  # -A also records deleted files
            tree = g('write-tree')
            if tree == git_text(cfg['top'], 'rev-parse', 'HEAD^{tree}'):
                commit = head  # the changes are already committed; do not add an empty commit
            else:
                commit = g('commit-tree', tree, '-p', head, '-F', '-', input='\n'.join(lines).encode('utf-8'))
            # 2. Build that exact commit from a clean export.
            root_rel = self.repo_rel(cfg, cfg['root_path'])
            archive = git(cfg['top'], 'archive', '--format=tar', commit, '--', root_rel).stdout
            export = Path(tmp) / 'src'
            export.mkdir()
            subprocess.run(['tar', '-x', '-f', '-', '-C', str(export)], input=archive, check=True, timeout=120)
            ok, log, errors, pdf = self.latexmk(export / root_rel, cfg['main'], Path(tmp) / 'out', Path(doc['name']).stem)
            if not ok:
                raise SourceError('The build from the committed source failed, so nothing was committed. '
                                  + (' | '.join(errors[:3]) or log[-500:]))
            data = pdf.read_bytes()
        # 3. Only now move the branch (refusing if it moved meanwhile) and sync the index for these paths.
        #    The caller imports the PDF next and calls rollback() if that fails.
        moved = commit != head
        if moved:
            git(cfg['top'], 'update-ref', '-m', 'research-workbench: save draft as new version', 'HEAD', commit, head)
            self.sync_index(cfg, repo_paths)
        return {'commit': commit, 'head': head, 'moved': moved, 'paths': repo_paths, 'data': data}

    def sync_index(self, cfg, repo_paths):
        r = git(cfg['top'], 'reset', '-q', 'HEAD', '--', *repo_paths, check=False)
        return r.returncode == 0  # best effort: a stale index entry is shown by git status, not lost work

    def rollback(self, doc, result):
        """Undo the branch move of a promotion whose library import failed."""
        if not result['moved']:
            return
        cfg, active = self.require(doc)
        git(cfg['top'], 'update-ref', '-m', 'research-workbench: undo draft commit (import failed)', 'HEAD', result['head'], result['commit'])
        self.sync_index(cfg, result['paths'])
