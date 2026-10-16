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
import { DETAIL_COMPONENTS_PROFILE_2, isDetailPresentationProfile } from "./detailPresentationCatalog.mjs";
import { DETAIL_PRESENTATION_BUSINESS_MODULES } from "./detailBusinessPresentationV2.mjs";
import { parseDetailWebCards } from "./detailWebPresentation.mjs";
import { DETAIL_NATIVE_BUSINESS_PROFILE } from "./detailNativeBusinessContract.mjs";
import { projectNativeBusinessDocument, NATIVE_BUSINESS_MODULES, nativeBusinessModuleCard, nativeBusinessEnvelope } from "./detailNativeBusinessProjection.mjs";

const services = new WeakMap();
const digest = value => createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
const failure = (code, status = 400) => Object.assign(new Error(code), { code, status });
const knownDependencies = new Set(DETAIL_RESOURCE_TYPES);
const richHostModules = DETAIL_RICH_BUSINESS_MODULES;
const modulesFor = profile => profile.catalog === DETAIL_COMPONENTS_PROFILE_2 ? DETAIL_PRESENTATION_BUSINESS_MODULES : richHostModules;
export const DETAIL_CAPABILITIES_ACCEPT_V2 = "application/json; corptie-detail-capabilities=2";
export function detailCapabilitiesVersion(accept) {
  if (accept === "application/json") return 1;
  if (accept === DETAIL_CAPABILITIES_ACCEPT_V2) return 2;
  throw failure("DETAIL_CATALOG_UNSUPPORTED", 409);
}
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
  return ["application/json; corptie-detail=native-v1", "text/event-stream; corptie-detail=native-v1",
    `application/json; corptie-detail=${DETAIL_NATIVE_BUSINESS_PROFILE}`, `text/event-stream; corptie-detail=${DETAIL_NATIVE_BUSINESS_PROFILE}`].includes(request.headers.accept);
}
export const requestsNativeBusiness = request => request.headers.accept?.endsWith(`corptie-detail=${DETAIL_NATIVE_BUSINESS_PROFILE}`) === true;

/** Product projection only: no Provider adapters, arbitrary URLs or store serialization. */
export function projectDetailDocument(scope, modules = DEFAULT_DETAIL_MODULES) {
  return businessDocument(scope, projectBusinessModules(scope, modules));
}

