const STATE_KEY = "worktree:auto-follow:v1";
const ACTIVE = new Set(["awaiting_confirmation", "queued", "running", "paused", "replanning", "cancellation_requested"]);

// Shared Session dispatch barrier: queued user messages remain queued during
// an actual automatic Git job instead of starting in the rebasing Worktree.
export function automaticWorktreeMutationActive(store, reference) {
  const logical = (reference.logicalSessionId ? store.getLogicalSession?.(reference.logicalSessionId) : null)
    ?? store.getLogicalSessionByLegacySessionId?.(reference.sessionId);
  if (!logical?.repositoryId || !logical.activeWorkspaceId) return false;
  const job = store.getLatestWorktreeIntegrationJob?.(logical.repositoryId);
  return Boolean(job?.details?.automaticFollow && ["queued", "running", "cancellation_requested"].includes(job.status)
      && job.details.plan?.items?.some(item => item.worktreeId === logical.activeWorkspaceId));
}
export function assertNoAutomaticWorktreeMutation(store, reference) {
  if (automaticWorktreeMutationActive(store, reference)) {
    throw Object.assign(new Error("Automatic Worktree synchronization is in progress. This message will wait."),
      { code: "SESSION_BUSY", reason: "WORKTREE_AUTO_FOLLOW_IN_PROGRESS", statusCode: 409 });
  }
}

