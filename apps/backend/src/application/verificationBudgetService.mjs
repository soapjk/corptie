import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const fail = (code, statusCode = 409) => { throw Object.assign(new Error(code), { code, statusCode }); };
const identity = value => {
  if (typeof value !== "string" || !value.trim() || value.length > 512) fail("VERIFICATION_ID_INVALID", 400);
  return value;
};
const count = value => {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) fail("VERIFICATION_LIMIT_INVALID", 400);
  return value;
};

export const VERIFICATION_LIMITATION = "仅约束统一验证入口；Provider 原生 Shell 和其他执行通道仍可绕过预算。";

export class VerificationBudgetService {
  constructor({ store, scope, workingDirectory, interrupt = async () => {}, changed = () => {},
    run = execute, readOnly = false }) {
    Object.assign(this, { store, scope, workingDirectory, interrupt, changed, run, readOnly });
    this.active = new Map();
  }
  writable() { if (this.readOnly) fail("DEVELOPMENT_PREVIEW_READ_ONLY", 403); }
  defaultLimit() { return this.store.selectOne("SELECT limit_count FROM verification_budget_defaults WHERE id=1")?.limit_count ?? 3; }
  setDefault(limit) {
    this.writable(); count(limit);
    this.store.db.run("INSERT INTO verification_budget_defaults(id,limit_count) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET limit_count=excluded.limit_count", [limit]);
    this.store.scheduleSave();
    return { limit, limitation: VERIFICATION_LIMITATION };
  }
  // Walk authoritative existing dispatch/operation links, never a root ID
  // supplied by the model. Missing ancestry stays scoped to the dispatch.
  operationRoot(operation, seen = new Set()) {
    if (!operation || seen.has(operation.task_id)) return null;
    seen.add(operation.task_id);
    let source = {}; try { source = JSON.parse(operation.source_json ?? "{}"); } catch {}
    if (source.type === "scheduled_session_task") {
      const scheduled = this.store.getScheduledSessionTask(source.scheduledTaskId);
      const originalId = scheduled?.policySpec?.verificationOperationId;
      const original = originalId && this.store.selectOne("SELECT * FROM agent_operations WHERE task_id=?", [originalId]);
      const root = this.operationRoot(original, seen);
      if (root) return root;
    }
    const request = this.store.selectOne("SELECT * FROM coordination_requests WHERE operation_id=?", [operation.task_id]);
    if (request?.relation === "supplement" && request.related_request_id) {
      const related = this.store.selectOne("SELECT operation_id FROM coordination_requests WHERE request_id=?", [request.related_request_id]);
      const original = related?.operation_id && this.store.selectOne("SELECT * FROM agent_operations WHERE task_id=?", [related.operation_id]);
      const root = this.operationRoot(original, seen);
      if (root) return root;
    }
    const dispatch = this.store.selectOne("SELECT * FROM task_coordination_dispatches WHERE operation_id=? OR dispatch_id=? LIMIT 1", [operation.task_id, source.coordinationDispatchId ?? null]);
    if (dispatch) {
      let runtime = {}; try { runtime = JSON.parse(dispatch.runtime_json); } catch {}
      const origin = runtime.verificationOperationId && this.store.selectOne("SELECT * FROM agent_operations WHERE task_id=?", [runtime.verificationOperationId]);
      const boundRoot = this.operationRoot(origin, seen);
      if (boundRoot) return boundRoot;
      const logical = this.store.getLogicalSession(dispatch.source_session_id);
      const parent = logical && dispatch.source_turn_id && this.store.selectOne(
        "SELECT * FROM agent_operations WHERE session_id=? AND target_turn_id=? ORDER BY created_at DESC LIMIT 1",
        [logical.legacySessionId, dispatch.source_turn_id]);
      return this.operationRoot(parent, seen) ?? { instructionId: dispatch.progress_batch_id ?? dispatch.dispatch_id,
        taskId: dispatch.parent_task_id, sessionId: dispatch.source_session_id };
    }
    const session = this.store.getSession(operation.session_id);
    if (session?.taskId && operation.kind === "user" && /^(继续|继续开发|continue)[。.!！\s]*$/iu.test(operation.text.trim())) {
      const previous = this.store.selectOne("SELECT instruction_id,task_id,session_id FROM verification_budgets WHERE task_id=? AND created_at<=? ORDER BY created_at DESC LIMIT 1", [session.taskId, operation.created_at]);
      if (previous) return { instructionId: previous.instruction_id, taskId: previous.task_id, sessionId: previous.session_id };
    }
    return session?.taskId ? { instructionId: operation.task_id, taskId: session.taskId,
      sessionId: this.store.getLogicalSessionByLegacySessionId(operation.session_id)?.logicalSessionId ?? operation.session_id } : null;
  }
  current(metadata) {
    const { task, logical, session } = this.scope(metadata);
    const operation = this.store.selectOne("SELECT * FROM agent_operations WHERE session_id=? AND status='running' LIMIT 1", [session.id]);
    const root = this.operationRoot(operation);
    if (!root) fail("VERIFICATION_INSTRUCTION_UNAVAILABLE");
    return { ...root, operationId: operation?.task_id, executorSessionId: session.id, executorTaskId: task.id, logicalSessionId: logical.logicalSessionId };
  }
  operationForSession(sessionId) {
    const logical = this.store.getLogicalSession(sessionId) ?? this.store.getLogicalSessionByLegacySessionId(sessionId);
    if (!logical) return null;
    const request = this.store.selectOne("SELECT operation_id FROM coordination_requests WHERE shadow_session_id=?", [logical.logicalSessionId]);
    return request?.operation_id ?? this.store.getRunningAgentTaskForSession(logical.legacySessionId)?.taskId ?? null;
  }
  operationPaused(operationId) {
    const operation = this.store.selectOne("SELECT * FROM agent_operations WHERE task_id=?", [operationId]);
    const root = this.operationRoot(operation);
    return Boolean(root && this.read(root.instructionId)?.paused);
  }
  captureAutomationOwner(sessionId, actor) {
    if (actor?.type !== "agent") return null;
    const logical = this.store.getLogicalSession(sessionId);
    const session = logical && this.store.getSession(logical.legacySessionId);
    if (!session || session.agentId !== actor.id) return null;
    const operation = this.store.getRunningAgentTaskForSession(session.id);
    return operation ? { verificationOperationId: operation.taskId } : null;
  }
  read(instructionId) {
    const row = this.store.selectOne("SELECT * FROM verification_budgets WHERE instruction_id=?", [instructionId]);
    if (!row) return null;
    const runs = this.store.selectAll("SELECT execution_id,status,created_at FROM verification_budget_charges WHERE instruction_id=? ORDER BY rowid", [instructionId]);
    const used = runs.filter(run => run.status !== "not_started").length;
    const active = runs.some(run => ["reserved", "running"].includes(run.status));
    const paused = Boolean(row.stopped) || (!active && used >= row.limit_count && runs.at(-1)?.status !== "passed");
    const instruction = this.store.selectOne("SELECT text FROM agent_operations WHERE task_id=?", [instructionId])?.text?.slice(0, 160) ?? "子任务验证";
    return { instructionId, taskId: row.task_id, sessionId: row.session_id, limit: row.limit_count, used,
      instruction, paused, stopped: Boolean(row.stopped), running: active, runs, limitation: VERIFICATION_LIMITATION };
  }
  list(taskId) {
    const task = this.store.getTask(taskId);
    return this.store.selectAll("SELECT instruction_id FROM verification_budgets WHERE task_id IN (?,?) ORDER BY rowid DESC LIMIT 20", [taskId, task?.parent_task_id ?? taskId])
      .map(row => this.read(row.instruction_id));
  }
  taskCanManage(taskId, budget) {
    if (!budget) return false;
    if (budget.taskId === taskId) return true;
    const task = this.store.getTask(taskId), parent = this.store.getTask(budget.taskId);
    return Boolean(task && parent && task.parent_task_id === parent.id && task.work_id === parent.work_id);
  }
  reserve(scope, executionId) {
    this.writable(); identity(executionId);
    return this.store.runInTransaction(() => {
      this.store.db.run(`INSERT OR IGNORE INTO verification_budgets(instruction_id,task_id,session_id,limit_count,created_at)
        VALUES(?,?,?,?,?)`, [scope.instructionId, scope.taskId, scope.sessionId, this.defaultLimit(), new Date().toISOString()]);
      const old = this.store.selectOne("SELECT status FROM verification_budget_charges WHERE instruction_id=? AND execution_id=?", [scope.instructionId, executionId]);
      if (old) return { launch: false, status: old.status, budget: this.read(scope.instructionId) };
      const budget = this.read(scope.instructionId);
      if (budget.running) fail("VERIFICATION_ALREADY_RUNNING");
      if (budget.stopped || budget.paused || budget.used >= budget.limit) fail("VERIFICATION_BUDGET_EXHAUSTED");
      this.store.db.run("INSERT INTO verification_budget_charges(instruction_id,execution_id,status,created_at) VALUES(?,?,'reserved',?)",
        [scope.instructionId, executionId, new Date().toISOString()]);
      this.store.scheduleSave();
      return { launch: true, budget: this.read(scope.instructionId) };
    });
  }
  finish(instructionId, executionId, status) {
    this.store.db.run("UPDATE verification_budget_charges SET status=? WHERE instruction_id=? AND execution_id=?", [status, instructionId, executionId]);
    this.store.scheduleSave();
    const budget = this.read(instructionId);
    this.changed(budget);
    return budget;
  }
  extend(taskId, instructionId, { requestId, amount = 1 }) {
    this.writable(); identity(requestId); count(amount);
    return this.store.runInTransaction(() => {
      const budget = this.read(instructionId);
      if (!this.taskCanManage(taskId, budget)) fail("VERIFICATION_NOT_FOUND", 404);
      const old = this.store.selectOne("SELECT amount FROM verification_budget_extensions WHERE instruction_id=? AND request_id=?", [instructionId, requestId]);
      if (old) { if (old.amount !== amount) fail("VERIFICATION_REQUEST_CONFLICT"); return budget; }
      this.store.db.run("INSERT INTO verification_budget_extensions(instruction_id,request_id,amount) VALUES(?,?,?)", [instructionId, requestId, amount]);
      this.store.db.run("UPDATE verification_budgets SET limit_count=limit_count+?,stopped=0,notified=0 WHERE instruction_id=?", [amount, instructionId]);
      this.store.scheduleSave();
      this.store.afterCommit(() => this.changed(this.read(instructionId)));
      return this.read(instructionId);
    });
  }
  stop(taskId, instructionId) {
    this.writable(); const budget = this.read(instructionId);
    if (!this.taskCanManage(taskId, budget)) fail("VERIFICATION_NOT_FOUND", 404);
    this.store.db.run("UPDATE verification_budgets SET stopped=1 WHERE instruction_id=?", [instructionId]);
    this.store.scheduleSave();
    this.active.get(instructionId)?.controller.abort();
    this.changed(this.read(instructionId));
    return this.read(instructionId);
  }
  cancelSession(sessionId) {
    for (const entry of this.active.values()) if (entry.sessionId === sessionId) entry.controller.abort();
  }
  async notifyPaused(scope) {
    const budget = this.read(scope.instructionId);
    if (!budget?.paused) return;
    this.store.runInTransaction(() => {
      const row = this.store.selectOne("SELECT notified FROM verification_budgets WHERE instruction_id=?", [scope.instructionId]);
      if (row.notified) return;
      const session = this.store.getLogicalSession(scope.sessionId)?.legacySessionId ?? scope.sessionId;
      this.store.upsertTimelineItemProjection(session, { id: `verification-budget:${scope.instructionId}`, type: "agentMessage",
        title: "验证预算", text: `${budget.used >= budget.limit ? "本条指令验证预算已用完" : "本条指令执行已停止"}（${budget.used}/${budget.limit}），执行已暂停。请在验证预算中追加次数或结束执行。\n${VERIFICATION_LIMITATION}`,
        turnId: "", turnStatus: "completed", status: "completed", createdAt: new Date().toISOString() });
      this.store.db.run("UPDATE verification_budgets SET notified=1 WHERE instruction_id=?", [scope.instructionId]);
      this.store.scheduleSave();
    });
    // Match exact instruction lineage, not the whole Task or parent Session.
    // Recheck each lease immediately before interrupting it.
    const targets = this.store.selectAll("SELECT * FROM agent_operations WHERE status='running'")
      .filter(operation => this.operationRoot(operation)?.instructionId === scope.instructionId);
    const failures = [];
    for (const target of targets) {
      const current = this.store.selectOne("SELECT task_id FROM agent_operations WHERE session_id=? AND status='running'", [target.session_id]);
      if (current?.task_id !== target.task_id) continue;
      try { await this.interrupt(target.session_id); }
      catch (error) { failures.push(error.code ?? "INTERRUPT_FAILED"); }
    }
    if (failures.length) fail("VERIFICATION_INTERRUPT_INCOMPLETE", 503);
  }
  async execute(metadata, input) {
    this.writable();
    const scope = this.current(metadata);
    if (input.developmentComplete !== true) fail("DEVELOPMENT_NOT_FINISHED");
    const commands = input.commands;
    const timeoutSeconds = input.timeoutSeconds ?? 120;
    if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) fail("VERIFICATION_TIMEOUT_INVALID", 400);
    if (!Array.isArray(commands) || !commands.length || commands.length > 20) fail("VERIFICATION_COMMANDS_INVALID", 400);
    for (const command of commands) {
      if (!command || typeof command.file !== "string" || !command.file.trim() || !Array.isArray(command.args)
        || command.args.some(arg => typeof arg !== "string" || arg.length > 16000)) fail("VERIFICATION_COMMANDS_INVALID", 400);
    }
    const cwd = await this.workingDirectory(scope.executorSessionId);
    const current = this.current(metadata);
    if (current.operationId !== scope.operationId || current.executorSessionId !== scope.executorSessionId) fail("VERIFICATION_EXECUTION_CHANGED");
    const executionId = identity(input.executionId);
    let receipt;
    try { receipt = this.reserve(scope, executionId); }
    catch (error) {
      if (error.code === "VERIFICATION_BUDGET_EXHAUSTED") {
        this.store.db.run("UPDATE verification_budgets SET stopped=1 WHERE instruction_id=?", [scope.instructionId]);
        this.store.scheduleSave();
        await this.notifyPaused(scope);
      }
      throw error;
    }
    if (!receipt.launch) return { ...receipt, instruction: "这是原执行的回执，不会重新运行；验证输出沿用原工具结果。" };
    const controller = new AbortController(); this.active.set(scope.instructionId, { controller, sessionId: scope.executorSessionId });
    this.finish(scope.instructionId, executionId, "running");
    const results = [];
    try {
      for (const command of commands) {
        if (controller.signal.aborted) break;
        try {
          const result = await this.run(command.file, command.args, { cwd, signal: controller.signal,
            timeout: timeoutSeconds * 1000, maxBuffer: 1024 * 1024, encoding: "utf8" });
          results.push({ ok: true, stdout: result.stdout, stderr: result.stderr });
        } catch (error) {
          results.push({ ok: false, exitCode: Number.isInteger(error.code) ? error.code : null,
            reason: String(error.code ?? "EXECUTION_FAILED"), stdout: error.stdout ?? "", stderr: error.stderr ?? "" });
        }
      }
      const passed = results.length === commands.length && results.every(result => result.ok);
      const notStarted = results.length === commands.length && results.every(result => !result.ok && ["ENOENT", "EACCES"].includes(result.reason));
      const budget = this.finish(scope.instructionId, executionId, passed ? "passed" : notStarted ? "not_started" : "failed");
      // Deliver this final allowed round's output normally. Interrupting before
      // returning would discard the very tool result the user relies on. An
      // attempted additional round is rejected and interrupted before launch.
      return { executionId, results, budget, instruction: budget.paused
        ? "验证预算已用完，停止本条指令的后续执行，等待用户追加次数；不要使用其他通道绕过。" : null };
    } finally { this.active.delete(scope.instructionId); }
  }
  recover() {
    this.writable();
    // No process is relaunched on recovery. Previously reserved executions
    // remain charged; command output is not duplicated in this ledger.
    this.store.db.run("UPDATE verification_budgets SET stopped=1 WHERE instruction_id IN (SELECT instruction_id FROM verification_budget_charges WHERE status IN ('running','reserved'))");
    this.store.db.run("UPDATE verification_budget_charges SET status='unknown' WHERE status IN ('running','reserved')");
    this.store.scheduleSave();
  }
}
