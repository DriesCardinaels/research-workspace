# Research Workbench implementation package

`research_workbench.py` is the public launcher. Run it from any working
directory, or run `python3 -m research_workbench` from the checkout. `bootstrap.run`
composes application/server dependencies and owns server shutdown. Importing this
package does not launch a server or open a project.

| Directory | Owner and extension guide |
| --- | --- |
| [domain](domain/README.md) | Pure bibliography, review, comment, PDF and schema rules |
| [application](application/README.md) | Project library/index and settings/session operations |
| [infrastructure](infrastructure/README.md) | Filesystem and external-process adapters |
| [extensions](extensions/README.md) | Validated trusted file-type registration |
| [transport](transport/README.md) | HTTP route contributions |

`resources.py` resolves installation assets from this package's location, never
from the caller's working directory. This is currently a source-checkout application;
a wheel distribution has not been implemented. Do not assume assets are discoverable
from arbitrary third-party package installations.

Add behavior to its owner, expose a small public operation, and inject dependencies
where they vary. Add a README with every implementation subdirectory. Use the
[contracts and checks](../CONTRIBUTING.md), and keep historical imports until callers
have migrated. The [implementation status](../docs/MIGRATION_STATUS.md) distinguishes
completed extractions from remaining work.
