const DEFAULT_HISTORY_LIMIT = 256;

function stableSessionFields(previous, next) {
  const fields = [];
  if (previous.title !== next.title
    || previous.agent !== next.agent
    || previous.accent !== next.accent) fields.push("identity");
  if (previous.summary !== next.summary) fields.push("summary");
  if (previous.status !== next.status || previous.progress !== next.progress) fields.push("status");
  if (previous.activityStatus !== next.activityStatus || previous.updatedAt !== next.updatedAt) fields.push("activity");
  if (JSON.stringify(previous.external?.connectionStatus) !== JSON.stringify(next.external?.connectionStatus)
    || previous.external?.agentSessionId !== next.external?.agentSessionId) fields.push("connection");
  if (JSON.stringify(previous.capabilities) !== JSON.stringify(next.capabilities)
    || JSON.stringify(previous.actions) !== JSON.stringify(next.actions)) fields.push("capabilities");
  if (JSON.stringify(previous.external?.workspace) !== JSON.stringify(next.external?.workspace)
    || previous.external?.cwd !== next.external?.cwd
    || previous.external?.threadId !== next.external?.threadId
    || previous.external?.routingVersion !== next.external?.routingVersion) fields.push("workspace");
  if (JSON.stringify(previous.suggestedOptions) !== JSON.stringify(next.suggestedOptions)
    || previous.suggestedPrompt !== next.suggestedPrompt
    || JSON.stringify(previous.pendingCollaborationConfirmation) !== JSON.stringify(next.pendingCollaborationConfirmation)) {
    fields.push("suggestedOptions");
  }
  if (previous.pinned !== next.pinned
    || previous.sortOrder !== next.sortOrder
    || previous.archived !== next.archived
    || previous.lastMessageAt !== next.lastMessageAt) fields.push("ordering");
  if (JSON.stringify(previous.external) !== JSON.stringify(next.external)
    || previous.lastAgentMessageSequence !== next.lastAgentMessageSequence
    || previous.lastReadMessageSequence !== next.lastReadMessageSequence) fields.push("metadata");
  return fields;
}

export function createSessionCollectionPatch(previous, next, { baseRevision, revision }) {
  const previousById = new Map(previous.map((session, index) => [session.id, { session, index }]));
  const nextById = new Map(next.map((session, index) => [session.id, { session, index }]));
  const inserted = next.flatMap((session, index) => previousById.has(session.id)
    ? []
    : [{ index, session }]);
  const removedIds = previous.flatMap((session) => nextById.has(session.id) ? [] : [session.id]);
  const updated = next.flatMap((session) => {
    const prior = previousById.get(session.id)?.session;
    if (!prior || JSON.stringify(prior) === JSON.stringify(session)) return [];
    return [{ sessionId: session.id, changedFields: stableSessionFields(prior, session), session }];
  });
  const previousIds = previous.map((session) => session.id);
  const orderedIds = next.map((session) => session.id);
  const structureChanged = inserted.length > 0
    || removedIds.length > 0
    || previousIds.some((id, index) => orderedIds[index] !== id);

  return {
    baseRevision,
    revision,
    orderedIds: structureChanged ? orderedIds : null,
    inserted,
    removedIds,
    updated
  };
}

export function sessionCollectionPatchIsEmpty(patch) {
  return !patch.orderedIds
    && patch.inserted.length === 0
    && patch.removedIds.length === 0
    && patch.updated.length === 0;
}

export class SessionCollectionRevisionBuffer {
  #revision = 0;
  #sessions = [];
  #history = [];
  #historyLimit;

  constructor({ historyLimit = DEFAULT_HISTORY_LIMIT } = {}) {
    this.#historyLimit = Math.max(1, historyLimit);
  }

  get revision() { return this.#revision; }
  get sessions() { return this.#sessions; }

  snapshot() {
    return { revision: this.#revision, sessions: this.#sessions };
  }

  update(nextSessions) {
    // Provider runtimes are allowed to keep mutable session objects. Retain an
    // immutable transport snapshot so an in-place Provider mutation cannot
    // retroactively rewrite the previous revision and disappear from the diff.
    const canonicalSessions = structuredClone(nextSessions);
    const revision = this.#revision + 1;
    const patch = createSessionCollectionPatch(this.#sessions, canonicalSessions, {
      baseRevision: this.#revision,
      revision
    });
    if (sessionCollectionPatchIsEmpty(patch)) return null;
    this.#revision = revision;
    this.#sessions = canonicalSessions;
    this.#history.push(patch);
    if (this.#history.length > this.#historyLimit) {
      this.#history.splice(0, this.#history.length - this.#historyLimit);
    }
    return patch;
  }

  framesAfter(requestedRevision) {
    if (!Number.isSafeInteger(requestedRevision) || requestedRevision < 0) {
      return [{ name: "session-collection-snapshot", data: this.snapshot() }];
    }
    if (requestedRevision === this.#revision) return [];
    const first = this.#history.findIndex((patch) => patch.baseRevision === requestedRevision);
    if (first < 0) {
      return [{ name: "session-collection-snapshot", data: this.snapshot() }];
    }
    const patches = this.#history.slice(first);
    let expected = requestedRevision;
    for (const patch of patches) {
      if (patch.baseRevision !== expected) {
        return [{ name: "session-collection-snapshot", data: this.snapshot() }];
      }
      expected = patch.revision;
    }
    return patches.map((patch) => ({ name: "session-collection-patch", data: patch }));
  }
}
