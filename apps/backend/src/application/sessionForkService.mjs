import { createHash, randomUUID } from "node:crypto";
import { AGENT_PROVIDER_CAPABILITIES } from "../agent-provider/contracts.mjs";
import { validateEntityName } from "../domain/workTaskValidation.mjs";

const terminal = new Set(["completed", "complete", "interrupted", "cancelled", "canceled", "failed"]);
const priorities = new Set(["low", "medium", "high"]);
function fail(code, message, statusCode = 409) { throw Object.assign(new Error(message), { code, statusCode }); }
function json(value) { try { return JSON.parse(value ?? "null"); } catch { return null; } }

/** User-confirmed conversation branching. Provider history and product identity remain separate. */
export class SessionForkService {
  constructor({ store, registry, sessionService, workService, startWorkSession, createChat,
    copyMetadata = async raw => raw, onChanged = () => {} }) {
    Object.assign(this, { store, registry, sessionService, workService, startWorkSession, createChat, copyMetadata, onChanged });
    this.inFlight = new Map();
  }

  async source(sessionId, itemId) {
    const reference = await this.sessionService.referenceFor(sessionId);
    const session = this.store.getSession(reference.sessionId);
    if (!session || !["worker", "assistantChat"].includes(session.sessionKind)) {
      fail("FORK_KIND_UNSUPPORTED", "仅普通 Chat 和 Task 支持消息分叉。");
    }
    if (session.archived || ["running", "blocked"].includes(session.status)) {
      fail("FORK_SOURCE_BUSY", "请等待当前会话结束执行后再创建分支。");
    }
    this.registry.requireCapability(reference.providerId, AGENT_PROVIDER_CAPABILITIES.SESSION_FORK);
    const item = this.store.selectOne("SELECT rowid AS ordinal, * FROM session_items WHERE session_id=? AND id=?", [session.id, itemId]);
    if (!item || item.type !== "agentMessage" || !terminal.has(item.turn_status)) {
      fail("FORK_POINT_UNAVAILABLE", "请选择已结束轮次的模型回复创建分支。");
    }
    if (!item.binding_id || item.binding_id !== reference.bindingId) {
      fail("FORK_POINT_BINDING_CHANGED", "这条消息属于先前的运行会话，当前 Provider 无法从该位置精确分叉。");
    }
    const end = this.store.selectOne(
      "SELECT MIN(rowid) AS start_ordinal, MAX(rowid) AS ordinal FROM session_items WHERE session_id=? AND turn_id=? AND binding_id=?",
      [session.id, item.turn_id, reference.bindingId]);
    const lastReply = this.store.selectOne(
      "SELECT id FROM session_items WHERE session_id=? AND turn_id=? AND binding_id=? AND type='agentMessage' ORDER BY rowid DESC LIMIT 1",
      [session.id, item.turn_id, reference.bindingId]);
    if (lastReply?.id !== item.id) fail("FORK_POINT_NOT_TURN_END", "请从这一轮的最后一条回复创建分支。");
    const source = { reference, session, item, startOrdinal: end.start_ordinal, endOrdinal: end.ordinal,
      point: { turnId: item.turn_id, itemId: item.id,
        providerMessageId: json(item.raw_metadata_json)?.forkPoint?.messageId ?? null } };
    const provider = this.registry.get(reference.providerId);
    if (typeof provider.validateForkPoint === "function") await provider.validateForkPoint(source);
    return source;
  }

  async preview(sessionId, itemId) {
    const { session, reference, point, item } = await this.source(sessionId, itemId);
    const task = session.taskId ? this.store.getTask(session.taskId) : null;
    const work = task ? this.store.getWork(task.work_id) : null;
    const agent = this.store.getAgent(session.agentId);
    const turnNumber = Number(this.store.selectOne(
      "SELECT COUNT(DISTINCT turn_id) AS count FROM session_items WHERE session_id=? AND binding_id=? AND rowid<=? AND type IN ('userMessage','agentMessage')",
      [session.id, reference.bindingId, item.ordinal]
    )?.count ?? 0);
    return { schemaVersion: 1, sourceSessionId: session.id, sourceItemId: itemId,
      sourceBindingId: reference.bindingId, turnId: point.turnId, kind: session.sessionKind,
      suggestedTitle: `${String(session.title ?? "").replace(/[^\p{Script=Han}a-zA-Z0-9]/gu, "").slice(0, 60)}分支`,
      workName: work?.name ?? null, agentName: agent?.name ?? null,
      providerName: this.registry.get(reference.providerId).descriptor.displayName,
      model: session.external?.currentModel ?? null,
      reasoningLevel: session.external?.currentReasoningLevel ?? null,
      sourceSessionTitle: session.title, sourceTurnNumber: turnNumber,
      sourceExcerpt: String(item.presentation_text || item.text || "").trim().slice(0, 280),
      description: task?.description ?? "", acceptanceCriteria: task?.acceptance_criteria ?? "",
      verificationCriteria: task?.verification_criteria ?? "", priority: task?.priority ?? "medium",
      hasWorktree: Boolean(this.store.getLogicalSessionByLegacySessionId(session.id)?.activeWorkspaceId) };
  }

