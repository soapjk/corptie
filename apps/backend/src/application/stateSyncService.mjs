const ENTITY_COLLECTION = Object.freeze({
  session: "sessions",
  workItem: "workItems",
  objective: "objectives",
  agent: "agents",
  repository: "repositories",
  integrationRun: "integrationRuns"
});

const ENTITY_ID = Object.freeze({
  sessions: (entity) => entity.id,
  workItems: (entity) => entity.id,
  objectives: (entity) => entity.id,
  agents: (entity) => entity.agentId,
  repositories: (entity) => entity.id,
  integrationRuns: (entity) => entity.id
});

export const STATE_COLLECTIONS = Object.freeze(Object.values(ENTITY_COLLECTION));

export class StateSyncService {
  constructor({ store, snapshot }) {
    if (!store || typeof snapshot !== "function") {
      throw new Error("StateSyncService requires store and snapshot.");
    }
    this.store = store;
    this.snapshotProvider = snapshot;
  }

  snapshot() {
    const revision = this.store.stateRevision();
    const state = normalizeSnapshot(this.snapshotProvider());
    return { revision, state };
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
    const state = normalizeSnapshot(this.snapshotProvider());
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
      if (row.operation === "delete" || !entity) deletes[collection].push(row.entityId);
      else upserts[collection].push(entity);
    }
    return {
      snapshotRequired: false,
      baseRevision: after,
      revision: currentRevision,
      upserts,
      deletes
    };
  }
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
