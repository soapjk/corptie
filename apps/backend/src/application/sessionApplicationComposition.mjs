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

// Product policy wired into the common Session service. Later-created services
// enter through narrow deferred operations to preserve startup dependency order.
export function createSessionApplicationComposition({
  store, agentProviderRegistry, sessionBindingRepository, toolHostService, toolMaterializationPort,
  requiredToolDomainsForSession, assertForkDispatchAllowed, assertSessionRecoveryMessageBoundary,
  recoverSession, requireSessionReference, workChatContextService, resolveContextReferences,
  artifactService, memoryRecallService, mcpAssignmentRevisionForAgent,
  ensureCollaborationAgentForSession, ensureLogicalRouteForProviderSession,
  sessionWithLogicalWorkspace, collaborationCore, emitEvent
}) {
  const sessionApplicationService = new SessionApplicationService({
    registry: agentProviderRegistry,
    observeLifecycle: ({ type, sessionId, ...payload }) => {
      console.info(`[session-lifecycle] ${JSON.stringify({ type, sessionId, ...payload })}`);
      emitEvent(type, payload, { sessionId });
    },
    toolHostService,
    toolMaterializationPort,
    resolveRequiredToolDomains: requiredToolDomainsForSession,
    resolveSessionReference: (sessionId) => sessionBindingRepository.resolve(sessionId),
    resolveSessionBinding: (sessionId, bindingId) => sessionBindingRepository.resolveBinding(sessionId, bindingId),
    assertMessageDispatchAllowed: (reference) => {
      assertForkDispatchAllowed(reference.sessionId);
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
      let baseContext = null;
      let referenceContext = null;
      if (session?.sessionKind === "workChat" && session.workId) {
        baseContext = workChatContextService.build(session.workId, session);
        referenceContext = await resolveContextReferences(reference.sessionId, { characterBudget: 4_096 });
        if (referenceContext?.prompt) {
          baseContext = { ...baseContext, prompt: `${baseContext.prompt}\n\n${referenceContext.prompt}` };
        }
      } else if (session?.sessionKind === "assistantChat") {
        baseContext = await resolveContextReferences(reference.sessionId);
        baseContext = {
          ...baseContext,
          prompt: [sessionResponsibilityInstructions("assistantChat"), baseContext?.prompt].filter(Boolean).join("\n\n")
        };
      } else if (session?.sessionKind === "worker") {
        const ownership = store.assertLogicalWorkSessionBinding(reference.logicalSessionId);
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
          artifactIndex: artifactService.indexForSession(session),
          startupReceipt: startupReceiptRow ? JSON.parse(startupReceiptRow.receipt_json) : null,
          toolDomains: appliedToolDomainIds(toolMaterialization),
          toolCatalogVersion: toolMaterialization?.appliedCatalogVersion ?? null
        });
        referenceContext = await resolveContextReferences(reference.sessionId, { characterBudget: 4_096 });
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
      const globalPreferences = recallScope
        ? memoryRecallService?.globalPreferences?.(recallScope) : null;
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
          ? await memoryRecallService.startup(recallScope, { excludeIds })
          : await memoryRecallService.turn(conversationMessageText(messageContext.message), recallScope,
            { deepRecall: messageContext.deepRecall === true, excludeIds });
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
      const skillRoutingContext = skillMcpTurnContext(
        mcpAssignmentRevisionForAgent(session?.agentId)
      );
      // Refresh presentation capabilities at Turn boundaries, including already
      // running/resumed Sessions whose Provider thread predates this contract.
      const presentationContext = { prompt: `<corptie_message_presentation>\n${CHART_PRESENTATION_INSTRUCTIONS}\n</corptie_message_presentation>` };
      const contexts = [baseContext, globalPreferenceContext, skillRoutingContext,
        presentationContext, mentionContext, directUserIntentContext, memoryContext]
        .filter((item) => item?.prompt);
      const recordInjection = (globalIncluded, recallIncluded) => {
        if (globalPreferences) memoryRecallService.markInjection?.(globalPreferences,
          globalIncluded ? "context_included" : "budget_omitted");
        if (!recallDecision) return;
        const status = recallDecision.memories.length === 0 ? "not_selected"
          : recallIncluded ? "context_included" : "budget_omitted";
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
          requiredContexts: [globalPreferenceContext, skillRoutingContext, presentationContext].filter(Boolean)
        });
        recordInjection(Boolean(result), Boolean(result.memoryRecall));
        return { ...result, globalPreferenceRecall: globalPreferences };
      }
      recordInjection(true, Boolean(memoryContext));
      if (contexts.length === 1) return { ...contexts[0], globalPreferenceRecall: globalPreferences };
      return {
        ...baseContext,
        prompt: contexts.map((item) => item.prompt).join("\n\n"),
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
      collaborationCore.detachSession(reference.sessionId);
      collaborationCore.detachSession(reference.providerSessionId);
      store.deleteLogicalSessionByLegacySessionId(reference.sessionId);
      store.deleteSession(reference.sessionId);
      emitEvent("SessionDeleted", {
        sessionId: reference.sessionId,
        logicalSessionId: reference.logicalSessionId,
        provider: reference.providerId
      }, { detachedSession: true });
    }
  });
  return sessionApplicationService;
}
