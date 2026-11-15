# Historical application icon assets

The current `manifest.json` declares no icons. These assets are not a Tool icon
registry; toolbar SVG geometry is registered through `EditorTools.icons` in
`toolbar.js` and feature contributions. See [the extension guide](../README.md).

`tools/make_icons.py` generates historical page icons using optional Pillow and
writes this directory. Its Pillow version is not pinned. Other existing logo
images have no regeneration/provenance record established by the architecture
analysis; establish their source and redistribution rights before including them
in a public release. Do not regenerate or reconnect unused branding as part of
normal feature work.
