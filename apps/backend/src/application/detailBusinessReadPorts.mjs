import { presentMemory } from "./memoryOperationService.mjs";
import { presentMemoryRecallAudit } from "./memoryRecallService.mjs";
import { presentTaskSummary } from "./taskSummaryContract.mjs";
import { pairedDeviceActor } from "./clientDeviceAuthority.mjs";
import { AGENT_PROVIDER_CAPABILITIES } from "../agent-provider/contracts.mjs";
import { detailBusinessDate as date } from "./detailBusinessDate.mjs";

const string = (value, limit = 2000) => typeof value === "string" ? value.slice(0, limit) : "";
const id = value => string(value, 512);
const integer = value => Number.isSafeInteger(value) ? value : null;
const ref = (resourceType, value) => ({ resourceType, id: id(value) });
const page = (items, hasMore = false) => ({ items, hasMore });
function summary(task) {
  const value = presentTaskSummary(task), content = value?.content;
  return { state: string(value?.state, 64), focus: string(content?.focus), progress: string(content?.progress),
    messageSummary: string(content?.messageSummary), intervention: value?.state === "ready" ? string(content?.intervention, 64) : "unknown",
    reason: string(content?.reason), nextAction: value?.state === "ready" ? string(content?.nextAction) : "",
    generatedAt: date(content?.generatedAt) };
}
function safeReference(row) {
  const displayName = row.displayName === row.locator ? "" : string(row.displayName, 512);
  return { resource: ref("contextReference", row.referenceId), displayName,
    targetType: string(row.targetType, 64), status: string(row.status, 64), enabled: row.enabled === true,
    snapshotAt: date(row.snapshotAt), contentHash: string(row.contentHash, 64) };
}
function artifact(row, scope) {
  const references = (row.references ?? []).filter(value => !value.revokedAt && (!scope.task || value.taskId === scope.task.id));
  const pinned = references.find(value => value.versionPolicy === "fixed" && value.pinnedVersion);
  const version = integer(pinned?.pinnedVersion ?? row.approvedVersion ?? row.currentVersion);
  const hash = string(pinned?.pinnedHash ?? row.versions?.find(value => value.version === version)?.contentHash, 64);
  return { resource: ref("artifact", row.artifactId), title: string(row.title, 512), summary: string(row.summary),
    status: string(row.status, 64), visibility: string(row.visibility, 64), version, contentHash: hash,
    readAvailable: version !== null && /^[a-f0-9]{64}$/.test(hash),
    references: references.slice(0, 20).map(value => ({ resource: ref("artifactReference", value.referenceId),
      required: value.required === true, versionPolicy: string(value.versionPolicy, 64),
      pinnedVersion: integer(value.pinnedVersion), pinnedHash: string(value.pinnedHash, 64),
      pendingVersion: integer(value.pendingVersion), pendingHash: string(value.pendingHash, 64),
      resourceVersion: integer(value.resourceVersion) })),
    audit: (row.audit ?? []).slice(0, 20).map(value => ({ id: id(value.auditId), action: string(value.action, 128), createdAt: date(value.createdAt) })) };
}
function memory(row) {
  const value = presentMemory(row);
  return { resource: ref("memory", value.id), kind: string(value.kind, 64), content: string(value.content),
    sourceType: string(value.sourceType, 64), trustLevel: string(value.trustLevel, 64),
    promotionStatus: string(value.promotionStatus, 64), version: integer(value.version),
    revokedAt: date(value.revokedAt), updatedAt: date(value.updatedAt), tags: value.tags.slice(0, 16).map(value => string(value, 128)) };
}
const durations = value => Object.fromEntries(Object.entries(value ?? {}).filter(([key, duration]) =>
  /^[A-Za-z0-9_.]{1,64}$/.test(key) && typeof duration === "number" && Number.isFinite(duration) && duration >= 0)
  .slice(0, 20).map(([key, duration]) => [key, String(duration)]));

/** Internal read ports, not a new wire schema or a second renderer. No loaders,
 * remote URLs, Artifact bodies, Provider events or arbitrary metadata escape. */