  async create(sessionId, input) {
    const fields = ["requestId", "itemId", "sourceBindingId", "title", "description", "acceptanceCriteria", "verificationCriteria", "priority"];
    if (!input || Object.keys(input).some(key => !fields.includes(key))
      || !/^[A-Za-z0-9_-]{8,128}$/.test(input.requestId ?? "")
      || typeof input.itemId !== "string" || typeof input.sourceBindingId !== "string") fail("INVALID_FORK_INPUT", "分叉请求不完整。", 400);
    for (const key of ["title", "description", "acceptanceCriteria", "verificationCriteria"]) {
      if (input[key] !== undefined && (typeof input[key] !== "string" || input[key].length > 16000)) fail("INVALID_FORK_INPUT", "分支信息过长。", 400);
    }
    if (input.priority !== undefined && !priorities.has(input.priority)) fail("INVALID_FORK_INPUT", "分支优先级无效。", 400);
    validateEntityName(input.title, "title", "分支");
    const fingerprint = createHash("sha256").update(JSON.stringify([sessionId, ...fields.map(key => input[key] ?? null)])).digest("hex");
    const existing = this.operation(input.requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) fail("FORK_IDEMPOTENCY_CONFLICT", "该创建请求已经用于不同的分支信息。");
      if (this.inFlight.has(input.requestId)) return this.inFlight.get(input.requestId);
      if (existing.state === "ready") {
        const result = json(existing.result_json);
        return { ...result, session: this.store.getSession(result.session.id) ?? result.session };
      }
      if (existing.state === "finalizing" && existing.target_session_id) {
        const source = await this.source(existing.source_session_id, existing.source_item_id);
        if (this.inFlight.has(input.requestId)) return this.inFlight.get(input.requestId);
        if (source.reference.bindingId !== existing.source_binding_id) fail("FORK_SOURCE_CHANGED", "源会话的运行绑定发生了变化。");
        const session = this.store.getSession(existing.target_session_id);
        if (!session) fail("FORK_TARGET_MISSING", "分支会话已被移除。");
        const promise = this.finish(input, source, session, existing.target_task_id)
          .finally(() => this.inFlight.delete(input.requestId));
        this.inFlight.set(input.requestId, promise);
        return promise;
      }
      fail(existing.error_code ?? "FORK_OUTCOME_UNCERTAIN", existing.error_message ?? "上一次分叉尚未完成，请检查新建会话后再操作。");
    }
    const source = await this.source(sessionId, input.itemId);
    if (source.reference.bindingId !== input.sourceBindingId) fail("FORK_SOURCE_CHANGED", "确认期间源会话已变化，请重新打开分叉窗口。");
    // Another request may have claimed the key during asynchronous validation.
    if (this.operation(input.requestId)) return this.create(sessionId, input);
    const taskId = source.session.sessionKind === "worker" ? `task:${randomUUID()}` : null;
    this.store.db.run(`INSERT INTO session_fork_operations
      (request_id,fingerprint,source_session_id,source_binding_id,source_item_id,target_task_id,state,input_json,created_at)
      VALUES (?,?,?,?,?,?,'creating',?,?)`,
      [input.requestId, fingerprint, source.session.id, source.reference.bindingId, input.itemId, taskId, JSON.stringify(input), new Date().toISOString()]);
    this.store.scheduleSave();
    const promise = this.drive(input, source, taskId).finally(() => this.inFlight.delete(input.requestId));
    this.inFlight.set(input.requestId, promise);
    return promise;
  }

  operation(requestId) { return this.store.selectOne("SELECT * FROM session_fork_operations WHERE request_id=?", [requestId]); }
  forTask(taskId) { return this.store.selectOne("SELECT * FROM session_fork_operations WHERE target_task_id=?", [taskId]); }
  recordTarget(requestId, sessionId) {
    this.store.db.run("UPDATE session_fork_operations SET target_session_id=? WHERE request_id=? AND state='creating'", [sessionId, requestId]);
    this.store.scheduleSave();
  }
  assertCanDispatch(sessionId) {
    const operation = this.store.selectOne("SELECT state FROM session_fork_operations WHERE target_session_id=?", [sessionId]);
    if (operation && operation.state !== "ready") fail("FORK_NOT_READY", "分支仍在准备对话历史，请等待创建完成。");
  }
  async contextForTask(taskId) {
    const operation = this.forTask(taskId);
    if (!operation) return null;
    if (operation.state !== "creating") fail("FORK_NOT_ACTIVE", "分叉操作已结束。");
    const source = await this.source(operation.source_session_id, operation.source_item_id);
    if (source.reference.bindingId !== operation.source_binding_id) fail("FORK_SOURCE_CHANGED", "源会话的运行绑定发生了变化。");
    return source;
  }

  async drive(input, source, taskId) {
    let session = null;
    try {
      if (taskId) {
        const parent = this.store.getTask(source.session.taskId);
        const workspace = this.store.getTaskWorkspaceContext(parent);
        if (!workspace?.repository?.id) fail("FORK_WORKSPACE_UNSUPPORTED", "当前 Task 文件空间没有 Git Worktree，暂不能创建文件分支。");
        const task = this.workService.createTask({ id: taskId, workId: parent.work_id,
          title: input.title, description: input.description ?? parent.description ?? "",
          acceptanceCriteria: input.acceptanceCriteria ?? parent.acceptance_criteria ?? "",
          verificationCriteria: input.verificationCriteria ?? parent.verification_criteria ?? "",
          priority: input.priority ?? parent.priority,
          mainAgentId: parent.main_agent_id }, { creationOrigin: { originType: "direct_user", operationId: input.requestId } });
        const current = this.store.getTask(task.id);
        const started = await this.startWorkSession({ taskId, assigneeAgentId: parent.main_agent_id,
          expectedTaskVersion: Number(current.resource_version ?? 1), providerId: source.reference.providerId,
          title: input.title, idempotencyKey: `fork:${input.requestId}`,
          sourceSessionId: source.reference.logicalSessionId, dispatchInitialTurn: false,
          ...(source.session.external?.currentModel ? { model: source.session.external.currentModel } : {}),
          ...(source.session.external?.currentReasoningLevel ? { reasoningLevel: source.session.external.currentReasoningLevel } : {}) });
        if (started.status !== "ready" || !started.session) fail(started.error?.code ?? "FORK_START_FAILED", started.error?.message ?? "分支会话未能启动。");
        session = started.session;
      } else {
        session = await this.createChat({ source, input });
      }
      this.store.db.run("UPDATE session_fork_operations SET state='finalizing',target_session_id=? WHERE request_id=?", [session.id, input.requestId]);
      return await this.finish(input, source, session, taskId);
    } catch (error) {
      this.store.db.run("UPDATE session_fork_operations SET state=?,error_code=?,error_message=? WHERE request_id=?",
        [session ? "finalizing" : "failed", error.code ?? "FORK_FAILED", error.message, input.requestId]);
      // A failed new Task must not look like a ready, empty task awaiting instructions.
      if (taskId && this.store.getTask(taskId) && !this.store.getTask(taskId).current_session_id) {
        try { this.workService.deleteTask(taskId); }
        catch (cleanupError) {
          error.cleanupError = cleanupError.message;
          this.store.setTaskArchived(taskId, true);
        }
      }
      this.store.scheduleSave();
      throw error;
    }
  }

  async finish(input, source, session, taskId) {
    await this.copyTimeline(source, session);
    const result = { schemaVersion: 1, session: this.store.getSession(session.id) ?? session,
      taskId, sourceSessionId: source.session.id, sourceItemId: source.item.id };
    this.store.db.run("UPDATE session_fork_operations SET state='ready',result_json=? WHERE request_id=?", [JSON.stringify(result), input.requestId]);
    this.store.scheduleSave();
    this.onChanged("SessionForked", result);
    return result;
  }

  async copyTimeline(source, target) {
    const binding = this.store.getLogicalSessionByLegacySessionId(target.id)?.activeBinding;
    if (!binding) fail("FORK_BINDING_MISSING", "新分支缺少运行绑定。");
    const rows = this.store.selectAll(`SELECT * FROM session_items
      WHERE session_id=? AND binding_id=? AND rowid<=?
        AND turn_id IN (SELECT turn_id FROM session_items WHERE session_id=? AND binding_id=?
          GROUP BY turn_id HAVING MIN(rowid)<=?) ORDER BY rowid`,
      [source.session.id, source.reference.bindingId, source.endOrdinal,
        source.session.id, source.reference.bindingId, source.startOrdinal]);
    const targetReference = await this.sessionService.referenceFor(target.id);
    const imageCache = new Map();
    const copies = [];
    for (const row of rows) {
      if (["approval", "choice", "userInput", "collaborationConfirmation"].includes(row.type)) continue;
      const raw = await this.copyMetadata(json(row.raw_metadata_json) ?? {}, source.reference, targetReference, imageCache);
      delete raw.forkPoint;
      raw.inheritedFrom = { sessionId: source.session.id, itemId: row.id };
      copies.push({ row, raw });
    }
    this.store.runInTransaction(() => {
      for (const { row, raw } of copies) {
        // Bulk projection: notify once after commit, not once per historic item.
        this.store.db.run(`INSERT OR IGNORE INTO session_items
          (session_id,id,turn_id,turn_status,type,title,text,raw_metadata_json,binding_id,presentation_role,presentation_text,status,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [target.id, `fork:${target.id}:${row.id}`, row.turn_id, row.turn_status,
          row.type, row.title, row.text, JSON.stringify(raw), binding.bindingId, row.presentation_role,
          row.presentation_text, row.type === "userMessage" ? "consumed" : "completed", row.created_at]);
      }
      if (!this.store.selectOne("SELECT event_id FROM session_events WHERE event_id=?", [`fork:${target.id}`])) this.store.appendSessionEvent({ eventId: `fork:${target.id}`, sessionId: target.id,
        type: "session/forked", producer: "system", surface: false,
        payload: { sourceSessionId: source.session.id, sourceItemId: source.item.id, sourceTurnId: source.item.turn_id } });
    });
    this.store.notifyTimelineDirty(target.id);
  }
}
