import { normalizeSessionTitle } from "../../utils/sessionTitles.mjs";

export function migrateCanonicalSessionNames({ selectAll, db }) {
  const rows = selectAll(
    `SELECT ls.logical_session_id, ls.legacy_session_id, ls.title, ls.session_name,
            s.title AS legacy_title
     FROM logical_sessions ls
     LEFT JOIN sessions s ON s.id = ls.legacy_session_id
     ORDER BY ls.created_at ASC, ls.logical_session_id ASC`
  );
  const used = new Set();
  for (const row of rows) {
    const base = String(row.session_name || row.legacy_title || row.title || "Agent").trim() || "Agent";
    let sessionName = base;
    let suffix = 1;
    while (used.has(normalizeSessionTitle(sessionName))) {
      sessionName = `${base} ${suffix}`;
      suffix += 1;
    }
    const sessionNameKey = normalizeSessionTitle(sessionName);
    used.add(sessionNameKey);
    db.run(
      `UPDATE logical_sessions
       SET session_name = ?, session_name_key = ?, title = ?
       WHERE logical_session_id = ?
         AND (session_name IS NOT ? OR session_name_key IS NOT ? OR title IS NOT ?)`,
      [sessionName, sessionNameKey, sessionName, row.logical_session_id,
        sessionName, sessionNameKey, sessionName]
    );
    if (row.legacy_session_id) {
      db.run(
        "UPDATE sessions SET title = ? WHERE id = ? AND title IS NOT ?",
        [sessionName, row.legacy_session_id, sessionName]
      );
    }
  }
  // Session names are replaceable labels, not durable routes. Stable IDs
  // supersede the legacy alias table, so old names must stop resolving.
  db.run("DELETE FROM session_name_aliases");
}

export function migrateCollaborationSessionIdentities({ db }) {
  for (const table of ["collaboration_requests", "collaboration_request_confirmations"]) {
    db.run(
      `UPDATE ${table}
       SET initiator_session_id = COALESCE(initiator_session_id, (
             SELECT MIN(ls.logical_session_id)
             FROM agent_sessions binding
             JOIN logical_sessions ls
               ON ls.legacy_session_id = binding.session_id
                  OR ls.logical_session_id = binding.session_id
             WHERE binding.agent_id = ${table}.initiator_agent_id
             HAVING COUNT(DISTINCT ls.logical_session_id) = 1
           )),
           recipient_session_id = COALESCE(recipient_session_id, (
             SELECT MIN(ls.logical_session_id)
             FROM agent_sessions binding
             JOIN logical_sessions ls
               ON ls.legacy_session_id = binding.session_id
                  OR ls.logical_session_id = binding.session_id
             WHERE binding.agent_id = ${table}.recipient_agent_id
             HAVING COUNT(DISTINCT ls.logical_session_id) = 1
           ))`
    );
    db.run(
      `UPDATE ${table}
       SET initiator_name_at_send = COALESCE(initiator_name_at_send, (
             SELECT ls.session_name FROM logical_sessions ls
             WHERE ls.logical_session_id = initiator_session_id
           )),
           recipient_name_at_send = COALESCE(recipient_name_at_send, (
             SELECT ls.session_name FROM logical_sessions ls
             WHERE ls.logical_session_id = recipient_session_id
           ))`
    );
    if (table === "collaboration_requests") {
      db.run(
        `UPDATE collaboration_requests
         SET route_status = 'unresolved'
         WHERE initiator_session_id IS NULL OR recipient_session_id IS NULL`
      );
    }
  }
}

