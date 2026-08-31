import { resolveRecipientSession } from "../application/sessionCollaborationService.mjs";

export function handleCollaborationHttpRequest({
  request,
  response,
  url,
  core,
  sessionCollaborationService,
  sessionChannelService,
  onConfirmationStaged,
  onConfirmationResolved,
  onChannelRequestStaged,
  onChannelRequestResolved,
  onChannelMessageCreated,
  onListWorkspaces,
  onCreateWorktree,
  onSwitchWorkspace,
  onMemoryOperation,
  onSearchMemory,
  onSearchSkills,
  onLoadSkill,
  onReportWorkItemAcceptance
}) {
  const isInternal = url.pathname.startsWith("/internal/collaboration/");
  const isProductApi = url.pathname === "/collaboration/overview"
    || url.pathname.startsWith("/collaboration/channels/")
    || url.pathname.startsWith("/collaboration/channel-requests/")
    || url.pathname.startsWith("/collaboration/tasks/")
    || url.pathname.startsWith("/collaboration/confirmations/")
    || url.pathname === "/collaboration/services"
    || url.pathname.startsWith("/collaboration/services/")
    || url.pathname.startsWith("/collaboration/deliveries/");
  if (!isInternal && !isProductApi) return false;

  Promise.resolve()
    .then(async () => {
      if (isProductApi) {
        return handleProductRequest({ request, response, url, core, sessionChannelService,
          onConfirmationResolved, onChannelRequestResolved, onChannelMessageCreated });
      }
      const actorAgentId = requiredActor(request, core);
      const sessionMetadata = memoryMetadata(request);

      if (request.method === "GET" && url.pathname === "/internal/collaboration/session-capabilities") {
        if (!sessionCollaborationService) throw apiError("SESSION_COLLABORATION_UNAVAILABLE", "Session collaboration tools are unavailable.", 503);
        return sendJson(response, 200, sessionCollaborationService.capabilities(sessionMetadata, actorAgentId));
      }

      if (request.method === "GET" && url.pathname === "/internal/collaboration/sessions") {
        if (!sessionCollaborationService) throw apiError("SESSION_COLLABORATION_UNAVAILABLE", "Session discovery is unavailable.", 503);
        return sendJson(response, 200, { sessions: sessionCollaborationService.discoverSessions(sessionMetadata, actorAgentId, {
          agentId: url.searchParams.get("agentId") || undefined,
          objectiveId: url.searchParams.get("objectiveId") || undefined,
          workItemId: url.searchParams.get("workItemId") || undefined,
          sessionKind: url.searchParams.get("sessionKind") || undefined
        }) });
      }

      const scopedSessionMatch = url.pathname.match(/^\/internal\/collaboration\/sessions\/([^/]+)$/);
      if (request.method === "GET" && scopedSessionMatch) {
        if (!sessionCollaborationService) throw apiError("SESSION_COLLABORATION_UNAVAILABLE", "Session discovery is unavailable.", 503);
        return sendJson(response, 200, { session: sessionCollaborationService.getSession(
          sessionMetadata, actorAgentId, decodeURIComponent(scopedSessionMatch[1])
        ) });
      }

      if (request.method === "GET" && url.pathname === "/internal/collaboration/work-items") {
        if (!sessionCollaborationService) throw apiError("SESSION_COLLABORATION_UNAVAILABLE", "Scoped WorkItem tools are unavailable.", 503);
        return sendJson(response, 200, { workItems: sessionCollaborationService.listWorkItems(sessionMetadata, actorAgentId) });
      }

      const scopedWorkItemMatch = url.pathname.match(/^\/internal\/collaboration\/work-items\/([^/]+)$/);
      if (request.method === "GET" && scopedWorkItemMatch) {
        if (!sessionCollaborationService) throw apiError("SESSION_COLLABORATION_UNAVAILABLE", "Scoped WorkItem tools are unavailable.", 503);
        return sendJson(response, 200, { workItem: sessionCollaborationService.getWorkItem(
          sessionMetadata, actorAgentId, decodeURIComponent(scopedWorkItemMatch[1])
        ) });
      }

      if (request.method === "POST" && url.pathname === "/internal/collaboration/work-items") {
        if (!sessionCollaborationService) throw apiError("SESSION_COLLABORATION_UNAVAILABLE", "Scoped WorkItem tools are unavailable.", 503);
        return sendJson(response, 201, sessionCollaborationService.createWorkItem(
          sessionMetadata, actorAgentId, await readJson(request)
        ));
      }

      if (request.method === "POST" && url.pathname === "/internal/collaboration/work-item-relations") {
        if (!sessionCollaborationService) throw apiError("SESSION_COLLABORATION_UNAVAILABLE", "Scoped WorkItem tools are unavailable.", 503);
        return sendJson(response, 201, { relationship: sessionCollaborationService.relateWorkItems(
          sessionMetadata, actorAgentId, await readJson(request)
        ) });
      }

      if (request.method === "POST" && url.pathname === "/internal/collaboration/work-item-artifact-references") {
        if (!sessionCollaborationService) throw apiError("SESSION_COLLABORATION_UNAVAILABLE", "Scoped Artifact sharing is unavailable.", 503);
        return sendJson(response, 201, sessionCollaborationService.shareArtifact(
          sessionMetadata, actorAgentId, await readJson(request)
        ));
      }

      const scopedWorkItemAction = url.pathname.match(/^\/internal\/collaboration\/work-items\/([^/]+)\/(start|cancel)$/);
      if (request.method === "POST" && scopedWorkItemAction) {
        if (!sessionCollaborationService) throw apiError("SESSION_COLLABORATION_UNAVAILABLE", "Scoped WorkItem tools are unavailable.", 503);
        const input = await readJson(request);
        input.workItemId = decodeURIComponent(scopedWorkItemAction[1]);
        const result = scopedWorkItemAction[2] === "start"
          ? await sessionCollaborationService.startWorkItem(sessionMetadata, actorAgentId, input)
          : sessionCollaborationService.cancelWorkItem(sessionMetadata, actorAgentId, input);
        return sendJson(response, 200, result);
      }

      if (request.method === "GET" && url.pathname === "/internal/collaboration/workspaces") {
        if (!onListWorkspaces) throw apiError("WORKSPACE_TOOLS_UNAVAILABLE", "Workspace tools are unavailable.", 503);
        return sendJson(response, 200, await onListWorkspaces(actorAgentId, sessionMetadata));
      }

      if (request.method === "POST" && url.pathname === "/internal/collaboration/worktrees") {
        if (!onCreateWorktree) throw apiError("WORKSPACE_TOOLS_UNAVAILABLE", "Workspace tools are unavailable.", 503);
        return sendJson(response, 201, await onCreateWorktree(actorAgentId, await readJson(request), sessionMetadata));
      }

      if (request.method === "POST" && url.pathname === "/internal/collaboration/workspaces/switch") {
        if (!onSwitchWorkspace) throw apiError("WORKSPACE_TOOLS_UNAVAILABLE", "Workspace tools are unavailable.", 503);
        return sendJson(response, 202, await onSwitchWorkspace(actorAgentId, await readJson(request), sessionMetadata));
      }

      if (request.method === "POST" && url.pathname === "/internal/collaboration/work-items/acceptance") {
        if (!onReportWorkItemAcceptance) {
          throw apiError("WORK_ITEM_ACCEPTANCE_UNAVAILABLE", "WorkItem acceptance reporting is unavailable.", 503);
        }
        return sendJson(
          response,
          200,
          await onReportWorkItemAcceptance(actorAgentId, await readJson(request), sessionMetadata)
        );
      }

      if (request.method === "GET" && url.pathname === "/internal/collaboration/memory/search") {
        if (!onMemoryOperation && !onSearchMemory) throw apiError("MEMORY_TOOLS_UNAVAILABLE", "Memory search is unavailable.", 503);
        const intent = String(url.searchParams.get("intent") ?? "").trim();
        return sendJson(response, 200, onMemoryOperation
          ? await onMemoryOperation(actorAgentId, "corptie_memory_search", { intent }, memoryMetadata(request))
          : await onSearchMemory(actorAgentId, intent));
      }

      if (request.method === "GET" && url.pathname === "/internal/collaboration/memory") {
        if (!onMemoryOperation) throw apiError("MEMORY_TOOLS_UNAVAILABLE", "Memory tools are unavailable.", 503);
        return sendJson(response, 200, await onMemoryOperation(actorAgentId, "corptie_memory_list", {
          scope: url.searchParams.get("scope") || undefined,
          include_revoked: url.searchParams.get("includeRevoked") === "true"
        }, memoryMetadata(request)));
      }

      if (request.method === "POST" && url.pathname === "/internal/collaboration/memory") {
        if (!onMemoryOperation) throw apiError("MEMORY_TOOLS_UNAVAILABLE", "Memory tools are unavailable.", 503);
        return sendJson(response, 201, await onMemoryOperation(
          actorAgentId,
          "corptie_memory_remember",
          await readJson(request),
          memoryMetadata(request)
        ));
      }

      const memoryActionMatch = url.pathname.match(/^\/internal\/collaboration\/memory\/([^/]+)\/(update|revoke)$/);
      if (request.method === "POST" && memoryActionMatch) {
        if (!onMemoryOperation) throw apiError("MEMORY_TOOLS_UNAVAILABLE", "Memory tools are unavailable.", 503);
        const input = await readJson(request);
        const memoryId = decodeURIComponent(memoryActionMatch[1]);
        const action = memoryActionMatch[2];
        return sendJson(response, 200, await onMemoryOperation(
          actorAgentId,
          action === "update" ? "corptie_memory_update" : "corptie_memory_revoke",
          { ...input, memory_id: memoryId },
          memoryMetadata(request)
        ));
      }

      if (request.method === "GET" && url.pathname === "/internal/collaboration/skills/search") {
        if (!onSearchSkills) throw apiError("SKILL_TOOLS_UNAVAILABLE", "Skill search is unavailable.", 503);
        const intent = String(url.searchParams.get("intent") ?? "").trim();
        if (!intent) throw apiError("INVALID_INPUT", "intent is required.", 400);
        return sendJson(response, 200, await onSearchSkills(actorAgentId, intent));
      }

      const skillLoadMatch = url.pathname.match(/^\/internal\/collaboration\/skills\/([^/]+)$/);
      if (request.method === "GET" && skillLoadMatch) {
        if (!onLoadSkill) throw apiError("SKILL_TOOLS_UNAVAILABLE", "Skill loading is unavailable.", 503);
        return sendJson(response, 200, await onLoadSkill(actorAgentId, decodeURIComponent(skillLoadMatch[1])));
      }

      if (request.method === "GET" && url.pathname === "/internal/collaboration/agents") {
        const requestedStatus = url.searchParams.get("status") || undefined;
        const sourceCapabilities = sessionCollaborationService && sessionMetadata.sessionId
          ? sessionCollaborationService.capabilities(sessionMetadata, actorAgentId)
          : null;
        return sendJson(response, 200, {
          agents: core.listAgents({ status: requestedStatus }).map((agent) => agent.agentId === actorAgentId && sourceCapabilities
            ? withAuthoritativeBinding(agent, sourceCapabilities)
            : agent),
          actorAgentId
        });
      }

      const agentMatch = url.pathname.match(/^\/internal\/collaboration\/agents\/([^/]+)$/);
      if (request.method === "GET" && agentMatch) {
        let agent = core.getAgent(decodeURIComponent(agentMatch[1]));
        if (!agent) throw apiError("AGENT_NOT_FOUND", "Agent was not found.", 404);
        if (agent.agentId === actorAgentId && sessionCollaborationService && sessionMetadata.sessionId) {
          agent = withAuthoritativeBinding(
            agent,
            sessionCollaborationService.capabilities(sessionMetadata, actorAgentId)
          );
        }
        return sendJson(response, 200, { agent, actorAgentId });
      }

      if (request.method === "GET" && url.pathname === "/internal/collaboration/services") {
        return sendJson(response, 200, {
          services: core.listServices({
            ownerAgentId: url.searchParams.get("ownerAgentId") || undefined,
            status: url.searchParams.get("status") || undefined
          })
        });
      }

      const serviceMatch = url.pathname.match(/^\/internal\/collaboration\/services\/([^/]+)$/);
      if (request.method === "GET" && serviceMatch) {
        const service = core.getService(decodeURIComponent(serviceMatch[1]));
        if (!service) throw apiError("SERVICE_NOT_FOUND", "Service was not found.", 404);
        return sendJson(response, 200, {
          service,
          consumers: core.listServiceConsumers(service.serviceId)
        });
      }

      if (request.method === "GET" && url.pathname === "/internal/collaboration/inbox") {
        const status = url.searchParams.getAll("status");
        return sendJson(response, 200, {
          tasks: core.listInbox(sessionMetadata.sessionId, {
            status: status.length ? status : undefined,
            limit: url.searchParams.get("limit")
          })
        });
      }

      if (request.method === "GET" && url.pathname === "/internal/collaboration/channels") {
        if (!sessionChannelService) throw apiError("SESSION_CHANNEL_UNAVAILABLE", "Session Channels are unavailable.", 503);
        const statuses = url.searchParams.getAll("status");
        return sendJson(response, 200, { channels: sessionChannelService.listChannels(
          sessionMetadata.sessionId,
          { statuses: statuses.length ? statuses : undefined, limit: url.searchParams.get("limit") }
        ) });
      }

      const channelMatch = url.pathname.match(/^\/internal\/collaboration\/channels\/([^/]+)$/);
      if (request.method === "GET" && channelMatch) {
        if (!sessionChannelService) throw apiError("SESSION_CHANNEL_UNAVAILABLE", "Session Channels are unavailable.", 503);
        const channelId = decodeURIComponent(channelMatch[1]);
        const channels = sessionChannelService.listChannels(sessionMetadata.sessionId, {
          statuses: ["active", "revoked", "legacy_unresolved"], limit: 500
        });
        const channel = channels.find((candidate) => candidate.channelId === channelId);
        if (!channel) throw apiError("CHANNEL_NOT_FOUND", "Channel was not found in this Session scope.", 404);
        return sendJson(response, 200, {
          channel,
          messages: sessionChannelService.listMessages(channelId, sessionMetadata.sessionId, {
            limit: url.searchParams.get("limit")
          })
        });
      }

      const channelMessagesMatch = url.pathname.match(/^\/internal\/collaboration\/channels\/([^/]+)\/messages$/);
      if (request.method === "POST" && channelMessagesMatch) {
        if (!sessionChannelService) throw apiError("SESSION_CHANNEL_UNAVAILABLE", "Session Channels are unavailable.", 503);
        const input = await readJson(request);
        const result = sessionChannelService.sendMessage({
          channelId: decodeURIComponent(channelMessagesMatch[1]),
          senderSessionId: sessionMetadata.sessionId,
          ...input
        });
        await onChannelMessageCreated?.(result);
        return sendJson(response, 201, result);
      }

      const channelRevokeMatch = url.pathname.match(/^\/internal\/collaboration\/channels\/([^/]+)\/revoke$/);
      if (request.method === "POST" && channelRevokeMatch) {
        if (!sessionChannelService) throw apiError("SESSION_CHANNEL_UNAVAILABLE", "Session Channels are unavailable.", 503);
        const input = await readJson(request);
        return sendJson(response, 200, { channel: sessionChannelService.revokeChannel(
          decodeURIComponent(channelRevokeMatch[1]), sessionMetadata.sessionId, input.reason,
          { type: "authenticated_session" }
        ) });
      }

      if (request.method === "POST" && url.pathname === "/internal/collaboration/channel-requests") {
        if (!sessionChannelService || !sessionCollaborationService) {
          throw apiError("SESSION_CHANNEL_UNAVAILABLE", "Session Channel creation is unavailable.", 503);
        }
        const input = await readJson(request);
        const sourceCapabilities = sessionCollaborationService.capabilities(
          sessionMetadata, actorAgentId, { validateContext: true }
        );
        let recipientSessionId = input.recipientSessionId ?? null;
        if (!recipientSessionId && input.recipientSessionName) {
          recipientSessionId = core.store.getLogicalSessionByName(input.recipientSessionName)?.logicalSessionId ?? null;
        }
        if (recipientSessionId) {
          recipientSessionId = resolveRecipientSession(sessionCollaborationService, sessionMetadata, actorAgentId, {
            ...input, recipientSessionId
          }).sessionId;
        } else if (!input.targetObjectiveId || !input.sessionAgentId) {
          throw apiError(
            "SESSION_CREATION_RESOURCES_REQUIRED",
            "Supply an exact recipient Session, or targetObjectiveId plus sessionAgentId so Corptie can create the target WorkItem and Session.",
            400
          );
        }
        const channelRequest = sessionChannelService.requestChannel({
          ...input,
          requestingSessionId: sourceCapabilities.sourceSessionId,
          recipientSessionId
        });
        if (channelRequest.status === "sent") {
          await onChannelMessageCreated?.(channelRequest);
          return sendJson(response, 201, { request: channelRequest });
        }
        try {
          await onChannelRequestStaged?.(channelRequest);
        } catch (error) {
          sessionChannelService.failRequest(channelRequest.requestId, error);
          throw error;
        }
        return sendJson(response, 201, { request: channelRequest });
      }

      if (request.method === "POST" && url.pathname === "/internal/collaboration/task-confirmations") {
        const input = await readJson(request);
        if (!sessionCollaborationService) throw apiError("SESSION_COLLABORATION_UNAVAILABLE", "Session-scoped collaboration is unavailable.", 503);
        const sourceCapabilities = sessionCollaborationService.capabilities(
          sessionMetadata,
          actorAgentId,
          { validateContext: true }
        );
        if (!sourceCapabilities.actions.includes("collaboration.request")) {
          const denial = sourceCapabilities.denials?.["collaboration.request"];
          throw apiError(
            denial?.code ?? "COLLABORATION_REQUEST_FORBIDDEN",
            denial?.reason ?? "The authenticated Session does not have collaboration.request permission.",
            403
          );
        }
        let recipientSessionDescriptor = null;
        if (input.recipientSessionId) {
          recipientSessionDescriptor = resolveRecipientSession(
            sessionCollaborationService,
            sessionMetadata,
            actorAgentId,
            input
          );
        } else if (input.recipientSessionName) {
          const namedSessionId = core.store.getLogicalSessionByName(input.recipientSessionName)?.logicalSessionId ?? null;
          if (namedSessionId) {
            recipientSessionDescriptor = resolveRecipientSession(
              sessionCollaborationService,
              sessionMetadata,
              actorAgentId,
              { ...input, recipientSessionId: namedSessionId }
            );
          }
        }
        const recipientSession = recipientSessionDescriptor?.sessionId ?? null;
        const recipient = recipientSession
          ? core.getAgentForSession(recipientSession)
          : (input.sessionAgentId ? core.getAgent(input.sessionAgentId) : null);
        if (!recipient) {
          throw apiError(
            recipientSession ? "SESSION_RESOURCE_OWNER_NOT_FOUND" : "SESSION_CREATION_RESOURCES_REQUIRED",
            input.recipientSessionName
              ? `No active Session is named ${input.recipientSessionName}.`
              : "Supply an exact recipientSessionId, or targetObjectiveId plus sessionAgentId so Corptie can create the target WorkItem and Session before creating the task.",
            404
          );
        }
        if (!recipientSession && !String(input.targetObjectiveId ?? "").trim()) {
          throw apiError("TARGET_OBJECTIVE_REQUIRED", "targetObjectiveId is required when Corptie must create a target WorkItem and Session.", 400);
        }
        const actor = core.getAgent(actorAgentId);
        const sourceLogical = core.store.getLogicalSession(sessionMetadata.sessionId);
        const sourceProviderSessionId = sourceLogical?.legacySessionId ?? sessionMetadata.sessionId;
        const runningWork = sourceProviderSessionId
          ? core.store.getRunningAgentWorkItemForSession(sourceProviderSessionId)
          : null;
        const parentTask = (runningWork?.source?.taskId
          ? core.getTask(runningWork.source.taskId)
          : null) ?? core.getTaskForWorkItem(sourceCapabilities.workItemId);
        const trustedSessionRoute = Boolean(recipientSession && onConfirmationResolved)
          && core.hasConfirmedSessionRoute(sourceCapabilities.sourceSessionId, recipientSession);
        const confirmation = core.proposeTask({
          ...input,
          parentTaskId: parentTask?.taskId ?? undefined,
          contextId: parentTask?.contextId ?? undefined,
          sourceObjectiveId: sourceCapabilities.objectiveId ?? undefined,
          sourceWorkItemId: sourceCapabilities.workItemId ?? undefined,
          workItemId: input.workItemId ?? recipientSessionDescriptor?.workItemId ?? undefined,
          sessionAgentId: input.sessionAgentId ?? undefined,
          recipientAgentId: recipient.agentId,
          recipientSessionId: recipientSession,
          initiatorAgentId: actorAgentId,
          initiatorSessionId: sourceCapabilities.sourceSessionId,
          sourceSessionId: sessionMetadata.sessionId,
          sourceTurnId: runningWork?.targetTurnId ?? null
        });
        if (trustedSessionRoute) {
          try {
            const resolved = await onConfirmationResolved(confirmation.confirmationId, true, {
              type: "trusted_session_route"
            });
            if (resolved?.status !== "confirmed" || !resolved.taskId) {
              throw apiError(
                "TRUSTED_SESSION_ROUTE_NOT_CONFIRMED",
                "The previously authorized Session route did not create a confirmed collaboration task.",
                500
              );
            }
            return sendJson(response, 201, {
              confirmation: resolved,
              routeAuthorization: "trusted_session_pair"
            });
          } catch (error) {
            const current = core.getTaskConfirmation(confirmation.confirmationId);
            if (current?.status === "pending" && !current.taskId) {
              core.discardPendingTaskConfirmation(confirmation.confirmationId);
            }
            throw error;
          }
        }
        try {
          await onConfirmationStaged?.(confirmation);
        } catch (error) {
          core.discardPendingTaskConfirmation(confirmation.confirmationId);
          throw error;
        }
        return sendJson(response, 201, { confirmation });
      }

      // Kept for trusted internal callers and migration compatibility. The MCP
      // request tool uses task-confirmations so user-originated sends always
      // pass route validation and either first-use confirmation or exact-pair authorization.
      if (request.method === "POST" && url.pathname === "/internal/collaboration/tasks") {
        const input = await readJson(request);
        const task = core.createTask({ ...input, initiatorAgentId: actorAgentId });
        return sendJson(response, 201, { task });
      }

      const taskMatch = url.pathname.match(/^\/internal\/collaboration\/tasks\/([^/]+)$/);
      if (request.method === "GET" && taskMatch) {
        const task = requireParticipant(core, decodeURIComponent(taskMatch[1]), actorAgentId, sessionMetadata.sessionId);
        const includeHistory = url.searchParams.get("includeHistory") === "true";
        return sendJson(response, 200, {
          task: includeHistory ? task : compactTaskForActor(task, actorAgentId, sessionMetadata.sessionId, core)
        });
      }

      const actionMatch = url.pathname.match(/^\/internal\/collaboration\/tasks\/([^/]+)\/actions\/([^/]+)$/);
      if (request.method === "POST" && actionMatch) {
        const taskId = decodeURIComponent(actionMatch[1]);
        const action = decodeURIComponent(actionMatch[2]);
        requireParticipant(core, taskId, actorAgentId, sessionMetadata.sessionId);
        const input = await readJson(request);
        const task = performAction(core, taskId, actorAgentId, action, input, sessionMetadata.sessionId);
        return sendJson(response, 200, { task });
      }

      throw apiError("NOT_FOUND", "Collaboration endpoint was not found.", 404);
    })
    .catch((error) => {
      sendJson(response, error.statusCode ?? statusForCode(error.code), {
        error: error.message,
        code: error.code ?? "COLLABORATION_ERROR"
      });
    });
  return true;
}

