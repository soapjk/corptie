import { DEVELOPMENT_WORKFLOW_INSTRUCTIONS } from "./executionChecklistInstructions.mjs";
import { SessionApplicationService } from "../agent-provider/sessionApplicationService.mjs";
import { persistProviderSessionProjection, persistSessionModelSelection } from "./providerSessionProjection.mjs";
import { buildWorkSessionContext, mergeWorkerSessionContexts } from "./workSessionContext.mjs";
import { CHART_PRESENTATION_INSTRUCTIONS } from "./chartPresentationInstructions.mjs";
import { sessionResponsibilityInstructions } from "./sessionResponsibilityInstructions.mjs";
import { conversationMessageText, normalizeConversationMessage } from "./conversationMessage.mjs";
import { resolveMessageMentionContext } from "./messageMentionContext.mjs";
import { buildDirectUserMessageEvidence } from "./directUserMessageEvidence.mjs";
import { skillMcpTurnContext } from "./skillMcpTurnContext.mjs";
import { desiredToolDomainIds, appliedToolDomainIds } from "./sessionToolBindingProjection.mjs";
import { assertNoAutomaticWorktreeMutation } from "./worktreeAutoFollowService.mjs";
import { resolveTaskCreationDefaults } from "../utils/newSessionDefaults.mjs";

