import { createHash } from "node:crypto";
import { validateDetailContract } from "./detailDocumentContract.mjs";
import { validateDetailV2Envelope } from "./detailV2Contract.mjs";
import { detailV2CatalogOptions, validateDetailV2Components, validateDetailV2CollectionTransition } from "./detailV2Catalog.mjs";
import { isDetailPresentationProfile } from "./detailPresentationCatalog.mjs";

// native-v2 is not enabled on HTTP routes until both endpoints support the
// contract. These pure functions are the shared synchronization boundary.
export const DETAIL_V2_LIMITS = Object.freeze({ bytes: 256 * 1024, depth: 32,
  journalEntries: 128, journalBytes: 2 * 1024 * 1024, journalMs: 10 * 60 * 1000 });
const fail = code => { throw Object.assign(new Error(code), { code }); };
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);
const validString = value => {
  if (typeof value !== "string" || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) fail("DETAIL_V2_STRING");
};
const revision = value => { if (!Number.isSafeInteger(value) || value < 1) fail("DETAIL_V2_REVISION"); };
const id = value => { validString(value); if (!value.length || [...value].length > 512) fail("DETAIL_V2_ID"); };
const hashPattern = /^sha256:[0-9a-f]{64}$/;

/** Restricted canonical JSON: UTF-16 key ordering, safe integer numbers only,
 * no Unicode normalization, JSON escapes, no unpaired surrogates. Decimal
 * business values must be strings. This is not advertised as general JCS. */