function memoryMetadata(request) {
  return {
    sessionId: headerText(request, "x-corptie-session-id"),
    objectiveId: headerText(request, "x-corptie-objective-id"),
    workItemId: headerText(request, "x-corptie-work-item-id")
  };
}

function withAuthoritativeBinding(agent, capabilities) {
  return {
    ...agent,
    sessionId: capabilities.sourceSessionId,
    providerSessionId: capabilities.providerSessionId,
    currentSessionId: capabilities.sourceSessionId,
    currentObjectiveId: capabilities.objectiveId,
    currentWorkItemId: capabilities.workItemId,
    runtimeBinding: {
      authoritative: true,
      sessionId: capabilities.sourceSessionId,
      providerSessionId: capabilities.providerSessionId,
      sessionKind: capabilities.sessionKind,
      objectiveId: capabilities.objectiveId,
      workItemId: capabilities.workItemId
    }
  };
}

function headerText(request, name) {
  const value = request.headers?.[name];
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}

async function handleProductRequest({ request, response, url, core, sessionChannelService,
  onConfirmationResolved, onChannelRequestResolved, onChannelMessageCreated }) {
  if (request.method === "GET" && url.pathname === "/collaboration/overview") {
    return sendJson(response, 200, {
      agents: core.listAgents(),
      services: core.listServices(),
      channels: sessionChannelService
        ? core.store.selectAll("SELECT * FROM session_collaboration_channels ORDER BY updated_at DESC LIMIT 500")
          .map((row) => sessionChannelService.getChannel(row.channel_id))
        : []
    });
  }

  const channelRequestMatch = url.pathname.match(/^\/collaboration\/channel-requests\/([^/]+)\/(confirm|reject)$/);
  if (request.method === "POST" && channelRequestMatch) {
    if (!onChannelRequestResolved) throw apiError("SESSION_CHANNEL_UNAVAILABLE", "Channel confirmation is unavailable.", 503);
    const resolved = await onChannelRequestResolved(
      decodeURIComponent(channelRequestMatch[1]), channelRequestMatch[2] === "confirm", { type: "desktop" }
    );
    return sendJson(response, 200, { request: resolved });
  }

  const compatibilityConfirmationMatch = url.pathname.match(/^\/collaboration\/confirmations\/([^/]+)\/(confirm|reject)$/);
  if (request.method === "POST" && compatibilityConfirmationMatch && sessionChannelService) {
    const requestId = decodeURIComponent(compatibilityConfirmationMatch[1]);
    if (sessionChannelService.getRequest(requestId)) {
      if (!onChannelRequestResolved) throw apiError("SESSION_CHANNEL_UNAVAILABLE", "Channel confirmation is unavailable.", 503);
      const resolved = await onChannelRequestResolved(
        requestId, compatibilityConfirmationMatch[2] === "confirm", { type: "desktop" }
      );
      return sendJson(response, 200, { request: resolved });
    }
  }

  const productChannelMatch = url.pathname.match(/^\/collaboration\/channels\/([^/]+)$/);
  if (request.method === "GET" && productChannelMatch) {
    if (!sessionChannelService) throw apiError("SESSION_CHANNEL_UNAVAILABLE", "Session Channels are unavailable.", 503);
    const channelId = decodeURIComponent(productChannelMatch[1]);
    const channel = sessionChannelService.getChannel(channelId);
    if (!channel) throw apiError("CHANNEL_NOT_FOUND", "Channel was not found.", 404);
    return sendJson(response, 200, {
      channel,
      messages: sessionChannelService.listMessages(channelId, channel.sessionAId, { limit: 500 })
    });
  }

  const productChannelMessageMatch = url.pathname.match(/^\/collaboration\/channels\/([^/]+)\/messages$/);
  if (request.method === "POST" && productChannelMessageMatch) {
    if (!sessionChannelService) throw apiError("SESSION_CHANNEL_UNAVAILABLE", "Session Channels are unavailable.", 503);
    const input = await readJson(request);
    const result = sessionChannelService.sendMessage({
      channelId: decodeURIComponent(productChannelMessageMatch[1]), ...input
    });
    await onChannelMessageCreated?.(result);
    return sendJson(response, 201, result);
  }

  if (request.method === "POST" && url.pathname === "/collaboration/services") {
    const input = await readJson(request);
    return sendJson(response, 201, { service: core.registerService(input) });
  }

  const confirmationMatch = url.pathname.match(/^\/collaboration\/confirmations\/([^/]+)\/(confirm|reject)$/);
  if (request.method === "POST" && confirmationMatch) {
    const confirmationId = decodeURIComponent(confirmationMatch[1]);
    const action = confirmationMatch[2];
    if (action === "confirm" && !onConfirmationResolved) {
      throw apiError(
        "COLLABORATION_TARGET_PREPARATION_UNAVAILABLE",
        "Collaboration confirmation requires the Session target preparation service.",
        503
      );
    }
    const confirmation = onConfirmationResolved
      ? await onConfirmationResolved(confirmationId, action === "confirm", { type: "desktop" })
      : core.rejectTaskConfirmation(confirmationId);
    return sendJson(response, 200, { confirmation });
  }

  const serviceMatch = url.pathname.match(/^\/collaboration\/services\/([^/]+)$/);
  if (request.method === "PATCH" && serviceMatch) {
    const input = await readJson(request);
    const serviceId = decodeURIComponent(serviceMatch[1]);
    const service = core.getService(serviceId);
    if (!service) throw apiError("SERVICE_NOT_FOUND", "Service was not found.", 404);
    return sendJson(response, 200, {
      service: core.updateService(serviceId, service.ownerAgentId, input)
    });
  }

  const taskMatch = url.pathname.match(/^\/collaboration\/tasks\/([^/]+)$/);
  if (request.method === "GET" && taskMatch) {
    const taskId = decodeURIComponent(taskMatch[1]);
    const task = core.getTask(taskId);
    if (!task) throw apiError("TASK_NOT_FOUND", "Task was not found.", 404);
    return sendJson(response, 200, {
      task,
      deliveries: core.listDeliveriesForTask(taskId)
    });
  }

  const cancelMatch = url.pathname.match(/^\/collaboration\/tasks\/([^/]+)\/interventions\/cancel$/);
  if (request.method === "POST" && cancelMatch) {
    const input = await readJson(request);
    return sendJson(response, 200, {
      task: core.cancelByUser(decodeURIComponent(cancelMatch[1]), input.reason)
    });
  }

  const retryMatch = url.pathname.match(/^\/collaboration\/deliveries\/([^/]+)\/retry$/);
  if (request.method === "POST" && retryMatch) {
    return sendJson(response, 200, {
      delivery: core.retryDeliveryByUser(decodeURIComponent(retryMatch[1]))
    });
  }

  throw apiError("NOT_FOUND", "Collaboration product endpoint was not found.", 404);
}

