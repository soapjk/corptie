import { SessionProviderSwitchCoordinator } from "../../application/sessionProviderSwitchCoordinator.mjs";
import { AGENT_PROVIDER_CAPABILITIES } from "../contracts.mjs";
import { desiredToolDomainIds } from "../../application/sessionToolBindingProjection.mjs";
import { sessionHasActiveRun } from "../../utils/sessionPresentation.mjs";

// Wiring for route replacement, not a new lifecycle authority. Provider-native
// empty-thread proof remains narrowly scoped to the existing Codex protocol.
export function createSessionProviderSwitchComposition({
  store, agentProviderRegistry, sessionBindingRepository, collaborationCore,
  ensureCollaborationAgentForSession, toolHostService, sessionApplicationService,
  codexRuntime, prospectiveToolHostBinding, toolHostMaterializationCoordinator, emitEvent
}) {
  return new SessionProviderSwitchCoordinator({
    store,
    registry: agentProviderRegistry,
    resolveSessionReference: (sessionId) => sessionBindingRepository.resolve(sessionId),
    hasActiveRun: (session) => sessionHasActiveRun(session),
    resolveTargetContext: async ({ reference, logical, providerId }) => {
      const session = reference.metadata?.session ?? store.getSession(reference.sessionId);
      const agent = collaborationCore.getAgentForSession(reference.sessionId)
        ?? ensureCollaborationAgentForSession(session);
      const sourceMaterialization = logical?.activeBinding?.bindingId
        ? store.getSessionToolCatalogMaterialization(
            logical.logicalSessionId,
            logical.activeBinding.bindingId
          )
        : null;
      const preservedDomains = desiredToolDomainIds(sourceMaterialization);
      const desiredToolDomains = preservedDomains.length > 0
        ? preservedDomains
        : session?.sessionKind === "worker" ? ["artifacts"] : [];
      const toolHostContext = {
        purpose: "provider-switch",
        actorId: agent?.agentId ?? null,
        sessionId: reference.sessionId,
        logicalSessionId: logical.logicalSessionId,
        sessionKind: session?.sessionKind ?? "legacy",
        workId: session?.workId ?? null,
        taskId: session?.taskId ?? null,
        desiredToolDomains
      };
      const preparedToolHost = await toolHostService.prepareSession(providerId, toolHostContext);
      const providerAttachment = preparedToolHost?.providerAttachment ?? null;
      return {
        agentId: agent?.agentId ?? null,
        sessionKind: session?.sessionKind ?? "legacy",
        instructionSummary: summarizeProviderInstructionSources(logical),
        desiredToolDomains,
        toolHostContext,
        preparedToolHost,
        dynamicTools: providerAttachment?.dynamicTools,
        dynamicToolAgentId: providerAttachment?.dynamicToolAgentId ?? agent?.agentId ?? null,
        dynamicToolMetadata: providerAttachment?.dynamicToolMetadata ?? null
      };
    },
    createTargetSession: async ({
      providerId, title, cwd, agentId, instructionSummary, sessionKind,
      input, preparedToolHost, toolHostContext
    }) => {
      const created = await sessionApplicationService.createSessionForRouteTransition(providerId, {
        ...(input ?? {}),
        title,
        cwd,
        instructionSources: instructionSummary ? [instructionSummary] : [],
        sessionKind
      }, {
        ...(toolHostContext ?? {}),
        purpose: "provider-switch",
        actorId: agentId ?? null,
        sessionKind,
        preparedToolHost
      });
      return {
        providerThreadId: created?.external?.threadId ?? created?.external?.sessionId ?? created?.id ?? null,
        providerSessionId: created?.external?.sessionId
          ?? created?.external?.threadId
          ?? created?.id
          ?? null,
        sessionProjection: created
      };
    },
    resumeTargetSession: async (input) => {
      const sourceSession = store.getSession(
        input.sourceLogical?.legacySessionId ?? input.context?.toolHostContext?.sessionId
      );
      const targetProjection = {
        ...(sourceSession ?? {}),
        status: "complete",
        summary: "Provider Session recovered for route commit.",
        external: {
          ...(sourceSession?.external ?? {}),
          provider: input.providerId,
          threadId: input.providerThreadId,
          sessionId: input.providerSessionId,
          cwd: input.sourceLogical?.activeBinding?.boundCwd ?? sourceSession?.external?.cwd ?? null
        }
      };
      const preparedToolHost = input.context?.preparedToolHost ?? null;
      const providerAttachment = input.dynamicToolConfirmation && preparedToolHost?.providerAttachment
        ? {
            ...preparedToolHost.providerAttachment,
            dynamicToolConfirmation: input.dynamicToolConfirmation
          }
        : preparedToolHost?.providerAttachment;
      if (input.providerId === "codex-app-server") {
        try {
          await codexRuntime.inspectEmptyThreadForRouteCommit(input.providerThreadId, {
            cwd: input.sourceLogical?.activeBinding?.boundCwd ?? sourceSession?.external?.cwd ?? undefined,
            runtimeWorkspaceRoots: input.sourceLogical?.activeBinding?.boundCwd
              ? [input.sourceLogical.activeBinding.boundCwd]
              : undefined,
            ...(providerAttachment ?? {})
          });
          return {
            providerThreadId: input.providerThreadId,
            providerSessionId: input.providerSessionId,
            sessionProjection: targetProjection
          };
        } catch (error) {
          if (error?.code !== "PROVIDER_EMPTY_THREAD_UNRECOVERABLE" || error?.safeToRecreate !== true) {
            throw error;
          }
          const recreated = await sessionApplicationService.createSessionForRouteTransition(
            input.providerId,
            {
              title: input.sourceLogical?.title ?? sourceSession?.title ?? "Recovered Provider Session",
              cwd: input.sourceLogical?.activeBinding?.boundCwd ?? sourceSession?.external?.cwd,
              instructionSources: input.context?.instructionSummary
                ? [input.context.instructionSummary]
                : [],
              sessionKind: input.context?.sessionKind ?? sourceSession?.sessionKind ?? "legacy"
            },
            {
              ...(input.context?.toolHostContext ?? {}),
              purpose: "provider-switch-recreate-empty-target",
              preparedToolHost
            }
          );
          const providerThreadId = recreated?.external?.threadId
            ?? recreated?.external?.sessionId
            ?? recreated?.id
            ?? null;
          if (!providerThreadId) throw error;
          return {
            providerThreadId,
            providerSessionId: recreated?.external?.sessionId ?? providerThreadId,
            sessionProjection: recreated,
            replacedUnrecoverableTarget: true,
            previousProviderThreadId: input.providerThreadId
          };
        }
      }
      const resumed = await agentProviderRegistry.invoke(
        input.providerId,
        AGENT_PROVIDER_CAPABILITIES.SESSION_RESUME,
        {
          sessionId: sourceSession?.id ?? input.context?.toolHostContext?.sessionId ?? input.logicalSessionId,
          logicalSessionId: input.logicalSessionId,
          providerId: input.providerId,
          providerSessionId: input.providerSessionId,
          routingVersion: Number(input.transition?.sourceRoutingVersion ?? 0) + 1,
          metadata: { session: targetProjection }
        },
        {
          ...(input.context?.toolHostContext ?? {}),
          purpose: "provider-switch-recovery",
          toolHost: preparedToolHost
            ? { ...preparedToolHost, providerAttachment }
            : null
        }
      );
      return {
        providerThreadId: input.providerThreadId,
        providerSessionId: input.providerSessionId,
        sessionProjection: resumed ?? targetProjection
      };
    },
    confirmToolSchema: ({ providerThreadId, dynamicTools }) => (
      codexRuntime.confirmThreadToolPlan(providerThreadId, dynamicTools)
    ),
    prepareToolMaterialization: async (input) => {
      const session = input.sessionId ? store.getSession(input.sessionId) : null;
      const source = input.sourceBinding?.bindingId
        ? store.getSessionToolCatalogMaterialization(input.logicalSessionId, input.sourceBinding.bindingId)
        : null;
      const replacement = {
        binding: prospectiveToolHostBinding({
          logicalSessionId: input.logicalSessionId,
          binding: input.binding,
          session
        }),
        desiredDomains: desiredToolDomainIds(source)
      };
      return input.requiresApplied === true
        ? toolHostMaterializationCoordinator.prepareAppliedReplacement({
            ...replacement,
            providerConfirmation: input.dynamicToolConfirmation
          })
        : toolHostMaterializationCoordinator.prepareDesiredReplacement(replacement);
    },
    finalizeCommittedTarget: async (input) => (
      sessionApplicationService.ensureActiveBindingToolsReady(
        input.logicalSessionId,
        {
          purpose: input.purpose,
          desiredToolDomains: input.desiredToolDomains,
          expectedLogicalSessionId: input.logicalSessionId,
          expectedProviderBindingId: input.providerBindingId,
          expectedProviderSessionId: input.providerSessionId,
          expectedRoutingVersion: input.routingVersion,
          activeTurn: false
        }
      )
    ),
    onTransitionEvent: (type, payload) => emitEvent(type, payload, { sessionId: payload.sessionId })
  });
}

function summarizeProviderInstructionSources(logical) {
  const sources = logical?.activeBinding?.instructionSources ?? [];
  if (!sources.length) return null;
  const text = sources
    .map((source) => {
      if (typeof source === "string") return source;
      if (source?.title) return source.title;
      if (source?.summary) return source.summary;
      if (source?.path) return source.path;
      return null;
    })
    .filter(Boolean)
    .join("\n");
  return text || null;
}