export function canonicalDetailV2(value, depth = 0) {
  if (depth > DETAIL_V2_LIMITS.depth) fail("DETAIL_V2_DEPTH");
  if (value === null) return "null";
  if (typeof value === "string") { validString(value); return JSON.stringify(value); }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) fail("DETAIL_V2_NUMBER");
    return String(value === 0 ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(v => canonicalDetailV2(v, depth + 1)).join(",")}]`;
  if (!object(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail("DETAIL_V2_VALUE");
  return `{${Object.keys(value).sort().map(key => {
    validString(key); return `${JSON.stringify(key)}:${canonicalDetailV2(value[key], depth + 1)}`;
  }).join(",")}}`;
}
export function detailV2Hash(value) {
  return `sha256:${createHash("sha256").update(canonicalDetailV2(value)).digest("hex")}`;
}
function bounded(value) {
  const bytes = Buffer.byteLength(canonicalDetailV2(value));
  if (bytes > DETAIL_V2_LIMITS.bytes) fail("DETAIL_V2_LIMIT");
  return bytes;
}
const copy = value => JSON.parse(canonicalDetailV2(value));
const instanceBody = value => ({ fields: value.fields, collections: value.collections, actions: value.actions });
export function detailV2StateHash(state) {
  return detailV2Hash({ manifestHash: state.manifest.hash,
    instances: Object.keys(state.instances).sort().map(cardId => ({ cardId,
      revision: state.instances[cardId].revision, hash: state.instances[cardId].hash })) });
}

export function validateDetailV2(state, profile = {}) {
  const options = detailV2CatalogOptions(profile);
  bounded(state);
  validateDetailV2Envelope(state, "State");
  if (state.protocolVersion !== 2) fail("DETAIL_V2_PROTOCOL");
  id(state.documentId); id(state.sessionId); id(state.generation); revision(state.revision);
  if (!object(state.manifest) || !object(state.templates) || !object(state.instances)) fail("DETAIL_V2_SHAPE");
  const manifest = state.manifest;
  revision(manifest.revision);
  if (!object(manifest.cards) || !Array.isArray(manifest.order) || manifest.order.length > 30 ||
      new Set(manifest.order).size !== manifest.order.length ||
      Object.keys(manifest.cards).length !== manifest.order.length ||
      Object.keys(state.instances).length !== manifest.order.length) fail("DETAIL_V2_MANIFEST");
  if (manifest.hash !== detailV2Hash({ cards: manifest.cards, order: manifest.order })) fail("DETAIL_V2_HASH");
  if (Object.keys(state.templates).length > 30) fail("DETAIL_V2_LIMIT");
  for (const [hash, template] of Object.entries(state.templates)) {
    if (!hashPattern.test(hash) || hash !== detailV2Hash(template)) fail("DETAIL_V2_HASH");
    if (isDetailPresentationProfile(options.catalog) ? template.catalogProfile !== options.catalog : template.catalogProfile !== undefined) fail("DETAIL_V2_CATALOG");
  }
  let nodeCount = 0;
  for (const cardId of manifest.order) {
    id(cardId);
    const ref = manifest.cards[cardId], instance = state.instances[cardId];
    if (!own(manifest.cards, cardId) || !own(state.instances, cardId) || !object(ref) ||
        !own(state.templates, ref.templateHash) || !object(instance)) fail("DETAIL_V2_DEPENDENCY");
    id(ref.templateId); revision(instance.revision);
    if (!object(instance.fields) || !object(instance.collections) || !object(instance.actions)) fail("DETAIL_V2_SHAPE");
    if (instance.hash !== detailV2Hash(instanceBody(instance))) fail("DETAIL_V2_HASH");
    // The initial catalog deliberately reuses the validated v1 native tree.
    // Richer v2 component semantics are not silently accepted here.
    const template = state.templates[ref.templateHash];
    nodeCount += template.card?.nodes?.length ?? 0;
    if (nodeCount > 500 || Object.entries(instance.actions).some(([key, action]) => key !== action.id)) fail("DETAIL_V2_CATALOG");
    if (template.templateId !== ref.templateId) fail("DETAIL_V2_CATALOG");
    if (isDetailPresentationProfile(options.catalog)) {
      validateDetailV2Components(template, instance, state, cardId, options);
      continue;
    }
    if (Object.keys(instance.collections).length) fail("DETAIL_V2_CATALOG");
    validateDetailContract({ schemaVersion: 1, documentId: state.documentId, sessionId: state.sessionId,
      generation: state.generation, revision: state.revision, order: [cardId], cards: [{
        id: cardId, ...template.card, templateRevision: template.templateVersion,
        dataRevision: instance.hash, data: instance.fields, actions: Object.values(instance.actions)
      }] }, "Document");
  }
  if (state.stateHash !== detailV2StateHash(state)) fail("DETAIL_V2_HASH");
  return state;
}

/** Project current, proven cards without changing their rendering semantics. */
export function projectDetailV2(document, previous = null) {
  validateDetailContract(document, "Document");
  if (previous && (document.documentId !== previous.documentId || document.generation !== previous.generation)) previous = null;
  const cards = Object.create(null), templates = Object.create(null), instances = Object.create(null);
  for (const card of document.cards) {
    const { id: cardId, data, actions, dataRevision, templateRevision, ...definition } = card;
    const template = { templateId: `native:${card.semanticKind}:${cardId}`, templateVersion: templateRevision, card: definition };
    const templateHash = detailV2Hash(template);
    templates[templateHash] = template;
    cards[cardId] = { templateId: template.templateId, templateHash };
    const body = { fields: data, collections: {}, actions: Object.fromEntries(actions.map(action => [action.id, action])) };
    const hash = detailV2Hash(body), old = previous?.instances[cardId];
    instances[cardId] = { ...body, hash, revision: old ? old.revision + (old.hash === hash ? 0 : 1) : 1 };
  }
  const manifestBody = { cards, order: document.order }, hash = detailV2Hash(manifestBody);
  const state = { protocolVersion: 2, documentId: document.documentId, sessionId: document.sessionId,
    generation: document.generation, revision: document.revision,
    manifest: { ...manifestBody, hash, revision: previous ? previous.manifest.revision + (previous.manifest.hash === hash ? 0 : 1) : 1 }, templates, instances };
  state.stateHash = detailV2StateHash(state);
  return validateDetailV2(state);
}

function fieldDelta(before, after) {
  return { set: Object.fromEntries(Object.entries(after).filter(([key, value]) =>
    !own(before, key) || canonicalDetailV2(before[key]) !== canonicalDetailV2(value))),
  remove: Object.keys(before).filter(key => !own(after, key)).sort() };
}
export function diffDetailV2(before, after, profile = {}) {
  const options = detailV2CatalogOptions(profile);
  validateDetailV2(before, options); validateDetailV2(after, options);
  if (before.documentId !== after.documentId || before.sessionId !== after.sessionId || before.generation !== after.generation || after.revision <= before.revision) fail("DETAIL_V2_BASE");
  const changes = [];
  for (const [cardId, next] of Object.entries(after.instances)) {
    const old = before.instances[cardId];
    if (!old) changes.push({ cardId, replacement: next });
    else {
      validateDetailV2CollectionTransition(old.collections, next.collections);
      if (old.hash !== next.hash || old.revision !== next.revision) {
        if (next.revision <= old.revision) fail("DETAIL_V2_REVISION");
        changes.push({ cardId, baseRevision: old.revision, revision: next.revision, baseHash: old.hash, resultHash: next.hash,
          fields: fieldDelta(old.fields, next.fields), actions: fieldDelta(old.actions, next.actions),
          ...(isDetailPresentationProfile(options.catalog) ? { collections: fieldDelta(old.collections, next.collections) } : {}) });
      }
    }
  }
  const commit = { protocolVersion: 2, documentId: after.documentId, sessionId: after.sessionId, generation: after.generation,
    baseRevision: before.revision, revision: after.revision, baseStateHash: before.stateHash, resultStateHash: after.stateHash,
    templates: Object.fromEntries(Object.entries(after.templates).filter(([hash]) => !own(before.templates, hash))),
    manifestChange: before.manifest.hash === after.manifest.hash ? null : after.manifest,
    instanceChanges: changes, removeInstanceIds: Object.keys(before.instances).filter(id => !own(after.instances, id)) };
  bounded(commit); return commit;
}
function applyFields(before, delta) {
  if (!object(delta) || !object(delta.set) || !Array.isArray(delta.remove) ||
      delta.remove.some(key => typeof key !== "string" || !own(before, key) || own(delta.set, key)) ||
      new Set(delta.remove).size !== delta.remove.length) fail("DETAIL_V2_DELTA");
  const next = Object.assign(Object.create(null), before, delta.set);
  for (const key of delta.remove) delete next[key];
  return next;
}
export function applyDetailV2(before, commit, profile = {}) {
  const options = detailV2CatalogOptions(profile);
  validateDetailV2Envelope(commit, "Commit");
  validateDetailV2(before, options); bounded(commit);
  if (!isDetailPresentationProfile(options.catalog) && commit.instanceChanges.some(change => own(change, "collections"))) fail("DETAIL_V2_CATALOG");
  if (commit.protocolVersion !== 2 || commit.documentId !== before.documentId || commit.sessionId !== before.sessionId || commit.generation !== before.generation) fail("DETAIL_V2_BASE");
  if (commit.revision === before.revision && commit.resultStateHash === before.stateHash) return before;
  revision(commit.revision);
  if (commit.baseRevision !== before.revision || commit.baseStateHash !== before.stateHash || commit.revision <= before.revision) fail("DETAIL_V2_BASE");
  if (!object(commit.templates) || !Array.isArray(commit.instanceChanges) || !Array.isArray(commit.removeInstanceIds)) fail("DETAIL_V2_SHAPE");
  const next = copy(before), touched = new Set();
  next.instances = Object.assign(Object.create(null), next.instances);
  next.templates = Object.assign(Object.create(null), next.templates);
  Object.assign(next.templates, commit.templates);
  for (const cardId of commit.removeInstanceIds) {
    id(cardId); if (touched.has(cardId) || !own(next.instances, cardId)) fail("DETAIL_V2_DELTA");
    touched.add(cardId); delete next.instances[cardId];
  }
  for (const change of commit.instanceChanges) {
    id(change.cardId); if (touched.has(change.cardId)) fail("DETAIL_V2_DELTA"); touched.add(change.cardId);
    const old = next.instances[change.cardId];
    if (change.replacement) {
      if (old) fail("DETAIL_V2_DELTA"); next.instances[change.cardId] = change.replacement;
    } else {
      revision(change.revision);
      if (!old || old.revision !== change.baseRevision || old.hash !== change.baseHash || change.revision <= old.revision) fail("DETAIL_V2_BASE");
      const collections = change.collections ? applyFields(old.collections, change.collections) : old.collections;
      validateDetailV2CollectionTransition(old.collections, collections);
      next.instances[change.cardId] = { ...old, fields: applyFields(old.fields, change.fields), collections,
        actions: applyFields(old.actions, change.actions), revision: change.revision, hash: change.resultHash };
    }
  }
  if (commit.manifestChange !== null) {
    if (commit.manifestChange.revision <= before.manifest.revision) fail("DETAIL_V2_REVISION");
    next.manifest = commit.manifestChange;
  }
  // Drop no-longer-referenced definitions, bounding state size over migrations.
  const refs = new Set(Object.values(next.manifest.cards).map(card => card.templateHash));
  for (const hash of Object.keys(next.templates)) if (!refs.has(hash)) delete next.templates[hash];
  next.revision = commit.revision; next.stateHash = commit.resultStateHash;
  return validateDetailV2(next, options);
}

/** A per-document, bounded in-memory resume journal. It records immutable states
 * so reconnect can coalesce changes, not replay irrelevant intermediate UI. */
export class DetailV2Journal {
  constructor({ now = Date.now, limits = DETAIL_V2_LIMITS, catalog = "native-v2", clientCapabilities } = {}) {
    this.now = now; this.limits = limits; this.profile = Object.freeze(detailV2CatalogOptions({ catalog, clientCapabilities }));
    Object.freeze(this.profile.clientCapabilities); this.entries = []; this.bytes = 0;
  }
  publish(state) {
    validateDetailV2(state, this.profile);
    const latest = this.entries.at(-1)?.state;
    if (latest && latest.documentId === state.documentId && latest.generation === state.generation) {
      if (state.revision === latest.revision && state.stateHash === latest.stateHash) return;
      if (latest.sessionId !== state.sessionId || state.revision <= latest.revision) fail("DETAIL_V2_BASE");
    } else { this.entries = []; this.bytes = 0; }
    const bytes = bounded(state);
    this.entries.push({ state: copy(state), time: this.now(), bytes }); this.bytes += bytes; this.prune();
  }
  prune() {
    while (this.entries.length > 1 && (this.entries.length > this.limits.journalEntries ||
        this.bytes > this.limits.journalBytes || this.now() - this.entries[0].time > this.limits.journalMs)) {
      this.bytes -= this.entries.shift().bytes;
    }
  }
  resume(cursor = null) {
    this.prune(); const latest = this.entries.at(-1)?.state;
    if (!latest) fail("DETAIL_V2_EMPTY");
    const base = cursor && this.entries.find(({ state }) => state.documentId === cursor.documentId &&
      state.generation === cursor.generation && state.revision === cursor.revision && state.stateHash === cursor.stateHash)?.state;
    if (!base) return { kind: "snapshot", value: copy(latest) };
    if (base.revision === latest.revision) return { kind: "ready", revision: latest.revision, stateHash: latest.stateHash };
    try {
      const value = diffDetailV2(base, latest, this.profile);
      // A large structural replacement can cost more than a full snapshot.
      if (bounded(value) < bounded(latest)) return { kind: "commit", value };
    } catch (error) { if (error.code !== "DETAIL_V2_LIMIT") throw error; }
    return { kind: "snapshot", value: copy(latest) };
  }
}
