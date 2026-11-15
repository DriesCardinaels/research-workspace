/* Background bibliography diagnostics use public workspace operations only. */
'use strict';
(() => {
  class BibtexSourceRanges {
    /** Locate metadata entries in the exact editor snapshot, including older parser responses.
     * @param {string} text Current BibTeX source, with native newlines.
     * @param {object[]} entries Parsed metadata in source order, including duplicate occurrences.
     * @pre Text is a string and entry keys are strings.
     * @post Metadata is copied; source ranges are calculated locally in Unicode code points.
     * @return {object[]} Entries with verified record, key and field ranges.
     * @throws {Error} Metadata cannot be located; invalid ranges never reach the renderer.
     */
    static locate(text, entries) {
      const points = new Uint32Array(text.length + 1);
      let unit = 0, point = 0;
      for (const char of text) { points[unit] = point; unit += char.length; points[unit] = ++point; }
      const records = new Map(), header = /@\s*([A-Za-z]+)\s*([{(])/g;
      let match;
      while ((match = header.exec(text))) {
        const lineStart = text.lastIndexOf('\n', match.index - 1) + 1;
        if (/(?<!\\)%/.test(text.slice(lineStart, match.index))) continue;
        const bodyStart = header.lastIndex, close = match[2] === '{' ? '}' : ')';
        const comment = match[1].toLowerCase() === 'comment', commas = [];
        let depth = 0, quoted = false, end = bodyStart;
        for (; end < text.length; end++) {
          const char = text[end];
          if (char === '\\') { end++; continue; }
          if (!comment && char === '"' && depth === 0) { quoted = !quoted; continue; }
          if (quoted) continue;
          if (char === '{') { depth++; continue; }
          if (char === '}' && depth) { depth--; continue; }
          if (depth) continue;
          if (char === close) break;
          if (!comment && char === '%') {
            const newline = text.indexOf('\n', end);
            end = newline < 0 ? text.length : newline;
            continue;
          }
          if (char === ',') commas.push(end);
        }
        if (end >= text.length) break;
        header.lastIndex = end + 1;
        if (/^(comment|string|preamble)$/i.test(match[1]) || !commas.length) continue;
        const rawKey = text.slice(bodyStart, commas[0]), key = rawKey.trim();
        if (!key || /\s/.test(key)) continue;
        const keyStart = bodyStart + rawKey.length - rawKey.trimStart().length;
        const fields = {};
        let fieldStart = commas[0] + 1;
        for (const fieldEnd of [...commas.slice(1), end]) {
          const rawField = text.slice(fieldStart, fieldEnd);
          const prefix = rawField.match(/^(?:\s+|%[^\n]*(?:\n|$))*/)[0].length;
          const field = rawField.slice(prefix).match(/^([A-Za-z][\w-]*)\s*=\s*/);
          if (field) {
            const start = fieldStart + prefix + field[0].length;
            const trimmedEnd = fieldStart + rawField.trimEnd().length;
            fields[field[1].toLowerCase()] ??= {start: points[start], end: points[trimmedEnd]};
          }
          fieldStart = fieldEnd + 1;
        }
        if (!records.has(key)) records.set(key, []);
        records.get(key).push({start: points[match.index], end: points[end + 1],
          key_start: points[keyStart], key_end: points[keyStart + key.length], field_ranges: fields});
      }
      return entries.map(entry => {
        const ranges = records.get(entry.key)?.shift();
        if (!ranges) throw new Error('Could not locate bibliography entry “' + entry.key + '” in the current source.');
        return {...entry, ...ranges};
      });
    }
  }
  class BibliographyDiagnostics {
    #providers; #owner; #storage; #timer; #generation = 0; #disposed = false;
    #cache = new Map(); #suppressed = new Set(); #files = new Map();
    #automatic = true; #busy = null; #lastRequest = 0; #retryAfter = new Map();
    #storageKey; #storageError = ''; #delay; #interval; #remoteDelay; #now;
    /** Initialize per-workspace checking and persisted warning preferences.
     * @param {Workspace} owner Public snapshot, request and diagnostic-render operations.
     * @param {object} options Optional storage, debounce, request interval and clock for tests.
     * @pre Owner is mounted. @post Preferences/cache load without source edits or network requests.
     * @return {BibliographyDiagnostics} Controller with private state.
     * @throws {Error} Owner snapshot access failure; storage failures become visible status text.
     */
    constructor(owner, { storage, delay = 400, interval = 1100, remoteDelay = 900, now = Date.now, providers = window.BibliographyDiagnosticProviders.registry } = {}) {
      this.#providers = providers;
      this.#owner = owner; this.#delay = delay; this.#interval = interval; this.#remoteDelay = remoteDelay; this.#now = now;
      this.#storageKey = 'pdf-editor:bibliography-diagnostics:v1:' + owner.getBibliographySnapshot().scope;
      try {
        this.#storage = storage ?? window.localStorage;
        const saved = JSON.parse(this.#storage?.getItem(this.#storageKey) || '{}');
        this.#automatic = saved.automatic !== false;
        this.#suppressed = new Set(Array.isArray(saved.suppressed) ? saved.suppressed.filter(id => {
          try { const parts = JSON.parse(id); return Array.isArray(parts) && parts.length === 3 && parts.every(part => typeof part === 'string'); }
          catch { return false; }
        }) : []);
        for (const item of Array.isArray(saved.cache) ? saved.cache : []) {
          if (item && typeof item.id === 'string' && Array.isArray(item.warnings) && item.expires > this.#now()) this.#cache.set(item.id, item);
        }
      } catch { this.#storageError = 'Warning preferences could not be loaded; changes will last for this session.'; }
    }
    /** Debounce local checks and invalidate outstanding results immediately.
     * @param {void} none No arguments. @pre Owner is mounted.
     * @post Stale decorations clear; only the newest snapshot can publish results.
     * @return {void} Nothing. @throws {Error} Owner rendering failure.
     */
    schedule() {
      clearTimeout(this.#timer); ++this.#generation;
      if (this.#disposed) return;
      const snapshot = this.#owner.getBibliographySnapshot();
      this.#publish(snapshot, [], { pending: !!snapshot.file });
      if (snapshot.file) this.#timer = setTimeout(() => this.refresh(), this.#delay);
    }
    /** Parse the current file and check complete unique entries in a paced queue.
     * @param {boolean} force Recheck cached entries and retry after a provider failure.
     * @pre Owner is mounted. @post Local duplicates publish first; current remote results follow.
     * @return {Promise<void>} Completion, including handled request failures.
     * @throws {Error} Owner snapshot/render contract failure; transport errors are displayed here.
     */
    async refresh(force = false) {
      clearTimeout(this.#timer);
      const generation = ++this.#generation, snapshot = this.#owner.getBibliographySnapshot();
      if (this.#disposed || !snapshot.file) return;
      let warnings = [];
      try {
        const parsed = await this.#owner.requestBibliographyDiagnostics('/api/bibliography/entries', {text: snapshot.text});
        if (!this.#current(generation, snapshot)) return;
        const entries = BibtexSourceRanges.locate(snapshot.text, parsed.entries), counts = new Map();
        for (const entry of entries) counts.set(entry.key, (counts.get(entry.key) || 0) + 1);
        const problems = [];
        for (const provider of this.#providers.list('file')) {
          try {
            const found = await provider.diagnose({ snapshot: Object.freeze({ ...snapshot }),
              entries: JSON.parse(JSON.stringify(entries)), counts: new Map(counts) });
            if (!this.#current(generation, snapshot)) return;
            warnings.push(...found);
          } catch (error) { problems.push(provider.label + ': ' + error.message); }
        }
        if (!this.#current(generation, snapshot)) return;
        this.#files.set(snapshot.file, {snapshot, warnings});
        this.#publish(snapshot, warnings, {pending: this.#automatic || force});
        if ((this.#automatic || force) && this.#remoteDelay) await new Promise(resolve => setTimeout(resolve, this.#remoteDelay));
        if (!this.#current(generation, snapshot)) return;
        let checked = 0;
        for (const entry of entries) {
          if (counts.get(entry.key) > 1) continue;
          for (const provider of this.#providers.list('entry')) {
            try {
              if (provider.eligible && !provider.eligible(JSON.parse(JSON.stringify(entry)))) continue;
              // Parsed metadata, not layout, identifies a cache entry. Formatting never rechecks it.
              const identity = [entry.key, entry.type, Object.entries(entry.fields).sort()];
              // Retain existing OpenAlex cache identities; additional providers get isolated namespaces.
              const id = JSON.stringify(provider.id === 'openalex' ? identity : [provider.id, ...identity]);
              let cached = this.#cache.get(id);
              if (cached?.expires <= this.#now()) { this.#cache.delete(id); cached = null; }
              if (force || !cached) {
                if (!force && !this.#automatic) continue;
                if (!force && this.#now() < (this.#retryAfter.get(provider.id) || 0)) throw new Error('Metadata checks paused after a request failure. Use Recheck file to retry.');
                cached = await this.#compare(snapshot, entry, id, generation, force, provider);
                if (!cached || !this.#current(generation, snapshot)) return;
              }
              this.#retryAfter.delete(provider.id);
              checked++;
              for (const warning of cached.warnings) {
                const range = entry.field_ranges[warning.field] || {start: entry.key_start, end: entry.key_end};
                warnings.push({...warning, key: entry.key, ...range});
              }
              this.#files.set(snapshot.file, {snapshot, warnings: [...warnings]});
              this.#publish(snapshot, warnings, {pending: this.#automatic || force, checked});
            } catch (error) {
              if (!this.#current(generation, snapshot)) return;
              if ((this.#retryAfter.get(provider.id) || 0) <= this.#now()) this.#retryAfter.set(provider.id, this.#now() + 60000);
              problems.push(error.status === 404
                ? 'Restart the editor server and reload this page to enable inline metadata checks. Local warnings remain available.'
                : error.message);
            }
          }
        }
        this.#publish(snapshot, warnings, {checked, ...(problems.length ? {error: [...new Set(problems)].join(' · ')} : {})});
      } catch (error) {
        if (!this.#current(generation, snapshot)) return;
        const message = error.status === 404
          ? 'Restart the editor server and reload this page to enable OpenAlex inline checks. Local duplicate warnings remain available.'
          : error.message;
        this.#publish(snapshot, warnings, {error: message});
      }
    }
    /** Suppress one rule for an entry in the active file and persist the choice.
     * @param {object} warning Diagnostic with key and code.
     * @pre The current snapshot has a bibliography file.
     * @post Other entries/rules stay visible; source is unchanged.
     * @return {void} Nothing. @throws {Error} Owner access/render failure.
     */
    suppress(warning) {
      const snapshot = this.#owner.getBibliographySnapshot();
      if (!snapshot.file) return;
      this.#suppressed.add(this.#id(snapshot.file, warning)); this.#persist(); this.#republish(snapshot);
    }
    /** Restore all suppressed rules for the active file.
     * @param {void} none No arguments. @pre Owner is mounted.
     * @post Other files retain their suppressions; no source changes or lookups.
     * @return {void} Nothing. @throws {Error} Owner access/render failure.
     */
    restore() {
      const snapshot = this.#owner.getBibliographySnapshot();
      for (const id of this.#suppressed) if (JSON.parse(id)[0] === snapshot.file) this.#suppressed.delete(id);
      this.#persist(); this.#republish(snapshot);
    }
    /** Enable or pause automatic provider checks while retaining local duplicate checks.
     * @param {boolean} enabled Whether to use background OpenAlex checks.
     * @pre Owner is mounted. @post Preference persists; pending runs become stale.
     * @return {void} Nothing. @throws {Error} Owner rendering failure.
     */
    setAutomatic(enabled) { this.#automatic = !!enabled; this.#persist(); this.schedule(); }
    /** Cancel scheduling and invalidate asynchronous work when the workspace closes.
     * @param {void} none No arguments. @pre None; repeat calls are safe.
     * @post No subsequent request result can modify the editor.
     * @return {void} Nothing. @throws {Error} None under normal operation.
     */
    dispose() { this.#disposed = true; ++this.#generation; clearTimeout(this.#timer); }
    /** Serialize and pace one provider lookup, reusing comparisons completed while waiting.
     * @param {object} snapshot Current source. @param {object} entry Parsed local entry.
     * @param {string} id Metadata cache key. @param {number} generation Current run.
     * @param {boolean} force Bypass the completed-result cache.
     * @pre Entry is complete and unique. @post At most one request is active; results cache locally.
     * @return {Promise<object|null>} Cached comparison, or null when superseded/disposed.
     * @throws {Error} Provider/transport failures propagate to refresh() for recovery.
     */
    async #compare(snapshot, entry, id, generation, force, provider) {
      if (this.#busy) await this.#busy;
      if (!this.#current(generation, snapshot)) return null;
      const completed = this.#cache.get(id);
      if (!force && completed?.expires > this.#now()) return completed;
      const wait = this.#interval - (this.#now() - this.#lastRequest);
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
      if (!this.#current(generation, snapshot)) return null;
      this.#lastRequest = this.#now();
      const source = [...snapshot.text].slice(entry.start, entry.end).join('');
      const lookup = Promise.resolve().then(() => provider.compare({ entry: JSON.parse(JSON.stringify(entry)), source,
        snapshot: Object.freeze({ ...snapshot }), request: (path, data) => this.#owner.requestBibliographyDiagnostics(path, data) }));
      this.#busy = lookup.catch(() => {});
      let result;
      try { result = await lookup; }
      finally { this.#busy = null; }
      // Source ranges are recalculated from the current parser output when publishing.
      const cached = {id, expires: this.#now() + 7 * 86400000, warnings: result.warnings.map(warning => ({...warning,
        field: warning.field || null,
      }))};
      this.#cache.set(id, cached); this.#persist();
      return cached;
    }
    /** Identify an entry/rule suppression independent of line numbers and formatting.
     * @param {string} file Source path. @param {object} warning Key and rule.
     * @pre Values are strings. @post No state changes. @return {string} Stable identity.
     * @throws {Error} JSON serialization failure.
     */
    #id(file, warning) { return JSON.stringify([file, warning.key, warning.code]); }
    /** Reject stale provider/parser responses.
     * @param {number} generation Run number. @param {object} snapshot Source snapshot.
     * @pre Owner is mounted. @post No state changes. @return {boolean} Result is current.
     * @throws {Error} Snapshot access failure.
     */
    #current(generation, snapshot) {
      const current = this.#owner.getBibliographySnapshot();
      return !this.#disposed && generation === this.#generation && current.file === snapshot.file && current.text === snapshot.text;
    }
    /** Save a bounded metadata cache and suppression preferences.
     * @param {void} none No arguments. @pre Cache entries are JSON-compatible.
     * @post At most 500 recent cached comparisons persist; failures become visible status.
     * @return {void} Nothing. @throws {Error} None; this is the storage recovery boundary.
     */
    #persist() {
      try {
        const cache = [...this.#cache.values()].filter(item => item.expires > this.#now()).slice(-500);
        this.#storage?.setItem(this.#storageKey, JSON.stringify({automatic: this.#automatic, suppressed: [...this.#suppressed], cache}));
      } catch { this.#storageError = 'Warning preferences could not be saved; changes will last for this session.'; }
    }
    /** Refresh suppression visibility from the most recent results without a request.
     * @param {object} snapshot Current source. @pre Owner is mounted.
     * @post Current decorations update. @return {void} Nothing.
     * @throws {Error} Owner rendering failure.
     */
    #republish(snapshot) {
      const state = this.#files.get(snapshot.file);
      this.#publish(snapshot, state?.snapshot.text === snapshot.text ? state.warnings : []);
    }
    /** Publish current warnings and public UI actions without exposing controller storage.
     * @param {object} snapshot Source snapshot. @param {object[]} warnings Current diagnostics.
     * @param {object} status Pending/error/count state.
     * @pre Owner is mounted. @post Suppressed warnings are filtered and safe callbacks rendered.
     * @return {void} Nothing. @throws {Error} Owner rendering failure.
     */
    #publish(snapshot, warnings, status = {}) {
      if (this.#disposed) return;
      const visible = warnings.filter(warning => !this.#suppressed.has(this.#id(snapshot.file, warning)));
      const suppressed = [...this.#suppressed].filter(id => JSON.parse(id)[0] === snapshot.file).length;
      this.#owner.renderBibliographyDiagnostics(snapshot, visible, {...status, automatic: this.#automatic, suppressed,
        storageError: this.#storageError, onSuppress: warning => this.suppress(warning), onRestore: () => this.restore(),
        onRecheck: () => this.refresh(true), onAutomatic: enabled => this.setAutomatic(enabled)});
    }
  }
  window.BibliographyDiagnostics = BibliographyDiagnostics;
})();
