/* Built-in composition. Metadata is supplied by the authoritative backend catalog. */
'use strict';
(() => {
  window.FileTypes.registry.install(window.WorkbenchFileTypeCatalog, {
    pdf: context => context.openPdf(),
    source: context => context.openSource(),
    text: context => context.openText(),
    image: context => context.openSession(options => new window.ImageWorkspace(options)),
  });
})();
