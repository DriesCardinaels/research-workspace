# Built-in file-type catalog

`filetypes.json` is the single source of file identity and capability metadata for
both Python and the browser. It is trusted installation configuration, not user
project data. Restart the server after changing it.

## Add an extension with an existing editor

Append an entry such as:

```json
{
  "id": "notes",
  "label": "Notes",
  "extensions": [".notes"],
  "adapter": "text",
  "kind": "text",
  "toolbarAreas": ["text.actions"],
  "capabilities": {"text": true},
  "permissions": {"editable": true}
}
```

The existing text-file HTTP routes, explorer and editor host then support it;
there are no per-extension route changes or duplicated frontend registrations.
IDs/extensions must be unique. Extensions are lowercase and include their dot.
Schema version is currently 1. `mode` optionally names an already loaded CodeMirror
mode; syntax mode implementation remains authored JavaScript.

| Field | Meaning |
| --- | --- |
| `adapter` | Existing `pdf`, `source`, `text` or `image` factory in browser composition |
| `kind`, `label` | Display identity; do not grant permissions |
| `capabilities` | Boolean browser behavior; `text`, `sourceReview` and `image` must agree with backend permissions |
| `toolbarAreas`, `standaloneToolbarAreas` | Optional registered toolbar placement |
| `permissions.editable`, `review`, `prose` | Independent authoritative backend flags |
| `permissions.initial_text` | Optional exact starter text for creation |
| `permissions.preview_mime`, `preview_signature` | Required image MIME and hexadecimal byte signature |
| `mime` | Image presentation MIME, required to match the backend declaration |

A new image format using the existing image host needs metadata plus explicit
signature/MIME policy. A new editing model needs an authored adapter and an entry
in `static/filetype-adapters.js`; the registry validates all required adapter keys
before installing the catalog. Adding metadata cannot create executable behavior.

The server serves a normalized permission-free snapshot at `GET /api/file-types`
and a classic-script assignment at `GET /api/file-types.js`; `index.html` loads that
before the registry/composition scripts. No generated metadata file is committed.
The browser treats metadata as presentation and cannot grant backend permission.

Run `node tests/test_filetype_catalog.mjs`, `node tests/test_media_filetypes.mjs`
and `python3 tests/run_inprocess.py`. The `.notes` regression in
`tests/test_modular_contracts.py` demonstrates extension through existing routes.
