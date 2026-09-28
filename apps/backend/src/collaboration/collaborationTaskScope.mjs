import { optionalText, domainError } from "./collaborationValidation.mjs";

// Resolves and validates collaboration resource ownership. Session identity and
// Agent lookup are shared ports, not independent actors or authorization stores.
export class CollaborationTaskScope {
  constructor({ store, stableSessionIdentity, getAgentForSession }) {
    Object.assign(this, { store, stableSessionIdentity, getAgentForSession });
  }

  resolveTaskScope(input, initiator, recipient) {
    const initiatorRoute = this.routeForSession(input.initiatorSessionId);
    const recipientRoute = this.routeForSession(input.recipientSessionId);
    const targetWorkId = recipientRoute?.workId ?? this.#resolveWorkForAgent(
      recipient, optionalText(input.targetWorkId), "targetWorkId"
    );
    const sourceWorkId = initiatorRoute?.workId
      ?? (initiator.agentKind === "platformAssistant" && !input.sourceWorkId
        ? targetWorkId
        : this.#resolveWorkForAgent(initiator, optionalText(input.sourceWorkId), "sourceWorkId"));
    if (input.sourceWorkId && input.sourceWorkId !== sourceWorkId) {
      throw domainError("SOURCE_WORK_SPOOFED", "sourceWorkId is derived from the authenticated source Session.");
    }
    if (input.targetWorkId && input.targetWorkId !== targetWorkId) {
      throw domainError("TARGET_WORK_MISMATCH", "targetWorkId does not match the selected recipient Session.");
    }
    const sourceTaskId = optionalText(input.sourceTaskId);
    if (sourceTaskId) {
      const task = this.store.getTask(sourceTaskId);
      if (!task) throw domainError("TASK_NOT_FOUND", `Task ${sourceTaskId} was not found.`);
      if (task.work_id !== sourceWorkId) {
        throw domainError("TASK_WORK_MISMATCH", "The source Task does not belong to the source Work.");
      }
    }
    return {
      sourceWorkId,
      targetWorkId,
      sourceTaskId,
      routingVersion: recipientRoute?.routingVersion ?? null,
      routeStatus: recipientRoute?.routeStatus ?? "unresolved",
      initiatorBindingId: initiatorRoute?.bindingId ?? null,
      recipientBindingId: recipientRoute?.bindingId ?? null,
      targetTaskId: recipientRoute?.taskId ?? null
    };
  }

  assertSessionParticipants(input, initiator, recipient, options = {}) {
    const initiatorSessionId = optionalText(input.initiatorSessionId);
    const recipientSessionId = optionalText(input.recipientSessionId);
    if (!initiatorSessionId) throw domainError("INITIATOR_SESSION_REQUIRED", "Collaboration requires an explicit source Session.");
    if (options.requireRecipient && !recipientSessionId) {
      throw domainError("RECIPIENT_SESSION_REQUIRED", "A formal collaboration Task cannot be created before its target Session exists.");
    }
    if (recipientSessionId && this.stableSessionIdentity(initiatorSessionId) === this.stableSessionIdentity(recipientSessionId)) {
      throw domainError("DISTINCT_SESSIONS_REQUIRED", "Collaboration requires two explicit, distinct Sessions.");
    }
    if (initiatorSessionId) {
      const sourceAgent = this.getAgentForSession(initiatorSessionId);
      if (sourceAgent?.agentId !== initiator.agentId) {
        throw domainError("INITIATOR_SESSION_AGENT_MISMATCH", "The selected source Session is not bound to initiatorAgentId.");
      }
    }
    if (recipientSessionId) {
      const targetAgent = this.getAgentForSession(recipientSessionId);
      if (targetAgent?.agentId !== recipient.agentId) {
        throw domainError("RECIPIENT_SESSION_AGENT_MISMATCH", "The selected target Session is not bound to recipientAgentId.");
      }
    }
  }

  initialRecipientSessionId(input, recipient) {
    const explicit = optionalText(input.recipientSessionId);
    return explicit ? this.stableSessionIdentity(explicit) : null;
  }

