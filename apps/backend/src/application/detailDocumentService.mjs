import { randomUUID, createHash } from "node:crypto";
import { ClientInspectorStream } from "./clientInspectorStream.mjs";
import { validateDetailContract } from "./detailDocumentContract.mjs";
import { projectDetailV2, DetailV2Journal, diffDetailV2 } from "./detailSyncV2.mjs";
import { readDetailV2Request } from "./detailV2JSON.mjs";
import { validateDetailV2Envelope } from "./detailV2Contract.mjs";
import { sendDetailV2Snapshot } from "./detailSnapshotTransport.mjs";
import { detailV2GetNegotiation, detailV2ServiceOptions, detailV2PinnedAuthenticate, DETAIL_TRANSPORT_CATALOGS } from "./detailV2Negotiation.mjs";

const services = new WeakMap();
const text = (key, fallback) => ({ key, fallback });
const bounded = value => typeof value === "string" ? value.slice(0, 16000) : "";
const digest = value => createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
const failure = (code, status = 400) => Object.assign(new Error(code), { code, status });

// Accept is already authenticated and forwarded by the secure relay. Do not
// introduce a new custom header that installed relay hosts would strip.
export function acceptsNativeDetail(request) {
  return ["application/json; corptie-detail=native-v1", "text/event-stream; corptie-detail=native-v1"].includes(request.headers.accept);
}

/** Product projection only: no Provider adapters, arbitrary URLs or store serialization. */
export function projectDetailDocument({ session, logicalSessionId, work }) {
  const cards = [];
  const card = (id, title, kind, nodes, data) => cards.push({ id, title, semanticKind: kind,
    templateRevision: 1, dataRevision: digest(data), rootNodeId: "root", nodes, data,
    actions: [{ id: "refresh", kind: "read", operation: "detail.refresh", label: text("detail.refresh", "刷新"), available: true }],
    fallback: text("detail.unavailable", "此卡片暂时无法显示") });
  const column = children => ({ id: "root", kind: "column", props: {}, children });
  const field = (id, binding) => ({ id, kind: "text", props: {}, binding, children: [] });
  card("session-info", text("detail.sessionInfo", "会话信息"), "information",
    [column(["session", ...(work ? ["work"] : [])]), field("session", "sessionId"), ...(work ? [field("work", "workName")] : [])],
    { sessionId: logicalSessionId, ...(work ? { workName: bounded(work.name) } : {}) });
  if (session.sessionKind === "assistantChat" && bounded(session.summary).trim()) card("session-summary", text("detail.sessionSummary", "会话摘要"), "summary",
    [column(["summary"]), { ...field("summary", "summary"), kind: "markdown" }], { summary: bounded(session.summary) });
  return { schemaVersion: 1, documentId: `detail:${logicalSessionId}`, sessionId: logicalSessionId, cards, order: cards.map(c => c.id) };
}

