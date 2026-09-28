// The Store owns the connection, including replacements during data-root moves.
// No connection is opened or closed by this repository.
export class FeishuRepository {
  constructor({ getDatabase, selectAll, selectOne, scheduleSave }) {
    this.getDatabase = getDatabase;
    this.selectAll = selectAll;
    this.selectOne = selectOne;
    this.scheduleSave = scheduleSave;
  }

  get db() {
    return this.getDatabase();
  }

  listFeishuBots() {
    return this.selectAll("SELECT * FROM feishu_bots ORDER BY created_at ASC").map(feishuBotFromRow);
  }

  getFeishuBot(id) {
    const row = this.selectOne("SELECT * FROM feishu_bots WHERE id = ?", [id]);
    return row ? feishuBotFromRow(row) : null;
  }

  createFeishuBot(bot) {
    const createdAt = bot.createdAt || new Date().toISOString();
    this.db.run(
      `INSERT INTO feishu_bots (
        id, name, profile, app_id, brand, managed_profile, transport_type, enabled, connection_status, last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        bot.id,
        bot.name,
        bot.profile,
        bot.appId || null,
        bot.brand || "feishu",
        bot.managedProfile ? 1 : 0,
        bot.transportType || "lark-cli",
        bot.enabled ? 1 : 0,
        bot.enabled ? "connecting" : "disabled",
        null,
        createdAt,
        createdAt
      ]
    );
    this.scheduleSave();
    return this.getFeishuBot(bot.id);
  }

  updateFeishuBot(id, patch = {}) {
    const current = this.getFeishuBot(id);
    if (!current) {
      return null;
    }
    const next = {
      ...current,
      name: typeof patch.name === "string" && patch.name.trim() ? patch.name.trim() : current.name,
      profile: typeof patch.profile === "string" && patch.profile.trim() ? patch.profile.trim() : current.profile,
      enabled: typeof patch.enabled === "boolean" ? patch.enabled : current.enabled,
      transportType: patch.transportType || current.transportType,
      connectionStatus: patch.connectionStatus || current.connectionStatus,
      lastError: Object.hasOwn(patch, "lastError") ? patch.lastError : current.lastError,
      remoteName: Object.hasOwn(patch, "remoteName") ? patch.remoteName : current.remoteName,
      remoteAvatarURL: Object.hasOwn(patch, "remoteAvatarURL") ? patch.remoteAvatarURL : current.remoteAvatarURL,
      remoteOpenId: Object.hasOwn(patch, "remoteOpenId") ? patch.remoteOpenId : current.remoteOpenId,
      remoteActivateStatus: Object.hasOwn(patch, "remoteActivateStatus") ? patch.remoteActivateStatus : current.remoteActivateStatus,
      updatedAt: new Date().toISOString()
    };
    this.db.run(
      `UPDATE feishu_bots SET
        name = ?, profile = ?, transport_type = ?, enabled = ?, connection_status = ?, last_error = ?,
        remote_name = ?, remote_avatar_url = ?, remote_open_id = ?, remote_activate_status = ?, updated_at = ?
       WHERE id = ?`,
      [
        next.name,
        next.profile,
        next.transportType,
        next.enabled ? 1 : 0,
        next.connectionStatus,
        next.lastError,
        next.remoteName,
        next.remoteAvatarURL,
        next.remoteOpenId,
        next.remoteActivateStatus != null && Number.isFinite(Number(next.remoteActivateStatus))
          ? Number(next.remoteActivateStatus)
          : null,
        next.updatedAt,
        id
      ]
    );
    this.scheduleSave();
    return this.getFeishuBot(id);
  }

  deleteFeishuBot(id) {
    this.db.run("DELETE FROM feishu_session_assignments WHERE bot_id = ?", [id]);
    this.db.run("DELETE FROM feishu_pairing_codes WHERE bot_id = ?", [id]);
    this.db.run("DELETE FROM feishu_bindings WHERE bot_id = ?", [id]);
    this.db.run("DELETE FROM feishu_bots WHERE id = ?", [id]);
    this.scheduleSave();
  }

  replaceFeishuPairingCode(code) {
    this.db.run("DELETE FROM feishu_pairing_codes WHERE bot_id = ? AND consumed_at IS NULL", [code.botId]);
    this.db.run(
      `INSERT INTO feishu_pairing_codes (
        id, bot_id, code_hash, expires_at, consumed_at, created_at
      ) VALUES (?, ?, ?, ?, NULL, ?)`,
      [code.id, code.botId, code.codeHash, code.expiresAt, code.createdAt]
    );
    this.scheduleSave();
  }

  consumeFeishuPairingCode(codeHash, binding) {
    const code = this.selectOne(
      `SELECT * FROM feishu_pairing_codes
       WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
      [codeHash, new Date().toISOString()]
    );
    if (!code || code.bot_id !== binding.botId) {
      return null;
    }
    const verifiedAt = new Date().toISOString();
    this.db.run("BEGIN TRANSACTION");
    try {
      this.db.run(
        `INSERT INTO feishu_bindings (id, bot_id, open_id, chat_id, tenant_key, verified_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(bot_id, open_id) DO UPDATE SET
           chat_id = excluded.chat_id,
           tenant_key = excluded.tenant_key,
           verified_at = excluded.verified_at,
           revoked_at = NULL`,
        [binding.id, binding.botId, binding.openId, binding.chatId || null, binding.tenantKey || null, verifiedAt]
      );
      this.db.run("UPDATE feishu_pairing_codes SET consumed_at = ? WHERE id = ?", [verifiedAt, code.id]);
      this.db.run("COMMIT");
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    }
    this.scheduleSave();
    return this.getFeishuBinding(binding.botId, binding.openId);
  }

