import { randomUUID } from "node:crypto";
import { requiredText } from "../validation.mjs";
import { parseJson } from "../storedJson.mjs";

export class WorkspaceTransitionRepository {
  constructor({ getDatabase, toRawStatus, getLogicalSession, assertLogicalWorkSessionBinding, selectOne, scheduleSave, getProviderThreadBinding, getSessionToolCatalogMaterialization, insertAppliedSessionToolCatalogMaterialization, assertLogicalSessionRoute, selectAll }) {
    this.getDatabase = getDatabase;
    this.toRawStatus = toRawStatus;
    this.getLogicalSession = getLogicalSession;
    this.assertLogicalWorkSessionBinding = assertLogicalWorkSessionBinding;
    this.selectOne = selectOne;
    this.scheduleSave = scheduleSave;
    this.getProviderThreadBinding = getProviderThreadBinding;
    this.getSessionToolCatalogMaterialization = getSessionToolCatalogMaterialization;
    this.insertAppliedSessionToolCatalogMaterialization = insertAppliedSessionToolCatalogMaterialization;
    this.assertLogicalSessionRoute = assertLogicalSessionRoute;
    this.selectAll = selectAll;
  }

  get db() {
    return this.getDatabase();
  }

  beginWorkspaceTransition(input) {
    const transitionId = requiredText(input?.transitionId, "transitionId");
    const logicalSessionId = requiredText(input?.logicalSessionId, "logicalSessionId");
    const transitionKind = input.transitionKind === "provider" ? "provider" : "workspace";
    const targetWorktreeId = typeof input?.targetWorktreeId === "string"
      && input.targetWorktreeId.trim()
      ? input.targetWorktreeId.trim()
      : null;
    let targetCwd = typeof input?.targetCwd === "string" && input.targetCwd.trim()
      ? input.targetCwd.trim()
      : null;
    const timestamp = input.createdAt || new Date().toISOString();
    const logicalSession = this.getLogicalSession(logicalSessionId);
    if (!logicalSession?.activeBinding) {
      throw new Error(`Logical session ${logicalSessionId} has no active binding.`);
    }
    this.assertLogicalWorkSessionBinding(logicalSessionId);
    const sourceRoutingVersion = Number(input.sourceRoutingVersion);
    if (sourceRoutingVersion !== logicalSession.routingVersion) {
      throw new Error(`Logical session routing version changed from ${sourceRoutingVersion} to ${logicalSession.routingVersion}.`);
    }
    if (transitionKind === "workspace") {
      if (targetWorktreeId) {
        const target = this.selectOne(
          "SELECT availability, path, canonical_path FROM git_worktrees WHERE worktree_id = ?",
          [targetWorktreeId]
        );
        if (!target || target.availability !== "available") {
          throw new Error(`Target worktree ${targetWorktreeId} is not available.`);
        }
        targetCwd ??= target.canonical_path || target.path;
        if (targetCwd !== (target.canonical_path || target.path)) {
          throw new Error("The target cwd does not match the target worktree.");
        }
      }
      targetCwd = requiredText(targetCwd, "targetCwd");
    } else {
      if (typeof input.targetProviderId !== "string" || !input.targetProviderId.trim()) {
        throw new Error("targetProviderId is required for a Provider transition.");
      }
      // A Provider switch does not move the workspace; reuse the active binding's cwd
      // so the non-null target_cwd constraint stays satisfied without workspace semantics.
      targetCwd = targetCwd ?? logicalSession.activeBinding.boundCwd;
      if (!targetCwd) {
        throw new Error(`Logical session ${logicalSessionId} has no bound cwd for the Provider transition.`);
      }
    }
    const unfinished = this.selectOne(
      `SELECT transition_id FROM workspace_transitions
       WHERE logical_session_id = ? AND phase NOT IN ('committed', 'failed')`,
      [logicalSessionId]
    );
    if (unfinished) {
      throw new Error(`Logical session ${logicalSessionId} already has transition ${unfinished.transition_id}.`);
    }
    this.db.run("BEGIN IMMEDIATE");
    try {
      this.db.run(
        `INSERT INTO workspace_transitions (
          transition_id, logical_session_id, source_thread_id, target_worktree_id, target_cwd,
          transition_kind, target_provider_id, source_routing_version, last_completed_turn_id, resume_goal_after_transition,
          continuation_prompt, continuation_state, phase, strategy,
          error_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        [
          transitionId,
          logicalSessionId,
          logicalSession.activeThreadId,
          targetWorktreeId,
          targetCwd,
          transitionKind,
          transitionKind === "provider" ? input.targetProviderId.trim() : null,
          sourceRoutingVersion,
          input.lastCompletedTurnId || null,
          input.resumeGoalAfterTransition ? 1 : 0,
          input.continuationPrompt || null,
          input.continuationPrompt ? "pending" : "none",
          input.phase || "waitingForTurn",
          input.strategy || "fork",
          timestamp,
          timestamp
        ]
      );
      this.db.run(
        `UPDATE logical_sessions SET transition_state = ?, updated_at = ?
         WHERE logical_session_id = ?`,
        [input.phase || "waitingForTurn", timestamp, logicalSessionId]
      );
      this.db.run(
        `UPDATE sessions SET archive_dependency_version = archive_dependency_version + 1
         WHERE id = (SELECT legacy_session_id FROM logical_sessions WHERE logical_session_id = ?)`,
        [logicalSessionId]
      );
      this.db.run("COMMIT");
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    }
    this.scheduleSave();
    return this.getWorkspaceTransition(transitionId);
  }

  updateWorkspaceTransition(transitionId, update = {}) {
    const allowedPhases = new Set([
      "waitingForTurn", "preflighting", "forking", "validatingInstructions",
      "committingRoute", "committed", "failed"
    ]);
    if (!allowedPhases.has(update.phase)) {
      throw new Error(`Unsupported workspace transition phase: ${update.phase}`);
    }
    const allowedStrategies = new Set(["fork", "handoff", "settingsUpdate"]);
    if (update.strategy !== undefined && !allowedStrategies.has(update.strategy)) {
      throw new Error(`Unsupported workspace transition strategy: ${update.strategy}`);
    }
    const transition = this.getWorkspaceTransition(transitionId);
    if (!transition) throw new Error(`Workspace transition ${transitionId} was not found.`);
    const timestamp = update.updatedAt || new Date().toISOString();
    this.db.run("BEGIN IMMEDIATE");
    try {
      this.db.run(
        `UPDATE workspace_transitions
         SET phase = ?, strategy = ?, last_completed_turn_id = ?, new_thread_id = ?, handoff_turn_id = ?,
             tool_confirmation_json = ?,
             error_json = ?,
             continuation_state = CASE
               WHEN ? = 'failed' AND continuation_state = 'pending' THEN 'failed'
               ELSE continuation_state
             END,
             continuation_error = CASE
               WHEN ? = 'failed' AND continuation_state = 'pending' THEN ?
               ELSE continuation_error
             END,
             updated_at = ?
         WHERE transition_id = ?`,
        [
          update.phase,
          update.strategy ?? transition.strategy,
          update.lastCompletedTurnId ?? transition.lastCompletedTurnId,
          update.newThreadId ?? transition.newThreadId,
          update.handoffTurnId ?? transition.handoffTurnId,
          Object.hasOwn(update, "toolConfirmation")
            ? (update.toolConfirmation == null ? null : JSON.stringify(update.toolConfirmation))
            : (transition.toolConfirmation == null ? null : JSON.stringify(transition.toolConfirmation)),
          update.error === undefined ? (transition.error ? JSON.stringify(transition.error) : null) : JSON.stringify(update.error),
          update.phase,
          update.phase,
          update.error?.message ?? null,
          timestamp,
          transitionId
        ]
      );
      this.db.run(
        `UPDATE logical_sessions SET transition_state = ?, updated_at = ?
         WHERE logical_session_id = ?`,
        [["committed", "failed"].includes(update.phase) ? null : update.phase, timestamp, transition.logicalSessionId]
      );
      this.db.run(
        `UPDATE sessions SET archive_dependency_version = archive_dependency_version + 1
         WHERE id = (SELECT legacy_session_id FROM logical_sessions WHERE logical_session_id = ?)`,
        [transition.logicalSessionId]
      );
      this.db.run("COMMIT");
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    }
    this.scheduleSave();
    return this.getWorkspaceTransition(transitionId);
  }

  commitWorkspaceTransition(transitionId, binding) {
    const transition = this.getWorkspaceTransition(transitionId);
    if (!transition) throw new Error(`Workspace transition ${transitionId} was not found.`);
    if (transition.phase === "failed") throw new Error(`Workspace transition ${transitionId} has failed.`);
    if (transition.phase === "committed") {
      const current = this.getLogicalSession(transition.logicalSessionId);
      if (current?.activeThreadId === transition.newThreadId) return current;
      throw new Error(`Committed workspace transition ${transitionId} has an inconsistent route.`);
    }
    const newThreadId = requiredText(binding?.providerThreadId, "providerThreadId");
    const sourceBinding = this.getProviderThreadBinding(transition.sourceThreadId);
    const providerId = requiredText(binding?.providerId ?? sourceBinding?.providerId ?? "codex-app-server", "providerId");
    const providerSessionId = requiredText(binding?.providerSessionId ?? newThreadId, "providerSessionId");
    const bindingId = requiredText(binding?.bindingId ?? `binding:${randomUUID()}`, "bindingId");
    const isProviderSwitch = transition.transitionKind === "provider";
    const boundCwd = isProviderSwitch
      ? (binding?.boundCwd || sourceBinding?.boundCwd || transition.targetCwd)
      : requiredText(binding?.boundCwd, "boundCwd");
    const target = transition.targetWorktreeId
      ? this.selectOne(
        "SELECT * FROM git_worktrees WHERE worktree_id = ?",
        [transition.targetWorktreeId]
      )
      : null;
    if (!isProviderSwitch) {
      if (transition.targetWorktreeId && (!target || target.availability !== "available")) {
        throw new Error(`Target worktree ${transition.targetWorktreeId} is not available.`);
      }
      if (boundCwd !== transition.targetCwd
        || (target && boundCwd !== (target.canonical_path || target.path))) {
        throw new Error("The new thread cwd does not match the transition target.");
      }
    }
    const timestamp = binding.createdAt || new Date().toISOString();
    this.db.run("BEGIN IMMEDIATE");
    try {
      this.assertLogicalWorkSessionBinding(transition.logicalSessionId);
      const logical = this.selectOne(
        "SELECT * FROM logical_sessions WHERE logical_session_id = ?",
        [transition.logicalSessionId]
      );
      if (!logical
        || logical.active_thread_id !== transition.sourceThreadId
        || Number(logical.routing_version) !== transition.sourceRoutingVersion) {
        throw new Error("The logical session route changed before the workspace transition committed.");
      }
      const sourceToolMaterialization = sourceBinding?.bindingId
        ? this.getSessionToolCatalogMaterialization(transition.logicalSessionId, sourceBinding.bindingId)
        : null;
      this.db.run(
        `UPDATE provider_thread_bindings SET state = 'superseded', updated_at = ?
         WHERE provider_thread_id = ? AND state = 'active'`,
        [timestamp, transition.sourceThreadId]
      );
      this.db.run(
        `INSERT INTO provider_thread_bindings (
          provider_thread_id, binding_id, provider_id, provider_session_id,
          logical_session_id, worktree_id, bound_cwd,
          parent_thread_id, parent_binding_id, forked_at_turn_id, instruction_sources_json,
          permission_snapshot_json, provider_metadata_json,
          routing_version, binding_generation, capability_revision, state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        [
          newThreadId,
          bindingId,
          providerId,
          providerSessionId,
          transition.logicalSessionId,
          isProviderSwitch ? (sourceBinding?.worktreeId ?? null) : transition.targetWorktreeId,
          boundCwd,
          transition.sourceThreadId,
          sourceBinding?.bindingId ?? null,
          binding.forkedAtTurnId || transition.lastCompletedTurnId,
          JSON.stringify(binding.instructionSources ?? []),
          JSON.stringify(binding.permissionSnapshot ?? {}),
          JSON.stringify(binding.providerMetadata ?? {}),
          Number(logical.routing_version) + 1,
          Number(sourceBinding?.bindingGeneration ?? 1) + 1,
          binding.capabilityRevision ?? sourceBinding?.capabilityRevision ?? "legacy:unknown",
          timestamp,
          timestamp
        ]
      );
      this.insertAppliedSessionToolCatalogMaterialization(binding.toolMaterialization, {
        required: providerId === "codex-app-server" || Boolean(sourceToolMaterialization),
        logicalSessionId: transition.logicalSessionId,
        providerBindingId: bindingId,
        providerId,
        providerSessionId,
        providerConfirmation: transition.toolConfirmation ?? null,
        sourceDesiredDomains: sourceToolMaterialization?.desiredDomains ?? [],
        sourceAppliedDomains: sourceToolMaterialization?.appliedDomains ?? [],
        createdAt: timestamp
      });
      this.db.run(
        `INSERT INTO provider_thread_lineage (
          child_thread_id, parent_thread_id, logical_session_id, transition_id, created_at
        ) VALUES (?, ?, ?, ?, ?)`,
        [
          newThreadId,
          transition.sourceThreadId,
          transition.logicalSessionId,
          transitionId,
          timestamp
        ]
      );
      this.db.run(
        `UPDATE logical_sessions
         SET active_thread_id = ?, active_workspace_id = ?, repository_id = ?,
             routing_version = routing_version + 1, transition_state = NULL, updated_at = ?
         WHERE logical_session_id = ?`,
        [
          newThreadId,
          isProviderSwitch ? logical.active_workspace_id : transition.targetWorktreeId,
          isProviderSwitch ? logical.repository_id : (target?.repository_id ?? null),
          timestamp,
          transition.logicalSessionId
        ]
      );
      if (!isProviderSwitch) {
        this.db.run(
          `UPDATE sessions SET cwd = ?, updated_at = ?
           WHERE id = (SELECT legacy_session_id FROM logical_sessions WHERE logical_session_id = ?)`,
          [boundCwd, timestamp, transition.logicalSessionId]
        );
      } else {
        const targetSession = binding.sessionProjection ?? {};
        const targetExternal = targetSession.external ?? {};
        const routedTargetSession = {
          ...targetSession,
          provider: providerId,
          command: targetSession.command ?? targetExternal.source ?? providerId,
          args: targetSession.args ?? targetExternal.args ?? [],
          external: {
            ...targetExternal,
            provider: providerId,
            threadId: newThreadId,
            sessionId: providerSessionId,
            logicalSessionId: transition.logicalSessionId,
            routingVersion: Number(logical.routing_version) + 1
          }
        };
        const targetStatus = targetSession.status ?? null;
        const targetProgress = Number.isFinite(targetSession.progress) ? targetSession.progress : null;
        const targetSummary = targetSession.summary ?? null;
        this.db.run(
          `UPDATE sessions
           SET provider = ?, command = ?, args_json = ?, cwd = COALESCE(?, cwd),
               status = COALESCE(?, status), progress = COALESCE(?, progress),
               summary = COALESCE(?, summary), raw_json = ?, updated_at = ?
           WHERE id = (SELECT legacy_session_id FROM logical_sessions WHERE logical_session_id = ?)`,
          [
            providerId,
            routedTargetSession.command,
            JSON.stringify(routedTargetSession.args),
            targetExternal.cwd ?? boundCwd ?? null,
            targetStatus,
            targetProgress,
            targetSummary,
            JSON.stringify(this.toRawStatus(routedTargetSession)),
            timestamp,
            transition.logicalSessionId
          ]
        );
      }
      this.db.run(
        `UPDATE workspace_transitions
         SET new_thread_id = ?, phase = 'committed', error_json = NULL, updated_at = ?
         WHERE transition_id = ?`,
        [newThreadId, timestamp, transitionId]
      );
      this.assertLogicalSessionRoute(transition.logicalSessionId);
      this.assertLogicalWorkSessionBinding(transition.logicalSessionId);
      this.db.run("COMMIT");
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    }
    this.scheduleSave();
    return this.getLogicalSession(transition.logicalSessionId);
  }

  getWorkspaceTransition(transitionId) {
    const row = this.selectOne(
      "SELECT * FROM workspace_transitions WHERE transition_id = ?",
      [transitionId]
    );
    return row ? workspaceTransitionFromRow(row) : null;
  }

  getPendingWorkspaceTransition(logicalSessionId) {
    const row = this.selectOne(
      `SELECT * FROM workspace_transitions
       WHERE logical_session_id = ? AND phase NOT IN ('committed', 'failed')
       ORDER BY created_at DESC LIMIT 1`,
      [logicalSessionId]
    );
    return row ? workspaceTransitionFromRow(row) : null;
  }

  getLatestCommittedWorkspaceTransition(logicalSessionId) {
    const row = this.selectOne(
      `SELECT transition.* FROM workspace_transitions transition
       JOIN logical_sessions logical
         ON logical.logical_session_id = transition.logical_session_id
       WHERE transition.logical_session_id = ?
         AND transition.phase = 'committed'
         AND transition.new_thread_id = logical.active_thread_id
         AND transition.source_routing_version + 1 = logical.routing_version
       ORDER BY transition.created_at DESC LIMIT 1`,
      [logicalSessionId]
    );
    return row ? workspaceTransitionFromRow(row) : null;
  }

  listWorkspaceTransitionsAwaitingContinuation() {
    return this.selectAll(
      `SELECT * FROM workspace_transitions
       WHERE phase = 'committed' AND continuation_state IN ('pending', 'queued', 'running', 'failed')
       ORDER BY created_at ASC`
    ).map(workspaceTransitionFromRow);
  }

  updateWorkspaceTransitionContinuation(transitionId, update = {}) {
    const transition = this.getWorkspaceTransition(transitionId);
    if (!transition) throw new Error(`Workspace transition ${transitionId} was not found.`);
    const states = new Set(["none", "pending", "queued", "running", "completed", "failed"]);
    const state = update.state ?? transition.continuationState;
    if (!states.has(state)) throw new Error(`Unsupported workspace continuation state: ${state}`);
    const timestamp = update.updatedAt || new Date().toISOString();
    this.db.run(
      `UPDATE workspace_transitions
       SET continuation_state = ?, continuation_turn_id = ?, continuation_error = ?, updated_at = ?
       WHERE transition_id = ?`,
      [
        state,
        Object.hasOwn(update, "turnId") ? update.turnId : transition.continuationTurnId,
        Object.hasOwn(update, "error") ? update.error : transition.continuationError,
        timestamp,
        transitionId
      ]
    );
    this.scheduleSave();
    return this.getWorkspaceTransition(transitionId);
  }

  listPendingWorkspaceTransitions() {
    return this.selectAll(
      `SELECT * FROM workspace_transitions
       WHERE phase NOT IN ('committed', 'failed')
       ORDER BY created_at ASC`
    ).map(workspaceTransitionFromRow);
  }
}

function workspaceTransitionFromRow(row) {
  return {
    transitionId: row.transition_id,
    logicalSessionId: row.logical_session_id,
    sourceThreadId: row.source_thread_id,
    targetWorktreeId: row.target_worktree_id,
    targetCwd: row.target_cwd,
    transitionKind: row.transition_kind || "workspace",
    targetProviderId: row.target_provider_id || null,
    sourceRoutingVersion: Number(row.source_routing_version),
    lastCompletedTurnId: row.last_completed_turn_id,
    newThreadId: row.new_thread_id,
    resumeGoalAfterTransition: Boolean(row.resume_goal_after_transition),
    continuationPrompt: row.continuation_prompt || null,
    continuationState: row.continuation_state || "none",
    continuationTurnId: row.continuation_turn_id || null,
    handoffTurnId: row.handoff_turn_id || null,
    toolConfirmation: parseJson(row.tool_confirmation_json, null),
    continuationError: row.continuation_error || null,
    phase: row.phase,
    strategy: row.strategy,
    error: parseJson(row.error_json, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