// Product policy wired into the common Session service. Later-created services
// enter through narrow deferred operations to preserve startup dependency order.
export function createSessionApplicationComposition({
  store, agentProviderRegistry, sessionBindingRepository, toolHostService, toolMaterializationPort,
  requiredToolDomainsForSession, assertForkDispatchAllowed, assertSessionRecoveryMessageBoundary,
  recoverSession, requireSessionReference, workChatContextService, resolveContextReferences,
  artifactService, memoryRecallService, memoryTopicService, mcpAssignmentRevisionForAgent,
  resolveAssignedCapabilities = () => [],
  ensureCollaborationAgentForSession, ensureLogicalRouteForProviderSession,
  sessionWithLogicalWorkspace, collaborationCore, emitEvent
}) {
  const sessionApplicationService = new SessionApplicationService({
    registry: agentProviderRegistry,
    resolveCreationDefaults: (providerId, input) => {
      const runtime = resolveTaskCreationDefaults({ ...input, providerId },
        store.settings?.().newSessionDefaults ?? {}, agentProviderRegistry.defaultProviderId);
      return { providerId: runtime.providerId, input: { ...input, model: runtime.model, reasoningLevel: runtime.reasoningLevel } };
    },
    observeLifecycle: ({ type, sessionId, ...payload }) => {
      console.info(`[session-lifecycle] ${JSON.stringify({ type, sessionId, ...payload })}`);
      if (type === "SessionToolPreparationWarning") {
        const id = `tool-preparation-warning:${payload.bindingId}:${payload.turnId}`;
        emitEvent(type, { ...payload, item: {
          id, turnId: id, type: "system", title: "工具配置提示",
          text: "工具配置暂未就绪，本次对话已继续；部分工具可能暂不可用。",
          status: "completed", turnStatus: "completed", createdAt: new Date().toISOString()
        } }, { sessionId, eventId: id });
        return;
      }
      emitEvent(type, payload, { sessionId });
    },
    toolHostService,
    toolMaterializationPort,
    resolveRequiredToolDomains: requiredToolDomainsForSession,
    resolveSessionReference: (sessionId) => sessionBindingRepository.resolve(sessionId),
    resolveSessionBinding: (sessionId, bindingId) => sessionBindingRepository.resolveBinding(sessionId, bindingId),
    assertMessageDispatchAllowed: (reference, context) => {
      assertForkDispatchAllowed(reference.sessionId);
      assertNoAutomaticWorktreeMutation(store, reference);
      return assertSessionRecoveryMessageBoundary(reference);
    },
    recoverUnavailableSession: async ({ sessionId, reference, error, context }) => {
      if (!reference.logicalSessionId || !context.idempotencyKey) {
        const recoveryError = new Error("Automatic recovery requires a logical Session and stable message idempotency key.");
        recoveryError.code = "SESSION_RECOVERY_IDEMPOTENCY_REQUIRED";
        throw recoveryError;
      }
      const recoveryKind = context.recoveryKind === "restart" ? "restart" : "message";
      const attempt = await recoverSession({
        logicalSessionId: reference.logicalSessionId,
        providerId: reference.providerId,
        idempotencyKey: `${recoveryKind}-recovery:${context.idempotencyKey}`,
        triggerDeliveryId: recoveryKind === "message" ? context.idempotencyKey : null,
        reason: error?.replacementReason ?? error?.code ?? "provider-session-unavailable"
      });
      const recoveredReference = requireSessionReference(sessionId);
      const recoveredSession = store.getSession(sessionId);
      await sessionApplicationService.resumeSession(sessionId, {
        purpose: "session-create-finalization",
        actorId: recoveredSession?.agentId ?? null,
        sessionId,
        logicalSessionId: recoveredReference.logicalSessionId,
        providerBindingId: recoveredReference.bindingId,
        sessionKind: recoveredSession?.sessionKind ?? "legacy",
        workId: recoveredSession?.workId ?? null,
        taskId: recoveredSession?.taskId ?? null,
        desiredToolDomains: desiredToolDomainIds(attempt.toolCatalog)
      });
      if (recoveryKind === "message") {
        store.rerouteUnsentMessageDelivery(context.idempotencyKey, recoveredReference);
      }
      return { reference: recoveredReference, attempt };
    },
    resolveMessageContext: async (reference, messageContext = {}) => {
      const session = store.getSession(reference.sessionId);
      const mentionContext = resolveMessageMentionContext(
        store,
        reference.sessionId,
        normalizeConversationMessage(messageContext.message).mentions ?? []
      );
      const ownership = session?.sessionKind === "worker"
        ? store.assertLogicalWorkSessionBinding(reference.logicalSessionId) : null;
      const assignedCapabilities = Promise.resolve().then(() => session?.agentId
        ? resolveAssignedCapabilities(session.agentId, reference.logicalSessionId ?? reference.sessionId) : []).then(value => ({ value }), error => ({ error }));
      let baseContext = null;
      let referenceContext = null;
      if (session?.sessionKind === "workChat" && session.workId) {
        baseContext = workChatContextService.build(session.workId, session);
        referenceContext = await resolveContextReferences(reference.sessionId);
        if (referenceContext?.prompt) {
          baseContext = { ...baseContext, prompt: `${baseContext.prompt}\n\n${referenceContext.prompt}`,
            contextSections: [...(baseContext.contextSections ?? [
              { id: "work-context", prompt: baseContext.prompt, reusable: true }
            ]), { id: "context-references", prompt: referenceContext.prompt, reusable: true }] };
        }
      } else if (session?.sessionKind === "assistantChat") {
        baseContext = await resolveContextReferences(reference.sessionId);
        baseContext = {
          ...baseContext,
          prompt: [sessionResponsibilityInstructions("assistantChat"), baseContext?.prompt].filter(Boolean).join("\n\n")
        };
      } else if (session?.sessionKind === "worker") {
        const task = store.getTask(ownership.taskId);
        const work = task?.work_id ? store.getWork(task.work_id) : null;
        const startupReceiptRow = store.selectOne(
          `SELECT receipt.receipt_json, operation.updated_at FROM work_session_startup_receipts receipt
           JOIN work_session_startup_operations operation
             ON operation.startup_operation_id=receipt.startup_operation_id
           WHERE operation.logical_session_id=? AND operation.state='ready'
           UNION ALL
           SELECT execution.receipt_json, execution.updated_at FROM execution_spaces execution
           WHERE execution.logical_session_id=? AND execution.status='ready'
           ORDER BY updated_at DESC LIMIT 1`,
          [reference.logicalSessionId, reference.logicalSessionId]
        );
        const toolMaterialization = store.getSessionToolCatalogMaterialization(
          reference.logicalSessionId,
          reference.bindingId
        );
        baseContext = buildWorkSessionContext({
          session, task, work,
          coordination: task ? {
            children: store.selectAll("SELECT id,substr(title,1,120) AS title,current_session_id AS sessionId,lifecycle_state AS state,execution_status AS executionStatus FROM tasks WHERE parent_task_id=? AND COALESCE(deletion_status,'')<>'deleted' ORDER BY updated_at DESC LIMIT 20", [task.id]),
            dispatches: store.selectAll("SELECT dispatch_id AS dispatchId,target_task_id AS taskId,status,error_code AS errorCode FROM task_coordination_dispatches WHERE parent_task_id=? ORDER BY created_at DESC LIMIT 20", [task.id])
          } : null,
          artifactReferences: [...(store.listArtifactReferences?.({ taskId: task.id, requiredOnly: true }) ?? []),
            ...(store.listArtifactReferences?.({ sessionId: session.id, requiredOnly: true }) ?? [])]
            .filter((ref, index, all) => ref.required && ref.workId === task.work_id && all.findIndex(item => item.referenceId === ref.referenceId) === index)
            .map(ref => ({ artifactId: ref.artifactId, pinnedVersion: ref.pinnedVersion, contentHash: ref.pinnedHash, relation: ref.relation })),
          startupReceipt: startupReceiptRow ? JSON.parse(startupReceiptRow.receipt_json) : null,
          toolDomains: appliedToolDomainIds(toolMaterialization),
          toolCatalogVersion: toolMaterialization?.appliedCatalogVersion ?? null
        });
        referenceContext = await resolveContextReferences(reference.sessionId);
      }
      let memoryContext = null;
      let recallDecision = null;
      let globalPreferenceContext = null;
      const recallScope = session ? {
        sessionId: session.id,
        agentId: session.agentId ?? null,
        workId: session.workId ?? null,
        taskId: session.taskId ?? null
      } : null;
      const currentMessage = conversationMessageText(messageContext.message);
      const topicProfile = session && memoryTopicService
        ? memoryTopicService.profileForMessage(session, currentMessage) : { topics: [], contexts: [], keywords: [] };
      memoryTopicService?.requestUpdate(session, currentMessage,
        messageContext.source?.messageId ?? messageContext.source?.deliveryId ?? messageContext.idempotencyKey ?? null);
      const globalPreferences = recallScope
        ? memoryRecallService?.applicablePreferences?.(recallScope, topicProfile) : null;
      if (globalPreferences?.memories.length) {
        const lines = globalPreferences.memories.map((memory) => `- ${memory.content}`);
        globalPreferenceContext = {
          prompt: `<corptie_global_preferences>\nThese user-saved preferences apply to this Session's work. Follow them unless the current direct user explicitly changes them or a higher-priority rule conflicts.\n${lines.join("\n")}\n</corptie_global_preferences>`,
          globalPreferenceRecall: globalPreferences
        };
      }
      if (session?.agentId) {
        const excludeIds = new Set(globalPreferences?.memories.map((memory) => memory.id) ?? []);
        const recall = memoryRecallService.hasStartupRecall?.(session.id) === false
          ? await memoryRecallService.startup(recallScope, { excludeIds, intent: currentMessage,
            profile: topicProfile, deepRecall: messageContext.deepRecall === true })
          : await memoryRecallService.turn(currentMessage, recallScope,
            { deepRecall: messageContext.deepRecall === true, excludeIds, profile: topicProfile });
        recallDecision = recall;
        if (recall.memories.length > 0) {
          const lines = recall.memories.map((memory) => `- [${memory.kind}] ${memory.content}`);
          memoryContext = {
            prompt: `<corptie_memory_recall mode="${recall.mode}" reason="${recall.reason}">\n${lines.join("\n")}\n</corptie_memory_recall>`,
            memoryRecall: recall
          };
        }
      }
      // Provider-native thread context remains Provider-owned. Ordinary sends
      // contain only this turn's Corptie product context and never replay chat
      // history from either Provider or session_items.
      const directUserIntentContext = buildDirectUserMessageEvidence(store, reference, messageContext);
      const discoveryContext = toolHostService?.discoveryContext({
        actorId: session?.agentId,
        metadata: { purpose: "session", sessionKind: session?.sessionKind ?? "legacy",
          sessionId: session?.id, workId: session?.workId ?? null, taskId: session?.taskId ?? null,
          logicalSessionId: reference.logicalSessionId, providerId: reference.providerId,
          providerBindingId: reference.bindingId }
      });
      const assigned = await assignedCapabilities;
      if (assigned.error) throw assigned.error;
      const skillRoutingContext = { ...skillMcpTurnContext(
        mcpAssignmentRevisionForAgent(session?.agentId),
        assigned.value
      ), contextKey: "skill-routing", contextReusable: true };
      // Refresh presentation capabilities at Turn boundaries, including already
      // running/resumed Sessions whose Provider thread predates this contract.
      const presentationContext = { contextKey: "presentation", contextReusable: true,
        prompt: `<corptie_message_presentation>\n${CHART_PRESENTATION_INSTRUCTIONS}\n</corptie_message_presentation>\n\nRole is reusable user configuration; Provider is the execution engine; Session is the only executor and authorization/collaboration actor. Historical Agent resource labels mean Role. Selecting a Role never grants permissions.` };
      if (globalPreferenceContext) globalPreferenceContext.contextKey = "global-preferences";
      const workflowContext = { prompt: DEVELOPMENT_WORKFLOW_INSTRUCTIONS };
      const contexts = [workflowContext, directUserIntentContext, globalPreferenceContext, baseContext, discoveryContext, skillRoutingContext,
        presentationContext, mentionContext, memoryContext]
        .filter((item) => item?.prompt);
      const recordInjection = (globalIncluded, recallIncluded) => {
        if (globalPreferences && globalIncluded) memoryRecallService.markInjection?.(globalPreferences, "context_included");
        if (!recallDecision) return;
        const status = recallDecision.memories.length === 0 ? "not_selected"
          : recallIncluded ? "context_included" : "not_selected";
        memoryRecallService.markInjection?.(recallDecision, status);
      };
      if (contexts.length === 0) {
        recordInjection(false, false);
        return null;
      }
      if (session?.sessionKind === "worker") {
        const result = mergeWorkerSessionContexts({
          baseContext,
          directUserIntentContext,
          memoryContext,
          mentionContext,
          referenceContext,
          requiredContexts: [globalPreferenceContext, discoveryContext, skillRoutingContext, presentationContext,
            sessionApplicationService.coordinationTurns?.handoffContext(reference)].filter(Boolean)
        });
        recordInjection(Boolean(result), Boolean(result.memoryRecall));
        return { ...result, globalPreferenceRecall: globalPreferences };
      }
      recordInjection(true, Boolean(memoryContext));
      if (contexts.length === 1) return { ...contexts[0], globalPreferenceRecall: globalPreferences };
      return {
        ...baseContext,
        prompt: contexts.map((item) => item.prompt).join("\n\n"),
        contextSections: [
          { id: "execution-workflow", prompt: DEVELOPMENT_WORKFLOW_INSTRUCTIONS, reusable: false },
          { id: "direct-user-evidence", prompt: directUserIntentContext?.prompt ?? "", reusable: false },
          { id: "global-preferences", prompt: globalPreferenceContext?.prompt ?? "", reusable: false },
          ...(baseContext?.contextSections ?? [{ id: "base-context", prompt: baseContext?.prompt ?? "", reusable: true }]),
          { id: "tool-discovery", prompt: discoveryContext?.prompt ?? "", reusable: true },
          { id: "skill-routing", prompt: skillRoutingContext.prompt, reusable: true },
          { id: "presentation", prompt: presentationContext.prompt, reusable: true },
          { id: "mentions", prompt: mentionContext?.prompt ?? "", reusable: false },
          { id: "memory-recall", prompt: memoryContext?.prompt ?? "", reusable: false }
        ],
        memoryRecall: memoryContext?.memoryRecall ?? null,
        globalPreferenceRecall: globalPreferences
      };
    },
    observeMemoryDispatch: (recall, status) => memoryRecallService.markInjection?.(recall, status),
    bindCreatedSession: async ({ providerId, session, input, context }) => {
      persistProviderSessionProjection(store, session, {
        providerId,
        agentId: input.toolHost?.actorId ?? context.actorId ?? null,
        sessionKind: input.sessionKind,
        workId: context.workId ?? null,
        taskId: context.taskId ?? null
      });
      ensureCollaborationAgentForSession(session, input.toolHost?.actorId ?? context.actorId);
      const logical = await ensureLogicalRouteForProviderSession(session, providerId, {
        instructionSources: input.instructionSources,
        runtimeWorkspaceRoots: input.runtimeWorkspaceRoots,
        approvalPolicy: input.approvalPolicy,
        sandbox: input.sandbox
      });
      if (context.source === "coordination-request" && logical) {
        const request = store.selectOne("SELECT * FROM coordination_requests WHERE request_id=?", [context.requestId]);
        if (!request || request.main_session_id !== context.shadowOwnerSessionId || request.parent_task_id !== context.taskId || request.shadow_session_id)
          throw Object.assign(new Error("Request reservation changed"), { code: "REQUEST_RESERVATION_CHANGED" });
        store.db.run("UPDATE coordination_requests SET shadow_session_id=?,updated_at=? WHERE request_id=? AND shadow_session_id IS NULL",
          [logical.logicalSessionId, new Date().toISOString(), context.requestId]);
        store.scheduleSave();
      }
      if (context.source === "coordination-shadow" && context.shadowOwnerSessionId && logical) {
        const delegation = store.selectOne("SELECT * FROM coordination_shadow_sessions WHERE main_session_id=?", [context.shadowOwnerSessionId]);
        if (!delegation || delegation.parent_task_id !== context.taskId || delegation.shadow_session_id) {
          throw Object.assign(new Error("Shadow creation no longer owns this reservation."), { code: "SHADOW_RESERVATION_CHANGED" });
        }
        store.db.run("UPDATE coordination_shadow_sessions SET shadow_session_id=?,state='ready',updated_at=? WHERE main_session_id=? AND shadow_session_id IS NULL",
          [logical.logicalSessionId, new Date().toISOString(), context.shadowOwnerSessionId]);
        store.scheduleSave();
      }
      return logical ? {
        sessionId: logical.legacySessionId,
        logicalSessionId: logical.logicalSessionId,
        bindingId: logical.activeBinding?.bindingId ?? null,
        routingVersion: logical.routingVersion,
        providerId,
        providerSessionId: logical.activeBinding?.providerSessionId ?? null,
        session: store.getSession(logical.legacySessionId)
          ?? sessionWithLogicalWorkspace(session, logical)
      } : null;
    },
    persistRenamedSession: async ({ reference, title, providerSession }) => {
      const stored = store.renameSession(reference.sessionId, title);
      return stored ? {
        ...providerSession,
        ...stored,
        external: providerSession?.external ?? stored.external
      } : providerSession;
    },
    persistModelSelection: (input) => persistSessionModelSelection(store, input),
    removeSessionBinding: async ({ reference }) => {
      // All local ownership, routing and list/timeline tombstones form one
      // commit. A late write failure must not strand a live Session behind a
      // deleted logical route (or publish intermediate list invalidations).
      store.runInTransaction(() => {
        collaborationCore.detachSession(reference.sessionId);
        collaborationCore.detachSession(reference.providerSessionId);
        store.deleteLogicalSessionByLegacySessionId(reference.sessionId);
        store.deleteSession(reference.sessionId);
      });
      emitEvent("SessionDeleted", {
        sessionId: reference.sessionId,
        logicalSessionId: reference.logicalSessionId,
        provider: reference.providerId
      }, { detachedSession: true });
    }
  });
  return sessionApplicationService;
}
