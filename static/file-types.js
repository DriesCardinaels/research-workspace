/* Filetype identity and contributions; editor implementations remain behind adapters. */
'use strict';
(function (scope) {
  class FileTypeRegistry {
    #providers = new Map();
    #extensions = new Map();
    /** Register a filetype independently of navigation and toolbar hosts.
     * @param {object} provider Unique id, extensions, label, open(context), optional mode/toolbars/capabilities.
     * @pre Extensions and id are unclaimed. @post Immutable metadata is registered atomically.
     * @return {FileTypeRegistry} This registry. @throws {TypeError|Error} Invalid or ambiguous registration.
     */
    register(provider) {
      if (!provider || !['id', 'label'].every(key => typeof provider[key] === 'string' && provider[key].trim()) || typeof provider.open !== 'function')
        throw new TypeError('Filetypes require id, label and open(context)');
      if (!Array.isArray(provider.extensions) || !provider.extensions.length || provider.extensions.some(extension => !/^\.[a-z0-9]+$/i.test(extension)))
        throw new TypeError('Filetypes require explicit extensions');
      const extensions = provider.extensions.map(extension => extension.toLowerCase());
      if (this.#providers.has(provider.id) || new Set(extensions).size !== extensions.length || extensions.some(extension => this.#extensions.has(extension)))
        throw new Error('Filetype id or extension already registered');
      if (['toolbarAreas', 'standaloneToolbarAreas'].some(key => provider[key] !== undefined && (!Array.isArray(provider[key]) || provider[key].some(area => typeof area !== 'string' || !area.trim()))))
        throw new TypeError('Toolbar areas must be named locations');
      const frozen = Object.freeze({ ...provider, extensions: Object.freeze(extensions), toolbarAreas: Object.freeze([...(provider.toolbarAreas || [])]), standaloneToolbarAreas: provider.standaloneToolbarAreas && Object.freeze([...provider.standaloneToolbarAreas]), capabilities: Object.freeze({ ...provider.capabilities }) });
      this.#providers.set(provider.id, frozen);
      for (const extension of extensions) this.#extensions.set(extension, frozen);
      return this;
    }
    /** Install an inert catalog through trusted adapter factories, atomically.
     * @param {object} catalog Versioned public backend metadata.
     * @param {object} adapters Adapter key => open(context) operation.
     * @pre Host adapter factories are registered before navigation starts.
     * @post Every descriptor is registered, or this registry is unchanged.
     * @return {FileTypeRegistry} This registry.
     * @throws {TypeError|Error} Invalid version, duplicate identity or missing adapter.
     */
    install(catalog, adapters) {
      if (catalog?.schemaVersion !== 1 || !Array.isArray(catalog.types)) throw new TypeError('Unsupported filetype catalog');
      const candidate = new FileTypeRegistry();
      for (const provider of this.list()) candidate.register(provider);
      for (const descriptor of catalog.types) {
        if (!descriptor || !Object.prototype.hasOwnProperty.call(adapters || {}, descriptor.adapter) || typeof adapters[descriptor.adapter] !== 'function') throw new Error('Missing filetype adapter: ' + descriptor?.adapter);
        candidate.register({ ...descriptor, open: adapters[descriptor.adapter] });
      }
      this.#providers = candidate.#providers;
      this.#extensions = candidate.#extensions;
      return this;
    }
    /** Resolve normalized identity without probing contents or changing files.
     * @param {string} path Filename. @pre None. @post Registry unchanged.
     * @return {object|null} Immutable provider or null. @throws {void} None.
     */
    resolve(path) { return this.#extensions.get(String(path || '').match(/\.[^./\\]+$/)?.[0].toLowerCase()) || null; }
    /** Read one provider. @param {string} id Registered identity.
     * @pre None. @post No changes. @return {object|null} Provider. @throws {void} None.
     */
    get(id) { return this.#providers.get(id) || null; }
    /** List immutable definitions. @param {void} none No arguments.
     * @pre None. @post Storage remains private. @return {object[]} New array. @throws {void} None.
     */
    list() { return [...this.#providers.values()]; }
  }
  const registry = new FileTypeRegistry();
  scope.FileTypes = Object.freeze({ FileTypeRegistry, registry });
})(typeof window === 'undefined' ? globalThis : window);
