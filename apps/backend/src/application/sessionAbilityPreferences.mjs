// User preferences only: never grants capabilities or changes Role assignments.
export class SessionAbilityPreferences {
  constructor({ store, registry }) {
    this.store = store;
    this.registry = registry;
  }

  resolve(reference) {
    const logical = this.store.getLogicalSession(reference)
      ?? this.store.getLogicalSessionByLegacySessionId(reference);
    if (!logical) throw failure("SESSION_NOT_FOUND", "Session not found.", 404);
    const session = this.store.getSession(logical.legacySessionId);
    if (!session) throw failure("SESSION_NOT_FOUND", "Session projection not found.", 404);
    return { logical, session };
  }

  preferences(reference) {
    const { logical } = this.resolve(reference);
    const row = this.store.selectOne(
      "SELECT * FROM session_ability_preferences WHERE logical_session_id = ?", [logical.logicalSessionId]);
    return { logicalSessionId: logical.logicalSessionId,
      disabledSkillIds: row ? JSON.parse(row.disabled_skills_json) : [],
      disabledMcpServerIds: row ? JSON.parse(row.disabled_mcps_json) : [],
      resourceVersion: row?.resource_version ?? 0 };
  }

  isDisabled(reference, kind, id) {
    if (!reference) return false;
    const value = this.preferences(reference);
    return (kind === "skill" ? value.disabledSkillIds : value.disabledMcpServerIds).includes(id);
  }

  assertEnabled(reference, kind, id) {
    if (this.isDisabled(reference, kind, id)) {
      throw failure("SESSION_CAPABILITY_DISABLED", "This capability is disabled in this Session.", 403);
    }
  }

  inspect(reference) {
    const { session } = this.resolve(reference);
    const value = this.preferences(reference);
    const skills = (this.store.listRegistrySkillsForAgent(session.agentId) ?? []).map(skill => ({
      id: skill.skillId, name: skill.manifestName || skill.name, kind: "skill",
      disabled: value.disabledSkillIds.includes(skill.skillId), available: true
    }));
    const mcps = this.registry.listForAgent(session.agentId).map(id => this.registry.get(id)).filter(Boolean)
      .map(server => ({ id: server.serverId, name: server.name, kind: "mcp",
        disabled: value.disabledMcpServerIds.includes(server.serverId), available: server.enabled === true }));
    return { ...value, roleId: session.agentId, abilities: [...skills, ...mcps],
      application: { enforcement: "server", provider: "next_turn", historyRetracted: false,
        nativeSkillDirectoryIsolation: "unsupported" } };
  }

  update(reference, input) {
    const allowed = ["expectedResourceVersion", "requestId", "kind", "id", "disabled", "reset"];
    if (!input || Object.keys(input).some(key => !allowed.includes(key))
      || !Number.isSafeInteger(input.expectedResourceVersion) || input.expectedResourceVersion < 0
      || typeof input.requestId !== "string" || !input.requestId.trim() || input.requestId.length > 200
      || (input.reset === true ? ["kind", "id", "disabled"].some(key => key in input)
        : ("reset" in input || !["skill", "mcp"].includes(input.kind)
          || typeof input.id !== "string" || typeof input.disabled !== "boolean"))) {
      throw failure("INVALID_INPUT", "Expected a versioned ability toggle or reset request.", 400);
    }
    const { logical } = this.resolve(reference);
    const sessionId = logical.logicalSessionId;
    const normalized = JSON.stringify([input.expectedResourceVersion, input.reset === true,
      input.kind ?? null, input.id ?? null, input.disabled ?? null]);
    return this.store.runInTransaction(() => {
      const replay = this.store.selectOne(
        "SELECT input_json, receipt_json FROM session_ability_preference_receipts WHERE logical_session_id = ? AND request_id = ?",
        [sessionId, input.requestId]);
      if (replay) {
        if (replay.input_json !== normalized) throw failure("IDEMPOTENCY_CONFLICT", "Request ID reused with different input.", 409);
        return { ...JSON.parse(replay.receipt_json), idempotentReplay: true };
      }
      const current = this.inspect(reference);
      if (current.resourceVersion !== input.expectedResourceVersion) {
        throw failure("RESOURCE_VERSION_CONFLICT", "Session ability preferences changed. Reload and retry.", 409);
      }
      if (!input.reset && !current.abilities.some(item => item.kind === input.kind && item.id === input.id)) {
        throw failure("CAPABILITY_NOT_ASSIGNED", "Capability is not assigned to this Session's Role.", 403);
      }
      const skills = new Set(input.reset ? [] : current.disabledSkillIds);
      const mcps = new Set(input.reset ? [] : current.disabledMcpServerIds);
      if (!input.reset) {
        const values = input.kind === "skill" ? skills : mcps;
        if (input.disabled) values.add(input.id); else values.delete(input.id);
      }
      const now = new Date().toISOString();
      this.store.db.run(`INSERT INTO session_ability_preferences
        (logical_session_id, disabled_skills_json, disabled_mcps_json, resource_version, updated_at)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(logical_session_id) DO UPDATE SET
        disabled_skills_json=excluded.disabled_skills_json, disabled_mcps_json=excluded.disabled_mcps_json,
        resource_version=excluded.resource_version, updated_at=excluded.updated_at`,
      [sessionId, JSON.stringify([...skills].sort()), JSON.stringify([...mcps].sort()), current.resourceVersion + 1, now]);
      const receipt = { preferences: this.inspect(reference), requestId: input.requestId,
        idempotentReplay: false, previousResourceVersion: current.resourceVersion, updatedAt: now };
      this.store.db.run(`INSERT INTO session_ability_preference_receipts
        (logical_session_id, request_id, input_json, receipt_json, created_at) VALUES (?, ?, ?, ?, ?)`,
      [sessionId, input.requestId, normalized, JSON.stringify(receipt), now]);
      this.store.scheduleSave();
      return receipt;
    });
  }
}

function failure(code, message, statusCode) {
  return Object.assign(new Error(message), { code, statusCode });
}
