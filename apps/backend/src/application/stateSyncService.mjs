const ENTITY_COLLECTION = Object.freeze({
  session: "sessions",
  workItem: "workItems",
  objective: "objectives",
  agent: "agents",
  skill: "skills",
  repository: "repositories",
  integrationRun: "integrationRuns"
});

const ENTITY_ID = Object.freeze({
  sessions: (entity) => entity.id,
  workItems: (entity) => entity.id,
  objectives: (entity) => entity.id,
  agents: (entity) => entity.agentId,
  skills: (entity) => entity.skillId,
  repositories: (entity) => entity.id,
  integrationRuns: (entity) => entity.id
});

export const STATE_COLLECTIONS = Object.freeze(Object.values(ENTITY_COLLECTION));

export class StateSyncService {
  constructor({ store, snapshot, optimized = process.env.CORPTIE_OPTIMIZED_STATE_SYNC !== "0" }) {
    if (!store || typeof snapshot !== "function") {
      throw new Error("StateSyncService requires store and snapshot.");
    }
    this.store = store;
    this.snapshotProvider = snapshot;
    this.optimized = optimized;
    this.cachedSnapshot = null;
    this.snapshotBuilds = 0;
  }

  snapshot() {
    const requestedRevision = this.store.stateRevision();
    if (this.optimized && this.cachedSnapshot?.revision === requestedRevision) {
      return this.cachedSnapshot;
    }
    // A revision names one immutable wire payload. Never stamp a projection
    // built across revisions with the newer revision: clients correctly reject
    // a later equal-revision payload, so that mismatch can strand a Session in
    // `running` after its terminal row was already committed. Projection is
    // strictly read-only; retry the read on the rare crossed-revision boundary.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const revision = this.store.stateRevision();
      const state = normalizeSnapshot(this.snapshotProvider());
      if (this.store.stateRevision() === revision) {
        return this.cacheSnapshot({ revision, state });
      }
    }
    const error = new Error("State snapshot could not obtain a stable revision.");
    error.code = "STATE_SNAPSHOT_UNSTABLE";
    throw error;
  }

  changesAfter(requestedRevision) {
    const after = Number(requestedRevision);
    const currentRevision = this.store.stateRevision();
    if (!Number.isSafeInteger(after) || after < 0 || after > currentRevision) {
      return { snapshotRequired: true, currentRevision };
    }
    if (after === currentRevision) {
      return emptyChangeSet(after);
    }
    const oldest = this.store.oldestStateChangeRevision();
    if (after < oldest - 1) {
      return { snapshotRequired: true, currentRevision };
    }

    const rows = this.store.stateChangesAfter(after);
    if (rows.length === 0 || rows.at(-1).revision !== currentRevision) {
      return { snapshotRequired: true, currentRevision };
    }
    const projected = this.optimized ? this.snapshot() : null;
    if (projected && projected.revision !== currentRevision) {
      return { snapshotRequired: true, currentRevision: projected.revision };
    }
    const state = projected?.state ?? normalizeSnapshot(this.snapshotProvider());
    const latestByEntity = new Map();
    for (const row of rows) {
      latestByEntity.set(`${row.entityType}\0${row.entityId}`, row);
    }
    const upserts = emptyCollections();
    const deletes = emptyCollections();
    for (const row of latestByEntity.values()) {
      const collection = ENTITY_COLLECTION[row.entityType];
      if (!collection) continue;
      const entity = state[collection].find((candidate) => ENTITY_ID[collection](candidate) === row.entityId);
      if (row.operation === "delete") {
        deletes[collection].push(row.entityId);
        if (process.env.CORPTIE_DEBUG_STATE_SYNC) {
          console.log(`[state-sync] DELETE ${collection} ${row.entityId} (op=delete) rev=${currentRevision} after=${after}`);
        }
      } else if (entity) {
        upserts[collection].push(entity);
      } else {
        // The entity was upserted in the database but is absent from the
        // provider-memory projection (e.g. an OpenClacky session whose in-memory
        // cache briefly dropped it). This is not a deletion; skip it so the
        // client keeps its last known state until the next full snapshot.
        if (process.env.CORPTIE_DEBUG_STATE_SYNC) {
          console.log(`[state-sync] SKIP ${collection} ${row.entityId} (upsert missing from snapshot) rev=${currentRevision}`);
        }
      }
    }
    if (process.env.CORPTIE_DEBUG_STATE_SYNC) {
      const summary = Object.fromEntries(
        STATE_COLLECTIONS.map((c) => [`${c}:u${upserts[c].length}/d${deletes[c].length}`])
      );
      console.log(`[state-sync] changeSet rev=${currentRevision} after=${after} ${JSON.stringify(summary)}`);
    }
    return {
      snapshotRequired: false,
      baseRevision: after,
      revision: currentRevision,
      upserts,
      deletes
    };
  }

  diagnostics() {
    return {
      optimized: this.optimized,
      cachedRevision: this.cachedSnapshot?.revision ?? null,
      snapshotBuilds: this.snapshotBuilds
    };
  }

  cacheSnapshot(snapshot) {
    this.snapshotBuilds += 1;
    if (this.optimized) this.cachedSnapshot = snapshot;
    return snapshot;
  }
}

/// An SSE cursor acknowledges exactly the frame written to the socket. Reading
/// the live Store revision again after serialization can skip a change that
/// committed between the write and cursor registration.
export function deliveredStateRevision(changes, snapshot = null) {
  const revision = changes?.snapshotRequired ? snapshot?.revision : changes?.revision;
  if (!Number.isSafeInteger(Number(revision)) || Number(revision) < 0) {
    const error = new Error("State delivery has no valid revision.");
    error.code = "STATE_DELIVERY_REVISION_INVALID";
    throw error;
  }
  return Number(revision);
}

function normalizeSnapshot(input = {}) {
  return Object.fromEntries(STATE_COLLECTIONS.map((key) => [
    key,
    Array.isArray(input[key]) ? structuredClone(input[key]) : []
  ]));
}

function emptyCollections() {
  return Object.fromEntries(STATE_COLLECTIONS.map((key) => [key, []]));
}

function emptyChangeSet(revision) {
  return {
    snapshotRequired: false,
    baseRevision: revision,
    revision,
    upserts: emptyCollections(),
    deletes: emptyCollections()
  };
}