export function migrateSessionProviderBindings({ db }) {
  db.run(
    `UPDATE provider_thread_bindings
     SET binding_id = COALESCE(binding_id, 'binding:' || lower(hex(randomblob(16)))),
         provider_session_id = COALESCE(provider_session_id, provider_thread_id),
         provider_id = COALESCE(
           provider_id,
           (
             SELECT sessions.provider
             FROM logical_sessions
             JOIN sessions ON sessions.id = logical_sessions.legacy_session_id
             WHERE logical_sessions.logical_session_id = provider_thread_bindings.logical_session_id
           ),
           'codex-app-server'
         ),
         provider_metadata_json = COALESCE(provider_metadata_json, '{}')
     WHERE binding_id IS NULL
        OR provider_session_id IS NULL
        OR provider_id IS NULL
        OR provider_metadata_json IS NULL`
  );
  db.run(
    `UPDATE provider_thread_bindings
     SET parent_binding_id = (
       SELECT parent.binding_id
       FROM provider_thread_bindings AS parent
       WHERE parent.provider_thread_id = provider_thread_bindings.parent_thread_id
     )
     WHERE parent_thread_id IS NOT NULL AND parent_binding_id IS NULL`
  );
  db.run(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_thread_bindings_binding_id ON provider_thread_bindings(binding_id)"
  );
  db.run("DROP INDEX IF EXISTS idx_provider_thread_bindings_provider_session");
  db.run(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_thread_bindings_provider_session
     ON provider_thread_bindings(provider_id, provider_session_id) WHERE state = 'active'`
  );
}

export function migrateWorkspaceTransitionsForDirectoryTargets({ selectAll, db }) {
  const columns = selectAll("PRAGMA table_info(workspace_transitions)");
  const targetWorktree = columns.find((column) => column.name === "target_worktree_id");
  const targetCwd = columns.find((column) => column.name === "target_cwd");
  if (targetCwd && Number(targetWorktree?.notnull) === 0) return;

  db.run(`
    PRAGMA foreign_keys = OFF;
    BEGIN IMMEDIATE;
    CREATE TABLE workspace_transitions_next (
      transition_id TEXT PRIMARY KEY,
      logical_session_id TEXT NOT NULL,
      source_thread_id TEXT NOT NULL,
      target_worktree_id TEXT,
      target_cwd TEXT NOT NULL,
      source_routing_version INTEGER NOT NULL,
      last_completed_turn_id TEXT,
      new_thread_id TEXT,
      resume_goal_after_transition INTEGER NOT NULL DEFAULT 0,
      phase TEXT NOT NULL CHECK (phase IN (
        'waitingForTurn', 'preflighting', 'forking', 'validatingInstructions',
        'committingRoute', 'committed', 'failed'
      )),
      strategy TEXT NOT NULL DEFAULT 'fork'
        CHECK (strategy IN ('fork', 'handoff', 'settingsUpdate')),
      error_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (logical_session_id) REFERENCES logical_sessions(logical_session_id) ON DELETE CASCADE,
      FOREIGN KEY (source_thread_id) REFERENCES provider_thread_bindings(provider_thread_id) ON DELETE RESTRICT,
      FOREIGN KEY (target_worktree_id) REFERENCES git_worktrees(worktree_id) ON DELETE RESTRICT
    );
    INSERT INTO workspace_transitions_next (
      transition_id, logical_session_id, source_thread_id, target_worktree_id, target_cwd,
      source_routing_version, last_completed_turn_id, new_thread_id,
      resume_goal_after_transition, phase, strategy,
      error_json, created_at, updated_at
    )
    SELECT transition_id, logical_session_id, source_thread_id, target_worktree_id,
           COALESCE(
             (SELECT canonical_path FROM git_worktrees WHERE worktree_id = target_worktree_id),
             (SELECT path FROM git_worktrees WHERE worktree_id = target_worktree_id),
             (SELECT bound_cwd FROM provider_thread_bindings WHERE provider_thread_id = source_thread_id)
           ),
           source_routing_version, last_completed_turn_id, new_thread_id, 0, phase, strategy,
           error_json, created_at, updated_at
    FROM workspace_transitions;
    DROP TABLE workspace_transitions;
    ALTER TABLE workspace_transitions_next RENAME TO workspace_transitions;
    CREATE INDEX idx_workspace_transitions_session
    ON workspace_transitions(logical_session_id, created_at DESC);
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}
