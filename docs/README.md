# Developer documentation

Start with [Contributing](../CONTRIBUTING.md) and the
[current ownership map](ARCHITECTURE.md), then read the
[modularity migration plan](MODULARITY_MIGRATION.md). Read [implementation status](MIGRATION_STATUS.md) for completed extractions and
remaining work. The original plan distinguishes baseline observations from proposed
interfaces; only the status document claims implementation.

| Area | Implementation guide |
| --- | --- |
| User behavior and detailed extension examples | [User guide](USER_GUIDE.md) |
| GitHub Actions and repository automation | [Automation guide](../.github/AUTOMATION.md) |
| Python package and module ownership | [research_workbench/README.md](../research_workbench/README.md) |
| Shared file-type metadata | [extensions/README.md](../extensions/README.md) |
| Browser tools, file types, editors, diagnostics and styling | [static/README.md](../static/README.md) |
| Python and JavaScript regression tests | [tests/README.md](../tests/README.md) |
| Shared JavaScript test fixtures | [tests/support/README.md](../tests/support/README.md) |
| Maintenance commands | [tools/README.md](../tools/README.md) |
| Bundled dependencies | [static/vendor/README.md](../static/vendor/README.md) |
| Archived workflow | [legacy/README.md](../legacy/README.md) |

## Adding documentation

Every new directory owning an implementation or an extension seam must include a
README in the same change. Explain purpose, public entry points, allowed
dependencies, a concrete extension procedure, lifecycle and errors, tests, and
compatibility obligations. Include examples using real interfaces. Mark proposed
interfaces as proposed; do not document them as available.

Asset directories and generated output need provenance and regeneration guidance,
not a fictional programming interface. Do not add documentation inside private
research projects. Keep this index updated when directories move.
