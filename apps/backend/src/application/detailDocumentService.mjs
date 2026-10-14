import { randomUUID, createHash } from "node:crypto";
import { ClientInspectorStream } from "./clientInspectorStream.mjs";
import { validateDetailContract } from "./detailDocumentContract.mjs";
import { projectDetailV2, DetailV2Journal, diffDetailV2, detailV2Hash } from "./detailSyncV2.mjs";
import { detailV2CatalogOptions } from "./detailV2Catalog.mjs";
import { readDetailV2Request } from "./detailV2JSON.mjs";
import { validateDetailV2Envelope } from "./detailV2Contract.mjs";
import { sendDetailV2Snapshot } from "./detailSnapshotTransport.mjs";
import { detailV2GetNegotiation, detailV2ServiceOptions, detailV2PinnedAuthenticate, DETAIL_TRANSPORT_CATALOGS } from "./detailV2Negotiation.mjs";
import { DEFAULT_DETAIL_MODULES, DETAIL_BUSINESS_MODULES, detailModuleNames, projectBusinessModules, businessDocument } from "./detailBusinessProjection.mjs";
import { DetailBusinessReadCache } from "./detailBusinessReadCache.mjs";
import { DetailBusinessInvalidation, DETAIL_RESOURCE_TYPES } from "./detailBusinessInvalidation.mjs";
import { projectDetailBusinessRich, DETAIL_RICH_BUSINESS_MODULES, DETAIL_RICH_BUSINESS_CAPABILITIES } from "./detailBusinessRichProjection.mjs";
import { DetailBusinessCollectionPager } from "./detailBusinessCollectionPager.mjs";

const services = new WeakMap();
const digest = value => createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
const failure = (code, status = 400) => Object.assign(new Error(code), { code, status });
const knownDependencies = new Set(DETAIL_RESOURCE_TYPES);
const richHostModules = DETAIL_RICH_BUSINESS_MODULES;
function trustedIdentity(identity, requirePrincipal = false) {
  if (!identity || typeof identity !== "object" || Array.isArray(identity) || typeof identity.then === "function") throw failure("DETAIL_IDENTITY_INVALID", 403);
  for (const name of ["serverId", "accountId", "principalId", "deviceId"]) {
    const value = identity[name];
    if (value !== undefined && value !== null && (typeof value !== "string" || !value.length || value.length > 512)) throw failure("DETAIL_IDENTITY_INVALID", 403);
  }
  if (requirePrincipal && !identity.principalId && !identity.deviceId) throw failure("AUTHENTICATED_PRINCIPAL_REQUIRED", 403);
  return identity;
}
function cacheScope(identity = {}, sessionId, catalogProfile = "native-v1", clientCapabilities = []) {
  trustedIdentity(identity);
  return { serverId: identity.serverId ?? "local-server", accountId: identity.accountId ?? "local-user",
    principalId: identity.principalId ?? (identity.deviceId ? `device:${identity.deviceId}` : "local-user"),
    deviceId: identity.deviceId ?? null,
    sessionId, catalogProfile, capabilitiesHash: detailV2Hash(clientCapabilities) };
}
function snapshotProfile({ catalog, catalogProfile, clientCapabilities } = {}) {
  if (catalog && catalogProfile && catalog !== catalogProfile) throw failure("DETAIL_CATALOG_CONFLICT");
  catalog = catalog ?? catalogProfile ?? "native-v1";
  if (catalog === "native-v1") {
    if (clientCapabilities !== undefined && (!Array.isArray(clientCapabilities) || clientCapabilities.length)) throw failure("DETAIL_CATALOG_UNSUPPORTED", 409);
    return { catalog, clientCapabilities: [] };
  }
  return detailV2CatalogOptions({ catalog, clientCapabilities });
}
/** Internal trusted identity scope, not a wire authority or authentication API. */
export function detailDocumentCacheScope(identity, sessionId, options = {}) {
  const profile = snapshotProfile(options);
  return cacheScope(identity, sessionId, profile.catalog, profile.clientCapabilities);
}
const matchesScope = (scope, filter) => Object.entries(filter).every(([key, value]) => scope[key] === value);
const resourceScope = scope => ({ session: { id: scope.session.id }, logicalSessionId: scope.logicalSessionId,
  task: scope.task ? { id: scope.task.id } : null, work: scope.work ? { id: scope.work.id } : null });

// Accept is already authenticated and forwarded by the secure relay. Do not
// introduce a new custom header that installed relay hosts would strip.
export function acceptsNativeDetail(request) {
  return ["application/json; corptie-detail=native-v1", "text/event-stream; corptie-detail=native-v1"].includes(request.headers.accept);
}

/** Product projection only: no Provider adapters, arbitrary URLs or store serialization. */
export function projectDetailDocument(scope, modules = DEFAULT_DETAIL_MODULES) {
  return businessDocument(scope, projectBusinessModules(scope, modules));
}

