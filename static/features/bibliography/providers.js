/* Diagnostic rule contributions. Scheduling, cache and stale-result checks belong to the controller. */
'use strict';
(() => {
  class DiagnosticProviders {
    #providers = new Map();
    /** Register a local file rule or remote entry comparison independently.
     * @param {object} provider Stable id/label, scope ('file' or 'entry'), and diagnose/compare callable.
     * @pre Provider is trusted application code; remote requests use the injected request capability.
     * @post Frozen definition installed; duplicates/invalid definitions change nothing.
     * @return {DiagnosticProviders} This registry. @throws {TypeError|Error} Invalid/duplicate provider.
     */
    register(provider) {
      if (!provider || !['id', 'label'].every(key => typeof provider[key] === 'string' && provider[key].trim())
          || !['file', 'entry'].includes(provider.scope)
          || typeof provider[provider.scope === 'file' ? 'diagnose' : 'compare'] !== 'function'
          || (provider.eligible !== undefined && typeof provider.eligible !== 'function'))
        throw new TypeError('Diagnostic providers require id, label, scope and an operation');
      if (this.#providers.has(provider.id)) throw new Error('Diagnostic provider already registered: ' + provider.id);
      this.#providers.set(provider.id, Object.freeze({ ...provider }));
      return this;
    }
    /** Read immutable contribution definitions. @param {string} scope File or entry scope.
     * @pre Registry initialized. @post Private storage remains unchanged.
     * @return {object[]} New ordered array. @throws {void} None.
     */
    list(scope) { return [...this.#providers.values()].filter(provider => provider.scope === scope); }
  }
  const registry = new DiagnosticProviders();
  registry.register({ id: 'duplicate-key', label: 'Duplicate citation keys', scope: 'file',
    /** Diagnose every duplicate occurrence from exact current source ranges.
     * @param {object} context Parsed entries and key counts. @pre Entries have code-point key ranges.
     * @post Source unchanged; each duplicate occurrence is returned.
     * @return {object[]} Local warnings. @throws {Error} Malformed input.
     */
    diagnose: ({ entries, counts }) => entries.filter(entry => counts.get(entry.key) > 1).map(entry => ({
      key: entry.key, code: 'duplicate-key', start: entry.key_start, end: entry.key_end,
      message: `Key “${entry.key}” already exists (${counts.get(entry.key)} entries in this file).`,
    })),
  });
  registry.register({ id: 'openalex', label: 'OpenAlex', scope: 'entry',
    /** Decide whether metadata can support a comparison. @param {object} entry Parsed reference.
     * @pre Fields are parsed. @post No effects. @return {boolean} Lookup eligibility. @throws {void} None.
     */
    eligible: entry => !!(entry.fields.doi || entry.fields.title),
    /** Compare only the supplied entry through the authenticated request capability.
     * @param {object} context Entry, exact source and request(path,data) function.
     * @pre Explicit automatic-check preference or recheck permitted this lookup.
     * @post No source change. @return {Promise<object>} Provider warnings. @throws {Error} Provider failure.
     */
    compare: ({ entry, source, request }) => request('/api/openalex/diagnose', { text: source, key: entry.key }),
  });
  window.BibliographyDiagnosticProviders = Object.freeze({ DiagnosticProviders, registry });
})();
