# External metadata adapters

`openalex.py` owns the existing bounded OpenAlex request, credential settings,
response normalization and reference comparison. The root `openalex.py` is a
compatibility import only. Application sessions construct the provider with an
explicit settings path; importing this package does not contact a provider.

## Add an adapter

Implement explicit search/compare operations accepting validated metadata and
returning bounded public values. Keep credentials in provider-owned private
settings, redact authentication errors and prohibit redirect/host drift. Never
rewrite source references as a side effect of checking them. Provider failure
must remain distinct from a factual mismatch.

Expose application operations through HTTP contributions. Browser diagnostics
register independently in `static/features/bibliography/providers.js`; their
controller owns pacing, caching, source revisions and suppression. A browser
provider receives only source/metadata snapshots and an injected authenticated
request capability, not workspace or buffer storage.

Tests patch the actual adapter's network seam
(`research_workbench.infrastructure.metadata.openalex.build_opener`) and exercise
production handlers with synthetic references. Use `tests/test_openalex.py` and
`tests/test_diagnostic_providers.mjs`. No live credentials or private bibliographies
belong in tests, logs or public issue reports.
