import { inferSessionKind } from "../utils/sessionKinds.mjs";
import { parseJson } from "./storedJson.mjs";

export function sessionProjectionSelectSQL() {
  return `SELECT sessions.*,
    projection_logical.logical_session_id AS projection_logical_session_id,
    projection_logical.session_name AS projection_session_name,
    projection_logical.transition_state AS projection_transition_state,
    projection_logical.routing_version AS projection_routing_version,
    projection_logical.active_workspace_id AS projection_active_workspace_id,
    projection_logical.repository_id AS projection_repository_id,
    projection_binding.binding_id AS projection_binding_id,
    projection_binding.provider_id AS projection_provider_id,
    projection_binding.provider_session_id AS projection_provider_session_id,
    projection_binding.provider_thread_id AS projection_provider_thread_id,
    projection_binding.bound_cwd AS projection_bound_cwd,
    projection_binding.worktree_id AS projection_worktree_id,
    projection_binding.routing_version AS projection_binding_routing_version,
    (SELECT bindings.agent_id FROM agent_sessions bindings
     WHERE bindings.session_id = sessions.id AND bindings.unbound_at IS NULL
     LIMIT 1) AS projection_binding_agent_id,
    CASE
      WHEN EXISTS (
        SELECT 1 FROM session_turns turns
        WHERE turns.session_id = sessions.id AND turns.execution_status = 'blocked'
      ) THEN 'blocked'
      WHEN EXISTS (
        SELECT 1 FROM session_turns turns
        WHERE turns.session_id = sessions.id AND turns.execution_status = 'running'
      ) THEN 'running'
      WHEN EXISTS (
        SELECT 1 FROM session_turns turns WHERE turns.session_id = sessions.id
      ) THEN (
        SELECT turns.execution_status FROM session_turns turns
        WHERE turns.session_id = sessions.id
        ORDER BY turns.updated_at DESC, turns.rowid DESC
        LIMIT 1
      )
      WHEN sessions.status = 'complete' THEN 'completed'
      ELSE sessions.status
    END AS projection_execution_status,
    (SELECT deliveries.status FROM message_deliveries deliveries
     WHERE deliveries.session_id = sessions.id
     ORDER BY deliveries.created_at DESC, deliveries.delivery_id DESC
     LIMIT 1) AS projection_delivery_status,
    (SELECT cursors.connection_status
     FROM logical_sessions logical
     JOIN provider_thread_bindings bindings
       ON bindings.provider_thread_id = logical.active_thread_id
     LEFT JOIN provider_binding_cursors cursors
       ON cursors.binding_id = bindings.binding_id
     WHERE logical.legacy_session_id = sessions.id
     LIMIT 1) AS projection_provider_connection_status,
    (SELECT tasks.lifecycle_state FROM tasks
     WHERE tasks.id = sessions.task_id
     LIMIT 1) AS projection_task_status,
    (SELECT tasks.title FROM tasks
     WHERE tasks.id = sessions.task_id
     LIMIT 1) AS projection_task_title,
    (SELECT tasks.archived FROM tasks
     WHERE tasks.id = sessions.task_id
     LIMIT 1) AS projection_task_archived,
    (SELECT works.name FROM works
     WHERE works.id = sessions.work_id
     LIMIT 1) AS projection_work_name,
    (SELECT cursors.sync_health
     FROM logical_sessions logical
     JOIN provider_thread_bindings bindings
       ON bindings.provider_thread_id = logical.active_thread_id
     LEFT JOIN provider_binding_cursors cursors
       ON cursors.binding_id = bindings.binding_id
     WHERE logical.legacy_session_id = sessions.id
     LIMIT 1) AS projection_sync_health
    FROM sessions
    LEFT JOIN logical_sessions projection_logical
      ON projection_logical.legacy_session_id = sessions.id
    LEFT JOIN provider_thread_bindings projection_binding
      ON projection_binding.provider_thread_id = projection_logical.active_thread_id
     AND projection_binding.logical_session_id = projection_logical.logical_session_id
     AND projection_binding.state = 'active'`;
}

