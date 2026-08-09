import { randomUUID } from "node:crypto";

export class ClaudeWorkspaceTransitionPort {
  constructor(options = {}) {
    this.store = options.store;
    this.manager = options.manager;
    this.instructionSources = options.instructionSources ?? (async () => []);
    if (!this.store || !this.manager) {
      throw new TypeError("ClaudeWorkspaceTransitionPort requires store and manager.");
    }
  }

  async forkThread(sourceRouteId, options = {}) {
    const providerSessionId = this.providerSessionIdForRoute(sourceRouteId);
    const session = await this.manager.switchWorkspace(providerSessionId, options.cwd);
    return this.response(`claude-route:${randomUUID()}`, providerSessionId, session, options.cwd);
  }

  async startThread() {
    const error = new Error("Claude workspace handoff requires an existing source Session.");
    error.code = "UNSUPPORTED_METHOD";
    throw error;
  }

  async resumeThread(routeId, options = {}) {
    const providerSessionId = this.providerSessionIdForRoute(routeId);
    let session = await this.manager.reconnect(providerSessionId, { startQuery: false });
    if (session?.external?.cwd !== options.cwd) {
      session = await this.manager.switchWorkspace(providerSessionId, options.cwd);
    }
    return this.response(routeId, providerSessionId, session, options.cwd);
  }

  async readThread(routeId) {
    const providerSessionId = this.providerSessionIdForRoute(routeId);
    const session = await this.manager.read(providerSessionId);
    const currentTurnId = this.manager.get(providerSessionId)?.currentTurnId ?? null;
    return {
      thread: {
        id: routeId,
        cwd: session?.external?.cwd,
        turns: currentTurnId ? [{ id: currentTurnId, status: "completed", items: [] }] : []
      }
    };
  }

  async startTurn(routeId, prompt) {
    const providerSessionId = this.providerSessionIdForRoute(routeId);
    await this.manager.send(providerSessionId, prompt, { localVisibility: "status_only" });
    return { turn: { id: this.manager.get(providerSessionId)?.currentTurnId ?? null } };
  }

  async updateThreadSettings() {}

  async deleteThread() {
    // A Claude logical route and its successor intentionally share the stable
    // Corptie Provider session. Only the underlying SDK session is forked.
    return { deleted: false };
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
    throw new Error(`Claude route ${routeId} has no Provider session binding.`);
  }

  async response(routeId, providerSessionId, session, cwd) {
    return {
      providerId: "claude-sdk",
      providerSessionId,
      cwd,
      thread: { id: routeId, cwd },
      instructionSources: await this.instructionSources(cwd),
      approvalPolicy: session?.external?.approvalPolicy,
      sandbox: session?.external?.sandbox
    };
  }
}
