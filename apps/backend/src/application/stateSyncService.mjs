const ENTITY_COLLECTION = Object.freeze({
  session: "sessions",
  task: "tasks",
  objective: "objectives",
  agent: "agents",
  skill: "skills",
  repository: "repositories",
  integrationRun: "integrationRuns"
});

const ENTITY_ID = Object.freeze({
  sessions: (entity) => entity.id,
  tasks: (entity) => entity.id,
  objectives: (entity) => entity.id,
  agents: (entity) => entity.agentId,
  skills: (entity) => entity.skillId,
  repositories: (entity) => entity.id,
  integrationRuns: (entity) => entity.id
});

export const STATE_COLLECTIONS = Object.freeze(Object.values(ENTITY_COLLECTION));

export class StateSyncService {
  constructor({ store, snapshot, readEntity = null }) {
    if (!store || typeof snapshot !== "function") {
      throw new Error("StateSyncService requires store and snapshot.");
    }
    this.store = store;
    this.snapshotProvider = snapshot;
    this.entityReader = typeof readEntity === "function" ? readEntity : null;
    this.cachedSnapshot = null;
    this.snapshotBuilds = 0;
  }

  snapshot() {
    const requestedRevision = this.store.stateRevision();
    if (this.cachedSnapshot?.revision === requestedRevision) {
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
    // Existing clients normally need only the entities named by the durable
    // change log. Hydrate those rows directly instead of rebuilding every
    // control-plane collection for one Session progress update.
    const state = this.entityReader ? null : this.snapshot().state;
    const latestByEntity = new Map();
    for (const row of rows) {
      latestByEntity.set(`${row.entityType}\0${row.entityId}`, row);
    }
    const upserts = emptyCollections();
    const deletes = emptyCollections();
    const artifactInvalidations = new Set();
    for (const row of latestByEntity.values()) {
      if (row.entityType === "artifact") {
        artifactInvalidations.add(row.entityId);
        continue;
      }
      const collection = ENTITY_COLLECTION[row.entityType];
      if (!collection) continue;
      const entity = this.entityReader
        ? this.entityReader(row.entityType, row.entityId)
        : state[collection].find((candidate) => ENTITY_ID[collection](candidate) === row.entityId);
      if (row.operation === "delete") {
        deletes[collection].push(row.entityId);
        if (process.env.CORPTIE_DEBUG_STATE_SYNC) {
          console.log(`[state-sync] DELETE ${collection} ${row.entityId} (op=delete) rev=${currentRevision} after=${after}`);
        }
      } else if (entity) {
        upserts[collection].push(entity);
      } else {
        // Changes describe the product collection, not physical storage rows.
        // If the durable projection no longer exposes an entity, remove any
        // stale client copy. Silently skipping here prevents convergence.
        deletes[collection].push(row.entityId);
        if (process.env.CORPTIE_DEBUG_STATE_SYNC) {
          console.log(`[state-sync] DELETE ${collection} ${row.entityId} (absent from projection) rev=${currentRevision}`);
        }
      }
    }
    const deliveredRevision = this.store.stateRevision();
    if (deliveredRevision !== currentRevision) {
      return { snapshotRequired: true, currentRevision: deliveredRevision };
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
      deletes,
      artifactInvalidations: [...artifactInvalidations].sort()
    };
  }

  diagnostics() {
    return {
      cachedRevision: this.cachedSnapshot?.revision ?? null,
      snapshotBuilds: this.snapshotBuilds
    };
  }

  cacheSnapshot(snapshot) {
    this.snapshotBuilds += 1;
    this.cachedSnapshot = snapshot;
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
    deletes: emptyCollections(),
    artifactInvalidations: []
  };
}
