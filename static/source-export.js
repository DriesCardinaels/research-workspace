/* Source ZIP transport and Tool contribution; existing workspaces own saving and state. */
'use strict';
(function () {
  class SourceDownloads {
    /** Fetch an authorized source archive and hand it to the browser's download manager.
     * @param {string} path Public export route. @param {string} name Download filename.
     * @param {object} options Request body/method. @param {string} token Current write token.
     * @pre Workspace saved its buffers. @post One ZIP download starts; temporary URL is released.
     * @return {Promise<void>} Download dispatch. @throws {Error} HTTP/build/transport failure.
     */
    static async download(path, name, options, token) {
      const response = await fetch(path, { ...options, headers: { ...options.headers, 'X-PDF-Token': token } });
      if (!response.ok) { const error = await response.json(); throw new Error(error.error || 'Source ZIP download failed.'); }
      if (!response.headers.get('Content-Type')?.startsWith('application/zip')) throw new Error('The server did not return a source ZIP.');
      const blob = await response.blob(), url = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = url; link.download = name;
      try { document.body.append(link); link.click(); }
      finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
    }
  }
  window.SourceDownloads = SourceDownloads;
  window.EditorTools.icons.register('sourceZip', 'M12 3v12 M7 10l5 5 5-5 M4 16v5h16v-5');
  window.EditorTools.registry.contribute('workspace.build', {
    id: 'source.download-zip', label: 'Download source ZIP', icon: 'sourceZip', showText: false,
    info: 'Save files and download LaTeX sources, figures and a freshly compiled PDF',
    available: ({ downloadSource }) => typeof downloadSource === 'function',
    enabled: ({ sourceExportBusy, buildBusy }) => !sourceExportBusy && !buildBusy,
    state: ({ sourceExportBusy }) => ({ busy: sourceExportBusy }),
    execute: ({ downloadSource }) => downloadSource(),
  });
})();
