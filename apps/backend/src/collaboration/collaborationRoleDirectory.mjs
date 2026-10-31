import { legacyAgentToRole, roleToLegacyAgentWire } from "../store/repositories/roleRepository.mjs";
import { agentFromRow as legacyAgentFromRow } from "./collaborationRecordProjection.mjs";
import { requiredId, requiredText, optionalText, stringList, domainError } from "./collaborationValidation.mjs";

// Agent resources and their Session bindings share the product Store. Channel
// invalidation participates in the same transaction when a Session is detached.
export class CollaborationRoleDirectory {
  constructor({ store, clock, idFactory, requireAgent, transaction, stableSessionIdentity, invalidateChannelsForSession }) {
    Object.assign(this, { store, clock, idFactory, requireAgent, transaction, stableSessionIdentity, invalidateChannelsForSession });
  }

  requireRole(id) { return legacyAgentToRole(this.requireAgent(id)); }

  registerRole(input) {
    const agentId = requiredId(input.roleId, "roleId");
    const name = requiredText(input.name, "name");
    const timestamp = this.clock();
    const existing = this.getRole(agentId);
    this.store.db.run(
      `INSERT INTO agents (
        agent_id, name, description, status, capabilities_json, current_session_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        status = excluded.status,
        capabilities_json = excluded.capabilities_json,
        updated_at = excluded.updated_at`,
      [
        agentId,
        name,
        optionalText(input.description) ?? "",
        "available",
        JSON.stringify(stringList(input.capabilities)),
        existing?.createdAt ?? timestamp,
        timestamp
      ]
    );
    this.store.scheduleSave();
    return this.getRole(agentId);
  }

  getRole(agentId) {
    const row = this.store.selectOne("SELECT * FROM agents WHERE agent_id = ?", [agentId]);
    return row ? roleFromRow(row, this.store) : null;
  }

  getRoleForSession(sessionId) {
    const logical = this.store.getLogicalSession(sessionId)
      ?? this.store.getLogicalSessionByLegacySessionId(sessionId);
    const row = this.store.selectOne(
      `SELECT a.* FROM agents a
       JOIN agent_sessions s ON s.agent_id = a.agent_id
       WHERE s.session_id IN (?, ?) AND s.unbound_at IS NULL
       ORDER BY s.bound_at DESC LIMIT 1`,
      [sessionId, logical?.legacySessionId ?? sessionId]
    );
    return row ? roleFromRow(row, this.store, logical) : null;
  }

  resolveRoleBySessionName(sessionName) {
    const logical = this.store.getLogicalSessionByName(sessionName);
    if (!logical) return null;
    const row = this.store.selectOne(
      `SELECT a.* FROM agents a
       JOIN agent_sessions binding ON binding.agent_id = a.agent_id
       WHERE binding.unbound_at IS NULL
         AND binding.session_id IN (?, ?)
       ORDER BY binding.bound_at DESC LIMIT 1`,
      [logical.logicalSessionId, logical.legacySessionId]
    );
    return row ? roleFromRow(row, this.store, logical) : null;
  }

  listRoles(options = {}) {
    const agents = this.store.selectAll("SELECT * FROM agents ORDER BY name ASC")
      .map((row) => roleFromRow(row, this.store));
    return options.status ? agents.filter((agent) => agent.status === options.status) : agents;
  }

  bindRoleSession(input) {
    const agent = this.requireRole(input.roleId);
    const sessionId = requiredId(input.sessionId, "sessionId");
    const timestamp = this.clock();
    this.transaction(() => {
      const other = this.store.selectOne(
        "SELECT agent_id FROM agent_sessions WHERE session_id = ? AND unbound_at IS NULL",
        [sessionId]
      );
      if (other && other.agent_id !== agent.roleId) {
        throw domainError("SESSION_ALREADY_BOUND", `Session ${sessionId} is already bound to agent ${other.agent_id}.`);
      }
      const current = this.store.selectOne(
        "SELECT binding_id FROM agent_sessions WHERE agent_id = ? AND session_id = ? AND unbound_at IS NULL",
        [agent.roleId, sessionId]
      );
      if (!current) {
        this.store.db.run(
          "INSERT INTO agent_sessions (binding_id, agent_id, session_id, bound_at, unbound_at) VALUES (?, ?, ?, ?, NULL)",
          [this.idFactory(), agent.roleId, sessionId, timestamp]
        );
      }
      this.store.db.run(
        `UPDATE sessions SET
           agent_id = ?,
           session_kind = CASE
             WHEN session_kind = 'legacy' AND work_id IS NULL AND task_id IS NULL THEN 'assistantChat'
             ELSE session_kind
           END,
           updated_at = ?
         WHERE id = ?
           AND (
             agent_id IS NOT ?
             OR (session_kind = 'legacy' AND work_id IS NULL AND task_id IS NULL)
           )`,
        [agent.roleId, timestamp, sessionId, agent.roleId]
      );
      // Re-observing an existing Provider projection must not rotate an Agent's
      // current Session through every historical active binding. Only a newly
      // created binding advances the recency cursor.
      if (!current) {
        this.store.db.run(
          `UPDATE agents SET current_session_id = ?, updated_at = ?
           WHERE agent_id = ? AND current_session_id IS NOT ?`,
          [sessionId, timestamp, agent.roleId, sessionId]
        );
      }
    });
    return this.getRole(agent.roleId);
  }

