"""Long draft compilation/version transactions independent of HTTP transport."""
import json
import os


class DraftOperations:
    """Coordinate source builds, version publication and review-history transfer."""

    def __init__(self, lock):
        """@param lock: Application mutation lock. @pre Shared lock supplied by composition.
        @post No work starts. @return None. @throws None.
        """
        self.__lock = lock

    def run(self, project, d, operation, data):
        """Run a validated source workflow without holding the lock during compilation.

        @param project,d,operation,data: Public project owner, active version, action and object input.
        @pre Caller validated input and active ownership under the application lock.
        @post Failed version import rolls back its commit; successful publication retains history.
        @return dict: Existing operation result, without transport status codes.
        @throws ValueError,OSError: Invalid/failed transaction; source/build errors propagate.
        """
        if operation not in ('compile', 'compile-active', 'no-figures', 'promote'):
            raise ValueError('Unsupported draft workflow.')
        drafts = project.drafts
        if operation == 'compile':
            result = drafts.compile(d)
            with self.__lock:
                drafts.record_build(d, result)
            return result
        if operation == 'compile-active':
            return drafts.compile_active_file(d, data.get('path'))
        if operation == 'no-figures':
            # Hide images: a separate build without figures; the draft and its build history stay as they are.
            return drafts.compile_no_figures(d)
        note = data.get('note', '')
        result = drafts.promote(d, note)
        with self.__lock:
            try:
                active = drafts.active_version(d)
                # Re-read the draft: comments or status changes may have arrived during the build.
                path = drafts.state_path(d['paper_id'])
                state = json.loads(path.read_text()) if path.is_file() else {}
                new = project.import_pdf(active['name'], result['data'], version_of=active['id'],
                                         source_commit=result['commit'])
            except Exception:
                drafts.rollback(d, result)
                raise
            warning = None
            try:
                if state.get('base_version_id') == active['id']:
                    state.update(promoted_to=new['id'], promoted_commit=result['commit'])
                    drafts.archive_state(d['paper_id'], state)
                    # Open comments refer to source text that still exists: they continue in the new draft.
                    still_open = [n for n in state.get('notes', []) if n.get('status') == 'open']
                    if still_open:
                        drafts.carry_notes(project.doc(new['id']), still_open, active['number'])
                draft_pdf = drafts.published(d['paper_id']) / 'draft.pdf'
                if draft_pdf.is_file():
                    os.replace(draft_pdf, drafts.dir / 'history' / (active['id'] + '-draft.pdf'))
            except (OSError, ValueError) as e:
                warning = 'The version was saved, but the draft history or open comments could not be moved: ' + str(e)
            return {'document': project.doc(new['id']), 'commit': result['commit'],
                          'new_commit': result['moved'], 'warning': warning}