export class DetailDocumentService {
  #streamAttachments = new Map();
  #richReadEnabled;
  #richNavigationEnabled;
  #richWritesEnabled;
  #businessActionRegistry;
  constructor(store, { modules = DEFAULT_DETAIL_MODULES, richReadEnabled = false, richWritesEnabled = false } = {}) {
    if (typeof richReadEnabled !== "boolean" || typeof richWritesEnabled !== "boolean") throw failure("DETAIL_GATE_INVALID", 500);
    this.#richReadEnabled = richReadEnabled;
    this.#richNavigationEnabled = richReadEnabled;
    this.#richWritesEnabled = richReadEnabled && richWritesEnabled;
    this.store = store; this.generation = randomUUID(); this.cache = new Map();
    this.modules = detailModuleNames(modules);
    this.businessInvalidation = new DetailBusinessInvalidation(store, change => this.invalidate(change));
    this.events = new ClientInspectorStream({ snapshot: (identity, id) => this.snapshot(id, { identity, invalidatedOnly: true }),
      eventPrefix: "detail", sessionScopedLimit: true, maxFrameBytes: 256 * 1024 + 1024,
      eventForSnapshot: (previous, next) => previous && previous.generation === next.generation
        ? { name: "detail-patch", value: detailPatch(previous, next) } : { name: "detail-snapshot", value: next } });
    this.v2Journals = new Map();
    this.richHostPending = new Map(); this.businessPortsEpoch = 0;
    this.collectionPager = new DetailBusinessCollectionPager();
    this.v2Events = new ClientInspectorStream({ snapshot: (identity, id) => this.v2Snapshot(id, { identity, invalidatedOnly: true }),
      eventPrefix: "detail", sessionScopedLimit: true, maxFrameBytes: 256 * 1024 + 1024 });
    for (const events of [this.events, this.v2Events]) {
      const invalidate = events.invalidate.bind(events);
      events.invalidate = change => { this.markDirty(change); invalidate(); };
      this.#streamAttachments.set(events, events.attach.bind(events));
      events.attach = (response, authenticate, id, request, options) => {
        this.#attachScoped(events, response, authenticate, id, request, options,
          { catalog: events === this.v2Events ? "native-v2" : "native-v1", clientCapabilities: [] });
      };
    }
  }
  /** Host configuration only. Requests cannot enable a catalog or write UI. */
  acceptsDeliveryCatalog(catalog) {
    return DETAIL_TRANSPORT_CATALOGS.includes(catalog)
      || this.#richReadEnabled && catalog === "native-v2-components-1";
  }
  deliveryCapabilities() {
    const richRead = this.#richReadEnabled && this.businessReader
      && richHostModules.every(name => this.businessReader.ports[name]);
    const pagination = Boolean(richRead && Object.values(this.businessReader.ports).some(port => typeof port.readPage === "function"));
    const writes = Boolean(richRead && this.#richWritesEnabled && this.#businessActionRegistry);
    return { schemaVersion: 1, catalogs: richRead ? ["native-v2", "native-v2-components-1"] : ["native-v2"],
      requiredCapabilities: richRead ? [...new Set([...(pagination || writes ? ["detail.button"] : []),
        ...DETAIL_RICH_BUSINESS_CAPABILITIES, ...(writes ? ["detail.form"] : [])])].sort() : [],
      pagination, writes };
  }
  configureBusinessActionRegistry(registry) {
    if (!registry || typeof registry.prepare !== "function") throw failure("DETAIL_ACTION_REGISTRY_INVALID", 500);
    this.#businessActionRegistry = registry;
    for (const [key, journal] of this.v2Journals) if (journal.detailCacheScope.catalogProfile !== "native-v2") this.retireJournal(key);
  }
  richPageLimit(profile) { return this.#richWritesEnabled && profile.clientCapabilities.includes("detail.form") ? 4 : 20; }
  #attachScoped(events, response, authenticate, id, request, options, profile) {
    const initial = cacheScope(trustedIdentity(authenticate(), true), this.scope(id).logicalSessionId, profile.catalog, profile.clientCapabilities);
    // New consumers check current facts, including changes while no consumer was attached.
    this.markDirty({ sessionId: initial.sessionId });
    const guarded = () => {
      try {
        const identity = trustedIdentity(authenticate(), true);
        const current = cacheScope(identity, this.scope(id).logicalSessionId, profile.catalog, profile.clientCapabilities);
        if (!matchesScope(current, initial)) throw failure("DETAIL_IDENTITY_CHANGED", 403);
        return identity;
      } catch (error) {
        const { catalogProfile, capabilitiesHash, sessionId, ...authority } = initial;
        this.clearCache(authority); throw error;
      }
    };
    this.#streamAttachments.get(events)(response, guarded, id, request, options);
    const client = [...events.clients].find(client => client.response === response);
    if (client) client.detailCacheScope = initial;
  }
  /** Internal async contract only; not mounted by any HTTP handler.
   * Promise<{state, revalidate}>. revalidate is synchronous and host-only;
   * callers must invoke it after every transport await, immediately before send. */
  async prepareRichSnapshot(id, { authenticate, catalog, clientCapabilities, invalidatedOnly = false } = {}) {
    const pinned = this.#pinRichRead(id, { authenticate, catalog, clientCapabilities });
    const state = await this.richBusinessSnapshot(id, { authenticate: pinned.revalidate, ...pinned.profile, invalidatedOnly });
    pinned.revalidate();
    return Object.freeze({ state, revalidate: pinned.revalidate });
  }
  #pinRichRead(id, { authenticate, catalog, clientCapabilities }) {
    if (typeof authenticate !== "function") throw failure("AUTHENTICATED_PRINCIPAL_REQUIRED", 403);
    const identity = trustedIdentity(authenticate(), true), context = this.v2Context(id, { identity, catalog, clientCapabilities });
    const { profile, identityScope, key } = context;
    if (profile.catalog !== "native-v2-components-1") throw failure("DETAIL_CATALOG_UNSUPPORTED", 409);
    if (DETAIL_RICH_BUSINESS_CAPABILITIES.some(c => !profile.clientCapabilities.includes(c))) throw failure("DETAIL_CAPABILITY_UNAVAILABLE", 409);
    const reader = this.businessReader, epoch = this.businessPortsEpoch;
    if (!reader || richHostModules.some(name => !reader.ports[name])) throw failure("DETAIL_BUSINESS_RICH_MODULE_UNAVAILABLE", 409);
    const journal = this.v2Journal(id, { identity, ...profile });
    const scope = this.scope(id), binding = digest({ resources: resourceScope(scope), task: scope.task, work: scope.work });
    const revalidate = () => {
      let current;
      try {
        current = trustedIdentity(authenticate(), true);
        if (!matchesScope(cacheScope(current, this.scope(id).logicalSessionId, profile.catalog, profile.clientCapabilities), identityScope)) throw failure("DETAIL_IDENTITY_CHANGED", 403);
      } catch (error) {
        const { catalogProfile, capabilitiesHash, sessionId, ...authority } = identityScope;
        this.clearCache(authority); throw error;
      }
      const now = this.scope(id);
      if (reader !== this.businessReader || epoch !== this.businessPortsEpoch || journal.detailRetired || this.v2Journals.get(key) !== journal
        || digest({ resources: resourceScope(now), task: now.task, work: now.work }) !== binding) throw failure("DETAIL_READ_INVALIDATED", 409);
      return current;
    };
    revalidate();
    return { profile, journal, revalidate };
  }
  async prepareRichActionSnapshot(id, options) {
    const pinned = this.#pinRichRead(id, options), state = pinned.journal.entries.at(-1)?.state;
    if (!state) return this.prepareRichSnapshot(id, options);
    pinned.revalidate(); return Object.freeze({ state, revalidate: pinned.revalidate });
  }
  richPageContext(id, { authenticate, catalog, clientCapabilities, cardId, collectionName, cursor }) {
    const pinned = this.#pinRichRead(id, { authenticate, catalog, clientCapabilities });
    const name = cardId?.startsWith("business-") ? cardId.slice(9) : "";
    const context = pinned.journal.detailPageContexts?.get(name);
    if (collectionName !== "resources" || !context || !this.businessReader.ports[name]?.readPage
      || !this.acceptsDeliveryCatalog(pinned.profile.catalog)) throw failure("DETAIL_CURSOR_INVALID", 409);
    const entry = this.collectionPager.validate(context, cursor);
    return { ...pinned, name, entry, context };
  }
  async richBusinessPage(id, options) {
    const pinned = this.richPageContext(id, options), reader = this.businessReader;
    const page = await this.collectionPager.read(pinned.context, options.cursor,
      async continuation => {
        await reader.admit();
        try { pinned.revalidate(); return await reader.ports[pinned.name].readPage(this.scope(id),
          pinned.revalidate(), continuation, this.richPageLimit(pinned.profile)); } finally { reader.release(); }
      }, () => {
        pinned.revalidate();
        const current = pinned.journal.detailPageContexts.get(pinned.name);
        if (!current) throw failure("DETAIL_CURSOR_INVALID", 409);
        this.collectionPager.validate(current, options.cursor);
      });
    pinned.revalidate();
    if (this.richHostPending.has(digest(pinned.journal.detailCacheScope))) throw failure("DETAIL_READ_BUSY", 429);
    // Only the host's opaque continuation selects a page. Keep the current
    // page position across unrelated SSE invalidations, never append >20 rows.
    const previous = pinned.journal.detailPagePositions.get(pinned.name);
    pinned.journal.detailPagePositions.set(pinned.name, pinned.entry.continuation);
    try {
      return await this.richBusinessSnapshot(id, { authenticate: pinned.revalidate, ...pinned.profile,
        pageOverride: { name: pinned.name, data: page } });
    } catch (error) {
      if (previous === undefined) pinned.journal.detailPagePositions.delete(pinned.name);
      else pinned.journal.detailPagePositions.set(pinned.name, previous);
      throw error;
    }
  }
  clearCache(filter = {}) {
    this.businessInvalidation.clear();
    this.businessReader?.clear(filter);
    for (const [key, entry] of this.cache) if (matchesScope(entry.cacheScope, filter)) this.cache.delete(key);
    for (const [key, journal] of this.v2Journals) if (matchesScope(journal.detailCacheScope, filter)) this.retireJournal(key);
    for (const events of [this.events, this.v2Events]) {
      for (const client of [...events.clients]) if (client.detailCacheScope && matchesScope(client.detailCacheScope, filter)) client.close();
    }
  }
  invalidate(change) {
    this.events.invalidate(change); this.v2Events.invalidate(change);
  }
  markDirty(change) {
    this.businessReader?.invalidate(change);
    for (const journal of this.v2Journals.values()) {
      if (change?.sessionId && ![journal.detailCacheScope.sessionId, journal.detailResourceScope?.session?.id].includes(change.sessionId)) continue;
      if (change?.taskId && journal.detailResourceScope?.task?.id !== change.taskId) continue;
      if (change?.workId && journal.detailResourceScope?.work?.id !== change.workId) continue;
      for (const name of journal.detailPageContexts?.keys() ?? []) {
        if (!knownDependencies.has(change?.resourceType) || this.businessReader?.ports[name]?.dependencies.includes(change.resourceType)) {
          this.collectionPager.clear({ generation: journal.detailGeneration, collectionName: name });
          journal.detailPageContexts.delete(name); journal.detailPagePositions.delete(name);
        }
      }
    }
    // Product-level callers can supply resource changes without coupling to a
    // Provider. Unknown/global hints conservatively invalidate every module.
    for (const entry of this.cache.values()) {
      if (change?.sessionId && ![entry.scope.session.id, entry.scope.logicalSessionId].includes(change.sessionId)) continue;
      if (change?.taskId && entry.scope.task?.id !== change.taskId) continue;
      if (change?.workId && entry.scope.work?.id !== change.workId) continue;
      for (const name of this.modules) {
        if (!knownDependencies.has(change?.resourceType) || DETAIL_BUSINESS_MODULES[name].dependencies.includes(change.resourceType)) entry.dirty.add(name);
      }
    }
  }
  configureBusinessPorts(ports) {
    this.businessReader?.clear();
    this.businessPortsEpoch++;
    for (const [key, journal] of this.v2Journals) if (journal.detailCacheScope.catalogProfile !== "native-v2") this.retireJournal(key);
    this.businessReader = new DetailBusinessReadCache(ports);
  }
  /** Internal preparation only: not mounted by GET or attachV2. The complete
   * currently supported producer set is mandatory, never a claim of full UI
   * coverage. authenticate must resolve trusted authority, not wire fields. */
  async richBusinessSnapshot(id, { authenticate, catalog, clientCapabilities, invalidatedOnly = false, modules = richHostModules, pageOverride } = {}) {
    if (typeof authenticate !== "function") throw failure("AUTHENTICATED_PRINCIPAL_REQUIRED", 403);
    const identity = trustedIdentity(authenticate(), true);
    const context = this.v2Context(id, { identity, catalog, clientCapabilities });
    const { profile, identityScope, key } = context;
    if (profile.catalog !== "native-v2-components-1") throw failure("DETAIL_CATALOG_UNSUPPORTED", 409);
    if (!Array.isArray(modules) || modules.length !== richHostModules.length || richHostModules.some((name, i) => modules[i] !== name)) {
      throw failure("DETAIL_BUSINESS_RICH_MODULE_UNAVAILABLE", 409);
    }
    if (DETAIL_RICH_BUSINESS_CAPABILITIES.some(capability => !profile.clientCapabilities.includes(capability))) {
      throw failure("DETAIL_CAPABILITY_UNAVAILABLE", 409);
    }
    const reader = this.businessReader, portsEpoch = this.businessPortsEpoch;
    if (!reader || richHostModules.some(name => !reader.ports[name])) throw failure("DETAIL_BUSINESS_RICH_MODULE_UNAVAILABLE", 409);
    const scope = this.scope(id), binding = digest({ resources: resourceScope(scope), task: scope.task, work: scope.work });
    const guard = journal => {
      try {
        const current = cacheScope(trustedIdentity(authenticate(), true), this.scope(id).logicalSessionId, profile.catalog, profile.clientCapabilities);
        if (!matchesScope(current, identityScope)) throw failure("DETAIL_IDENTITY_CHANGED", 403);
      } catch (error) {
        const { catalogProfile, capabilitiesHash, sessionId, ...authority } = identityScope;
        this.clearCache(authority); throw error;
      }
      const currentScope = this.scope(id);
      if (reader !== this.businessReader || portsEpoch !== this.businessPortsEpoch || journal.detailRetired
        || this.v2Journals.get(key) !== journal
        || digest({ resources: resourceScope(currentScope), task: currentScope.task, work: currentScope.work }) !== binding) {
        throw failure("DETAIL_READ_INVALIDATED", 409);
      }
    };
    let pending = this.richHostPending.get(key);
    if (pending && (pageOverride || pending.invalidatedOnly !== invalidatedOnly && !pending.pageOverride)) throw failure("DETAIL_READ_BUSY", 429);
    if (!pending) {
      if (this.richHostPending.size >= 8) throw failure("DETAIL_READ_BUSY", 429);
      const journal = this.v2Journal(id, { identity, ...profile });
      guard(journal);
      const operation = async () => {
        const values = new Array(richHostModules.length);
        let nextModule = 0;
        await Promise.all(Array.from({ length: 2 }, async () => {
          while (nextModule < richHostModules.length) {
            const index = nextModule++;
            guard(journal);
            const name = richHostModules[index], port = reader.ports[name];
            const paged = this.#richReadEnabled && profile.clientCapabilities.includes("detail.button") && typeof port.readPage === "function";
            const position = journal.detailPagePositions.get(name) ?? null;
            values[index] = await reader.read(scope, name, identityScope, { force: !invalidatedOnly,
              ...(paged ? { selector: position ?? "first-page", sourceRead: () => pageOverride?.name === name ? pageOverride.data
                : port.readPage(scope, identity, position, this.richPageLimit(profile)) } : {}) });
          }
        }));
        guard(journal);
        const previous = journal.entries.at(-1)?.state;
        const results = Object.fromEntries(richHostModules.map((name, i) => [name, values[i]]));
        const operations = [];
        if (this.#richWritesEnabled && this.#businessActionRegistry && profile.clientCapabilities.includes("detail.form")
          && profile.clientCapabilities.includes("detail.button")) {
          const identityForActions = identity.principalId === "local-user" && !identity.deviceId ? { ...identity, kind: "local_user" } : identity;
          const actionScope = { sessionId: scope.logicalSessionId, identity: identityForActions };
          const prepare = async (operation, target, fields, id, label) => {
            const port = this.#businessActionRegistry.ports[operation];
            if (!port?.resource || !port?.revision) return null;
            try {
              const resource = await port.resource(actionScope, target), expectedResourceRevision = port.revision(resource);
              const action = { id, kind: "command", operation, target, expectedResourceRevision, available: true,
                label: { fallback: label }, confirmation: operation === "memory.delete" || operation.endsWith(".remove") || operation === "schedule.cancel" ? "destructive" : "none" };
              await this.#businessActionRegistry.prepare({ action, fields, expectedResourceRevision, scope: actionScope });
              guard(journal); return action;
            } catch { guard(journal); return null; }
          };
          for (const row of results.memories?.data?.items ?? []) {
            const target = { resourceType: "memory", id: row.resource.id }, resource = this.store.getMemory?.(target.id);
            if (!resource || resource.revoked_at || typeof resource.content !== "string" || resource.content.length > 16000) continue;
            const save = await prepare("memory.update", target, { content: resource.content }, "save", "保存记忆");
            const remove = await prepare("memory.delete", target, { confirmed: true }, "remove", "撤销记忆");
            if (save && remove) operations.push({ kind: "memory", id: `memory-editor-${detailV2Hash(target).slice(7)}`,
              fields: { title: `记忆 · ${row.kind}`, state: "修改后需要保存；资源变化时请重新加载", content: resource.content }, actions: { save, remove } });
          }
          for (const [name, operation, type, label] of [["references", "reference.remove", "reference", "移除引用"],
            ["schedules", "schedule.cancel", "schedule", "取消计划"]]) {
            for (const row of results[name]?.data?.items ?? []) {
              const target = { resourceType: type, id: row.resource.id }, remove = await prepare(operation, target, { confirmed: true }, "remove", label);
              if (remove) operations.push({ kind: "remove", id: `${name}-operation-${detailV2Hash(target).slice(7)}`,
                fields: { title: row.displayName || row.name || label, state: "操作前需要确认" }, actions: { remove } });
            }
          }
          const target = { resourceType: "session", id: scope.logicalSessionId };
          const save = await prepare("reference.add", target, { locator: "https://example.invalid" }, "save", "添加引用");
          if (save) operations.push({ kind: "reference-add", id: "reference-add", fields: {
            title: "添加网页引用", state: "提交后将由服务器联网读取该地址", locator: "", displayName: "" }, actions: { save } });
        }
        const pages = Object.fromEntries(richHostModules.filter(name => this.#richReadEnabled
          && profile.clientCapabilities.includes("detail.button") && typeof reader.ports[name].readPage === "function")
          .map(name => [`business-${name}`, { nextCursor: previous?.instances[`business-${name}`]?.collections.resources.nextCursor ?? null }]));
        const project = () => projectDetailBusinessRich(scope, results,
          { profile, generation: journal.detailGeneration, previous, navigation: this.#richNavigationEnabled,
            editors: this.#richWritesEnabled && Boolean(this.#businessActionRegistry), pages, operations });
        const provisional = project();
        for (const [cardId, config] of Object.entries(pages)) {
          const name = cardId.slice(9), context = { authority: { serverId: identityScope.serverId, accountId: identityScope.accountId,
            principalId: identityScope.principalId, deviceId: identityScope.deviceId }, sessionId: identityScope.sessionId,
            catalog: profile.catalog, clientCapabilities: profile.clientCapabilities, generation: journal.detailGeneration,
            collectionName: name, revision: provisional.instances[cardId].collections.resources.revision };
          const source = results[name]?.data?.sourceCursor ?? null;
          let next = this.collectionPager.issue(context, source);
          if (previous && next !== config.nextCursor && context.revision === previous.instances[cardId]?.collections.resources.revision) {
            if (next) this.collectionPager.revoke(next);
            context.revision++; next = this.collectionPager.issue(context, source);
          }
          config.nextCursor = next; journal.detailPageContexts.set(name, context);
        }
        const state = project();
        guard(journal);
        if (state !== previous) journal.publish(state);
        return journal.entries.at(-1).state;
      };
      pending = { journal, invalidatedOnly, pageOverride: Boolean(pageOverride), promise: operation() };
      this.richHostPending.set(key, pending);
      void pending.promise.finally(() => { if (this.richHostPending.get(key) === pending) this.richHostPending.delete(key); }).catch(() => {});
    }
    guard(pending.journal);
    const state = await pending.promise;
    guard(pending.journal);
    return state;
  }
  invalidateStateChanges() { this.businessInvalidation.publishStateChanges(); }
  invalidateProductEvent(type, payload, sessionId) { this.businessInvalidation.publishEvent(type, payload, sessionId); }
  async readBusinessModule(id, name, { identity = {}, force = true, catalog = "native-v2", clientCapabilities } = {}) {
    const profile = detailV2CatalogOptions({ catalog, clientCapabilities });
    if (!this.businessReader) return { state: "error", code: "DETAIL_MODULE_UNAVAILABLE" };
    const scope = this.scope(id), reader = this.businessReader;
    const binding = digest(resourceScope(scope));
    const identityScope = cacheScope(identity, scope.logicalSessionId, profile.catalog, profile.clientCapabilities);
    // Account/principal metadata is retained; credentials are never retained.
    const result = await reader.read(scope, name, identityScope, { force });
    if (reader !== this.businessReader || digest(resourceScope(this.scope(id))) !== binding) {
      throw failure("DETAIL_READ_INVALIDATED", 409);
    }
    return result;
  }
  v2Context(id, options = {}) {
    const profile = snapshotProfile({ ...options, catalog: options.catalog ?? options.catalogProfile ?? "native-v2" });
    if (profile.catalog === "native-v1") throw failure("DETAIL_CATALOG_UNSUPPORTED", 409);
    const scope = this.scope(id), identityScope = cacheScope(options.identity, scope.logicalSessionId, profile.catalog, profile.clientCapabilities);
    return { profile, identityScope, key: digest(identityScope) };
  }
  // Internal journal preparation supports strict profiles without enabling a
  // rich producer or HTTP gate. Publication still validates the same profile.
  v2Journal(id, options = {}) {
    const { profile, identityScope, key } = this.v2Context(id, options);
    const resources = resourceScope(this.scope(id)), resourceBinding = digest(resources);
    const documentGeneration = this.cache.get(key)?.document.generation;
    let journal = this.v2Journals.get(key);
    if (!journal || journal.detailResourceBinding !== resourceBinding || (documentGeneration && journal.detailGeneration !== documentGeneration)) {
      this.retireJournal(key);
      journal = new DetailV2Journal(profile);
      journal.detailResourceBinding = resourceBinding; journal.detailResourceScope = resources;
      journal.detailPageContexts = new Map(); journal.detailPagePositions = new Map();
      const generation = documentGeneration ?? randomUUID(), publish = journal.publish.bind(journal), resume = journal.resume.bind(journal);
      Object.defineProperty(journal, "detailGeneration", { value: generation, enumerable: true });
      journal.publish = state => {
        if (journal.detailRetired) throw failure("DETAIL_JOURNAL_RETIRED", 409);
        if (state.documentId !== `detail:${identityScope.sessionId}` || state.sessionId !== identityScope.sessionId
          || state.generation !== generation) throw failure("DETAIL_JOURNAL_SCOPE_MISMATCH", 409);
        return publish(state);
      };
      journal.resume = cursor => {
        if (journal.detailRetired) throw failure("DETAIL_JOURNAL_RETIRED", 409);
        return resume(cursor);
      };
    }
    journal.detailCacheScope = identityScope;
    this.v2Journals.delete(key); this.v2Journals.set(key, journal);
    if (this.v2Journals.size > 64) this.retireJournal(this.v2Journals.keys().next().value);
    return journal;
  }
  retireJournal(key) {
    const journal = this.v2Journals.get(key);
    if (journal) {
      this.collectionPager.clear({ generation: journal.detailGeneration });
      journal.detailRetired = true; journal.entries = []; journal.bytes = 0;
      journal.detailPageContexts?.clear(); journal.detailPagePositions?.clear();
    }
    this.v2Journals.delete(key);
  }
  v2Snapshot(id, options = {}) {
    const { profile, key } = this.v2Context(id, options);
    if (profile.catalog !== "native-v2") throw failure("DETAIL_CATALOG_UNSUPPORTED", 409);
    const document = this.snapshot(id, { ...options, catalog: profile.catalog });
    const existing = this.v2Journals.get(key);
    const previous = existing?.entries.at(-1)?.state;
    if (previous?.generation === document.generation && previous.revision === document.revision) return previous;
    const journal = this.v2Journal(id, { ...options, ...profile });
    const state = projectDetailV2(document, previous);
    journal.publish(state);
    return state;
  }
  /** Exactly five arguments. authenticate is synchronous, returns the trusted
   * current principal/device authority, and throws on revoked credentials.
   * input is the validated wire Request; never accepts an identity/digest.
   * No sixth options argument or client-supplied authority is consumed. */
  attachV2(response, authenticate, id, request, input) {
    validateDetailV2Envelope(input, "Request");
    const profile = detailV2CatalogOptions(input);
    // Recognizing the strict rich wire must not enable either a public
    // subscription or scoped business caches, nor discard its capability set.
    if (!this.acceptsDeliveryCatalog(profile.catalog)) throw failure("DETAIL_CATALOG_UNSUPPORTED", 409);
    if (profile.catalog === "native-v2-components-1") {
      const pinned = this.#pinRichRead(id, { authenticate, ...profile });
      this.#attachV2Profile(response, pinned.revalidate, id, request, input, profile, true);
    } else this.#attachV2Profile(response, authenticate, id, request, input, profile);
  }
  /** Internal validation seam only. No HTTP handler calls this entry point. */
  attachRichBusiness(response, authenticate, id, request, input) {
    validateDetailV2Envelope(input, "Request");
    const profile = detailV2CatalogOptions(input);
    const pinned = this.#pinRichRead(id, { authenticate, ...profile });
    this.#attachV2Profile(response, pinned.revalidate, id, request, input, profile, true);
  }
  #attachV2Profile(response, authenticate, id, request, input, profile, rich = false) {
    const identity = trustedIdentity(authenticate(), true), canonicalSessionId = this.scope(id).logicalSessionId;
    const initial = cacheScope(identity, canonicalSessionId, profile.catalog, profile.clientCapabilities);
    const guardedAuthenticate = () => {
      try {
        const current = trustedIdentity(authenticate(), true);
        const currentScope = cacheScope(current, this.scope(id).logicalSessionId, profile.catalog, profile.clientCapabilities);
        if (!matchesScope(currentScope, initial)) throw failure("DETAIL_IDENTITY_CHANGED", 403);
        return current;
      } catch (error) {
        const { catalogProfile, capabilitiesHash, sessionId, ...authority } = initial;
        this.clearCache(authority);
        throw error;
      }
    };
    const resume = input.resume ? { ...input.resume } : null;
    const cached = new Set(input.cachedTemplateHashes);
    const filterTemplates = value => ({ ...value, templates: Object.fromEntries(
      Object.entries(value.templates).filter(([hash]) => !cached.has(hash))) });
    this.#attachScoped(this.v2Events, response, guardedAuthenticate, id, request, {
      // Capture this client's canonical negotiated profile, never a function
      // supplied by the Request. Rich remains gated above until full producer
      // and business capabilities are integrated.
      snapshot: rich ? async (_currentIdentity, sessionId) => {
        const prepared = await this.prepareRichSnapshot(sessionId, { authenticate: guardedAuthenticate, ...profile, invalidatedOnly: true });
        prepared.revalidate(); return prepared.state;
      } : (currentIdentity, sessionId) => this.v2Snapshot(sessionId,
        { identity: currentIdentity, ...profile, invalidatedOnly: true }),
      eventForSnapshot: (previous, next) => {
        if (previous && previous.generation === next.generation) {
          return { name: "detail-commit", value: diffDetailV2(previous, next, profile) };
        }
        const key = digest(initial);
        const journal = this.v2Journals.get(key);
        if (!journal || journal.detailRetired) throw failure("DETAIL_JOURNAL_RETIRED", 409);
        // resume prunes. Query a bounded shallow view so event generation is
        // pure with respect to the canonical journal and delivery baseline.
        const view = Object.create(journal);
        view.entries = journal.entries.slice(); view.bytes = journal.bytes;
        const result = DetailV2Journal.prototype.resume.call(view, previous ? null : resume);
        if (result.kind === "ready") return { name: "detail-ready", value: {
          protocolVersion: 2, documentId: next.documentId, sessionId: next.sessionId,
          generation: next.generation, revision: next.revision, stateHash: next.stateHash } };
        return { name: result.kind === "commit" ? "detail-commit" : "detail-snapshot", value: filterTemplates(result.value) };
      }
    }, profile);
  }
  scope(id) {
    const logical = this.store.getLogicalSession(id) ?? this.store.getLogicalSessionByLegacySessionId?.(id);
    const session = this.store.getSession(logical?.legacySessionId ?? id);
    if (!session || session.archived || logical?.archived) throw failure("SESSION_NOT_FOUND", 404);
    this.businessInvalidation.observe(session);
    const logicalSessionId = logical?.logicalSessionId ?? this.store.getLogicalSessionByLegacySessionId?.(session.id)?.logicalSessionId ?? session.id;
    const task = session.taskId ? this.store.getTask(session.taskId) : null;
    const workId = task?.work_id ?? session.workId;
    return { session, logicalSessionId, task, work: workId ? this.store.getWork(workId) : null };
  }
  snapshot(id, options = {}) {
    const { invalidatedOnly = false, identity } = options, profile = snapshotProfile(options);
    if (!["native-v1", "native-v2"].includes(profile.catalog)) throw failure("DETAIL_CATALOG_UNSUPPORTED", 409);
    const scope = this.scope(id), documentId = `detail:${scope.logicalSessionId}`;
    const identityScope = cacheScope(identity, scope.logicalSessionId, profile.catalog, profile.clientCapabilities), key = digest(identityScope);
    const previous = this.cache.get(key);
    // Direct reads/refresh always check current facts. Event delivery may reuse
    // modules outside the authoritative invalidation's dependency set.
    const modules = projectBusinessModules(scope, this.modules, previous?.modules, invalidatedOnly ? previous?.dirty : undefined);
    if (previous && [...modules].every(([name, module]) => previous.modules.get(name) === module)) {
      previous.scope = resourceScope(scope);
      return previous.document;
    }
    const projection = businessDocument(scope, modules);
    // Structure revisions cannot reset when an optional Work field disappears.
    const oldCards = new Map(previous?.document.cards.map(card => [card.id, card]) ?? []);
    projection.cards = projection.cards.map(card => {
      const old = oldCards.get(card.id);
      if (!old) return card;
      const shape = ({ title, semanticKind, rootNodeId, nodes, fallback }) => ({ title, semanticKind, rootNodeId, nodes, fallback });
      const templateRevision = old.templateRevision + Number(JSON.stringify(shape(old)) !== JSON.stringify(shape(card)));
      return old.templateRevision === templateRevision && old.dataRevision === card.dataRevision ? old : { ...card, templateRevision };
    });
    const hash = digest(projection);
    if (previous?.hash === hash) { previous.modules = modules; previous.scope = resourceScope(scope); return previous.document; }
    const document = { ...projection, generation: this.generation, revision: (previous?.document.revision ?? 0) + 1 };
    validateDetailContract(document, "Document");
    this.cache.delete(key);
    this.cache.set(key, { hash, document, modules, scope: resourceScope(scope), cacheScope: identityScope, dirty: new Set() });
    if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value);
    // Cache eviction starts a new document generation, rather than reusing a revision sequence.
    if (!previous) document.generation = randomUUID();
    else document.generation = previous.document.generation;
    return document;
  }
}