export function createDetailBusinessReadPorts({ store, references, artifacts, schedules, observability,
  providerRegistry, readWorktree, localScheduleActor = { type: "user", id: "user:local-macos" } }) {
  const context = (scope, identity) => ({ kind: "local_user", actorId: identity.principalId
    ?? (identity.deviceId ? `client-device:${identity.deviceId}` : "local-user"), workId: scope.work?.id });
  const ports = {
    focusTasks: { dependencies: ["task", "work", "sessionMetadata"], read: scope => {
      if (scope.session.sessionKind !== "workChat" || !scope.work) return page([]);
      const rows = store.listTasksByWork(scope.work.id).filter(row => !row.archived && !row.deletion_status && row.lifecycle_state !== "done")
        .map(row => ({ row, summary: summary(row) })).sort((a, b) =>
          Number(b.summary.intervention === "required") - Number(a.summary.intervention === "required")
          || String(b.row.updated_at).localeCompare(String(a.row.updated_at)) || a.row.id.localeCompare(b.row.id));
      return page(rows.slice(0, 3).map(({ row, summary }) => {
        const logical = row.current_session_id ? (store.getLogicalSession?.(row.current_session_id)
          ?? store.getLogicalSessionByLegacySessionId?.(row.current_session_id)) : null;
        const session = row.current_session_id ? store.getSession(logical?.legacySessionId ?? row.current_session_id) : null;
        const target = session && !session.archived && !logical?.archived && session.taskId === row.id
          ? ref("session", logical?.logicalSessionId ?? session.id) : null;
        return { resource: ref("task", row.id), title: string(row.title, 512), sessionTarget: target, summary };
      }));
    } },
    references: { dependencies: ["reference"], read: scope => {
      const rows = references.list(scope.session.id);
      return page(rows.slice(0, 20).map(safeReference), rows.length > 20);
    } },
    artifacts: { dependencies: ["artifact", "task", "work"], read: (scope, identity) => {
      if (!scope.work) return page([]);
      const options = { limit: 21, offset: 0, currentWorkOnly: true };
      const rows = scope.task ? artifacts.listForTask(context(scope, identity), scope.task.id, options) : artifacts.list(context(scope, identity), options);
      return page(rows.slice(0, 20).map(row => artifact(row, scope)), rows.length > 20);
    } },
    // These authorities have mutation paths outside the state log. Until all
    // notifications are connected, explicit reads must not reuse cached facts.
    memories: { cacheable: false, dependencies: ["memory"], read: scope => {
      const ownerType = scope.task ? "task" : "work", ownerId = scope.task?.id ?? scope.work?.id;
      if (!ownerId) return page([]);
      const result = store.listMemoryPage({ ownerType, ownerId, includeRevoked: true, limit: 20 });
      return page(result.items.map(memory), result.hasMore);
    } },
    recalls: { cacheable: false, dependencies: ["memory", "recall"], read: scope => page(store.listMemoryRecallAudit({ sessionId: scope.session.id, limit: 8 })
      .map(row => presentMemoryRecallAudit(store, row)).map(value => ({ resource: ref("memoryRecall", value.id),
        phase: string(value.phase, 64), mode: string(value.mode, 64), reason: string(value.reason, 128),
        injectionStatus: string(value.injectionStatus, 64), createdAt: date(value.createdAt),
        selectedEntries: value.selectedEntries.slice(0, 20).map(entry => ({ resource: ref("memory", entry.id),
          kind: string(entry.kind, 64), content: entry.content == null ? null : string(entry.content), snapshotAtRecall: entry.snapshotAtRecall === true })) }))) },
    schedules: { dependencies: ["schedule"], read: (scope, identity) => {
      const rows = schedules.list({ logicalSessionId: scope.logicalSessionId, status: "active" }, identity.deviceId ? pairedDeviceActor(identity) : localScheduleActor);
      return page(rows.slice(0, 20).map(row => ({ resource: ref("automation", row.taskId), name: string(row.name, 512),
        scheduleType: string(row.scheduleType, 64), status: string(row.status, 64), runAt: date(row.runAt), nextRunAt: date(row.nextRunAt),
        scheduleTimezone: string(row.timezone, 128), resourceVersion: integer(row.resourceVersion) })), rows.length > 20);
    } },
    provider: { cacheable: false, dependencies: ["provider", "sessionMetadata", "agent"], read: scope => {
      const descriptors = providerRegistry.descriptors();
      return {
      currentProviderId: id(scope.session.external?.provider), agentId: id(scope.session.agentId),
      model: string(scope.session.external?.currentModel, 512), reasoning: string(scope.session.external?.currentReasoningLevel, 128),
      hasMore: descriptors.length > 20,
      providers: descriptors.slice(0, 20).map(descriptor => ({ resource: ref("provider", descriptor.id),
        name: string(descriptor.displayName, 512), capabilities: Object.values(AGENT_PROVIDER_CAPABILITIES)
          .filter(capability => providerRegistry.supports(descriptor.id, capability)),
        available: [AGENT_PROVIDER_CAPABILITIES.SESSION_CREATE, AGENT_PROVIDER_CAPABILITIES.SESSION_RESUME,
          AGENT_PROVIDER_CAPABILITIES.CONVERSATION_SEND].every(capability => providerRegistry.supports(descriptor.id, capability)) })) };
    } },
    turn: { cacheable: false, dependencies: ["turn"], read: scope => {
      const value = observability.latestSummary(scope.logicalSessionId, { kind: "local_user" });
      if (!value) return null;
      if (value.identity?.logicalSessionId !== scope.logicalSessionId) throw Object.assign(new Error("Turn scope mismatch"), { status: 403 });
      return { resource: ref("turn", value.identity.turnExecutionId), wall: durations(value.wall),
        wallPartition: durations(value.wallPartition), inclusive: durations(value.inclusive), completeness: string(value.completeness?.state, 64) };
    } },
    worktree: { cacheable: false, dependencies: ["worktree", "workspace", "repository", "sessionMetadata"], read: async scope => {
      const value = await readWorktree(scope.logicalSessionId), tree = value.worktree;
      return { attached: value.attached === true, repository: ref("repository", value.repositoryId),
        blockedReason: string(value.blockedReason, 128), mainBranch: string(value.mainBranch, 512),
        workspace: tree ? ref("worktree", tree.worktreeId) : null,
        tree: tree ? { branchName: string(tree.branchName, 512), isMain: tree.isMain === true, dirty: typeof tree.dirty === "boolean" ? tree.dirty : null,
          availability: string(tree.availability, 64), aheadOfMain: integer(tree.aheadOfMain), behindMain: integer(tree.behindMain),
          changedFileCount: integer(tree.changedFileCount), operationState: string(tree.operationState, 64) } : null,
        autoFollow: { enabled: value.autoFollow?.enabled === true, status: string(value.autoFollow?.status, 64), reason: string(value.autoFollow?.reason, 128) },
        job: value.job ? { resource: ref("worktreeJob", value.job.id), status: string(value.job.status, 64), phase: string(value.job.phase, 64) } : null };
    } }
  };
  const bounds = (cursor, limit) => {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20
      || cursor != null && (typeof cursor !== "string" || !cursor.length || cursor.length > 512)) {
      throw Object.assign(new Error("Invalid page query"), { code: "DETAIL_CURSOR_INVALID", status: 409 });
    }
  };
  const offset = cursor => {
    if (cursor == null) return 0;
    if (!/^(0|[1-9][0-9]{0,8})$/.test(cursor)) throw Object.assign(new Error("Invalid page query"), { code: "DETAIL_CURSOR_INVALID", status: 409 });
    return Number(cursor);
  };
  ports.references.readPage = (scope, _identity, cursor = null, limit = 20) => {
    bounds(cursor, limit); const start = offset(cursor), rows = references.list(scope.session.id);
    const hasMore = start + limit < rows.length;
    return { items: rows.slice(start, start + limit).map(safeReference), hasMore, sourceCursor: hasMore ? String(start + limit) : null };
  };
  ports.artifacts.readPage = (scope, identity, cursor = null, limit = 20) => {
    bounds(cursor, limit); const start = offset(cursor);
    if (!scope.work) return { items: [], hasMore: false, sourceCursor: null };
    const options = { limit: limit + 1, offset: start, currentWorkOnly: true };
    const rows = scope.task ? artifacts.listForTask(context(scope, identity), scope.task.id, options) : artifacts.list(context(scope, identity), options);
    return { items: rows.slice(0, limit).map(row => artifact(row, scope)), hasMore: rows.length > limit,
      sourceCursor: rows.length > limit ? String(start + limit) : null };
  };
  ports.memories.readPage = (scope, _identity, cursor = undefined, limit = 20) => {
    bounds(cursor, limit); const ownerType = scope.task ? "task" : "work", ownerId = scope.task?.id ?? scope.work?.id;
    if (!ownerId) return { items: [], hasMore: false, sourceCursor: null };
    const result = store.listMemoryPage({ ownerType, ownerId, includeRevoked: true, limit, ...(cursor != null ? { cursor } : {}) });
    return { items: result.items.map(memory), hasMore: result.hasMore, sourceCursor: result.hasMore ? result.nextCursor : null };
  };
  ports.schedules.readPage = (scope, identity, cursor = null, limit = 20) => {
    bounds(cursor, limit); const start = offset(cursor);
    const rows = schedules.list({ logicalSessionId: scope.logicalSessionId, status: "active" }, identity.deviceId ? pairedDeviceActor(identity) : localScheduleActor);
    const hasMore = start + limit < rows.length;
    return { items: rows.slice(start, start + limit).map(row => ({ resource: ref("automation", row.taskId), name: string(row.name, 512),
      scheduleType: string(row.scheduleType, 64), status: string(row.status, 64), runAt: date(row.runAt), nextRunAt: date(row.nextRunAt),
      scheduleTimezone: string(row.timezone, 128), resourceVersion: integer(row.resourceVersion) })),
      hasMore, sourceCursor: hasMore ? String(start + limit) : null };
  };
  return ports;
}