  routeForSession(sessionId) {
    const normalized = optionalText(sessionId);
    if (!normalized) return null;
    const logical = this.store.getLogicalSession(normalized)
      ?? this.store.getLogicalSessionByLegacySessionId(normalized);
    const session = logical?.legacySessionId
      ? this.store.getSession(logical.legacySessionId)
      : this.store.getSession(normalized);
    if (!session) throw domainError("SESSION_NOT_FOUND", `Session ${normalized} was not found.`);
    const binding = logical?.activeBinding ?? null;
    return {
      workId: session.workId ?? null,
      taskId: session.taskId ?? null,
      routingVersion: logical?.routingVersion ?? null,
      bindingId: binding?.bindingId ?? null,
      routeStatus: binding?.state === "active" ? "active" : "unresolved"
    };
  }

  #resolveWorkForAgent(agent, requestedWorkId, field) {
    const session = agent.currentSessionId ? this.store.getSession(agent.currentSessionId) : null;
    const sessionWorkId = session?.workId ?? session?.work_id ?? null;
    const workId = requestedWorkId ?? sessionWorkId;
    if (!workId) return this.ensureCompatibilityWork(agent).id;
    const work = this.store.getWork(workId);
    if (!work) throw domainError("WORK_NOT_FOUND", `${field} ${workId} was not found.`);
    const contributorIds = work.contributorAgentIds ?? work.contributor_agent_ids ?? [];
    const ownsTask = this.store.listTasksByWork(workId)
      .some((task) => task.main_agent_id === agent.agentId);
    if (sessionWorkId !== workId && !contributorIds.includes(agent.agentId) && !ownsTask) {
      throw domainError("WORK_AGENT_NOT_AUTHORIZED", `Agent ${agent.agentId} is not assigned to Work ${workId}.`);
    }
    if (sessionWorkId === workId && this.isAssignableContributor(agent)) {
      this.ensureWorkContributor(workId, agent.agentId);
    }
    return workId;
  }

  isAssignableContributor(agent) {
    return agent.status === "available";
  }

  ensureCompatibilityWork(agent) {
    const id = `work:collaboration:${encodeURIComponent(agent.agentId)}`;
    return this.store.getWork(id) ?? this.store.createWork({
      id,
      name: `${agent.name} collaboration boundary`,
      description: "Compatibility Work created for collaboration from an unscoped legacy Session.",
      status: "active",
      tags: ["system:collaboration-compatibility"],
      contributorAgentIds: this.isAssignableContributor(agent) ? [agent.agentId] : []
    });
  }

  ensureWorkContributor(workId, agentId) {
    const work = this.store.getWork(workId);
    if (!work) throw domainError("WORK_NOT_FOUND", `Work ${workId} was not found.`);
    if (work.contributorAgentIds.includes(agentId)) return work;
    return this.store.updateWork(workId, {
      contributorAgentIds: [...work.contributorAgentIds, agentId]
    });
  }

  validateRequestedTask(taskId, targetWorkId, recipientAgentId) {
    const task = this.store.getTask(taskId);
    if (!task) throw domainError("TASK_NOT_FOUND", `Task ${taskId} was not found.`);
    if (task.work_id !== targetWorkId) {
      throw domainError("TASK_WORK_MISMATCH", "The collaboration Task must belong to the target Work.");
    }
    if (recipientAgentId && task.main_agent_id && task.main_agent_id !== recipientAgentId) {
      throw domainError("TASK_AGENT_MISMATCH", `Task ${taskId} is assigned to another Agent.`);
    }
    if (task.lifecycle_state === "done") {
      throw domainError("TASK_TERMINAL", `Task ${taskId} is already terminal.`);
    }
    return task;
  }

  ensureCollaborationTask(input) {
    if (input.requestedTaskId) {
      const existing = this.validateRequestedTask(
        input.requestedTaskId,
        input.targetWorkId,
        input.recipientAgentId
      );
      if (input.recipientAgentId && !existing.main_agent_id) {
        return this.store.updateTask(existing.id, { mainAgentId: input.recipientAgentId });
      }
      return existing;
    }
    const id = `task:collaboration:${input.taskId}`;
    return this.store.getTask(id) ?? this.store.createTask({
      id,
      workId: input.targetWorkId,
      title: input.title,
      description: input.summary,
      acceptanceCriteria: input.acceptanceCriteria.map((entry) => `- ${entry}`).join("\n"),
      priority: "medium",
      lifecycleState: input.lifecycleState ?? "todo",
      mainAgentId: input.recipientAgentId
    });
  }
}