export function detailPatch(previous, next) {
  const old = new Map(previous.cards.map(card => [card.id, card]));
  const remaining = new Set(next.order);
  return validateDetailContract({ documentId: next.documentId, sessionId: next.sessionId, generation: next.generation,
    baseRevision: previous.revision, revision: next.revision,
    upsertCards: next.cards.filter(card => digest(old.get(card.id)) !== digest(card)),
    removeCardIds: previous.order.filter(id => !remaining.has(id)),
    ...(JSON.stringify(previous.order) !== JSON.stringify(next.order) ? { order: next.order } : {}) }, "Patch");
}

export function detailServiceFor(store, hostOptions) {
  let service = services.get(store);
  if (!service) { service = new DetailDocumentService(store, hostOptions); services.set(store, service); }
  return service;
}

/** Actual HTTP delivery, with no host guard/container or authority on the wire. */
export async function sendNegotiatedDetailSnapshot(service, request, response, id, authenticate, negotiation) {
  if (!service.acceptsDeliveryCatalog(negotiation.catalog)) throw failure("DETAIL_CATALOG_UNSUPPORTED", 409);
  if (negotiation.catalog === "native-v2-components-1") {
    const prepared = await service.prepareRichSnapshot(id, { authenticate,
      catalog: negotiation.catalog, clientCapabilities: negotiation.clientCapabilities });
    prepared.revalidate();
    return sendDetailV2Snapshot(request, response, prepared.state, authenticate, { beforeWrite: prepared.revalidate });
  }
  const identity = authenticate();
  return sendDetailV2Snapshot(request, response, service.v2Snapshot(id, detailV2ServiceOptions(identity, negotiation)), authenticate);
}