// A durable, explicitly opted-in project capability. Never depends on a
// Provider, an open card, or a device being online. Reuses integration jobs.
export class WorktreeAutoFollowService {
  constructor({ store, readDetail, jobs, readHead, onEvent = () => {}, intervalMs = 30_000 }) {
    Object.assign(this, { store, readDetail, jobs, readHead, onEvent, intervalMs });
    this.timer = null;
    this.running = null;
    this.started = false;
    this.stopping = false;
    this.signatures = new Map();
  }
  entries() { return this.store.getRuntimeState(STATE_KEY) ?? {}; }
  state(worktreeId) {
    const entry = this.entries()[worktreeId];
    return { enabled: entry?.enabled === true, status: entry?.status ?? "off",
      reason: entry?.reason ?? null, jobId: entry?.jobId ?? null };
  }
  authorizes(job) {
    const grant = job.details?.automaticFollow;
    const entry = grant && this.entries()[grant.worktreeId];
    const plan = job.details?.plan;
    const logical = entry && (this.store.getLogicalSessionByLegacySessionId(entry.sessionId)
      ?? this.store.getLogicalSession(entry.sessionId));
    const session = logical && this.store.getSession(logical.legacySessionId);
    const task = session?.taskId ? this.store.getTask(session.taskId) : null;
    return Boolean(!this.stopping && entry?.enabled === true && entry.revision === grant.revision
      && logical?.activeWorkspaceId === entry.worktreeId && logical.repositoryId === entry.repositoryId
      && Boolean(logical.activeBinding?.boundCwd) && session && !session.archived
      && !task?.deletion_status && !task?.archived && task?.lifecycle_state !== "done"
      && job.repositoryId === entry.repositoryId && plan?.operationType === "sync"
      && plan.targetWorktreeId === entry.mainWorktreeId
      && plan.items.filter(item => !item.isMain).length === 1
      && plan.items.some(item => !item.isMain && item.worktreeId === entry.worktreeId && item.branchName === entry.sourceBranch)
      && plan.items.some(item => item.isMain && item.worktreeId === entry.mainWorktreeId && item.branchName === entry.targetBranch));
  }
  save(id, changes) {
    const entries = this.entries();
    const entry = entries[id];
    if (!entry) return;
    const next = { ...entry, ...changes };
    if (JSON.stringify(next) === JSON.stringify(entry)) return;
    entries[id] = next;
    this.store.setRuntimeState(STATE_KEY, entries);
    this.onEvent("WorktreeAutoFollowChanged", { sessionId: next.sessionId, worktreeId: id, autoFollow: this.state(id) });
  }
  async set(sessionId, input) {
    if (typeof input?.enabled !== "boolean" || typeof input?.expectedWorktreeId !== "string") {
      throw Object.assign(new Error("A boolean and the displayed Worktree identity are required."), { code: "INVALID_AUTO_FOLLOW", statusCode: 400 });
    }
    const detail = await this.readDetail(sessionId);
    const tree = detail.worktree;
    if (!detail.attached || !tree || tree.isMain || tree.worktreeId !== input.expectedWorktreeId
        || (input.enabled && (!detail.mainWorktreeId || !tree.branchName || !detail.mainBranch))) {
      throw Object.assign(new Error("The current Worktree binding changed or cannot follow main."), { code: "WORKTREE_STATE_CHANGED", statusCode: 409 });
    }
    const entries = this.entries();
    const previous = entries[tree.worktreeId];
    if (previous?.enabled === input.enabled && previous.sessionId === sessionId) return this.state(tree.worktreeId);
    entries[tree.worktreeId] = { sessionId, repositoryId: detail.repositoryId, worktreeId: tree.worktreeId,
      mainWorktreeId: detail.mainWorktreeId, sourceBranch: tree.branchName, targetBranch: detail.mainBranch,
      enabled: input.enabled, revision: (previous?.revision ?? 0) + 1,
      status: input.enabled ? "waiting" : "off", reason: null, jobId: previous?.jobId ?? null };
    this.store.setRuntimeState(STATE_KEY, entries);
    this.signatures.delete(tree.worktreeId);
    this.onEvent("WorktreeAutoFollowChanged", { sessionId, worktreeId: tree.worktreeId, autoFollow: this.state(tree.worktreeId) });
    if (this.started) this.schedule(0);
    return this.state(tree.worktreeId);
  }
  start() { this.stopping = false; this.started = true; this.schedule(0); }
  stop() { this.stopping = true; this.started = false; clearTimeout(this.timer); this.timer = null; }
  schedule(delay = this.intervalMs) {
    if (!this.started) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      try { await this.tick(); }
      catch (error) { if (!this.stopping) console.warn("[worktree-auto-follow] Check deferred:", error.code ?? "STORE_UNAVAILABLE"); }
      finally { this.schedule(); }
    }, delay);
    this.timer.unref?.();
  }
  tick() {
    if (this.running) return this.running;
    this.running = this.run().finally(() => { this.running = null; });
    return this.running;
  }
  async run() {
    // No Git commands at all when every preference is off. Checks are serial
    // and bounded to opted-in Worktrees; no new filesystem watcher.
    for (const [id, entry] of Object.entries(this.entries())) {
      if (this.stopping) break;
      if (!entry.enabled) continue;
      try { await this.check(id, entry); }
      catch (error) { this.save(id, { status: "waiting", reason: error.code ?? "AUTO_FOLLOW_CHECK_FAILED" }); }
    }
  }
  current(id, entry) {
    const now = this.entries()[id];
    return !this.stopping && now?.enabled === true && now.revision === entry.revision;
  }
  async check(id, entry) {
    if (!this.current(id, entry)) return;
    if (entry.jobId) {
      const job = this.jobs.get(entry.jobId);
      if (job.status === "awaiting_confirmation") {
        // A restart interrupted our own draft. Discard that unexecuted plan
        // and regenerate from fresh Git state; never auto-confirm a stale one.
        if (job.automaticFollow?.worktreeId !== id || job.automaticFollow?.revision !== entry.revision) {
          this.save(id, { status: "paused", reason: "AUTO_FOLLOW_NEEDS_ATTENTION" }); return;
        }
        await this.jobs.cancel(job.id);
      } else {
        if (["paused", "failed", "canceled", "cancelled"].includes(job.status)) {
          this.save(id, { status: "paused", reason: "AUTO_FOLLOW_NEEDS_ATTENTION" });
          return; // Explicit manual recovery, never retry a conflict automatically.
        }
        if (ACTIVE.has(job.status)) {
          this.save(id, { status: "running", reason: null });
          return;
        }
      }
      this.save(id, { jobId: null });
      this.signatures.delete(id);
    }
    // Check the persisted route BEFORE using cached branch tips, and never
    // transfer opt-in to a replacement Worktree or a renamed target branch.
    const logical = this.store.getLogicalSessionByLegacySessionId(entry.sessionId)
      ?? this.store.getLogicalSession(entry.sessionId);
    const session = logical ? this.store.getSession(logical.legacySessionId) : null;
    if (!logical || logical.activeWorkspaceId !== id || logical.repositoryId !== entry.repositoryId
        || !logical.activeBinding?.boundCwd || !session || session.archived) {
      this.save(id, { status: "paused", reason: "WORKTREE_BINDING_CHANGED" }); return;
    }
    const task = session.taskId ? this.store.getTask(session.taskId) : null;
    if (task?.deletion_status || task?.archived || task?.lifecycle_state === "done") {
      this.save(id, { status: "paused", reason: "SESSION_UNAVAILABLE" }); return;
    }
    const main = this.store.getGitWorktree(entry.mainWorktreeId);
    const source = this.store.getGitWorktree(id);
    if (!main || !source || main.branchName !== entry.targetBranch || source.branchName !== entry.sourceBranch) {
      this.save(id, { status: "paused", reason: "WORKTREE_BINDING_CHANGED" }); return;
    }
    const signature = `${await this.readHead(main.path)}:${await this.readHead(source.path)}`;
    if (!this.current(id, entry)) return;
    if (this.signatures.get(id) === signature && this.state(id).status === "aligned") return;
    const detail = await this.readDetail(entry.sessionId);
    if (!this.current(id, entry)) return;
    if (detail.repositoryId !== entry.repositoryId || detail.worktree?.worktreeId !== id
        || detail.mainWorktreeId !== entry.mainWorktreeId || detail.mainBranch !== entry.targetBranch
        || detail.worktree.branchName !== entry.sourceBranch) {
      this.save(id, { status: "paused", reason: "WORKTREE_BINDING_CHANGED" }); return;
    }
    let other = this.store.listWorktreeIntegrationJobs(entry.repositoryId).find(job => ACTIVE.has(job.status));
    if (other?.status === "awaiting_confirmation"
        && other.details?.automaticFollow?.worktreeId === id
        && other.details.automaticFollow.revision === entry.revision) {
      await this.jobs.cancel(other.id);
      other = this.store.listWorktreeIntegrationJobs(entry.repositoryId).find(job => ACTIVE.has(job.status));
    }
    if (detail.blockedReason || other) {
      this.save(id, { status: "waiting", reason: detail.blockedReason ?? "INTEGRATION_JOB_ACTIVE" }); return;
    }
    if (detail.worktree.behindMain === 0) {
      this.signatures.set(id, signature);
      this.save(id, { status: "aligned", reason: null }); return;
    }
    if (!(detail.worktree.behindMain > 0)) {
      this.save(id, { status: "waiting", reason: "WORKTREE_UNAVAILABLE" }); return;
    }
    let draft;
    try {
      draft = await this.jobs.preflight(entry.repositoryId, {
        operationType: "one_way_sync", sourceWorktreeIds: [id], targetWorktreeId: entry.mainWorktreeId,
        automaticFollow: { worktreeId: id, revision: entry.revision }
      });
      if (this.current(id, entry)) this.save(id, { jobId: draft.id });
      if (!this.current(id, entry) || draft.plan.blockingRisks.length
          || draft.plan.items.some(item => item.dirty || item.commitStatus !== "not_needed")) {
        await this.jobs.cancel(draft.id);
        if (this.entries()[id]?.jobId === draft.id) this.save(id, { jobId: null });
        if (this.current(id, entry)) this.save(id, { status: "waiting", reason: "WORKTREE_STATE_CHANGED", jobId: null });
        return;
      }
      // An explicit persisted opt-in authorizes only this exact, clean sync
      // plan. Re-read both trees and Session safety immediately before confirm.
      const fresh = await this.readDetail(entry.sessionId);
      if (!this.current(id, entry) || fresh.blockedReason || fresh.worktree?.worktreeId !== id
          || fresh.mainWorktreeId !== entry.mainWorktreeId) {
        await this.jobs.cancel(draft.id);
        if (this.entries()[id]?.jobId === draft.id) this.save(id, { jobId: null });
        if (this.current(id, entry)) this.save(id, { jobId: null });
        return;
      }
      const job = await this.jobs.confirm(draft.id, { confirmed: true, planFingerprint: draft.planFingerprint,
        commitProtectionDecisions: [], automaticFollow: { worktreeId: id, revision: entry.revision } });
      if (job.status === "awaiting_confirmation") {
        await this.jobs.cancel(draft.id);
        this.save(id, { status: "waiting", reason: "WORKTREE_STATE_CHANGED", jobId: null }); return;
      }
      this.save(id, { status: "running", reason: null, jobId: job.id });
    } catch (error) {
      if (draft && this.jobs.get(draft.id).status === "awaiting_confirmation") {
        await this.jobs.cancel(draft.id);
        this.save(id, { jobId: null });
      }
      throw error;
    }
  }
}