function performAction(core, taskId, actorAgentId, action, input, actorSessionId = null) {
  switch (action) {
    case "accept": {
      const current = core.getTask(taskId);
      if (current?.status === "revision_requested") {
        return core.startWorking(taskId, actorAgentId, actorSessionId);
      }
      const accepted = core.accept(taskId, actorAgentId, actorSessionId);
      return core.startWorking(accepted.taskId, actorAgentId, actorSessionId);
    }
    case "reject":
      return core.reject(taskId, actorAgentId, input.reason, actorSessionId);
    case "ask":
      return core.askForInformation(taskId, actorAgentId, input.body, { ...messageOptions(input), actorSessionId });
    case "reply":
      return core.reply(taskId, actorAgentId, input.body, { ...messageOptions(input), actorSessionId });
    case "submit-result":
      return core.submitResult(taskId, actorAgentId, { ...input, actorSessionId });
    case "request-revision": {
      let task = core.getTask(taskId);
      if (task.status === "delivered") task = core.beginVerification(taskId, actorAgentId, actorSessionId);
      return core.requestRevision(task.taskId, actorAgentId, input.body, { ...messageOptions(input), actorSessionId });
    }
    case "complete": {
      let task = core.getTask(taskId);
      if (task.status === "delivered") task = core.beginVerification(taskId, actorAgentId, actorSessionId);
      return core.complete(task.taskId, actorAgentId, input.body, { ...messageOptions(input), actorSessionId });
    }
    case "cancel":
      return core.cancel(taskId, actorAgentId, input.reason, actorSessionId);
    default:
      throw apiError("UNKNOWN_ACTION", `Unknown collaboration action: ${action}`, 404);
  }
}

