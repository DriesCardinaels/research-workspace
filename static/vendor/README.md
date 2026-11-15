# Bundled browser dependencies

The application loads these files locally without npm installation or CDN access.
Keep upstream artifacts and notices intact. Do not patch minified files as a
feature implementation; adapt dependencies behind the editor/rendering interface.

| Directory | Observed version | License/provenance entry point |
| --- | --- | --- |
| `codemirror/` | 5.65.16, embedded in `codemirror.min.js` | `codemirror/LICENSE`; TeX mode under `mode/stex/` |
| `pdfjs/` | 6.1.200, header of `pdf.min.mjs` | `pdfjs/LICENSE`; additional font/CMap/ICC/WASM notices in their directories |
| `pdf-lib/` | Not established by this analysis | `pdf-lib/LICENSE.md`; verify upstream version before updating |
| `marked/` | 15.0.12 | `marked/LICENSE.md`; release distribution from cdnjs/cdnjs, upstream markedjs/marked v15.0.12 |
| `dompurify/` | 3.4.18 | `dompurify/LICENSE`; upstream cure53/DOMPurify tag 3.4.18 |

Marked supplies a full GFM parser instead of a partial regular-expression renderer.
DOMPurify sanitizes parsed README HTML before it is inserted into the live app.
Both dependencies are bundled for offline preview; implementation lives in
`features/markdown/preview.js`, outside upstream artifacts.

`manifest.json` records every bundled dependency file and its SHA-256 digest.
Run `python3 tools/check.py --vendor` to verify file inventories, license presence
and bytes. Unknown pdf-lib version and original acquisition provenance remain
explicitly unresolved; a local hash inventory is not a complete upstream provenance
record.
A root application license is separate from these dependency licenses.

## Add or update a dependency

1. Establish the exact upstream release, source URL, artifact hashes and licenses;
   record them here and update the versioned manifest. Do not guess a version.
2. Explain why existing browser/standard-library capabilities are insufficient.
   Retain offline operation and the checkout-without-install workflow.
3. Replace the complete matching artifact set, including workers, decoders, fonts
   and notices where required. Keep PDF.js main and worker versions synchronized.
4. Keep vendor-specific behavior inside an adapter. Update asset paths deliberately
   in bootstrap/index and fixtures; use local URLs.
5. Run real CodeMirror history/range tests, PDF annotation/export/lifecycle tests,
   and browser rendering on representative synthetic PDFs. Verify offline loading.

Subdirectories containing upstream assets are not application extension locations;
use this guide rather than injecting application README files into vendor releases.
Optional icon generation uses Pillow outside this directory and has no pinned
version yet; see [tools](../../tools/README.md).