export class DetailDocumentService {
  constructor(store) {
    this.store = store; this.generation = randomUUID(); this.cache = new Map();
    this.events = new ClientInspectorStream({ snapshot: (_, id) => this.snapshot(id),
      eventPrefix: "detail", sessionScopedLimit: true, maxFrameBytes: 256 * 1024 + 1024,
      eventForSnapshot: (previous, next) => previous && previous.generation === next.generation
        ? { name: "detail-patch", value: detailPatch(previous, next) } : { name: "detail-snapshot", value: next } });
    this.v2Journals = new Map();
    this.v2Events = new ClientInspectorStream({ snapshot: (_, id) => this.v2Snapshot(id),
      eventPrefix: "detail", sessionScopedLimit: true, maxFrameBytes: 256 * 1024 + 1024 });
  }
  invalidate() { this.events.invalidate(); this.v2Events.invalidate(); }
  v2Snapshot(id) {
    const document = this.snapshot(id), existing = this.v2Journals.get(document.documentId);
    const previous = existing?.entries.at(-1)?.state;
    if (previous?.generation === document.generation && previous.revision === document.revision) return previous;
    const journal = existing ?? new DetailV2Journal();
    const state = projectDetailV2(document, previous);
    journal.publish(state);
    this.v2Journals.delete(document.documentId); this.v2Journals.set(document.documentId, journal);
    if (this.v2Journals.size > 64) this.v2Journals.delete(this.v2Journals.keys().next().value);
    return state;
  }
  attachV2(response, authenticate, id, request, input) {
    validateDetailV2Envelope(input, "Request");
    // Recognizing the strict rich wire does not enable scoped business caches.
    if (input.catalog !== "native-v2") throw failure("DETAIL_CATALOG_UNSUPPORTED", 409);
    authenticate(); this.scope(id);
    const cached = new Set(input.cachedTemplateHashes);
    const filterTemplates = value => ({ ...value, templates: Object.fromEntries(
      Object.entries(value.templates).filter(([hash]) => !cached.has(hash))) });
    this.v2Events.attach(response, authenticate, id, request, {
      eventForSnapshot: (previous, next) => {
        if (previous && previous.generation === next.generation) {
          return { name: "detail-commit", value: diffDetailV2(previous, next) };
        }
        const result = this.v2Journals.get(next.documentId).resume(previous ? null : input.resume);
        if (result.kind === "ready") return { name: "detail-ready", value: {
          protocolVersion: 2, documentId: next.documentId, sessionId: next.sessionId,
          generation: next.generation, revision: next.revision, stateHash: next.stateHash } };
        return { name: result.kind === "commit" ? "detail-commit" : "detail-snapshot", value: filterTemplates(result.value) };
      }
    });
  }
  scope(id) {
    const logical = this.store.getLogicalSession(id) ?? this.store.getLogicalSessionByLegacySessionId?.(id);
    const session = this.store.getSession(logical?.legacySessionId ?? id);
    if (!session || session.archived || logical?.archived) throw failure("SESSION_NOT_FOUND", 404);
    const logicalSessionId = logical?.logicalSessionId ?? this.store.getLogicalSessionByLegacySessionId?.(session.id)?.logicalSessionId ?? session.id;
    const task = session.taskId ? this.store.getTask(session.taskId) : null;
    const workId = task?.work_id ?? session.workId;
    return { session, logicalSessionId, task, work: workId ? this.store.getWork(workId) : null };
  }
  snapshot(id) {
    const projection = projectDetailDocument(this.scope(id));
    const hash = digest(projection), previous = this.cache.get(projection.documentId);
    if (previous?.hash === hash) return previous.document;
    const document = { ...projection, generation: this.generation, revision: (previous?.document.revision ?? 0) + 1 };
    validateDetailContract(document, "Document");
    this.cache.delete(document.documentId);
    this.cache.set(document.documentId, { hash, document });
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

export function detailServiceFor(store) {
  let service = services.get(store);
  if (!service) { service = new DetailDocumentService(store); services.set(store, service); }
  return service;
}

/** The desktop facade uses the existing loopback trust boundary, never a fabricated device. */
export function handleDesktopDetail({ request, response, url, store, sendJson }) {
  const match = /^\/sessions\/([^/]+)\/detail(?:\/(events))?$/.exec(url.pathname);
  if (!match) return false;
  const authenticate = () => {
    if (request.headers.origin || request.headers["x-corptie-agent-id"] ||
        !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress)) throw failure("LOCAL_USER_REQUIRED", 403);
    return { principalId: "local-user" };
  };
  try {
    const identity = authenticate();
    if (request.method !== "GET" || url.search) throw failure("DETAIL_REQUEST_NOT_ALLOWED", 405);
    const negotiation = !match[2] ? detailV2GetNegotiation(request) : null;
    const v2 = negotiation !== null;
    if (v2 && !DETAIL_TRANSPORT_CATALOGS.includes(negotiation.catalog)) throw failure("DETAIL_CATALOG_UNSUPPORTED", 409);
    if (!v2 && !acceptsNativeDetail(request)) throw failure("DETAIL_CATALOG_UNSUPPORTED", 409);
    const id = decodeURIComponent(match[1]), service = detailServiceFor(store);
    const scoped = service.scope(id);
    const authenticatedScope = detailV2PinnedAuthenticate(authenticate, () => service.scope(id).logicalSessionId, identity, scoped.logicalSessionId);
    if (match[2]) service.events.attach(response, authenticatedScope, id, request);
    else if (v2) void sendDetailV2Snapshot(request, response, service.v2Snapshot(id, detailV2ServiceOptions(identity, negotiation)), authenticatedScope)
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