/** The desktop facade uses the existing loopback trust boundary, never a fabricated device. */
export function handleDesktopDetail({ request, response, url, store, sendJson }) {
  const match = /^\/sessions\/([^/]+)\/detail(?:\/(events|capabilities))?$/.exec(url.pathname);
  if (!match) return false;
  const authenticate = () => {
    if (request.headers.origin || request.headers["x-corptie-agent-id"] ||
        !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress)) throw failure("LOCAL_USER_REQUIRED", 403);
    return { principalId: "local-user" };
  };
  try {
    const identity = authenticate();
    if (request.method !== "GET" || url.search) throw failure("DETAIL_REQUEST_NOT_ALLOWED", 405);
    if (match[2] === "capabilities") {
      if (request.headers.accept !== "application/json") throw failure("DETAIL_CATALOG_UNSUPPORTED", 409);
      const service = detailServiceFor(store); service.scope(decodeURIComponent(match[1]));
      sendJson(response, 200, service.deliveryCapabilities()); return true;
    }
    const negotiation = !match[2] ? detailV2GetNegotiation(request) : null;
    const v2 = negotiation !== null;
    if (!v2 && !acceptsNativeDetail(request)) throw failure("DETAIL_CATALOG_UNSUPPORTED", 409);
    const id = decodeURIComponent(match[1]), service = detailServiceFor(store);
    if (v2 && !service.acceptsDeliveryCatalog(negotiation.catalog)) throw failure("DETAIL_CATALOG_UNSUPPORTED", 409);
    const scoped = service.scope(id);
    const authenticatedScope = detailV2PinnedAuthenticate(authenticate, () => service.scope(id).logicalSessionId, identity, scoped.logicalSessionId);
    if (match[2]) service.events.attach(response, authenticatedScope, id, request);
    else if (v2) void sendNegotiatedDetailSnapshot(service, request, response, id, authenticatedScope, negotiation)
      .catch(error => { if (!response.destroyed && !response.headersSent) sendJson(response, error.status ?? 400, { code: error.code ?? "INVALID_DETAIL_REQUEST" }); });
    else sendJson(response, 200, service.snapshot(id, { identity }));
  } catch (error) { if (!response.headersSent) sendJson(response, error.status ?? 400, { code: error.code ?? "INVALID_DETAIL_REQUEST" }); }
  return true;
}

