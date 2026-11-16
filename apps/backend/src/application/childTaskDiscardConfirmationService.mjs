import { randomUUID } from "node:crypto";

const prefix = "child-discard:";
const fail = (code, message) => { throw Object.assign(new Error(message), { code, statusCode: 409 }); };
const metadata = item => JSON.parse(item?.rawMetadataJSON ?? "{}");

// Reuses durable host approval items. No Provider turn, new table, hash or
// approval token supplied by an Agent participates in the user's decision.
export class ChildTaskDiscardConfirmationService {
  constructor({ store, deletion, emitEvent = () => {} }) {
    Object.assign(this, { store, deletion, emitEvent });
    this.inFlight = new Map();
    deletion.requestUserConfirmation = (taskId, input, actor) => this.request(taskId, input, actor);
  }
  owns(id) { return typeof id === "string" && id.startsWith(prefix); }
  async request(taskId, input, actor) {
    const child = this.store.getTask(taskId);
    const parent = child?.parent_task_id && this.store.getTask(child.parent_task_id);
    if (!child || !parent) fail("TASK_PARENT_UNAVAILABLE", "无法定位父任务，未执行删除。");
    // Inspection checks the requesting Session's actual deletion scope; it
    // neither freezes scheduling nor stops executions or changes resources.
    const { plan, requiresConfirmation } = await this.deletion.inspectParentDiscard(taskId, input, actor);
    const requestKey = String(input.idempotencyKey ?? "").trim();
    if (!requestKey) fail("INVALID_INPUT", "直接删除请求需要稳定的请求标识。");
    const options = { mode: "force", deleteWorktree: input.deleteWorktree !== false,
      artifactDisposition: input.artifactDisposition ?? "retain", stopRunning: input.stopRunning === true,
      cancelStartup: input.cancelStartup === true, deleteAssociatedTasks: input.deleteAssociatedTasks === true,
      cancelIntegration: input.cancelIntegration === true };
    if (!["delete", "work", "retain"].includes(options.artifactDisposition)) fail("TASK_ARTIFACT_DISPOSITION_INVALID", "无效的成果处理方式。");
    const recipient = parent.current_session_id && this.store.getSession(parent.current_session_id);
    if (!recipient && requiresConfirmation) fail("TASK_PARENT_UNAVAILABLE", "无法定位用户可确认的父会话，未执行删除。");
    const old = recipient && this.store.selectOne(`SELECT id FROM session_items WHERE session_id=? AND type='choice' AND id GLOB 'child-discard:*'
      AND json_extract(raw_metadata_json,'$.childDiscard.requestingSessionId')=?
      AND json_extract(raw_metadata_json,'$.childDiscard.requestKey')=? LIMIT 1`, [recipient.id, actor.id, requestKey]);
    if (old) {
      const item = this.store.getSessionItem(recipient.id, old.id), saved = metadata(item).childDiscard;
      if (saved.taskId !== taskId || JSON.stringify(saved.options) !== JSON.stringify(options)) fail("TASK_DELETE_IDEMPOTENCY_CONFLICT", "同一请求的删除目标或选项不能改变。");
      if (item.status !== "pending" || requiresConfirmation) return this.receipt(item);
      const expired = { ...item, status: "expired" };
      this.store.upsertTimelineItemProjection(recipient.id, expired);
      this.emitEvent("ChildTaskDiscardConfirmationResolved", { item: expired }, { sessionId: recipient.id });
    }
    if (!requiresConfirmation) return this.deletion.requestDeliveredChild(taskId, { ...options, idempotencyKey: requestKey }, actor);
    const id = prefix + randomUUID(), createdAt = new Date().toISOString();
    const target = plan.worktree ? { worktreeId: plan.worktree.worktreeId, path: plan.worktree.path } : null;
    const body = `会话请求直接删除子任务「${child.title}」，不会先合入父工作区。未合入代码、聊天记录和子工作区可能被丢弃。\n`
      + (target?.path ? `工作区：${target.path}\n` : "")
      + `成果处理：${{ retain: "保留", work: "转移到 Work", delete: "删除" }[options.artifactDisposition]}。`
      + (options.deleteAssociatedTasks ? "将同时清理其后代及共用工作区的关联任务。" : "")
      + "\n未确认前不会停止任务或删除资源。";
    const item = { id, turnId: "", type: "choice", title: "直接删除子任务需要确认", text: body,
      options: [{ id: "reject", label: "保留子任务", role: "reject" }, { id: "approve", label: "确认丢弃并删除", role: "approve" }],
      status: "pending", createdAt, rawMetadataJSON: JSON.stringify({ childDiscard: {
        taskId, parentTaskId: parent.id, requestingSessionId: actor.id, requestKey, options, target
      } }) };
    this.store.upsertTimelineItemProjection(recipient.id, item);
    this.emitEvent("ChildTaskDiscardConfirmationRequested", { item, notice: this.notice(recipient.id, item) }, { sessionId: recipient.id });
    return this.receipt(item);
  }
  receipt(item) {
    const submission = metadata(item).approvalSubmission;
    const operation = submission?.operationId ? this.store.getTaskDeletionOperation(submission.operationId) : null;
    return { accepted: Boolean(operation), requiresUserConfirmation: item.status === "pending",
      confirmationId: item.id, status: item.status, operation,
      message: operation ? "用户已确认，删除以原作业状态为准。" : submission?.optionId === "reject" ? "用户已拒绝，未执行删除。"
        : "直接删除尚未执行；必须由用户点击确认，模型不得代为确认。" };
  }
  async respond(reference, input, source) {
    if (source?.type !== "desktop" && !(source?.type === "remote-client" && source.deviceId)) fail("TASK_DELETE_USER_CONFIRMATION_REQUIRED", "必须由已认证的用户界面确认，模型不能批准删除。");
    if (!["approve", "reject"].includes(input.optionId)) fail("INVALID_APPROVAL_OPTION", "请选择确认删除或保留子任务。");
    const key = `${reference.sessionId}:${input.itemId}`;
    const active = this.inFlight.get(key);
    if (active) {
      if (active.optionId !== input.optionId) fail("APPROVAL_IN_PROGRESS", "用户决定正在处理。");
      return active.promise;
    }
    const promise = this.resolve(reference, input, source).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, { optionId: input.optionId, promise });
    return promise;
  }
  async resolve(reference, input, source) {
    const item = this.store.getSessionItem(reference.sessionId, input.itemId), saved = metadata(item).childDiscard;
    if (!this.owns(item?.id) || !saved) fail("APPROVAL_NOT_PENDING", "删除确认不存在。");
    const previous = metadata(item).approvalSubmission;
    if (item.status === "submitted" && previous?.optionId === input.optionId) return this.store.getSession(reference.sessionId);
    if (!["pending", "dispatching", "unknown"].includes(item.status)) fail("APPROVAL_NOT_PENDING", "删除确认已处理。");
    const write = patch => this.store.upsertTimelineItemProjection(reference.sessionId, { ...item, ...patch });
    if (input.optionId === "reject") {
      write({ status: "submitted", rawMetadataJSON: JSON.stringify({ ...metadata(item), approvalSubmission: { optionId: "reject" } }) });
    } else {
      const child = this.store.getTask(saved.taskId), binding = this.store.getTaskDeliveryBinding(saved.taskId);
      if (!child || child.parent_task_id !== saved.parentTaskId || this.store.getTask(saved.parentTaskId)?.current_session_id !== reference.sessionId
        || saved.target && binding?.worktree_id !== saved.target.worktreeId) fail("APPROVAL_NOT_PENDING", "删除目标已变化，请重新查看当前删除请求。");
      const actor = { type: "user", id: source.type === "remote-client" ? `user:paired-device:${source.deviceId}` : "user:local-macos" };
      // Save the explicit click before asynchronous admission. Retrying that
      // click uses the same operation key and never broadens its target.
      write({ status: "dispatching", rawMetadataJSON: JSON.stringify({ ...metadata(item), approvalSubmission: { optionId: "approve" } }) });
      const result = await this.deletion.request(saved.taskId, { ...saved.options, idempotencyKey: item.id }, actor);
      write({ status: "submitted", rawMetadataJSON: JSON.stringify({ ...metadata(item), approvalSubmission: { optionId: "approve", operationId: result.operation?.operationId } }) });
    }
    this.emitEvent("ChildTaskDiscardConfirmationResolved", { item: this.store.getSessionItem(reference.sessionId, item.id) }, { sessionId: reference.sessionId });
    return this.store.getSession(reference.sessionId);
  }
  notice(sessionId, item) { return { id: item.id, sessionId, title: item.title, body: item.text, occurredAt: item.createdAt }; }
  pendingNotices() {
    if (!this.store.db) return [];
    return this.store.selectAll("SELECT session_id,id FROM session_items WHERE type='choice' AND status='pending' AND id GLOB 'child-discard:*' ORDER BY created_at DESC LIMIT 50")
      .map(row => this.notice(row.session_id, this.store.getSessionItem(row.session_id, row.id)));
  }
}