function requiredActor(request, core) {
  const actorAgentId = String(request.headers["x-corptie-agent-id"] ?? "").trim();
  if (!actorAgentId) throw apiError("AGENT_ID_REQUIRED", "x-corptie-agent-id is required.", 401);
  if (!core.getAgent(actorAgentId)) throw apiError("AGENT_NOT_FOUND", `Agent ${actorAgentId} was not found.`, 403);
  return actorAgentId;
}

function requireParticipant(core, taskId, actorAgentId, actorSessionId = null) {
  const task = core.getTask(taskId);
  if (!task) throw apiError("TASK_NOT_FOUND", `Task ${taskId} was not found.`, 404);
  const logical = core.store.getLogicalSession(actorSessionId)
    ?? core.store.getLogicalSessionByLegacySessionId(actorSessionId);
  const stable = logical?.logicalSessionId ?? actorSessionId;
  const role = stable === task.initiatorSessionId ? "initiator"
    : stable === task.recipientSessionId ? "recipient" : null;
  const expectedAgentResourceId = role === "initiator" ? task.initiatorAgentId
    : role === "recipient" ? task.recipientAgentId : null;
  if (!role || actorAgentId !== expectedAgentResourceId) {
    throw apiError("SESSION_ACTOR_MISMATCH", "Only the exact source or target Session may view or modify this task.", 403);
  }
  return task;
}

