import { randomUUID } from "node:crypto";

// Provider-neutral workspace transition port for OpenClacky. OpenClacky cannot
// fork a thread in place the way Codex does; the correct switch semantics are to
// create a fresh OpenClacky Session in the target worktree, load the target
// AGENTS.md / runtime instructions, then atomically commit the logical binding.
// This port deliberately does NOT use `PATCH working_dir` or `cd` as a stand-in
// for a logical Workspace switch: every switch produces a new Session bound to the
// target cwd and re-bootstrapped with the Corptie session contract.
export class OpenClackyWorkspaceTransitionPort {
  constructor(options = {}) {
    this.store = options.store;
    this.manager = options.manager;
    this.instructionSources = options.instructionSources ?? (async () => []);
    this.bootstrapSession = options.bootstrapSession ?? null;
    if (!this.store || !this.manager) {
      throw new TypeError("OpenClackyWorkspaceTransitionPort requires store and manager.");
    }
    if (typeof this.bootstrapSession !== "function") {
      throw new TypeError("OpenClackyWorkspaceTransitionPort requires bootstrapSession().");
    }
  }

  // OpenClacky has no in-place fork; a workspace switch is always a fresh Session
  // (handoff strategy). `forkThread` is therefore unsupported.
  async forkThread() {
    const error = new Error("OpenClacky workspace transition requires a fresh Session handoff.");
    error.code = "UNSUPPORTED_METHOD";
    throw error;
  }

  async startThread(options = {}) {
    const created = await this.bootstrapSession(options);
    const providerSessionId = created?.external?.sessionId ?? created?.providerSessionId;
    if (!providerSessionId) {
      throw new Error("OpenClacky workspace handoff returned no Session id.");
    }
    return this.response(
      `openclacky-route:${randomUUID()}`,
      providerSessionId,
      created,
      options.cwd
    );
  }

  async resumeThread(routeId, options = {}) {
    const providerSessionId = this.providerSessionIdForRoute(routeId);
    const session = await this.manager.read(providerSessionId);
    return this.response(routeId, providerSessionId, session, options.cwd);
  }

  async readThread(routeId) {
    const providerSessionId = this.providerSessionIdForRoute(routeId);
    const session = await this.manager.read(providerSessionId);
    return {
      thread: {
        id: routeId,
        cwd: session?.external?.cwd,
        turns: []
      }
    };
  }

  async startTurn(routeId, prompt) {
    const providerSessionId = this.providerSessionIdForRoute(routeId);
    await this.manager.send(providerSessionId, prompt, { localVisibility: "status_only" });
    return { turn: { id: `openclacky:turn:${randomUUID()}` } };
  }

  async updateThreadSettings() {}

  async deleteThread(routeId) {
    const providerSessionId = this.providerSessionIdForRoute(routeId);
    await this.manager.delete(providerSessionId);
    return { deleted: true };
  }

  providerSessionIdForRoute(routeId) {
    const binding = this.store.getProviderThreadBinding(routeId);
    if (binding?.providerSessionId) return binding.providerSessionId;
    const row = this.store.selectOne(
      `SELECT source_thread_id FROM workspace_transitions
       WHERE new_thread_id = ? ORDER BY updated_at DESC LIMIT 1`,
      [routeId]
    );
    const source = row ? this.store.getProviderThreadBinding(row.source_thread_id) : null;
    if (source?.providerSessionId) return source.providerSessionId;
    throw new Error(`OpenClacky route ${routeId} has no Provider session binding.`);
  }

  async response(routeId, providerSessionId, session, cwd) {
    return {
      providerId: "openclacky",
      providerSessionId,
      cwd,
      thread: { id: routeId, cwd },
      instructionSources: await this.instructionSources(cwd),
      approvalPolicy: session?.external?.approvalPolicy ?? null,
      sandbox: session?.external?.sandbox ?? null
    };
  }
}
