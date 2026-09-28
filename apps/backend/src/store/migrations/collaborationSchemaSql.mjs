// Schema text is ordered by migrations/index.mjs; execution remains owned by CorptieStore.
export const collaborationSchemaSql = `      CREATE TABLE IF NOT EXISTS services (
        service_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        owner_agent_id TEXT NOT NULL,
        current_version TEXT,
        status TEXT NOT NULL DEFAULT 'unknown'
          CHECK (status IN ('unknown', 'stopped', 'starting', 'running', 'degraded', 'failed', 'inactive')),
        endpoint TEXT,
        repository_root TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (owner_agent_id) REFERENCES agents(agent_id) ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS service_consumers (
        service_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (service_id, agent_id),
        FOREIGN KEY (service_id) REFERENCES services(service_id) ON DELETE CASCADE,
        FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS collaboration_contexts (
        context_id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS collaboration_requests (
        task_id TEXT PRIMARY KEY,
        context_id TEXT NOT NULL,
        parent_task_id TEXT,
        protocol_version TEXT NOT NULL DEFAULT '3.0',
        source_work_id TEXT,
        target_work_id TEXT,
        source_task_id TEXT,
        target_task_id TEXT,
        initiator_agent_id TEXT NOT NULL,
        recipient_agent_id TEXT NOT NULL,
        service_id TEXT,
        type TEXT NOT NULL CHECK (type IN ('question', 'change_request')),
        status TEXT NOT NULL DEFAULT 'proposed'
          CHECK (status IN ('proposed', 'needs_information', 'accepted', 'working', 'delivered', 'verifying', 'revision_requested', 'completed', 'rejected', 'canceled', 'escalated')),
        iteration INTEGER NOT NULL DEFAULT 1 CHECK (iteration >= 1),
        max_iterations INTEGER NOT NULL DEFAULT 3 CHECK (max_iterations >= 1),
        title TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
        idempotency_key TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        FOREIGN KEY (context_id) REFERENCES collaboration_contexts(context_id) ON DELETE RESTRICT,
        FOREIGN KEY (parent_task_id) REFERENCES collaboration_requests(task_id) ON DELETE SET NULL,
        FOREIGN KEY (source_work_id) REFERENCES works(id) ON DELETE RESTRICT,
        FOREIGN KEY (target_work_id) REFERENCES works(id) ON DELETE RESTRICT,
        FOREIGN KEY (source_task_id) REFERENCES tasks(id) ON DELETE RESTRICT,
        FOREIGN KEY (target_task_id) REFERENCES tasks(id) ON DELETE RESTRICT,
        FOREIGN KEY (initiator_agent_id) REFERENCES agents(agent_id) ON DELETE RESTRICT,
        FOREIGN KEY (recipient_agent_id) REFERENCES agents(agent_id) ON DELETE RESTRICT,
        FOREIGN KEY (service_id) REFERENCES services(service_id) ON DELETE RESTRICT,
        UNIQUE (initiator_agent_id, idempotency_key)
      );

      CREATE INDEX IF NOT EXISTS idx_collaboration_requests_inbox
      ON collaboration_requests(recipient_agent_id, status, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_collaboration_requests_outbox
      ON collaboration_requests(initiator_agent_id, status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS collaboration_request_confirmations (
        confirmation_id TEXT PRIMARY KEY,
        initiator_agent_id TEXT NOT NULL,
        recipient_agent_id TEXT NOT NULL,
        source_session_id TEXT,
        source_turn_id TEXT,
        request_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'confirmed', 'rejected')),
        task_id TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        FOREIGN KEY (initiator_agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE,
        FOREIGN KEY (recipient_agent_id) REFERENCES agents(agent_id) ON DELETE RESTRICT,
        FOREIGN KEY (task_id) REFERENCES collaboration_requests(task_id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_collaboration_request_confirmations_session
      ON collaboration_request_confirmations(source_session_id, created_at ASC);

      CREATE TABLE IF NOT EXISTS collaboration_participants (
        task_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('initiator', 'recipient')),
        created_at TEXT NOT NULL,
        PRIMARY KEY (task_id, agent_id),
        FOREIGN KEY (task_id) REFERENCES collaboration_requests(task_id) ON DELETE CASCADE,
        FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS collaboration_messages (
        message_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        protocol_version TEXT NOT NULL DEFAULT '3.0',
        source_work_id TEXT,
        target_work_id TEXT,
        source_task_id TEXT,
        target_task_id TEXT,
        sender_agent_id TEXT NOT NULL,
        recipient_agent_id TEXT NOT NULL,
        message_type TEXT NOT NULL
          CHECK (message_type IN ('question', 'change_request', 'needs_information', 'update_ready', 'verification_result')),
        body TEXT NOT NULL,
        evidence_json TEXT NOT NULL DEFAULT '[]',
        payload_json TEXT NOT NULL DEFAULT '{}',
        error_json TEXT,
        resource_version TEXT,
        idempotency_key TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES collaboration_requests(task_id) ON DELETE CASCADE,
        FOREIGN KEY (source_work_id) REFERENCES works(id) ON DELETE RESTRICT,
        FOREIGN KEY (target_work_id) REFERENCES works(id) ON DELETE RESTRICT,
        FOREIGN KEY (source_task_id) REFERENCES tasks(id) ON DELETE RESTRICT,
        FOREIGN KEY (target_task_id) REFERENCES tasks(id) ON DELETE RESTRICT,
        FOREIGN KEY (sender_agent_id) REFERENCES agents(agent_id) ON DELETE RESTRICT,
        FOREIGN KEY (recipient_agent_id) REFERENCES agents(agent_id) ON DELETE RESTRICT,
        UNIQUE (sender_agent_id, idempotency_key)
      );

      CREATE INDEX IF NOT EXISTS idx_collaboration_messages_task
      ON collaboration_messages(task_id, created_at ASC);

      CREATE TABLE IF NOT EXISTS collaboration_artifacts (
        artifact_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        producer_agent_id TEXT NOT NULL,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        uri TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES collaboration_requests(task_id) ON DELETE CASCADE,
        FOREIGN KEY (producer_agent_id) REFERENCES agents(agent_id) ON DELETE RESTRICT
      );

      CREATE INDEX IF NOT EXISTS idx_collaboration_artifacts_task
      ON collaboration_artifacts(task_id, created_at ASC);

      CREATE TABLE IF NOT EXISTS collaboration_deliveries (
        delivery_id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        recipient_agent_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'queued', 'delivering', 'delivered', 'failed')),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        next_attempt_at TEXT,
        delivered_at TEXT,
        target_turn_id TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (message_id) REFERENCES collaboration_messages(message_id) ON DELETE CASCADE,
        FOREIGN KEY (recipient_agent_id) REFERENCES agents(agent_id) ON DELETE RESTRICT,
        UNIQUE (message_id, recipient_agent_id)
      );

      CREATE INDEX IF NOT EXISTS idx_collaboration_deliveries_pending
      ON collaboration_deliveries(status, next_attempt_at, created_at ASC);

      CREATE TABLE IF NOT EXISTS collaboration_channels (
        channel_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL UNIQUE,
        initiator_agent_id TEXT NOT NULL,
        recipient_agent_id TEXT NOT NULL,
        initiator_session_id TEXT NOT NULL,
        recipient_session_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'invalid', 'closed')),
        established_delivery_id TEXT NOT NULL,
        last_delivery_id TEXT NOT NULL,
        invalidated_reason TEXT,
        established_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        invalidated_at TEXT,
        closed_at TEXT,
        FOREIGN KEY (task_id) REFERENCES collaboration_requests(task_id) ON DELETE CASCADE,
        FOREIGN KEY (initiator_agent_id) REFERENCES agents(agent_id) ON DELETE RESTRICT,
        FOREIGN KEY (recipient_agent_id) REFERENCES agents(agent_id) ON DELETE RESTRICT,
        FOREIGN KEY (established_delivery_id) REFERENCES collaboration_deliveries(delivery_id) ON DELETE RESTRICT,
        FOREIGN KEY (last_delivery_id) REFERENCES collaboration_deliveries(delivery_id) ON DELETE RESTRICT
      );

      CREATE INDEX IF NOT EXISTS idx_collaboration_channels_sessions
      ON collaboration_channels(status, initiator_session_id, recipient_session_id);

      -- Session collaboration v4. A Channel is a durable, bidirectional user
      -- authorization between two exact logical Sessions. It is deliberately
      -- independent from Task and from the retired Collaboration Task
      -- lifecycle above.
      CREATE TABLE IF NOT EXISTS session_collaboration_channels (
        channel_id TEXT PRIMARY KEY,
        session_a_id TEXT NOT NULL,
        session_b_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending_authorization'
          CHECK (status IN ('pending_authorization', 'active', 'revoked', 'legacy_unresolved')),
        requested_by_session_id TEXT NOT NULL,
        authorized_at TEXT,
        revoked_at TEXT,
        revocation_reason TEXT,
        resource_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (session_a_id < session_b_id),
        CHECK (requested_by_session_id IN (session_a_id, session_b_id))
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_session_collaboration_channels_pair_active
      ON session_collaboration_channels(session_a_id, session_b_id)
      WHERE status IN ('pending_authorization', 'active');

      CREATE INDEX IF NOT EXISTS idx_session_collaboration_channels_a
      ON session_collaboration_channels(session_a_id, status, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_session_collaboration_channels_b
      ON session_collaboration_channels(session_b_id, status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS session_collaboration_channel_requests (
        request_id TEXT PRIMARY KEY,
        channel_id TEXT,
        requesting_session_id TEXT NOT NULL,
        requested_recipient_session_id TEXT,
        request_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'confirmed', 'rejected', 'failed')),
        idempotency_key TEXT NOT NULL,
        first_message_id TEXT,
        failure_json TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        UNIQUE (requesting_session_id, idempotency_key),
        FOREIGN KEY (channel_id) REFERENCES session_collaboration_channels(channel_id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_session_collaboration_channel_requests_session
      ON session_collaboration_channel_requests(requesting_session_id, status, created_at DESC);

      CREATE TABLE IF NOT EXISTS session_collaboration_channel_authorizations (
        authorization_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        channel_id TEXT,
        requesting_session_id TEXT NOT NULL,
        decision TEXT NOT NULL CHECK (decision IN ('confirmed', 'rejected', 'revoked')),
        evidence_json TEXT NOT NULL DEFAULT '{}',
        decided_at TEXT NOT NULL,
        FOREIGN KEY (request_id) REFERENCES session_collaboration_channel_requests(request_id) ON DELETE RESTRICT,
        FOREIGN KEY (channel_id) REFERENCES session_collaboration_channels(channel_id) ON DELETE RESTRICT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_session_collaboration_channel_authorizations_request_decision
      ON session_collaboration_channel_authorizations(request_id, decision);

      CREATE INDEX IF NOT EXISTS idx_session_collaboration_channel_authorizations_channel
      ON session_collaboration_channel_authorizations(channel_id, decided_at ASC);

      CREATE TRIGGER IF NOT EXISTS session_collaboration_channel_authorizations_immutable_update
      BEFORE UPDATE ON session_collaboration_channel_authorizations
      BEGIN SELECT RAISE(ABORT, 'CHANNEL_AUTHORIZATION_AUDIT_IMMUTABLE'); END;

      CREATE TRIGGER IF NOT EXISTS session_collaboration_channel_authorizations_immutable_delete
      BEFORE DELETE ON session_collaboration_channel_authorizations
      BEGIN SELECT RAISE(ABORT, 'CHANNEL_AUTHORIZATION_AUDIT_IMMUTABLE'); END;

      CREATE TABLE IF NOT EXISTS session_collaboration_messages (
        message_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        sender_session_id TEXT NOT NULL,
        recipient_session_id TEXT NOT NULL,
        message_kind TEXT NOT NULL DEFAULT 'message'
          CHECK (message_kind IN ('message', 'question', 'update')),
        body TEXT NOT NULL,
        in_reply_to_message_id TEXT,
        resource_context_json TEXT NOT NULL DEFAULT '{}',
        idempotency_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (sender_session_id, idempotency_key),
        FOREIGN KEY (channel_id) REFERENCES session_collaboration_channels(channel_id) ON DELETE RESTRICT,
        FOREIGN KEY (in_reply_to_message_id) REFERENCES session_collaboration_messages(message_id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_session_collaboration_messages_channel
      ON session_collaboration_messages(channel_id, created_at ASC, message_id ASC);

      CREATE TABLE IF NOT EXISTS session_collaboration_deliveries (
        delivery_id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL UNIQUE,
        recipient_session_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'queued', 'delivering', 'delivered', 'failed')),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        next_attempt_at TEXT,
        delivered_at TEXT,
        target_turn_id TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (message_id) REFERENCES session_collaboration_messages(message_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_session_collaboration_deliveries_pending
      ON session_collaboration_deliveries(status, next_attempt_at, created_at ASC);

      CREATE TABLE IF NOT EXISTS task_creation_origins (
        task_id TEXT PRIMARY KEY,
        origin_type TEXT NOT NULL
          CHECK (origin_type IN ('direct_user', 'session', 'system', 'legacy_unattributed')),
        creator_session_id TEXT,
        creation_context_task_id TEXT,
        creation_context_message_id TEXT,
        operation_id TEXT,
        created_at TEXT NOT NULL,
        CHECK ((origin_type = 'session' AND creator_session_id IS NOT NULL)
          OR (origin_type <> 'session' AND creator_session_id IS NULL)),
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );

      CREATE TRIGGER IF NOT EXISTS task_creation_origins_immutable_update
      BEFORE UPDATE ON task_creation_origins
      BEGIN SELECT RAISE(ABORT, 'TASK_CREATION_ORIGIN_IMMUTABLE'); END;

      CREATE TRIGGER IF NOT EXISTS task_creation_origins_immutable_delete
      BEFORE DELETE ON task_creation_origins
      WHEN EXISTS (SELECT 1 FROM tasks WHERE id = OLD.task_id)
      BEGIN SELECT RAISE(ABORT, 'TASK_CREATION_ORIGIN_IMMUTABLE'); END;

`;
