import { randomUUID } from "node:crypto";
import {
  permissionSnapshotFromAppServerResponse,
  validateWorkspaceInstructionSources,
  workspaceTransitionContext
} from "../utils/workspaceTransitionValidation.mjs";

export class CodexWorkspaceTransitionManager {
  constructor(options) {
    this.store = options.store;
    this.codexClient = options.codexClient;
    this.requiredInstructionSources = options.requiredInstructionSources
      ?? (async () => []);
    this.globalInstructionSources = options.globalInstructionSources
      ?? (async () => []);
    this.onRouteCommitted = options.onRouteCommitted ?? null;
  }

  async switchWorkspace(input) {
    const logical = this.store.getLogicalSession(input.logicalSessionId);
    if (!logical?.activeBinding) {
      throw new Error(`Logical session ${input.logicalSessionId} has no active route.`);
    }
    const target = this.requireAvailableTarget(input.targetWorktreeId);
    if (logical.repositoryId && target.repositoryId !== logical.repositoryId) {
      throw new Error("Cross-repository workspace changes require a new thread with an explicit handoff.");
    }
    const activeTurnId = input.activeTurnId || null;
    const lastCompletedTurnId = input.lastCompletedTurnId || null;
    if (!activeTurnId && !lastCompletedTurnId) {
      throw new Error("A completed source turn is required before forking a workspace.");
    }
    const transition = this.store.beginWorkspaceTransition({
      transitionId: input.transitionId || `workspace-transition:${randomUUID()}`,
      logicalSessionId: input.logicalSessionId,
      targetWorktreeId: target.worktreeId,
      sourceRoutingVersion: logical.routingVersion,
      lastCompletedTurnId,
      strategy: "fork",
      phase: activeTurnId ? "waitingForTurn" : "preflighting"
    });
    if (activeTurnId) {
      return {
        status: "waitingForTurn",
        transition,
        activeTurnId
      };
    }
    return this.continueWorkspaceTransition(transition.transitionId, input);
  }