function messageOptions(input) {
  return {
    evidence: input.evidence,
    resourceVersion: input.resourceVersion,
    idempotencyKey: input.idempotencyKey
  };
}

function compactTaskForActor(task, actorAgentId, actorSessionId = null, core = null) {
  const actorLogical = core?.store.getLogicalSession(actorSessionId)
    ?? core?.store.getLogicalSessionByLegacySessionId(actorSessionId);
  const stableActorSessionId = actorLogical?.logicalSessionId ?? actorSessionId;
  const role = stableActorSessionId === task.initiatorSessionId ? "initiator" : "recipient";
  const peerAgentId = role === "initiator" ? task.recipientAgentId : task.initiatorAgentId;
  const currentMessage = [...(task.messages ?? [])]
    .reverse()
    .find((message) => message.recipientSessionId === stableActorSessionId)
    ?? task.messages?.at(-1)
    ?? null;
  const latestArtifact = task.artifacts?.at(-1) ?? null;
  const compact = {
    taskId: task.taskId,
    protocolVersion: task.protocolVersion,
    sourceObjectiveId: task.sourceObjectiveId,
    targetObjectiveId: task.targetObjectiveId,
    sourceWorkItemId: task.sourceWorkItemId,
    workItemId: task.workItemId,
    initiatorSessionId: task.initiatorSessionId,
    recipientSessionId: task.recipientSessionId,
    routingVersion: task.routingVersion,
    routeStatus: task.routeStatus,
    artifactStatus: task.artifactStatus,
    acceptanceStatus: task.acceptanceStatus,
    role,
    peerAgentId,
    serviceId: task.serviceId,
    type: task.type,
    status: task.status,
    title: task.title,
    summary: task.summary,
    acceptanceCriteria: task.acceptanceCriteria,
    currentMessage: currentMessage ? compactMessage(currentMessage) : null,
    latestArtifact: latestArtifact ? compactArtifact(latestArtifact) : null,
    availableActions: availableActions(task, role)
  };
  if (task.iteration > 1 || ["revision_requested", "escalated"].includes(task.status)) {
    compact.iteration = task.iteration;
    compact.maxIterations = task.maxIterations;
  }
  return compact;
}