  unbindRoleSession(agentId) {
    const agent = this.requireRole(agentId);
    if (!agent.currentSessionId) return agent;
    const timestamp = this.clock();
    this.transaction(() => {
      this.store.db.run(
        "UPDATE agent_sessions SET unbound_at = ? WHERE agent_id = ? AND unbound_at IS NULL",
        [timestamp, agent.roleId]
      );
      this.store.db.run(
        "UPDATE agents SET current_session_id = NULL, updated_at = ? WHERE agent_id = ?",
        [timestamp, agent.roleId]
      );
    });
    return this.getRole(agent.roleId);
  }

  detachRoleSession(sessionId) {
    const normalizedSessionId = requiredId(sessionId, "sessionId");
    const stableSessionId = this.stableSessionIdentity(normalizedSessionId);
    const agent = this.store.selectOne(
      `SELECT a.agent_id
       FROM agents a
       LEFT JOIN agent_sessions s
         ON s.agent_id = a.agent_id
        AND s.session_id = ?
        AND s.unbound_at IS NULL
       WHERE a.current_session_id = ? OR s.session_id = ?
       LIMIT 1`,
      [normalizedSessionId, normalizedSessionId, normalizedSessionId]
    );
    if (!agent) return null;

    const timestamp = this.clock();
    this.transaction(() => {
      this.invalidateChannelsForSession(stableSessionId, "session_detached", timestamp);
      this.store.db.run(
        "UPDATE agent_sessions SET unbound_at = ? WHERE session_id = ? AND unbound_at IS NULL",
        [timestamp, normalizedSessionId]
      );
      this.store.db.run(
        `UPDATE agents SET
           current_session_id = (
             SELECT session_id FROM agent_sessions
             WHERE agent_id = ? AND unbound_at IS NULL
             ORDER BY bound_at DESC LIMIT 1
           ),
           updated_at = ?
         WHERE agent_id = ?`,
        [agent.agent_id, timestamp, agent.agent_id]
      );
    });
    this.store.scheduleSave();
    return this.getRole(agent.agent_id);
  }

  detachMissingSessionBindings() {
    const sessionIds = this.store.selectAll(
      `SELECT DISTINCT session_id
       FROM (
         SELECT current_session_id AS session_id
         FROM agents
         WHERE current_session_id IS NOT NULL
         UNION
         SELECT session_id
         FROM agent_sessions
         WHERE unbound_at IS NULL
       )
       WHERE session_id NOT IN (SELECT id FROM sessions)`
    ).map((row) => row.session_id);

    return sessionIds
      .map((sessionId) => this.detachSession(sessionId))
      .filter(Boolean);
  }
  registerAgent(input) { return roleToLegacyAgentWire(this.registerRole({ ...input, roleId: input.agentId })); }
  getAgent(id) { return roleToLegacyAgentWire(this.getRole(id)); }
  getAgentForSession(id) { return roleToLegacyAgentWire(this.getRoleForSession(id)); }
  resolveAgentBySessionName(name) { return roleToLegacyAgentWire(this.resolveRoleBySessionName(name)); }
  listAgents(options) { return this.listRoles(options).map(roleToLegacyAgentWire); }
  bindSession(input) { return roleToLegacyAgentWire(this.bindRoleSession({ ...input, roleId: input.agentId })); }
  unbindSession(id) { return roleToLegacyAgentWire(this.unbindRoleSession(id)); }
  detachSession(id) { return roleToLegacyAgentWire(this.detachRoleSession(id)); }

}

function roleFromRow(...args) { return legacyAgentToRole(legacyAgentFromRow(...args)); }