/** Read-only synchronization with a bounded body; not a write/action endpoint. */
export function handleDesktopDetailSync({ request, response, url, store, sendJson }) {
  const match = /^\/sessions\/([^/]+)\/detail\/sync$/.exec(url.pathname);
  if (!match) return false;
  const authenticate = () => {
    if (request.headers.origin || request.headers["x-corptie-agent-id"] ||
        !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress)) throw failure("LOCAL_USER_REQUIRED", 403);
    return { principalId: "local-user" };
  };
  void (async () => {
    try {
      authenticate();
      if (request.method !== "POST" || url.search) throw failure("DETAIL_REQUEST_NOT_ALLOWED", 405);
      if (request.headers.accept !== "text/event-stream; corptie-detail=native-v2") throw failure("DETAIL_CATALOG_UNSUPPORTED", 409);
      const id = decodeURIComponent(match[1]), service = detailServiceFor(store);
      const identity = authenticate(), scoped = service.scope(id);
      const authenticatedScope = detailV2PinnedAuthenticate(authenticate, () => service.scope(id).logicalSessionId, identity, scoped.logicalSessionId);
      const input = await readDetailV2Request(request);
      service.attachV2(response, authenticatedScope, id, request, input);
    } catch (error) {
      if (!response.headersSent) sendJson(response, error.status ?? 400, { code: error.code ?? "INVALID_DETAIL_REQUEST" });
      else response.destroy();
    }
  })();
  return true;
}