export function sessionPresentationTitle(row) {
  const kind = inferSessionKind({
    sessionKind: row.session_kind,
    workId: row.work_id,
    taskId: row.task_id
  });
  if (kind === "worker") {
    const taskTitle = String(row.projection_task_title ?? "").trim();
    if (taskTitle) return taskTitle;
  }
  if (kind === "workChat") {
    const workName = String(row.projection_work_name ?? "").trim();
    if (workName) return `${workName} · 讨论`;
  }
  return String(row.projection_session_name ?? row.title ?? row.id).trim();
}

export function effectiveSessionArchivedSQL() {
  return `CASE
    WHEN sessions.archived = 1 THEN 1
    WHEN sessions.session_kind = 'worker' AND EXISTS (
      SELECT 1 FROM tasks archive_task
      WHERE archive_task.id = sessions.task_id
        AND (archive_task.lifecycle_state = 'done' OR archive_task.archived = 1)
    ) THEN 1
    ELSE 0
  END`;
}

export function normalizedExecutionStatus(value) {
  return value === "complete" ? "completed" : value;
}

export function normalizedProviderConnectionStatus(value) {
  const normalized = String(value ?? "").toLowerCase();
  if (normalized.includes("reconnect") || normalized.includes("connect")) {
    return normalized.includes("disconnect") ? "disconnected" : "connected";
  }
  return "disconnected";
}

export function parseActiveChoicePrompt(value) {
  const parsed = parseJson(value, null);
  if (!parsed || parsed.status !== "active" || !Array.isArray(parsed.options) || parsed.options.length < 2) {
    return null;
  }
  return parsed;
}

export function capabilitiesForStoredProvider(provider = "", status = "") {
  if (provider === "codex-app-server") {
    return {
      canSend: status !== "failed",
      canSwitchModel: true,
      canSwitchReasoning: true,
      canInterrupt: status === "running",
      canReconnect: false
    };
  }
  if (provider === "claude-sdk") {
    return {
      canSend: status !== "failed",
      canSwitchModel: true,
      canSwitchReasoning: false,
      canInterrupt: false,
      canReconnect: true
    };
  }
  return null;
}

export function normalizedStoredProviderCapabilities(provider = "", status = "", persisted = null) {
  const fallback = capabilitiesForStoredProvider(provider, status);
  if (provider === "claude-sdk") return {
    ...fallback,
    // A failed Turn is not a failed Session. Respect the current execution
    // projection, including an explicit denial for a broken Provider binding.
    ...(typeof persisted?.canSend === "boolean" ? { canSend: persisted.canSend } : {}),
    // Interrupt availability comes from the execution projection. The legacy
    // fallback must not hide an active Turn (or override an explicit denial).
    ...(typeof persisted?.canInterrupt === "boolean" ? { canInterrupt: persisted.canInterrupt } : {})
  };
  if (provider === "codex-app-server") {
    return {
      ...fallback,
      ...(persisted && typeof persisted === "object" ? persisted : {}),
      // Older Codex projections persisted this as false before reasoning
      // switching was implemented. Provider capability is authoritative; do
      // not let that compatibility snapshot permanently lock configuration.
      canSwitchReasoning: true
    };
  }
  return persisted ?? fallback;
}

export function modelFromArgs(args = []) {
  for (let index = 0; index < args.length; index += 1) {
    if ((args[index] === "-m" || args[index] === "--model") && args[index + 1]) {
      return args[index + 1];
    }
  }
  return null;
}

export function reasoningFromArgs(args = []) {
  for (let index = 0; index < args.length; index += 1) {
    if ((args[index] === "-c" || args[index] === "--config") && args[index + 1]) {
      const match = String(args[index + 1]).match(/^model_reasoning_effort\s*=\s*["']?([^"']+)["']?$/);
      if (match?.[1]) {
        return match[1];
      }
    }
  }
  return null;
}
