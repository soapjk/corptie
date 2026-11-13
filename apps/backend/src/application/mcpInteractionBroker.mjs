import { randomUUID } from "node:crypto";
import { elicitationInput, elicitationResponse } from "./structuredInteraction.mjs";

// Downstream MCP requests belong to one live Session invocation, never to a Role.
export class McpInteractionBroker {
  constructor({ store, emitEvent = () => {}, timeoutMs = 300_000 }) {
    Object.assign(this, { store, emitEvent, timeoutMs });
    this.pending = new Map();
    this.sessionGrants = new Map();
  }

  route(metadata) {
    const logical = this.store.getLogicalSession(metadata?.logicalSessionId)
      ?? this.store.getLogicalSessionByLegacySessionId(metadata?.sessionId);
    const binding = logical?.activeBinding;
    const session = logical?.legacySessionId && this.store.getSession(logical.legacySessionId);
    const bindingId = metadata?.providerBindingId ?? metadata?.bindingId;
    if (!session || !binding || binding.state !== "active" || binding.bindingId !== bindingId) {
      throw Object.assign(new Error("MCP request no longer belongs to the active Session binding."),
        { code: "MCP_INTERACTION_STALE" });
    }
    const turnId = session.external?.activeTurnId ?? session.rawStatus?.activeTurnId
      ?? this.store.listUnsettledSessionTurns?.(session.id).at(-1)?.turn_id;
    if (metadata?.turnId && metadata.turnId !== turnId) {
      throw Object.assign(new Error("MCP request belongs to an obsolete turn."), { code: "MCP_INTERACTION_STALE" });
    }
    return { logical, binding, session, turnId };
  }

  request({ metadata, request, signal }) {
    const userInput = elicitationInput(request);
    const { logical, binding, session, turnId } = this.route(metadata);
    if (!userInput) throw Object.assign(new Error("Unsupported MCP approval envelope."), { code: "INVALID_USER_INPUT_ANSWER" });
    if (signal?.aborted) return Promise.resolve({ action: "cancel" });
    const grantKey = this.grantKey(metadata, request);
    if (grantKey && this.sessionGrants.has(grantKey)) return Promise.resolve({ action: "accept", content: {}, _meta: { persist: "session" } });
    const id = `mcp-input:${randomUUID()}`;
    if (!turnId) throw Object.assign(new Error("MCP approval requires an active turn."), { code: "MCP_TURN_REQUIRED" });
    return new Promise((resolve, reject) => {
      const entry = { metadata, request, sessionId: session.id, bindingId: binding.bindingId,
        logicalSessionId: logical.logicalSessionId, resolve, signal, turnId, grantKey };
      const cancel = () => this.finish(id, { action: "cancel" }, "cancelled");
      entry.cancel = cancel;
      entry.timer = setTimeout(cancel, this.timeoutMs);
      entry.timer.unref?.();
      this.pending.set(id, entry);
      signal?.addEventListener("abort", cancel, { once: true });
      const item = { id, type: "userInput", status: "pending", turnId, bindingId: binding.bindingId,
        title: "MCP 请求授权", userInput, rawMetadataJSON: JSON.stringify({ userInput }),
        createdAt: new Date().toISOString() };
      try {
        this.store.upsertTimelineItemProjection(session.id, item);
        this.emitEvent("SessionUserInputRequested", { sessionId: session.id, item }, { sessionId: session.id });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(entry.timer);
        signal?.removeEventListener("abort", cancel);
        reject(error);
      }
      // A stop may have arrived between the initial check and handler registration.
      if (signal?.aborted) cancel();
    });
  }

  owns(itemId) { return this.pending.has(itemId); }

  respond(reference, input) {
    const entry = this.pending.get(input.itemId);
    if (!entry || entry.sessionId !== reference.sessionId || entry.bindingId !== reference.bindingId) {
      throw Object.assign(new Error("MCP approval is no longer pending."), { code: "USER_INPUT_NOT_PENDING" });
    }
    try { this.route({ ...entry.metadata, turnId: entry.turnId }); }
    catch (error) {
      this.finish(input.itemId, { action: "cancel" }, "expired");
      throw error;
    }
    const result = elicitationResponse(entry.request, input);
    if (!this.finish(input.itemId, result, result.action === "cancel" ? "cancelled" : "submitted")) {
      throw Object.assign(new Error("MCP approval could not be recorded."), { code: "MCP_INTERACTION_PERSISTENCE_FAILED" });
    }
    if (result.action === "accept" && result._meta?.persist === "session" && entry.grantKey) {
      this.sessionGrants.set(entry.grantKey, entry.logicalSessionId);
      if (this.sessionGrants.size > 256) this.sessionGrants.delete(this.sessionGrants.keys().next().value);
    }
    return this.store.getSession(entry.sessionId);
  }

  finish(id, result, status) {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.signal?.removeEventListener("abort", entry.cancel);
    let recorded = true;
    try {
      const item = this.store.getSessionItem(entry.sessionId, id);
      if (item) this.store.upsertTimelineItemProjection(entry.sessionId, { ...item, status });
      this.emitEvent("SessionUserInputResponded", { sessionId: entry.sessionId, itemId: id, status },
        { sessionId: entry.sessionId });
    } catch (error) {
      recorded = false;
      console.warn("[mcp-interaction] projection failed", error?.code ?? "PERSISTENCE_FAILED");
    } finally { entry.resolve(recorded ? result : { action: "cancel" }); }
    return recorded;
  }

  grantKey(metadata, request) {
    const meta = request._meta ?? request.meta;
    if (!metadata?.mcpServerKey || meta?.connector_id !== "computer-use"
      || typeof meta.tool_params?.app !== "string" || !meta.persist?.includes("session")) return null;
    return JSON.stringify([metadata.logicalSessionId, metadata.providerBindingId, metadata.mcpServerKey,
      meta.tool_params.app, meta.riskLevel ?? null]);
  }

  cancelSession(logicalSessionId, turnId = null, { revokeGrants = false } = {}) {
    if (revokeGrants) for (const [key, session] of this.sessionGrants) if (session === logicalSessionId) this.sessionGrants.delete(key);
    for (const [id, entry] of this.pending) {
      if (entry.logicalSessionId === logicalSessionId && (!turnId || entry.turnId === turnId)) {
        this.finish(id, { action: "cancel" }, "cancelled");
      }
    }
  }
}
