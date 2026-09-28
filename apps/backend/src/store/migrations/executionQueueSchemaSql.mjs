// Schema text is ordered by migrations/index.mjs; execution remains owned by CorptieStore.
export const executionQueueSchemaSql = `      CREATE TABLE IF NOT EXISTS agent_operations (
        task_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('user', 'collaboration')),
        priority INTEGER NOT NULL,
        text TEXT NOT NULL,
        source_json TEXT NOT NULL DEFAULT '{}',
        local_visibility TEXT NOT NULL DEFAULT 'normal'
          CHECK (local_visibility IN ('normal', 'status_only')),
        status TEXT NOT NULL DEFAULT 'queued'
          CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
        delivery_id TEXT,
        channel_delivery_id TEXT,
        target_turn_id TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE,
        FOREIGN KEY (delivery_id) REFERENCES collaboration_deliveries(delivery_id) ON DELETE CASCADE,
        FOREIGN KEY (channel_delivery_id) REFERENCES session_collaboration_deliveries(delivery_id) ON DELETE CASCADE,
        UNIQUE (delivery_id),
        UNIQUE (channel_delivery_id)
      );

      CREATE INDEX IF NOT EXISTS idx_agent_operations_next
      ON agent_operations(agent_id, status, priority DESC, created_at ASC);

      CREATE INDEX IF NOT EXISTS idx_agent_operations_session_turn
      ON agent_operations(session_id, target_turn_id);

      CREATE INDEX IF NOT EXISTS idx_agent_operations_session_next
      ON agent_operations(session_id, status, priority DESC, created_at ASC);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_operations_one_running_per_session
      ON agent_operations(session_id) WHERE status = 'running';

      CREATE TABLE IF NOT EXISTS scheduled_session_tasks (
        task_id TEXT PRIMARY KEY,
        logical_session_id TEXT NOT NULL,
        message_json TEXT NOT NULL,
        schedule_type TEXT NOT NULL
          CHECK (schedule_type IN ('once', 'interval', 'condition', 'process')),
        run_at TEXT,
        next_run_at TEXT,
        interval_seconds INTEGER,
        timezone TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'paused', 'completed', 'failed', 'cancelled')),
        missed_policy TEXT NOT NULL DEFAULT 'coalesce_once'
          CHECK (missed_policy IN ('coalesce_once', 'skip')),
        condition_spec_json TEXT,
        condition_state_json TEXT,
        process_spec_json TEXT,
        process_state_json TEXT,
        creator_type TEXT NOT NULL,
        creator_id TEXT NOT NULL,
        work_id TEXT,
        environment TEXT NOT NULL,
        pending_scheduled_for TEXT,
        lease_owner TEXT,
        lease_expires_at TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 5,
        last_run_id TEXT,
        last_run_status TEXT,
        last_error_code TEXT,
        last_error_message TEXT,
        last_run_at TEXT,
        resource_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        paused_at TEXT,
        cancelled_at TEXT,
        completed_at TEXT,
        FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_scheduled_session_tasks_due
      ON scheduled_session_tasks(environment, status, next_run_at, lease_expires_at);

      CREATE INDEX IF NOT EXISTS idx_scheduled_session_tasks_session
      ON scheduled_session_tasks(logical_session_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS scheduled_session_runs (
        run_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        run_key TEXT NOT NULL UNIQUE,
        scheduled_for TEXT NOT NULL,
        trigger_kind TEXT NOT NULL,
        trigger_reason TEXT NOT NULL,
        status TEXT NOT NULL
          CHECK (status IN ('missed', 'claimed', 'retry_wait', 'queued', 'running', 'completed', 'failed', 'cancelled', 'skipped')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        agent_task_id TEXT,
        target_turn_id TEXT,
        binding_id TEXT,
        provider_session_id TEXT,
        routing_version INTEGER,
        exit_status_json TEXT,
        condition_result_json TEXT,
        error_code TEXT,
        error_message TEXT,
        claimed_at TEXT,
        queued_at TEXT,
        started_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES scheduled_session_tasks(task_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_scheduled_session_runs_task
      ON scheduled_session_runs(task_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_scheduled_session_runs_task
      ON scheduled_session_runs(agent_task_id) WHERE agent_task_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS scheduled_session_events (
        event_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        run_id TEXT,
        sequence INTEGER NOT NULL,
        type TEXT NOT NULL,
        actor_type TEXT,
        actor_id TEXT,
        payload_json TEXT NOT NULL DEFAULT '{}',
        environment TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES scheduled_session_tasks(task_id) ON DELETE CASCADE,
        FOREIGN KEY (run_id) REFERENCES scheduled_session_runs(run_id) ON DELETE SET NULL,
        UNIQUE (task_id, sequence)
      );

      CREATE INDEX IF NOT EXISTS idx_scheduled_session_events_task
      ON scheduled_session_events(task_id, sequence ASC);

      CREATE TABLE IF NOT EXISTS collaboration_events (
        event_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        type TEXT NOT NULL,
        actor_agent_id TEXT,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES collaboration_requests(task_id) ON DELETE CASCADE,
        FOREIGN KEY (actor_agent_id) REFERENCES agents(agent_id) ON DELETE RESTRICT,
        UNIQUE (task_id, sequence)
      );

      CREATE INDEX IF NOT EXISTS idx_collaboration_events_task
      ON collaboration_events(task_id, sequence ASC);

`;
