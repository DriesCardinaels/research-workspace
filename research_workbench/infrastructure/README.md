# IO adapters

[filesystem](filesystem/README.md) owns atomic publication, exact source IO and
cross-process startup locks. [metadata](metadata/README.md) owns bounded external
metadata adapters. [processes](processes/README.md) owns bounded Git and
LaTeX execution. Domain rules must never import these implementations.

Add an adapter where behavior actually varies or an IO seam needs deterministic
tests. Accept explicit paths, arguments and dependencies; return results or raise
meaningful errors. Do not start servers, find the active project, read shell globals
or interpret transport payloads. Keep rollback/cleanup where recovery is possible
and let the request/task owner report the failure once.

A new adapter directory needs a README explaining its real callers, side effects,
exception/cleanup contract and focused integration test. Keep optional external
tools optional for unrelated application functionality.
