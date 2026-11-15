# Registered build strategies

`BuildVariantRegistry` binds a variant name to a `BuildRequest -> BuildPlan`
factory. `BuildService` owns locking, execution, elapsed time, page-count parsing
and artifact publication. Built-ins in `variants.py` supply paper, active-file and
figure-free plans. The executor contains no variant-name switch.

## Add a build variant

1. Implement a trusted factory accepting an authorized `BuildRequest`. Return a
   `BuildPlan` with source root/main, isolated output/publication directories, safe
   job name and artifact basenames. Do not mutate source files in the factory.
2. Put variant-specific setup in `prepare()` and result fields in `metadata(ok)`.
   Metadata cannot override shared result fields (`ok`, logs, timing or page count).
3. Register it on the owner registry before execution:

   ```python
   variants.register('poster', poster_plan)
   service = BuildService(variants, compiler, lock_factory)
   result = service.run('poster', authorized_request)
   ```

4. Required artifacts must exist after a successful compiler result. Declare
   optional artifacts explicitly in `optional_artifacts`; absent optional outputs
   remove stale published copies. Paper SyncTeX is optional, but an old map is never
   retained alongside a new mapless PDF.
5. Keep authorization with the application operation that constructs the request.
   A plan is trusted code, not client-supplied filesystem permissions. Existing
   document routes remain unchanged. A new exposed command can contribute a route
   and Tool through their public registries.

`Drafts.compile`, `compile_active_file`, `compile_no_figures`, `latexmk`, `log_pages`
and `removed_floats` remain compatible entry points that delegate to these owners.
`application.draft_operations.DraftOperations` coordinates build/version/history
transactions outside the HTTP socket host. It releases the application lock during
external compilation and rolls back a new commit when importing its version fails.

`filesystem.artifacts.publish_artifacts` stages the complete set and backups before
replacing files. Replacement errors restore old artifacts. If restoration itself
fails, recovery files are retained and their location is reported. This is per-file
atomic replacement with rollback, not a crash-atomic multi-file transaction.

Run `python3 -m unittest discover -s tests -p test_build_strategies.py -v`, the draft,
standalone and source-archive suites, then `python3 tools/check.py`. Tests demonstrate
an independent strategy, failed compilation, partial publication rollback, required
artifacts, stale optional-map removal, safe mapping and shutdown order.


For project-level composition, inject a factory rather than modifying a source owner:

```python
project = Project(folder, draft_factory=lambda owner: Drafts(
    owner, build_variants=variants, compiler=compiler))
```

Import `Project` and `Drafts` from `research_workbench.application.projects` and
`research_workbench.application.drafts`. `App` also accepts `project_factory` and
`provider_factory`, so installation composition can supply project/provider behavior
without editing application operations. The injected compiler is shared with archive
export through the established `latexmk` capability.