  async continueWorkspaceTransition(transitionId, input = {}) {
    let forkResponse = null;
    let instructionValidation = null;
    const transition = this.store.getWorkspaceTransition(transitionId);
    if (!transition) throw new Error(`Workspace transition ${transitionId} was not found.`);
    if (transition.phase === "committed") {
      return {
        status: "committed",
        transition,
        logicalSession: this.store.getLogicalSession(transition.logicalSessionId)
      };
    }
    if (transition.phase === "failed") {
      throw new Error(`Workspace transition ${transitionId} has already failed.`);
    }
    const logical = this.store.getLogicalSession(transition.logicalSessionId);
    if (!logical?.activeBinding
      || logical.activeThreadId !== transition.sourceThreadId
      || logical.routingVersion !== transition.sourceRoutingVersion) {
      throw new Error("The source workspace route changed before the transition could continue.");
    }
    const lastCompletedTurnId = input.lastCompletedTurnId || transition.lastCompletedTurnId;
    if (!lastCompletedTurnId) {
      throw new Error("The active turn must complete before the workspace transition can continue.");
    }
    const target = this.requireAvailableTarget(transition.targetWorktreeId);
    const targetCwd = target.canonicalPath || target.path;
    try {
      this.store.updateWorkspaceTransition(transitionId, {
        phase: "preflighting",
        lastCompletedTurnId
      });
      const requiredTargetSources = await this.requiredInstructionSources({
        cwd: targetCwd,
        repositoryId: target.repositoryId,
        worktreeId: target.worktreeId
      });
      const globalInstructionSources = await this.globalInstructionSources();
      this.store.updateWorkspaceTransition(transitionId, { phase: "forking" });
      const permission = logical.activeBinding.permissionSnapshot ?? {};
      forkResponse = await this.codexClient.forkThread(transition.sourceThreadId, {
        lastTurnId: lastCompletedTurnId,
        cwd: targetCwd,
        runtimeWorkspaceRoots: [targetCwd],
        approvalPolicy: input.approvalPolicy
          ?? permission.approvalPolicy
          ?? "on-request",
        sandbox: input.sandbox
          ?? coarseSandboxMode(permission.sandboxPolicy)
          ?? "workspace-write",
        permissions: input.permissions,
        dynamicToolAgentId: input.dynamicToolAgentId,
        developerInstructions: input.developerInstructions,
        threadSource: "user",
        excludeTurns: false,
        deferGoalContinuation: true
      });
      const newThreadId = forkResponse?.thread?.id;
      if (!newThreadId) throw new Error("Codex thread/fork returned no thread id.");
      this.store.updateWorkspaceTransition(transitionId, {
        phase: "validatingInstructions",
        newThreadId
      });
      if (forkResponse.cwd !== targetCwd && forkResponse.thread?.cwd !== targetCwd) {
        throw new Error("The forked Codex thread did not bind to the target workspace.");
      }
      instructionValidation = await validateWorkspaceInstructionSources({
        sourceCwd: logical.activeBinding.boundCwd,
        targetCwd,
        instructionSources: forkResponse.instructionSources ?? [],
        requiredTargetSources,
        globalInstructionSources
      });
      if (!instructionValidation.valid) {
        throw new Error("The forked Codex thread loaded invalid workspace instruction sources.");
      }
      if (input.sandboxPolicy) {
        await this.codexClient.updateThreadSettings(newThreadId, {
          cwd: targetCwd,
          approvalPolicy: input.approvalPolicy
            ?? forkResponse.approvalPolicy
            ?? permission.approvalPolicy,
          sandboxPolicy: input.sandboxPolicy
        });
      }
      this.store.updateWorkspaceTransition(transitionId, {
        phase: "committingRoute",
        newThreadId
      });
      const permissionSnapshot = permissionSnapshotFromAppServerResponse(forkResponse);
      if (input.sandboxPolicy) permissionSnapshot.sandboxPolicy = input.sandboxPolicy;
      const switched = this.store.commitWorkspaceTransition(transitionId, {
        providerThreadId: newThreadId,
        boundCwd: targetCwd,
        forkedAtTurnId: lastCompletedTurnId,
        instructionSources: instructionValidation.instructionSources,
        permissionSnapshot
      });
      const event = {
        logicalSessionId: switched.logicalSessionId,
        providerThreadId: switched.activeThreadId,
        worktreeId: switched.activeWorkspaceId,
        repositoryId: switched.repositoryId,
        cwd: targetCwd,
        routingVersion: switched.routingVersion,
        transitionId,
        transitionContext: workspaceTransitionContext({
          sourceCwd: logical.activeBinding.boundCwd,
          targetCwd,
          instructionSources: instructionValidation.instructionSources
        })
      };
      await this.onRouteCommitted?.(event);
      return {
        status: "committed",
        transition: this.store.getWorkspaceTransition(transitionId),
        logicalSession: switched,
        event
      };
    } catch (error) {
      const newThreadId = forkResponse?.thread?.id;
      if (newThreadId) {
        this.store.recordProviderThreadBinding({
          providerThreadId: newThreadId,
          logicalSessionId: transition.logicalSessionId,
          worktreeId: transition.targetWorktreeId,
          boundCwd: target.canonicalPath || target.path,
          parentThreadId: transition.sourceThreadId,
          forkedAtTurnId: lastCompletedTurnId,
          instructionSources: forkResponse.instructionSources ?? [],
          permissionSnapshot: permissionSnapshotFromAppServerResponse(forkResponse),
          state: instructionValidation && !instructionValidation.valid ? "invalid" : "orphaned"
        });
      }
      this.store.updateWorkspaceTransition(transitionId, {
        phase: "failed",
        newThreadId,
        error: {
          message: error.message,
          instructionValidation
        }
      });
      throw error;
    }
  }

  requireAvailableTarget(worktreeId) {
    const target = this.store.getGitWorktree(worktreeId);
    if (!target || target.availability !== "available") {
      throw new Error(`Target worktree ${worktreeId} is not available.`);
    }
    return target;
  }
}

function coarseSandboxMode(sandboxPolicy) {
  const type = typeof sandboxPolicy === "string" ? sandboxPolicy : sandboxPolicy?.type;
  return new Map([
    ["workspaceWrite", "workspace-write"],
    ["workspace-write", "workspace-write"],
    ["readOnly", "read-only"],
    ["read-only", "read-only"],
    ["dangerFullAccess", "danger-full-access"],
    ["danger-full-access", "danger-full-access"]
  ]).get(type);
}
