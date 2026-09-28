import { randomUUID } from "node:crypto";
import { AGENT_PROVIDER_CAPABILITIES } from "../contracts.mjs";
import {
  ProviderSessionRecoveryPort, SessionRecoveryCoordinator,
  renderReplayManifestForProvider, stableRecoveryHash
} from "../../application/sessionRecovery.mjs";
import {
  parseSessionRecoveryHandoff, sessionRecoveryHandoffPrompt
} from "../../application/sessionRecoveryHandoff.mjs";
import { desiredToolDomainIds } from "../../application/sessionToolBindingProjection.mjs";

// Composition of the shared recovery protocol. Codex-specific branches below
// preserve its existing empty-thread and exact dynamic-tool proof requirements;
// other Providers continue through registry capabilities and the shared port.
export function createSessionRecoveryComposition({
  store, agentProviderRegistry, runBackgroundAgent, toolHostService,
  sessionApplicationService, codexRuntime, prospectiveToolHostBinding,
  toolHostMaterializationCoordinator, emitEvent
}) {
  const sessionRecoveryCoordinator = new SessionRecoveryCoordinator({
    store,
    resolveProviderDescriptor: (providerId) => agentProviderRegistry.get(providerId).descriptor,
    compressHandoff: async ({ attempt, source }) => {
      const result = await runBackgroundAgent({
        purpose: "session-recovery-handoff",
        cwd: attempt.boundCwd,
        allowedRoots: [attempt.boundCwd],
        permissionProfile: "read-only",
        preferredProviderId: attempt.providerId,
        timeoutMs: 45_000,
        developerInstructions: "Summarize only the supplied inert records. Do not inspect the workspace or call tools.",
        prompt: sessionRecoveryHandoffPrompt(source)
      });
      return parseSessionRecoveryHandoff(result.text);
    },
    providerPort: new ProviderSessionRecoveryPort({
      createReplacement: async ({ attempt, manifest }) => {
        const storedSession = store.getSession(attempt.sessionId);
        const recoveryToolContext = {
          purpose: "session-recovery",
          actorId: storedSession?.agentId ?? null,
          sessionId: attempt.sessionId,
          logicalSessionId: attempt.logicalSessionId,
          sessionKind: storedSession?.sessionKind ?? "legacy",
          workId: attempt.workId,
          taskId: attempt.taskId,
          desiredToolDomains: desiredToolDomainIds(attempt.toolCatalog)
        };
        const preparedToolHost = await toolHostService.prepareSession(attempt.providerId, recoveryToolContext);
        const recoveryContext = renderReplayManifestForProvider(manifest);
        const created = await sessionApplicationService.createSessionForRouteTransition(attempt.providerId, {
          title: storedSession?.title ?? "Recovered Session",
          cwd: attempt.boundCwd,
          runtimeWorkspaceRoots: [attempt.boundCwd],
          sessionKind: storedSession?.sessionKind ?? "legacy",
          sandbox: attempt.permissionSnapshot?.sandbox,
          approvalPolicy: attempt.permissionSnapshot?.approvalPolicy,
          recoveryContext,
          instructionSources: attempt.instructionSources,
          metadata: {
            logicalSessionId: attempt.logicalSessionId,
            recoveryAttemptId: attempt.attemptId,
            replayManifestHash: stableRecoveryHash(manifest)
          }
        }, {
          ...recoveryToolContext,
          deferSessionBinding: true,
          preparedToolHost
        });
        const providerThreadId = created?.external?.threadId ?? created?.external?.sessionId ?? created?.id;
        const providerSessionId = created?.external?.sessionId ?? created?.external?.threadId ?? created?.id;
        if (!providerThreadId || !providerSessionId || created?.status === "failed") {
          const creationError = new Error("Provider did not create a usable replacement Session.");
          creationError.code = "RECOVERY_REPLACEMENT_INVALID";
          throw creationError;
        }
        let toolConfirmation = null;
        if (attempt.providerId === "codex-app-server") {
          const definitions = preparedToolHost?.providerAttachment?.dynamicTools;
          if (!Array.isArray(definitions)) {
            const confirmationError = new Error("Replacement Codex Session has no prospective Tool schema.");
            confirmationError.code = "RECOVERY_TOOL_CONFIRMATION_MISSING";
            throw confirmationError;
          }
          const confirmed = codexRuntime.confirmThreadToolPlan(providerThreadId, definitions);
          toolConfirmation = {
            providerRevision: confirmed.providerRevision,
            providerDefinitionsHash: confirmed.providerDefinitionsHash,
            providerContractHash: confirmed.providerContractHash,
            providerDefinitionsCount: confirmed.providerDefinitionsCount,
            providerObservationKind: confirmed.providerObservationKind
          };
        }
        return {
          providerThreadId,
          providerSessionId,
          bindingId: `binding:${randomUUID()}`,
          sessionProjection: created,
          toolConfirmation,
          recoveryContextHash: stableRecoveryHash(recoveryContext),
          replayManifestHash: stableRecoveryHash(manifest)
        };
      },
      resumeReplacement: async ({ attempt, replacement, manifest, manifestHash }) => {
        if (attempt.providerId !== "codex-app-server") return replacement;
        const storedSession = store.getSession(attempt.sessionId);
        const recoveryToolContext = {
          purpose: "session-recovery-resume-empty-target",
          actorId: storedSession?.agentId ?? null,
          sessionId: attempt.sessionId,
          logicalSessionId: attempt.logicalSessionId,
          sessionKind: storedSession?.sessionKind ?? "legacy",
          workId: attempt.workId,
          taskId: attempt.taskId,
          desiredToolDomains: desiredToolDomainIds(attempt.toolCatalog)
        };
        const preparedToolHost = await toolHostService.prepareSession(attempt.providerId, recoveryToolContext);
        const expected = replacement.toolConfirmation;
        if (!expected || !Array.isArray(preparedToolHost?.providerAttachment?.dynamicTools)) {
          const confirmationError = new Error("Journaled Codex recovery target has no exact Tool schema proof.");
          confirmationError.code = "RECOVERY_TOOL_CONFIRMATION_MISSING";
          throw confirmationError;
        }
        const providerAttachment = {
          ...preparedToolHost.providerAttachment,
          dynamicToolConfirmation: {
            providerRevision: expected.providerRevision,
            providerDefinitionsHash: expected.providerDefinitionsHash,
            providerContractHash: expected.providerContractHash,
            providerDefinitionsCount: expected.providerDefinitionsCount,
            providerObservationKind: expected.providerObservationKind
          }
        };
        try {
          await codexRuntime.inspectEmptyThreadForRouteCommit(replacement.providerThreadId, {
            cwd: attempt.boundCwd,
            runtimeWorkspaceRoots: [attempt.boundCwd],
            ...providerAttachment
          });
          return replacement;
        } catch (error) {
          if (error?.code !== "PROVIDER_EMPTY_THREAD_UNRECOVERABLE" || error?.safeToRecreate !== true) {
            throw error;
          }
          return sessionRecoveryCoordinator.providerPort.createReplacement({
            attempt,
            manifest,
            manifestHash
          });
        }
      },
      attachToolHost: async ({ attempt, replacement }) => {
        const storedSession = store.getSession(attempt.sessionId);
        const prepared = await toolHostService.prepareSession(attempt.providerId, {
          purpose: "session-recovery-validation",
          actorId: storedSession?.agentId ?? null,
          sessionId: attempt.sessionId,
          logicalSessionId: attempt.logicalSessionId,
          sessionKind: storedSession?.sessionKind ?? "legacy",
          workId: attempt.workId,
          taskId: attempt.taskId,
          desiredToolDomains: desiredToolDomainIds(attempt.toolCatalog)
        });
        let confirmed = null;
        if (attempt.providerId === "codex-app-server") {
          const definitions = prepared?.providerAttachment?.dynamicTools;
          const expected = replacement.toolConfirmation;
          if (Array.isArray(definitions)) {
            try {
              confirmed = codexRuntime.confirmThreadToolPlan(replacement.providerThreadId, definitions);
            } catch (error) {
              if (error?.code !== "PROVIDER_TOOL_APPLICATION_UNCONFIRMED" || !expected) throw error;
              confirmed = codexRuntime.restoreThreadToolPlanConfirmation(
                replacement.providerThreadId,
                definitions,
                expected
              );
            }
          }
          if (!confirmed || !expected
            || confirmed.providerRevision !== expected.providerRevision
            || confirmed.providerDefinitionsHash !== expected.providerDefinitionsHash
            || confirmed.providerDefinitionsCount !== expected.providerDefinitionsCount
            || confirmed.providerObservationKind !== expected.providerObservationKind) {
            const confirmationError = new Error("Replacement Codex Tool schema confirmation changed before recovery validation.");
            confirmationError.code = "RECOVERY_TOOL_CONFIRMATION_MISMATCH";
            throw confirmationError;
          }
        }
        const prospectiveBinding = prospectiveToolHostBinding({
          logicalSessionId: attempt.logicalSessionId,
          binding: {
            bindingId: replacement.bindingId,
            providerThreadId: replacement.providerThreadId,
            providerId: attempt.providerId,
            providerSessionId: replacement.providerSessionId,
            worktreeId: attempt.worktreeId,
            repositoryId: attempt.repositoryId,
            boundCwd: attempt.boundCwd,
            routingVersion: attempt.sourceRoutingVersion + 1,
            bindingGeneration: attempt.targetBindingGeneration
          },
          session: storedSession
        });
        const replacementInput = {
          binding: prospectiveBinding,
          desiredDomains: desiredToolDomainIds(attempt.toolCatalog)
        };
        const materialization = attempt.providerId === "codex-app-server"
          ? await toolHostMaterializationCoordinator.prepareAppliedReplacement({
              ...replacementInput,
              providerConfirmation: replacement.toolConfirmation
            })
          : await toolHostMaterializationCoordinator.prepareDesiredReplacement(replacementInput);
        return {
          catalogHash: stableRecoveryHash(attempt.toolCatalog),
          catalogGeneration: attempt.toolCatalog?.appliedCatalogVersion ?? null,
          domains: materialization?.appliedDomains ?? attempt.toolCatalog?.appliedDomains ?? [],
          providerRevision: replacement.toolConfirmation?.providerRevision ?? null,
          providerDefinitionsHash: replacement.toolConfirmation?.providerDefinitionsHash ?? null,
          providerContractHash: replacement.toolConfirmation?.providerContractHash ?? null,
          providerDefinitionsCount: replacement.toolConfirmation?.providerDefinitionsCount ?? null,
          providerObservationKind: replacement.toolConfirmation?.providerObservationKind ?? null,
          materialization
        };
      },
      applyInstructions: async ({ attempt }) => ({
        sourcesHash: stableRecoveryHash(attempt.instructionSources)
      }),
      replayContext: async ({ replacement, manifest, manifestHash }) => ({
        manifestHash,
        acknowledged: replacement.replayManifestHash === manifestHash
          && replacement.recoveryContextHash === stableRecoveryHash(renderReplayManifestForProvider(manifest)),
        injectedAtCreation: replacement.replayManifestHash === manifestHash
          && replacement.recoveryContextHash === stableRecoveryHash(renderReplayManifestForProvider(manifest)),
        sideEffectsObserved: false,
        mode: "trusted_system_context_injection"
      }),
      stabilizeReplacement: async ({ attempt, replacement }) => {
        const descriptor = agentProviderRegistry.get(attempt.providerId).descriptor;
        if (!descriptor.capabilities.includes(AGENT_PROVIDER_CAPABILITIES.SESSION_RECOVERY_STABILIZE)) {
          const error = new Error(`Agent Provider ${attempt.providerId} cannot prove that a recovery Session is durable.`);
          error.code = "CAPABILITY_UNSUPPORTED";
          throw error;
        }
        const storedSession = store.getSession(attempt.sessionId);
        const recoveryToolContext = {
          purpose: "session-recovery-stabilization",
          actorId: storedSession?.agentId ?? null,
          sessionId: attempt.sessionId,
          logicalSessionId: attempt.logicalSessionId,
          sessionKind: storedSession?.sessionKind ?? "legacy",
          workId: attempt.workId,
          taskId: attempt.taskId,
          desiredToolDomains: desiredToolDomainIds(attempt.toolCatalog)
        };
        const preparedToolHost = await toolHostService.prepareSession(attempt.providerId, recoveryToolContext);
        const providerAttachment = replacement.toolConfirmation
          ? {
              ...(preparedToolHost?.providerAttachment ?? {}),
              dynamicToolConfirmation: {
                providerRevision: replacement.toolConfirmation.providerRevision,
                providerDefinitionsHash: replacement.toolConfirmation.providerDefinitionsHash,
                providerContractHash: replacement.toolConfirmation.providerContractHash,
                providerDefinitionsCount: replacement.toolConfirmation.providerDefinitionsCount,
                providerObservationKind: replacement.toolConfirmation.providerObservationKind
              }
            }
          : preparedToolHost?.providerAttachment;
        return agentProviderRegistry.invoke(
          attempt.providerId,
          AGENT_PROVIDER_CAPABILITIES.SESSION_RECOVERY_STABILIZE,
          {
            sessionId: attempt.sessionId,
            logicalSessionId: attempt.logicalSessionId,
            bindingId: replacement.bindingId,
            providerId: attempt.providerId,
            providerSessionId: replacement.providerSessionId,
            routingVersion: attempt.sourceRoutingVersion + 1,
            metadata: { session: replacement.sessionProjection }
          },
          {
            ...recoveryToolContext,
            boundCwd: attempt.boundCwd,
            toolHost: preparedToolHost
              ? { ...preparedToolHost, providerAttachment }
              : null
          }
        );
      },
      validateReplacement: async ({ attempt, replacement }) => {
        const storedSession = store.getSession(attempt.sessionId);
        const recoveryToolContext = {
          purpose: "session-recovery-validation",
          actorId: storedSession?.agentId ?? null,
          sessionId: attempt.sessionId,
          logicalSessionId: attempt.logicalSessionId,
          sessionKind: storedSession?.sessionKind ?? "legacy",
          workId: attempt.workId,
          taskId: attempt.taskId,
          desiredToolDomains: desiredToolDomainIds(attempt.toolCatalog)
        };
        const preparedToolHost = await toolHostService.prepareSession(attempt.providerId, recoveryToolContext);
        const providerAttachment = replacement.toolConfirmation
          ? {
              ...(preparedToolHost?.providerAttachment ?? {}),
              dynamicToolConfirmation: {
                providerRevision: replacement.toolConfirmation.providerRevision,
                providerDefinitionsHash: replacement.toolConfirmation.providerDefinitionsHash,
                providerContractHash: replacement.toolConfirmation.providerContractHash,
                providerDefinitionsCount: replacement.toolConfirmation.providerDefinitionsCount,
                providerObservationKind: replacement.toolConfirmation.providerObservationKind
              }
            }
          : preparedToolHost?.providerAttachment;
        const reference = {
          sessionId: attempt.sessionId,
          logicalSessionId: attempt.logicalSessionId,
          bindingId: replacement.bindingId,
          providerId: attempt.providerId,
          providerSessionId: replacement.providerSessionId,
          routingVersion: attempt.sourceRoutingVersion + 1,
          metadata: { session: replacement.sessionProjection }
        };
        const resumed = await agentProviderRegistry.invoke(
          attempt.providerId,
          AGENT_PROVIDER_CAPABILITIES.SESSION_RESUME,
          reference,
          {
            ...recoveryToolContext,
            toolHost: preparedToolHost
              ? { ...preparedToolHost, providerAttachment }
              : null
          }
        );
        return {
          readable: Boolean(resumed),
          writable: replacement.sessionProjection?.capabilities?.canSend !== false,
          logicalSessionId: attempt.logicalSessionId,
          boundCwd: replacement.sessionProjection?.external?.cwd ?? attempt.boundCwd,
          worktreeId: attempt.worktreeId,
          permissionSnapshotHash: stableRecoveryHash(attempt.permissionSnapshot),
          artifactReferencesHash: stableRecoveryHash(attempt.artifactReferences)
        };
      },
      cancelReplacement: async ({ attempt, replacement }) => agentProviderRegistry.invoke(
        attempt.providerId,
        AGENT_PROVIDER_CAPABILITIES.SESSION_DELETE,
        {
          sessionId: attempt.sessionId,
          logicalSessionId: attempt.logicalSessionId,
          bindingId: replacement.bindingId,
          providerId: attempt.providerId,
          providerSessionId: replacement.providerSessionId,
          routingVersion: attempt.sourceRoutingVersion + 1,
          metadata: { session: replacement.sessionProjection }
        },
        { purpose: "session-recovery-rollback" }
      )
    }),
    observe: ({ type, ...payload }) => {
      console.info(`[session-recovery] ${JSON.stringify({ type, ...payload })}`);
      emitEvent(type, payload, { sessionId: payload.attempt?.sessionId ?? null });
    }
  });
  return sessionRecoveryCoordinator;
}