  getFeishuBinding(botId, openId) {
    const row = this.selectOne(
      "SELECT * FROM feishu_bindings WHERE bot_id = ? AND open_id = ? AND revoked_at IS NULL",
      [botId, openId]
    );
    return row ? feishuBindingFromRow(row) : null;
  }

  listFeishuBindings(botId) {
    return this.selectAll(
      "SELECT * FROM feishu_bindings WHERE bot_id = ? AND revoked_at IS NULL ORDER BY verified_at ASC",
      [botId]
    ).map(feishuBindingFromRow);
  }

  updateFeishuBindingChat(id, chatId) {
    this.db.run("UPDATE feishu_bindings SET chat_id = ? WHERE id = ?", [chatId, id]);
    this.scheduleSave();
  }

  claimFeishuInboundEvent(botId, eventId) {
    if (!eventId) {
      return true;
    }
    if (this.selectOne("SELECT event_id FROM feishu_inbound_events WHERE event_id = ?", [eventId])) {
      return false;
    }
    this.db.run(
      "INSERT INTO feishu_inbound_events (event_id, bot_id, received_at) VALUES (?, ?, ?)",
      [eventId, botId, new Date().toISOString()]
    );
    this.db.run(
      `DELETE FROM feishu_inbound_events
       WHERE received_at < ?`,
      [new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()]
    );
    this.scheduleSave();
    return true;
  }

  revokeFeishuBinding(id) {
    const revokedAt = new Date().toISOString();
    this.db.run("DELETE FROM feishu_session_assignments WHERE binding_id = ?", [id]);
    this.db.run("UPDATE feishu_bindings SET revoked_at = ? WHERE id = ?", [revokedAt, id]);
    this.scheduleSave();
  }

  getFeishuAssignmentForBot(botId) {
    const row = this.selectOne("SELECT * FROM feishu_session_assignments WHERE bot_id = ?", [botId]);
    return row ? feishuAssignmentFromRow(row) : null;
  }

  getFeishuAssignmentForSession(sessionId) {
    const row = this.selectOne("SELECT * FROM feishu_session_assignments WHERE session_id = ?", [sessionId]);
    return row ? feishuAssignmentFromRow(row) : null;
  }

  listFeishuAssignments() {
    return this.selectAll("SELECT * FROM feishu_session_assignments ORDER BY assigned_at ASC").map(feishuAssignmentFromRow);
  }