export class DetailDocumentService {
  #streamAttachments = new Map();
  #richReadEnabled;
  #richNavigationEnabled;
  #richWritesEnabled;
  #richNativeEditorsEnabled;
  #businessActionRegistry;
  #webCardIDs;
  constructor(store, { modules = DEFAULT_DETAIL_MODULES, richReadEnabled = false, richWritesEnabled = false, richNativeEditorsEnabled = false, webCardIDs = [] } = {}) {
    if ([richReadEnabled, richWritesEnabled, richNativeEditorsEnabled].some(value => typeof value !== "boolean")) throw failure("DETAIL_GATE_INVALID", 500);
    this.#richReadEnabled = richReadEnabled;
    this.#richNavigationEnabled = richReadEnabled;
    this.#richWritesEnabled = richReadEnabled && richWritesEnabled;
    this.#richNativeEditorsEnabled = richReadEnabled && richNativeEditorsEnabled;
    this.#webCardIDs = Object.freeze(parseDetailWebCards(webCardIDs));
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
    this.nativeEvents = new ClientInspectorStream({ snapshot: () => { throw failure("DETAIL_IDENTITY_REQUIRED", 403); },
      eventPrefix: "detail", sessionScopedLimit: true, maxFrameBytes: 256 * 1024 + 1024,
      retryableSnapshotError: error => error.code === "DETAIL_READ_SUPERSEDED" });
    this.nativeWriteGuards = new WeakMap(); this.nativeRetireEpoch = 0; this.nativeEntries = new Map();
    const nativeWrite = this.nativeEvents.write.bind(this.nativeEvents);
    this.nativeEvents.write = (client, event, value) => {
      if (event === "detail-snapshot") {
        try { this.nativeWriteGuards.get(client.response)?.(); } catch { client.close(); return; }
      }
      return nativeWrite(client, event, value);
    };
    for (const events of [this.events, this.v2Events, this.nativeEvents]) {
      this.#streamAttachments.set(events, events.attach.bind(events));
      events.attach = (response, authenticate, id, request, options) => {
        this.#attachScoped(events, response, authenticate, id, request, options,
          { catalog: events === this.nativeEvents ? DETAIL_NATIVE_BUSINESS_PROFILE : events === this.v2Events ? "native-v2" : "native-v1", clientCapabilities: [] });
      };
    }
  }
  async prepareNativeBusiness(id, authenticate, { invalidatedOnly = false } = {}) {
    if (!this.#richReadEnabled || NATIVE_BUSINESS_MODULES.some(name => !this.businessReader?.ports[name])) throw failure("DETAIL_CATALOG_UNSUPPORTED", 409);
    const identity = trustedIdentity(authenticate(), true), scope = this.scope(id), reader = this.businessReader,
      epoch = this.businessPortsEpoch, retired = this.nativeRetireEpoch,
      bound = digest({ task: scope.task, work: scope.work, session: scope.logicalSessionId }),
      authority = cacheScope(identity, scope.logicalSessionId, DETAIL_NATIVE_BUSINESS_PROFILE, []);
    const key = digest(authority), resourceBinding = digest(resourceScope(scope));
    let entry = this.nativeEntries.get(key);
    if (!entry || entry.binding !== resourceBinding || entry.reader !== reader || entry.epoch !== epoch) {
      if (entry) entry.retired = true;
      entry = { authority, resources: resourceScope(scope), binding: resourceBinding, reader, epoch, generation: randomUUID(), mutationEpoch: 0, contexts: new Map(), pageActions: new Map(), revisions: new Map() };
      this.nativeEntries.set(key, entry);
      while (this.nativeEntries.size > 64) { const oldest = this.nativeEntries.keys().next().value; this.nativeEntries.get(oldest).retired = true; this.nativeEntries.delete(oldest); }
    }
    const mutationEpoch = entry.mutationEpoch;
    const revalidate = () => {
      const current = trustedIdentity(authenticate(), true), next = this.scope(id);
      if (!matchesScope(cacheScope(current, next.logicalSessionId, DETAIL_NATIVE_BUSINESS_PROFILE, []), authority)) {
        const { catalogProfile, capabilitiesHash, sessionId, ...owner } = authority;
        this.clearCache(owner); throw failure("DETAIL_IDENTITY_CHANGED", 403);
      }
      if (reader !== this.businessReader || epoch !== this.businessPortsEpoch || retired !== this.nativeRetireEpoch || entry.retired || this.nativeEntries.get(key) !== entry) throw failure("DETAIL_SCOPE_RETIRED", 409);
      if (entry.resources.task?.id !== next.task?.id || entry.resources.work?.id !== next.work?.id
        || entry.resources.session.id !== next.session.id || entry.resources.logicalSessionId !== next.logicalSessionId) throw failure("DETAIL_BINDING_CHANGED", 409);
      if (bound !== digest({ task: next.task, work: next.work, session: next.logicalSessionId })) throw failure("DETAIL_READ_SUPERSEDED", 409);
      if (mutationEpoch !== entry.mutationEpoch) throw failure("DETAIL_READ_SUPERSEDED", 409);
      return current;
    };
    revalidate();
    const results = {}; let index = 0;
    await Promise.all(Array.from({ length: 2 }, async () => {
      while (index < NATIVE_BUSINESS_MODULES.length) {
        const name = NATIVE_BUSINESS_MODULES[index++], port = reader.ports[name]; revalidate();
        try { results[name] = await reader.read(scope, name, authority, { force: !invalidatedOnly,
          ...(port.readPage ? { selector: "native-business:first", sourceRead: () => port.readPage(scope, identity, null,
            ["memories", "memoryHits"].includes(name) ? 1 : 20, { fullContent: true }) } : {}) }); }
        catch (error) { if (error.code === "DETAIL_READ_INVALIDATED") revalidate(); throw error; }
        revalidate();
      }
    }));
    const operations = await this.nativeBusinessOperations(scope, identity, results, revalidate), pages = {};
    for (const name of NATIVE_BUSINESS_MODULES) {
      if (!reader.ports[name].readPage) continue;
      const context = { authority: { serverId: authority.serverId, accountId: authority.accountId, principalId: authority.principalId, deviceId: authority.deviceId },
        sessionId: scope.logicalSessionId, catalog: DETAIL_NATIVE_BUSINESS_PROFILE, clientCapabilities: [], generation: entry.generation,
        collectionName: name, revision: digest(results[name]) };
      const old = entry.contexts.get(name);
      if (old && old.revision !== context.revision) entry.pageActions.delete(name);
      entry.contexts.set(name, context);
      pages[name] = { sessionId: scope.logicalSessionId, nextCursor: this.collectionPager.issue(context, results[name].data?.sourceCursor ?? null) };
    }
    revalidate(); entry.revalidate = revalidate;
    const state = projectNativeBusinessDocument(scope, results, entry.generation, { editors: this.#richNativeEditorsEnabled, pages, operations });
    for (const card of state.cards) entry.revisions.set(card.id, card.revision);
    entry.state = state;
    return Object.freeze({ state, revalidate });
  }
  async nativeBusinessOperations(scope, identity, results, revalidate) {
    const operations = {};
    if (!this.#richWritesEnabled || !this.#businessActionRegistry) return operations;
    const actionScope = { sessionId: scope.logicalSessionId, identity: identity.principalId === "local-user" && !identity.deviceId ? { ...identity, kind: "local_user" } : identity };
    const prepare = async (name, operation, type, id, fields, title) => {
      const port = this.#businessActionRegistry.ports[operation];
      if (!port?.resource || !port.revision) return;
      try {
        const target = { resourceType: type, id }, resource = await port.resource(actionScope, target), expectedResourceRevision = port.revision(resource);
        const action = { id: `${operation}-${digest(id).slice(0, 24)}`, kind: "command", operation, target, expectedResourceRevision,
          label: { fallback: title }, available: true, confirmation: operation === "memory.update" || operation === "reference.add" ? "none" : "destructive" };
        await this.#businessActionRegistry.prepare({ action, fields, expectedResourceRevision, scope: actionScope });
        revalidate(); (operations[name] ??= []).push(action);
      } catch { revalidate(); }
    };
    for (const row of results.memories?.data?.items ?? []) {
      if (!row.revokedAt && row.content.length <= 16000) {
        await prepare("memories", "memory.update", "memory", row.resource.id, { content: row.content }, "保存记忆");
        await prepare("memories", "memory.delete", "memory", row.resource.id, { confirmed: true }, "撤销记忆");
      }
    }
    for (const [name, operation, type, title] of [["references", "reference.remove", "reference", "移除引用"], ["schedules", "schedule.cancel", "schedule", "取消计划"]]) {
      for (const row of results[name]?.data?.items ?? []) await prepare(name, operation, type, row.resource.id, { confirmed: true }, title);
    }
    if (results.references) await prepare("references", "reference.add", "session", scope.logicalSessionId, { locator: "https://example.invalid" }, "添加引用");
    return operations;
  }
  nativePageContext(id, { authenticate, cardId, collectionName, cursor }) {
    const identity = trustedIdentity(authenticate(), true), scope = this.scope(id), authority = cacheScope(identity, scope.logicalSessionId, DETAIL_NATIVE_BUSINESS_PROFILE, []);
    const entry = this.nativeEntries.get(digest(authority)), name = cardId?.startsWith("business-") ? cardId.slice(9) : "";
    if (!entry || entry.retired || collectionName !== "resources" || !entry.contexts.has(name)) throw failure("DETAIL_CURSOR_INVALID", 409);
    entry.revalidate(); const context = entry.contexts.get(name); this.collectionPager.validate(context, cursor);
    return { entry, name, context, scope, identity };
  }
  async nativeBusinessPage(id, options) {
    const { entry, name, context, scope, identity } = this.nativePageContext(id, options), reader = this.businessReader;
    const data = await this.collectionPager.read(context, options.cursor, async cursor => {
      await reader.admit();
      try { entry.revalidate(); return await reader.ports[name].readPage(scope, identity, cursor, ["memories", "memoryHits"].includes(name) ? 1 : 20, { fullContent: true }); }
      finally { reader.release(); }
    }, () => { entry.revalidate(); if (entry.contexts.get(name) !== context) throw failure("DETAIL_CURSOR_INVALID", 409); });
    entry.revalidate();
    const results = { [name]: { state: data.items.length ? "ready" : "empty", data } }, operations = await this.nativeBusinessOperations(scope, identity, results, entry.revalidate);
    const nextCursor = this.collectionPager.issue(context, data.sourceCursor ?? null);
    const card = nativeBusinessModuleCard(name, results[name], { editors: this.#richNativeEditorsEnabled, operations: operations[name] ?? [], page: { sessionId: scope.logicalSessionId, nextCursor } });
    card.revision = entry.revisions.get(card.id);
    const extra = entry.pageActions.get(name) ?? new Map();
    for (const action of card.actions) if (action.kind === "command" || action.operation === "artifact.content") extra.set(action.id, action);
    while (extra.size > 256) extra.delete(extra.keys().next().value);
    entry.pageActions.set(name, extra);
    return nativeBusinessEnvelope(scope.logicalSessionId, entry.generation, [card]);
  }
  async nativeActionDocument(id, authenticate) {
    const initialScope = this.scope(id), initialAuthority = cacheScope(trustedIdentity(authenticate(), true), initialScope.logicalSessionId, DETAIL_NATIVE_BUSINESS_PROFILE, []);
    const cached = this.nativeEntries.get(digest(initialAuthority));
    let prepared;
    if (cached?.state && !cached.retired) {
      try { cached.revalidate(); prepared = { state: cached.state, revalidate: cached.revalidate }; }
      catch (error) { if ([401, 403, 404].includes(error.status)) throw error; }
    }
    prepared ??= await this.prepareNativeBusiness(id, authenticate);
    const authority = cacheScope(trustedIdentity(authenticate(), true), prepared.state.sessionId, DETAIL_NATIVE_BUSINESS_PROFILE, []), entry = this.nativeEntries.get(digest(authority));
    const cards = prepared.state.cards.map(card => {
      const extra = entry.pageActions.get(card.id.slice(9));
      return extra ? { ...card, actions: [...new Map([...card.actions, ...extra.values()].map(action => [action.id, action])).values()] } : card;
    });
    return { state: { ...prepared.state, cards }, revalidate: prepared.revalidate };
  }
  attachNativeBusiness(response, authenticate, id, request) {
    if (!this.#richReadEnabled) throw failure("DETAIL_CATALOG_UNSUPPORTED", 409);
    return this.nativeEvents.attach(response, authenticate, id, request, {
      snapshot: async () => {
        const prepared = await this.prepareNativeBusiness(id, authenticate, { invalidatedOnly: true });
        this.nativeWriteGuards.set(response, prepared.revalidate); return prepared.state;
      }
    });
  }
  /** Host configuration only. Requests cannot enable a catalog or write UI. */
  acceptsDeliveryCatalog(catalog) {
    return DETAIL_TRANSPORT_CATALOGS.includes(catalog)
      || this.#richReadEnabled && isDetailPresentationProfile(catalog);
  }
  deliveryCapabilities(version = 1) {
    const richRead = this.#richReadEnabled && this.businessReader
      && richHostModules.every(name => this.businessReader.ports[name]);
    const pagination = Boolean(richRead && Object.values(this.businessReader.ports).some(port => typeof port.readPage === "function"));
    const writes = Boolean(richRead && this.#richWritesEnabled && this.#businessActionRegistry);
    const legacy = { schemaVersion: 1, catalogs: richRead ? ["native-v2", "native-v2-components-1"] : ["native-v2"],
      requiredCapabilities: richRead ? [...new Set([...(pagination || writes ? ["detail.button"] : []),
        ...DETAIL_RICH_BUSINESS_CAPABILITIES, ...(this.#richNativeEditorsEnabled ? ["detail.button"] : []), ...(writes ? ["detail.form"] : [])])].sort() : [],
      pagination, writes };
    if (version === 1) return legacy;
    if (version !== 2) throw failure("DETAIL_CATALOG_UNSUPPORTED", 409);
    const catalogs = [{ id: "native-v2", requiredCapabilities: [], writes: false, pagination: false }];
    if (richRead) catalogs.push({ id: "native-v2-components-1", requiredCapabilities: legacy.requiredCapabilities, writes, pagination });
    if (this.#richReadEnabled && this.businessReader && DETAIL_PRESENTATION_BUSINESS_MODULES.every(name => this.businessReader.ports[name])) {
      catalogs.push({ id: DETAIL_COMPONENTS_PROFILE_2, requiredCapabilities: legacy.requiredCapabilities, writes, pagination });
    }
    return { schemaVersion: 2, catalogs };
  }
  configureBusinessActionRegistry(registry) {
    if (!registry || typeof registry.prepare !== "function") throw failure("DETAIL_ACTION_REGISTRY_INVALID", 500);
    this.#businessActionRegistry = registry;
    for (const [key, journal] of this.v2Journals) if (journal.detailCacheScope.catalogProfile !== "native-v2") this.retireJournal(key);
  }
  richPageLimit(profile) { return this.#richWritesEnabled && profile.clientCapabilities.includes("detail.form") ? 4 : 20; }
  modulePageLimit(profile, name) {
    // Keep complete Unicode memory bodies inside the existing 64KiB read budget.
    return profile.catalog === DETAIL_COMPONENTS_PROFILE_2 && ["memories", "memoryHits"].includes(name) ? 1 : this.richPageLimit(profile);
  }
  async readPresentationList(port, scope, identity, position, profile, name, revalidate) {
    const options = { fullContent: profile.catalog === DETAIL_COMPONENTS_PROFILE_2 };
    let page = await port.readPage(scope, identity, position, this.modulePageLimit(profile, name), options);
    if (profile.catalog !== DETAIL_COMPONENTS_PROFILE_2) return page;
    // Pagination is a read transport detail, not a visible card control. Keep
    // the existing 20-item/64KiB budget and scope guard across every await.
    const seen = new Set();
    for (let count = 0; count < 19 && page.sourceCursor && page.items.length < 20; count++) {
      revalidate();
      if (seen.has(page.sourceCursor)) throw failure("DETAIL_CURSOR_INVALID", 409);
      seen.add(page.sourceCursor);
      const next = await port.readPage(scope, identity, page.sourceCursor,
        Math.min(this.modulePageLimit(profile, name), 20 - page.items.length), options);
      revalidate();
      const candidate = { ...next, items: [...page.items, ...next.items] };
      if (Buffer.byteLength(JSON.stringify(candidate)) > 65536) break;
      page = candidate;
    }
    revalidate();
    return page;
  }
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
    if (!invalidatedOnly && pinned.profile.catalog === DETAIL_COMPONENTS_PROFILE_2) pinned.journal.detailPagePositions.clear();
    const state = await this.richBusinessSnapshot(id, { authenticate: pinned.revalidate, ...pinned.profile, invalidatedOnly });
    pinned.revalidate();
    return Object.freeze({ state, revalidate: pinned.revalidate });
  }
  #pinRichRead(id, { authenticate, catalog, clientCapabilities }) {
    if (typeof authenticate !== "function") throw failure("AUTHENTICATED_PRINCIPAL_REQUIRED", 403);
    const identity = trustedIdentity(authenticate(), true), context = this.v2Context(id, { identity, catalog, clientCapabilities });
    const { profile, identityScope, key } = context;
    if (!isDetailPresentationProfile(profile.catalog)) throw failure("DETAIL_CATALOG_UNSUPPORTED", 409);
    if (DETAIL_RICH_BUSINESS_CAPABILITIES.some(c => !profile.clientCapabilities.includes(c))) throw failure("DETAIL_CAPABILITY_UNAVAILABLE", 409);
    const reader = this.businessReader, epoch = this.businessPortsEpoch;
    if (!reader || modulesFor(profile).some(name => !reader.ports[name])) throw failure("DETAIL_BUSINESS_RICH_MODULE_UNAVAILABLE", 409);
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
          pinned.revalidate(), continuation, this.modulePageLimit(pinned.profile, pinned.name),
          { fullContent: pinned.profile.catalog === DETAIL_COMPONENTS_PROFILE_2 }); } finally { reader.release(); }
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
    this.nativeRetireEpoch++;
    for (const [key, entry] of this.nativeEntries) if (matchesScope(entry.authority, filter)) { entry.retired = true; this.nativeEntries.delete(key); }
    this.businessInvalidation.clear();
    this.businessReader?.clear(filter);
    for (const [key, entry] of this.cache) if (matchesScope(entry.cacheScope, filter)) this.cache.delete(key);
    for (const [key, journal] of this.v2Journals) if (matchesScope(journal.detailCacheScope, filter)) this.retireJournal(key);
    for (const events of [this.events, this.v2Events, this.nativeEvents]) {
      for (const client of [...events.clients]) if (client.detailCacheScope && matchesScope(client.detailCacheScope, filter)) client.close();
    }
  }
  invalidate(change) {
    this.markDirty(change);
    this.events.invalidate(change); this.v2Events.invalidate(change); this.nativeEvents.invalidate(change);
  }
  markDirty(change) {
    for (const entry of this.nativeEntries?.values() ?? []) {
      if (change?.sessionId && entry.authority.sessionId !== change.sessionId) continue;
      if (change?.taskId && entry.resources?.task?.id !== change.taskId) continue;
      if (change?.workId && entry.resources?.work?.id !== change.workId) continue;
      entry.mutationEpoch++;
    }
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
  async richBusinessSnapshot(id, { authenticate, catalog, clientCapabilities, invalidatedOnly = false, modules, pageOverride } = {}) {
    if (typeof authenticate !== "function") throw failure("AUTHENTICATED_PRINCIPAL_REQUIRED", 403);
    const identity = trustedIdentity(authenticate(), true);
    const context = this.v2Context(id, { identity, catalog, clientCapabilities });
    const { profile, identityScope, key } = context;
    if (!isDetailPresentationProfile(profile.catalog)) throw failure("DETAIL_CATALOG_UNSUPPORTED", 409);
    const hostModules = modulesFor(profile); modules ??= hostModules;
    if (!Array.isArray(modules) || modules.length !== hostModules.length || hostModules.some((name, i) => modules[i] !== name)) {
      throw failure("DETAIL_BUSINESS_RICH_MODULE_UNAVAILABLE", 409);
    }
    if (DETAIL_RICH_BUSINESS_CAPABILITIES.some(capability => !profile.clientCapabilities.includes(capability))) {
      throw failure("DETAIL_CAPABILITY_UNAVAILABLE", 409);
    }
    const reader = this.businessReader, portsEpoch = this.businessPortsEpoch;
    if (!reader || hostModules.some(name => !reader.ports[name])) throw failure("DETAIL_BUSINESS_RICH_MODULE_UNAVAILABLE", 409);
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
        const values = new Array(hostModules.length);
        let nextModule = 0;
        await Promise.all(Array.from({ length: 2 }, async () => {
          while (nextModule < hostModules.length) {
            const index = nextModule++;
            guard(journal);
            const name = hostModules[index], port = reader.ports[name];
            const paged = this.#richReadEnabled && profile.clientCapabilities.includes("detail.button") && typeof port.readPage === "function";
            const position = journal.detailPagePositions.get(name) ?? null;
            values[index] = await reader.read(scope, name, identityScope, { force: !invalidatedOnly,
              ...(paged ? { selector: position ?? "first-page", sourceRead: () => pageOverride?.name === name ? pageOverride.data
                : this.readPresentationList(port, scope, identity, position, profile, name, () => guard(journal)) } : {}) });
          }
        }));
        guard(journal);
        const previous = journal.entries.at(-1)?.state;
        const results = Object.fromEntries(hostModules.map((name, i) => [name, values[i]]));
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
        const pages = Object.fromEntries(hostModules.filter(name => this.#richReadEnabled
          && profile.clientCapabilities.includes("detail.button") && typeof reader.ports[name].readPage === "function")
          .map(name => [`business-${name}`, { nextCursor: previous?.instances[`business-${name}`]?.collections.resources.nextCursor ?? null }]));
        const project = () => projectDetailBusinessRich(scope, results,
          { profile, generation: journal.detailGeneration, previous, navigation: this.#richNavigationEnabled,
            editors: this.#richWritesEnabled && Boolean(this.#businessActionRegistry), nativeEditors: this.#richNativeEditorsEnabled,
            pages, operations, webCardIDs: this.#webCardIDs });
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
    if (isDetailPresentationProfile(profile.catalog)) {
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
  if (isDetailPresentationProfile(negotiation.catalog)) {
    const prepared = await service.prepareRichSnapshot(id, { authenticate,
      catalog: negotiation.catalog, clientCapabilities: negotiation.clientCapabilities });
    prepared.revalidate();
    return sendDetailV2Snapshot(request, response, prepared.state, authenticate, { beforeWrite: prepared.revalidate });
  }
  const identity = authenticate();
  return sendDetailV2Snapshot(request, response, service.v2Snapshot(id, detailV2ServiceOptions(identity, negotiation)), authenticate);
}
export async function sendNativeBusinessSnapshot(service, request, response, id, authenticate) {
  const prepared = await service.prepareNativeBusiness(id, authenticate);
  prepared.revalidate();
  return sendDetailV2Snapshot(request, response, prepared.state, authenticate, { beforeWrite: prepared.revalidate });
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
      const version = detailCapabilitiesVersion(request.headers.accept);
      const service = detailServiceFor(store); service.scope(decodeURIComponent(match[1]));
      sendJson(response, 200, service.deliveryCapabilities(version)); return true;
    }
    const negotiation = !match[2] ? detailV2GetNegotiation(request) : null;
    const v2 = negotiation !== null;
    if (!v2 && !acceptsNativeDetail(request)) throw failure("DETAIL_CATALOG_UNSUPPORTED", 409);
    const id = decodeURIComponent(match[1]), service = detailServiceFor(store);
    if (v2 && !service.acceptsDeliveryCatalog(negotiation.catalog)) throw failure("DETAIL_CATALOG_UNSUPPORTED", 409);
    const scoped = service.scope(id);
    const authenticatedScope = detailV2PinnedAuthenticate(authenticate, () => service.scope(id).logicalSessionId, identity, scoped.logicalSessionId);
    if (requestsNativeBusiness(request)) {
      if (match[2]) service.attachNativeBusiness(response, authenticatedScope, id, request);
      else void sendNativeBusinessSnapshot(service, request, response, id, authenticatedScope)
        .catch(error => { if (!response.destroyed && !response.headersSent) sendJson(response, error.status ?? 400, { code: error.code ?? "INVALID_DETAIL_REQUEST" }); });
    } else if (match[2]) service.events.attach(response, authenticatedScope, id, request);
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
