import { nativeBusinessHash, validateNativeBusinessDocument, DETAIL_NATIVE_BUSINESS_PROFILE } from "./detailNativeBusinessContract.mjs";
import { presentTaskSummary } from "./taskSummaryContract.mjs";
export const NATIVE_BUSINESS_MODULES = Object.freeze(["focusTasks", "references", "artifacts", "memories", "memoryHits", "schedules", "provider", "turn", "worktree"]);
export const nativeModuleKind = Object.freeze({ focusTasks: "focusTasks", references: "contextReferences", artifacts: "artifacts", memories: "memoryResources", memoryHits: "memoryHits", schedules: "schedules", provider: "provider", turn: "turnMetrics", worktree: "worktree" });
const card = (id, kind, data, actions = [], loadState = "ready", nextCursor = null) => ({ id, kind, version: 1, revision: nativeBusinessHash({ data, actions, loadState }), loadState, data, actions, nextCursor });
const nav = (operation, resourceType, id, title, extra = {}) => ({ id: `nav-${nativeBusinessHash({ operation, resourceType, id }).slice(0, 24)}`, kind: "navigation", operation, label: { fallback: title }, available: true, target: { resourceType, id }, ...extra });
const summary = task => {
  const value = presentTaskSummary(task), content = value?.content;
  return { state: value?.state ?? "pending", focus: content?.focus ?? "", progress: content?.progress ?? "", intervention: content?.intervention ?? "unknown", reason: content?.reason ?? "", nextAction: content?.nextAction ?? "", current: value?.state === "ready" && content?.basis?.taskRevision === task.revision };
};

export function nativeBusinessModuleCard(name, result, { editors = false, page = null, operations = [] } = {}) {
  const source = result?.data, actions = [...operations]; let data;
  switch (name) {
  case "artifacts":
    data = { items: (source?.items ?? []).map(row => ({ artifactId: row.resource.id, title: row.title, summary: row.summary, version: row.version, contentHash: row.contentHash, readAvailable: row.readAvailable })), hasMore: source?.hasMore === true };
    actions.push(...data.items.filter(row => row.readAvailable).map(row => ({ id: `content-${nativeBusinessHash(row.artifactId).slice(0, 24)}`, kind: "read", operation: "artifact.content", label: { fallback: "打开 Artifact" }, available: true,
      target: { resourceType: "artifact", id: row.artifactId }, expectedResourceRevision: `${row.version}:${row.contentHash}` }))); break;
  case "focusTasks":
    data = { items: (source?.items ?? []).map(row => ({ taskId: row.resource.id, title: row.title, sessionId: row.sessionTarget?.resourceType === "session" ? row.sessionTarget.id : null, summary: row.summary })), hasMore: source?.hasMore === true };
    actions.push(...data.items.filter(row => row.sessionId).map(row => nav("resource.open", "session", row.sessionId, "打开会话"))); break;
  case "references":
    data = { items: (source?.items ?? []).map(row => ({ referenceId: row.resource.id, title: row.displayName || "引用", targetType: row.targetType, status: row.status, enabled: row.enabled })), hasMore: source?.hasMore === true };
    actions.push(...data.items.filter(row => row.enabled && row.status === "available" && row.targetType === "webURL").map(row => nav("resource.open", "reference", row.referenceId, "打开引用"))); break;
  case "memories": case "memoryHits":
    data = { items: (source?.items ?? []).map(row => ({ memoryId: row.resource.id, kind: row.kind, content: row.content, unavailable: row.unavailable === true || Boolean(row.revokedAt), snapshotAtRecall: row.snapshotAtRecall === true, updatedAt: row.lastHitAt ?? row.updatedAt ?? null, resourceVersion: row.version ?? null })), hasMore: source?.hasMore === true }; break;
  case "schedules":
    data = { items: (source?.items ?? []).map(row => ({ scheduleId: row.resource.id, name: row.name, scheduleType: row.scheduleType, status: row.status, runAt: row.runAt, nextRunAt: row.nextRunAt, timezone: row.scheduleTimezone, resourceRevision: String(row.resourceVersion) })), hasMore: source?.hasMore === true };
    actions.push(...data.items.map(row => nav("resource.open", "schedule", row.scheduleId, "打开计划"))); break;
  case "provider":
    data = { providerId: source?.currentProviderId ?? "", name: source?.currentProviderName ?? "", model: source?.model ?? "", reasoning: source?.reasoning ?? "", switching: source?.switching === true, providers: (source?.providers ?? []).map(row => ({ providerId: row.resource.id, name: row.name, available: row.available })) };
    if (editors && data.providerId) actions.push(nav("editor.open", "provider", data.providerId, "管理 Provider")); break;
  case "worktree":
    data = { attached: source?.attached === true, worktreeId: source?.workspace?.id ?? null, mainBranch: source?.mainBranch ?? "", blockedReason: source?.blockedReason ?? "", tree: source?.tree ?? null, autoFollow: source?.autoFollow ?? { enabled: false, status: "", reason: "" }, job: source?.job ? { jobId: source.job.resource.id, status: source.job.status, phase: source.job.phase } : null };
    if (editors && data.worktreeId) actions.push(nav("editor.open", "worktree", data.worktreeId, "管理 Worktree")); break;
  case "turn":
    data = { turnId: source?.resource.id ?? null, completeness: source?.completeness ?? "", wall: source?.wall ?? {}, wallPartition: source?.wallPartition ?? {}, inclusive: source?.inclusive ?? {} }; break;
  default: throw new Error("DETAIL_BUSINESS_KIND_INVALID");
  }
  if (page) actions.push({ id: "page", kind: "read", operation: "detail.collection.page", label: { fallback: "加载更多" }, available: page.nextCursor !== null, target: { resourceType: "session", id: page.sessionId } });
  return card(`business-${name}`, nativeModuleKind[name], data, actions, result?.state === "error" ? "error" : result?.state === "empty" ? "empty" : "ready", page?.nextCursor ?? null);
}