function compactMessage(message) {
  return compactObject({
    messageId: message.messageId,
    messageType: message.messageType,
    body: message.body,
    evidence: message.evidence?.length ? message.evidence : undefined,
    resourceVersion: message.resourceVersion ?? undefined,
    createdAt: message.createdAt,
    envelope: message.envelope
  });
}

function compactArtifact(artifact) {
  return {
    type: artifact.type,
    name: artifact.name,
    uri: artifact.uri,
    metadata: artifact.metadata
  };
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function availableActions(task, role) {
  const terminal = ["completed", "rejected", "canceled", "escalated"].includes(task.status);
  if (terminal) return [];
  if (role === "recipient") {
    if (task.status === "proposed") return ["accept", "reject", "ask"];
    if (task.status === "working") return ["reply", "submit_result"];
    if (task.status === "revision_requested") return ["accept", "reply"];
    return ["reply"];
  }
  if (task.type === "question") {
    if (task.status === "needs_information") return ["reply", "cancel"];
    return ["cancel"];
  }
  if (task.status === "delivered" || task.status === "verifying") {
    return ["complete", "request_revision", "cancel"];
  }
  if (task.status === "needs_information") return ["reply", "cancel"];
  return ["reply", "cancel"];
}

function statusForCode(code) {
  if (["AGENT_NOT_FOUND", "SERVICE_NOT_FOUND", "TASK_NOT_FOUND", "DELIVERY_NOT_FOUND", "OBJECTIVE_NOT_FOUND", "WORK_ITEM_NOT_FOUND"].includes(code)) return 404;
  if (["ACTOR_NOT_AUTHORIZED", "SERVICE_OWNER_REQUIRED", "RECIPIENT_NOT_SERVICE_OWNER", "OBJECTIVE_AGENT_NOT_AUTHORIZED", "MEMORY_SESSION_SCOPE_REQUIRED", "MEMORY_SCOPE_FORBIDDEN", "WORK_ITEM_CANCELLATION_WORKFLOW_REQUIRED"].includes(code)) return 403;
  if (["INVALID_TASK_TRANSITION", "TASK_TERMINAL", "IDEMPOTENCY_CONFLICT", "MEMORY_IDEMPOTENCY_CONFLICT", "QUESTION_FOLLOWUP_REQUIRES_NEW_TASK", "OBJECTIVE_BOUNDARY_REQUIRED", "WORK_ITEM_OBJECTIVE_MISMATCH", "WORK_ITEM_AGENT_MISMATCH", "WORK_ITEM_TERMINAL", "WORK_ITEM_ALREADY_CANCELED", "CANCELLATION_IDEMPOTENCY_CONFLICT", "RESOURCE_VERSION_CONFLICT"].includes(code)) return 409;
  if (["MEMORY_PERSISTENCE_FAILED", "MEMORY_IDEMPOTENCY_RECORD_INVALID"].includes(code)) return 500;
  return 400;
}

function apiError(code, message, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw apiError("INVALID_JSON", "Request body must be valid JSON.", 400);
  }
}

function sendJson(response, status, payload) {
  if (response.headersSent) return;
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}
