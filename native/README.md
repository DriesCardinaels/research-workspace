# Optional native application hosts

[macOS](macos/README.md) contains the AppKit/WKWebView source host. It displays the
existing web application and owns disconnected-state controls. The Python
[native recovery package](../research_workbench/native_host/README.md) owns startup,
readiness and cleanup. The existing browser/CLI do not require a native host.

New platform hosts need an ownership/build guide, native-only process actions,
unsaved-work protection and transport checks. Keep platform dependencies here;
do not add process launch to browser scripts or HTTP routes. Generated app bundles
are local build outputs and are ignored by Git.