/** Business data only. No nodes, templates, layout options or renderer hints. */
export function projectNativeBusinessDocument(scope, results, generation, { editors = false, pages = {}, operations = {} } = {}) {
  const cards = [card("session-info", "sessionInfo", { sessionId: scope.logicalSessionId, workName: scope.work?.name ?? "" })];
  if (scope.session.sessionKind === "assistantChat" && scope.session.summary?.trim()) cards.push(card("session-summary", "chatSummary", { text: scope.session.summary }));
  if (scope.session.sessionKind === "workChat" && scope.work) cards.push(card("work-overview", "workOverview", { workId: scope.work.id, name: scope.work.name ?? "", description: scope.work.description ?? "" }));
  if (scope.session.sessionKind === "worker" && scope.task) {
    const task = scope.task, data = { taskId: task.id, title: task.title ?? "", status: task.lifecycle_state ?? "", description: task.description ?? "", acceptanceCriteria: task.acceptance_criteria ?? "", verificationCriteria: task.verification_criteria ?? "", resourceRevision: String(task.revision), summary: summary(task) };
    cards.push(card("task-information", "taskInfo", data, editors ? [nav("editor.open", "task", task.id, "编辑 Task", { expectedResourceRevision: data.resourceRevision })] : []));
  }
  for (const name of NATIVE_BUSINESS_MODULES) cards.push(nativeBusinessModuleCard(name, results[name], { editors, page: pages[name], operations: operations[name] ?? [] }));
  return nativeBusinessEnvelope(scope.logicalSessionId, generation, cards);
}
export function nativeBusinessEnvelope(sessionId, generation, cards) {
  return validateNativeBusinessDocument({ protocolVersion: 1, catalog: DETAIL_NATIVE_BUSINESS_PROFILE, documentId: `detail:${sessionId}`, sessionId, generation, revision: nativeBusinessHash(cards), cards, order: cards.map(card => card.id) });
}
