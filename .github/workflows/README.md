# Validation workflow

`ci.yml` invokes `python tools/check.py` for domain/registry/browser contracts,
documentation and architecture. `--integration` adds real loopback HTTP
tests. The TeX job installs build tools explicitly rather than treating their absence
as proof of integration success.

To add a check, first make it reproducible through `tools/check.py`, then add the
smallest job/toolchain needed. Keep failure exits intact, avoid live accounts and
never write user projects. Verify YAML and run the same command locally when the
required platform/tools are available. Matrix support is established by completed
CI results, not by the presence of a matrix entry alone.
