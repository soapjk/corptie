// User-owned Session activation. Installation and legacy Role links never activate abilities.
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
    const active = this.store.selectOne(
      "SELECT * FROM session_ability_activations WHERE logical_session_id = ?", [logical.logicalSessionId]);
    const enabledSkillIds = active ? JSON.parse(active.enabled_skills_json) : [];
    const enabledMcpServerIds = active ? JSON.parse(active.enabled_mcps_json) : [];
    return { logicalSessionId: logical.logicalSessionId, enabledSkillIds, enabledMcpServerIds,
      disabledSkillIds: this.store.listRegistrySkills().map(s => s.skillId).filter(id => !enabledSkillIds.includes(id)),
      disabledMcpServerIds: this.registry.list().map(s => s.serverId).filter(id => !enabledMcpServerIds.includes(id)),
      resourceVersion: row?.resource_version ?? 0 };
  }

  isDisabled(reference, kind, id) {
    if (!reference) return true;
    const { logical } = this.resolve(reference);
    const active = this.store.selectOne(
      "SELECT * FROM session_ability_activations WHERE logical_session_id = ?", [logical.logicalSessionId]);
    if (!active) return true;
    const value = { enabledSkillIds: JSON.parse(active.enabled_skills_json),
      enabledMcpServerIds: JSON.parse(active.enabled_mcps_json) };
    return !(kind === "skill" ? value.enabledSkillIds : value.enabledMcpServerIds).includes(id);
  }

  assertEnabled(reference, kind, id) {
    if (this.isDisabled(reference, kind, id)) {
      throw failure("SESSION_CAPABILITY_DISABLED", "This capability is disabled in this Session.", 403);
    }
  }

  inspect(reference) {
    const { session } = this.resolve(reference);
    const value = this.preferences(reference);
    const skills = (this.store.listRegistrySkills() ?? []).map(skill => ({
      id: skill.skillId, name: skill.manifestName || skill.name, kind: "skill",
      disabled: value.disabledSkillIds.includes(skill.skillId), available: true
    }));
    const mcps = this.registry.list()
      .map(server => ({ id: server.serverId, name: server.name, kind: "mcp",
        disabled: value.disabledMcpServerIds.includes(server.serverId), available: server.enabled === true }));
    return { ...value, roleId: session.agentId, abilities: [...skills, ...mcps],
      application: { enforcement: "server", provider: "next_turn", historyRetracted: false,
        nativeSkillDirectoryIsolation: "gateway_only" } };
  }

  activateMentions(reference, mentions = []) {
    // Only called by user message admission; never exposed as an Agent tool.
    const targets = mentions.filter(m => ["skill", "mcp"].includes(m.targetType));
    if (!targets.length) return;
    return this.store.runInTransaction(() => {
      const installed = this.inspect(reference).abilities;
      for (const target of targets) {
        if (!installed.some(a => a.kind === target.targetType && a.id === target.targetId && a.available)) {
          throw failure("CAPABILITY_NOT_AVAILABLE", "Mentioned capability is not installed or available.", 403);
        }
      }
      let changed = false;
      for (const target of targets) {
        if (!this.isDisabled(reference, target.targetType, target.targetId)) continue;
        this.update(reference, { expectedResourceVersion: this.preferences(reference).resourceVersion,
          requestId: `mention:${crypto.randomUUID()}`, kind: target.targetType, id: target.targetId, disabled: false });
        changed = true;
      }
      return changed ? { preferences: this.inspect(reference) } : null;
    });
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
        throw failure("CAPABILITY_NOT_INSTALLED", "Capability is not installed.", 403);
      }
      const skills = new Set(input.reset ? [] : current.enabledSkillIds);
      const mcps = new Set(input.reset ? [] : current.enabledMcpServerIds);
      if (!input.reset) {
        const values = input.kind === "skill" ? skills : mcps;
        if (input.disabled) values.delete(input.id); else values.add(input.id);
      }
      this.store.db.run(`INSERT INTO session_ability_activations
        (logical_session_id, enabled_skills_json, enabled_mcps_json) VALUES (?, ?, ?)
        ON CONFLICT(logical_session_id) DO UPDATE SET enabled_skills_json=excluded.enabled_skills_json,
        enabled_mcps_json=excluded.enabled_mcps_json`,
      [sessionId, JSON.stringify([...skills].sort()), JSON.stringify([...mcps].sort())]);
      const now = new Date().toISOString();
      this.store.db.run(`INSERT INTO session_ability_preferences
        (logical_session_id, disabled_skills_json, disabled_mcps_json, resource_version, updated_at)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(logical_session_id) DO UPDATE SET
        disabled_skills_json=excluded.disabled_skills_json, disabled_mcps_json=excluded.disabled_mcps_json,
        resource_version=excluded.resource_version, updated_at=excluded.updated_at`,
      [sessionId, JSON.stringify(current.abilities.filter(a => a.kind === "skill" && !skills.has(a.id)).map(a => a.id).sort()), JSON.stringify(current.abilities.filter(a => a.kind === "mcp" && !mcps.has(a.id)).map(a => a.id).sort()), current.resourceVersion + 1, now]);
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
