# Review state and presentation

`state.js` owns selection, panel preferences, new-comment composition and per-thread
reply drafts behind `ReviewState`. Values returned by `note` and `selected` are
immutable copies; `replies()` returns detached map membership. Use `begin`,
`setNoteDraft` and `setReply` to edit. Capture `revision` before submitting a note,
then call `completeNote(revision)` only after success. `completeReply(key, text)`
clears only the submitted value. New typing survives older request completions.
`pending` is the polling guard. `dispose()` clears drafts and ignores late events.

`cards.js` owns comment/replacement forms, exact message rendering, reply controls,
status actions and tracked-change cards. `ReviewCards` accepts a state model, node
factory, formatting functions and explicit actions. It never receives a Workspace,
native document or buffer registry. The host owns authorized requests, source/PDF
navigation, dirty-source checks, confirmation and error reporting. Override
`reviewCardsFactory(options)` in Workspace construction to supply another adapter
with `newNoteForm`, `thread`, `replyBox`, `noteCard` and `changeCard`.

`panel.js` owns tab composition and selection, counts, visibility controls and
common review warnings. Comments, changes and writing are independent registered
contributions. The existing writing analysis and citation-warning implementations
remain host capabilities; their extraction is separate work.

## Implement a review tab

1. Start with `ReviewPanels.builtInTabs()` to retain standard tabs, or construct
   `new ReviewPanels.ReviewTabRegistry()` for an independent panel.
2. Register a unique ID, `label(snapshot)`, `render(body, context)` and optional
   `available(snapshot)` predicate. Invalid or duplicate definitions throw before
   changing registry membership.
3. Pass the registry as `reviewTabs` when constructing Workspace. The application
   must explicitly load contribution code before mounting that Workspace.
4. Render using `context.node`, `context.cards`, immutable `context.snapshot`,
   public `context.state` and the host's `context.actions`. Do not reach through
   DOM nodes to obtain native source buffers or introduce an independent save path.
5. Keep rendering synchronous. The host owns async action lifetimes and reporting.
   Scope styles under the review panel and bind interactive actions through Tools.

```js
const reviewTabs = window.ReviewPanels.builtInTabs();
reviewTabs.register({
  id: 'summary',
  /** Label a detached review snapshot. @param {object} snapshot Review values.
   * @pre Snapshot supplied by the panel. @post No mutation.
   * @return {string} Label. @throws {void} None.
   */
  label: snapshot => `Summary (${snapshot.openNotes})`,
  /** Render a read-only summary. @param {HTMLElement} body Owned tab container.
   * @param {object} context Public rendering capabilities.
   * @pre Trusted contribution. @post Summary appended; source unchanged.
   * @return {void} Nothing. @throws {Error} DOM failure.
   */
  render(body, { snapshot, node }) {
    body.append(node('p', { text: `${snapshot.openNotes} open comments` }));
  },
});
// Include reviewTabs in the existing Workspace construction options.
```

Display metadata includes visible `notes`/`changes`, open/resolved/accepted counts,
base version, inactive changes, problems and writing availability. Metadata is
copied and recursively frozen per render. Registry definitions and available lists
are frozen; registration membership stays private. An unavailable selected tab
falls back to the first available contribution. At least one must be available.
For a full replacement, inject `reviewPanelFactory(options)` returning `render`.

## Validate

Run `node tests/test_review_modules.mjs`, `node tests/test_comment_copy.mjs`,
`node tests/test_markup_sync.mjs` and `python3 tools/check.py --javascript`.
The extension test supplies an independent tab without modifying Workspace,
verifies immutable inputs and submission/typing races, and checks disposal.
No runtime dependency was added; Tools use the existing browser runtime.
