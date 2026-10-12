import { createHash } from "node:crypto";

export const DETAIL_RESOURCE_TYPES = Object.freeze(["session", "sessionMetadata", "task", "work", "artifact", "reference", "memory", "recall", "schedule", "provider", "agent", "turn", "worktree", "workspace", "repository"]);
const metadata = session => createHash("sha256").update(JSON.stringify(session ? {
  taskId: session.taskId, workId: session.workId, kind: session.sessionKind, archived: session.archived,
  agentId: session.agentId, cwd: session.cwd, provider: session.external?.provider,
  model: session.external?.currentModel, reasoning: session.external?.currentReasoningLevel,
  externalCwd: session.external?.cwd, connectionStatus: session.external?.connectionStatus,
  routingVersion: session.external?.routingVersion, workspaceId: session.external?.workspace?.workspaceId,
  capabilities: Object.fromEntries(Object.entries(session.capabilities ?? {}).filter(([, value]) => typeof value === "boolean"))
} : null)).digest("hex");

/** Durable log routes store changes; supplementary events route their own
 * dependencies. Never retain Session rows or scan event/token payloads. */
export class DetailBusinessInvalidation {
  constructor(store, invalidate) {
    this.store = store; this.invalidate = invalidate;
    this.revision = store.stateRevision?.() ?? null;
    this.sessions = new Map();
  }
  observe(session) {
    if (this.sessions.has(session.id)) return;
    this.sessions.delete(session.id); this.sessions.set(session.id, metadata(session));
    while (this.sessions.size > 64) this.sessions.delete(this.sessions.keys().next().value);
  }
  clear() { this.sessions.clear(); }
  publishStateChanges() {
    if (this.revision === null || !this.store.stateChangesAfter) { this.invalidate(); return; }
    const revision = this.store.stateRevision();
    if (revision === this.revision) return;
    if (revision < this.revision || this.store.oldestStateChangeRevision?.() > this.revision + 1) {
      this.revision = revision; this.sessions.clear(); this.invalidate(); return;
    }
    const changes = this.store.stateChangesAfter(this.revision);
    this.revision = revision;
    if (!changes.length) { this.sessions.clear(); this.invalidate(); return; }
    for (const change of new Map(changes.map(row => [`${row.entityType}:${row.entityId}`, row])).values()) {
      const resourceType = change.entityType;
      if (resourceType === "session") {
        this.invalidate({ resourceType, sessionId: change.entityId });
        const session = this.store.getSession(change.entityId), fingerprint = metadata(session);
        if (this.sessions.get(change.entityId) !== fingerprint) {
          this.invalidate({ resourceType: "sessionMetadata", sessionId: change.entityId });
          // A Work focus list belongs to a different Session. Its navigation
          // availability depends on the Task's associated Session binding.
          if (session?.taskId) this.invalidate({ resourceType: "task", ...(session.workId ? { workId: session.workId } : {}) });
          else if (!session) this.invalidate({ resourceType: "task" });
          this.sessions.delete(change.entityId); this.sessions.set(change.entityId, fingerprint);
          while (this.sessions.size > 64) this.sessions.delete(this.sessions.keys().next().value);
        }
      } else if (resourceType === "task") {
        const task = this.store.getTask?.(change.entityId);
        // Task deletion may no longer have a readable owner. In that case
        // invalidate Task-dependent ports, not unrelated heavy modules.
        this.invalidate({ resourceType, ...(task?.work_id ? { workId: task.work_id } : {}) });
      } else if (DETAIL_RESOURCE_TYPES.includes(resourceType)) {
        this.invalidate({ resourceType, ...(resourceType === "task" ? { taskId: change.entityId }
          : resourceType === "work" ? { workId: change.entityId } : {}) });
      } else if (resourceType === "integrationRun") this.invalidate({ resourceType: "worktree" });
    }
  }
  publishEvent(type, payload, sessionId) {
    const resourceType = /^(ScheduledSession|Automation)/.test(type) ? "schedule"
      : /^Worktree/.test(type) ? "worktree" : /^GitRepository/.test(type) ? "repository"
      : /^Workspace/.test(type) ? "workspace" : /^Provider(Capabilities|Settings|State|Registry)Changed$/.test(type) ? "provider"
      : /^MemoryRecall/.test(type) ? "recall" : /^Memory/.test(type) ? "memory"
      : /^(ContextReference|SessionContextReference)/.test(type) ? "reference"
      : /^Artifact/.test(type) ? "artifact" : /^(Turn|CodeTaskObservability)/.test(type) ? "turn" : null;
    if (resourceType) this.invalidate({ resourceType, ...(sessionId ? { sessionId } : {}) });
  }
}
