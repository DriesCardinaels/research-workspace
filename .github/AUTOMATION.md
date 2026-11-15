# Repository automation

`workflows/ci.yml` runs the standard-library Python and Node contract suites on
Linux/macOS with Python 3.10/3.14 and Node 26. A separate Ubuntu job installs the
optional TeX toolchain and exercises real builds and loopback HTTP transport.
Node 26 matches the validated local runtime: the bundled PDF.js 6.1.200 uses
modern built-ins such as `Promise.try`, unavailable in the original Node 22 matrix.
The runner rejects older Node versions before loading the PDF.js lifecycle test.

Add a job only when it proves a distinct supported environment or IO seam. Use
synthetic data, read-only repository permissions and no live provider credentials.
Keep optional OpenAlex validation separate from deterministic checks. These jobs
are configured here; a local change does not prove a remote CI run succeeded.

The root application uses [PolyForm Noncommercial 1.0.0](../LICENSE).
Reporting-channel activation and publication remain maintainer release decisions;
workflows do not publish packages or push code.