  initializeFeishuDelivery(assignmentId, seedItemIds = []) {
    const visibleIds = [...new Set(seedItemIds.filter(Boolean))];
    const assignment = this.selectOne(
      "SELECT delivery_initialized FROM feishu_session_assignments WHERE id = ?", [assignmentId]
    );
    if (!assignment) return new Set();
    if (!assignment.delivery_initialized) {
      this.db.run("BEGIN TRANSACTION");
      try {
        const now = new Date().toISOString();
        for (const itemId of visibleIds) {
          this.db.run(
            "INSERT OR IGNORE INTO feishu_delivered_items (assignment_id, item_id, delivered_at) VALUES (?, ?, ?)",
            [assignmentId, itemId, now]
          );
        }
        this.db.run("UPDATE feishu_session_assignments SET delivery_initialized = 1 WHERE id = ?", [assignmentId]);
        this.db.run("COMMIT");
      } catch (error) {
        this.db.run("ROLLBACK");
        throw error;
      }
      this.scheduleSave();
    }
    if (!visibleIds.length) return new Set();
    return new Set(this.selectAll(
      `SELECT item_id FROM feishu_delivered_items WHERE assignment_id = ? AND item_id IN (${visibleIds.map(() => "?").join(",")})`,
      [assignmentId, ...visibleIds]
    ).map((row) => row.item_id));
  }

  markFeishuItemDelivered(assignmentId, itemId) {
    this.db.run(
      "INSERT OR IGNORE INTO feishu_delivered_items (assignment_id, item_id, delivered_at) VALUES (?, ?, ?)",
      [assignmentId, itemId, new Date().toISOString()]
    );
    this.scheduleSave();
  }

  assignFeishuSession(assignment) {
    const occupied = this.getFeishuAssignmentForSession(assignment.sessionId);
    if (occupied && occupied.botId !== assignment.botId) {
      const error = new Error("Session is already assigned to another Feishu bot.");
      error.code = "FEISHU_SESSION_OCCUPIED";
      error.assignment = occupied;
      throw error;
    }
    this.db.run("BEGIN TRANSACTION");
    try {
      this.db.run("DELETE FROM feishu_session_assignments WHERE bot_id = ?", [assignment.botId]);
      this.db.run(
        `INSERT INTO feishu_session_assignments (
          id, bot_id, binding_id, session_id, assigned_at, last_event_sequence
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        [assignment.id, assignment.botId, assignment.bindingId, assignment.sessionId, assignment.assignedAt, Number(assignment.lastEventSequence) || 0]
      );
      this.db.run("COMMIT");
    } catch (error) {
      this.db.run("ROLLBACK");
      if (/UNIQUE constraint failed: feishu_session_assignments\.session_id/.test(error.message)) {
        error.code = "FEISHU_SESSION_OCCUPIED";
      }
      throw error;
    }
    this.scheduleSave();
    return this.getFeishuAssignmentForBot(assignment.botId);
  }

  releaseFeishuSession(botId) {
    this.db.run("DELETE FROM feishu_session_assignments WHERE bot_id = ?", [botId]);
    this.scheduleSave();
  }

  updateFeishuAssignmentCursor(botId, sequence) {
    this.db.run(
      `UPDATE feishu_session_assignments
       SET last_event_sequence = MAX(last_event_sequence, ?)
       WHERE bot_id = ?`,
      [Number(sequence) || 0, botId]
    );
    this.scheduleSave();
  }
}

function feishuBotFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    profile: row.profile,
    appId: row.app_id || null,
    brand: row.brand || "feishu",
    managedProfile: Boolean(row.managed_profile),
    remoteName: row.remote_name || null,
    remoteAvatarURL: row.remote_avatar_url || null,
    remoteOpenId: row.remote_open_id || null,
    remoteActivateStatus: row.remote_activate_status == null ? null : Number(row.remote_activate_status),
    transportType: row.transport_type,
    enabled: Boolean(row.enabled),
    connectionStatus: row.connection_status,
    lastError: row.last_error || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function feishuBindingFromRow(row) {
  return {
    id: row.id,
    botId: row.bot_id,
    openId: row.open_id,
    chatId: row.chat_id || null,
    tenantKey: row.tenant_key || null,
    verifiedAt: row.verified_at,
    revokedAt: row.revoked_at || null
  };
}

function feishuAssignmentFromRow(row) {
  return {
    id: row.id,
    botId: row.bot_id,
    bindingId: row.binding_id,
    sessionId: row.session_id,
    assignedAt: row.assigned_at,
    lastEventSequence: Number(row.last_event_sequence ?? 0),
    deliveryInitialized: Boolean(row.delivery_initialized)
  };
}
