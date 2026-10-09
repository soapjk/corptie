import { join } from "node:path";
import { AGENT_PROVIDER_CAPABILITIES } from "../agent-provider/contracts.mjs";
import { startConfiguredDeviceGateway } from "./clientDeviceGateway.mjs";
import { createDeviceSetup } from "./clientDeviceSetup.mjs";
import { ClientReadAPI } from "./clientReadAPI.mjs";
import { ClientInspectorAPI } from "./clientInspectorAPI.mjs";
import { inspectorFileImporter } from "./clientInspectorFiles.mjs";
import { ClientControlReadAPI } from "./clientControlReadAPI.mjs";
import { ClientWorktreeManagementAPI } from "./clientWorktreeManagementAPI.mjs";
import { ClientSessionAPI } from "./clientSessionAPI.mjs";
import { pairedDeviceActor } from "./clientDeviceAuthority.mjs";

export function startClientDeviceGateway({
  store, environmentName, developmentPreview, worktreeIntegrationJobService, projectApplicationService, emitEvent,
  readSessionTimelineWindow, getTimelineReadPool, requireSessionReference, sessionContextReferenceService,
  artifactService, scheduledSessionTaskService, turnObservability, agentProviderRegistry,
  switchSessionProvider, workService, inspectTaskWorktree, reclaimTaskWorktree,
  sendUnifiedSessionMessage, admitReliableMessage, interruptUnifiedSession, cancelQueuedUserMessage, deleteUserMessage, respondUnifiedSessionApproval,
  respondUnifiedSessionUserInput, resolveCollaborationConfirmation, resolveSessionChannelRequest,
  publishStateChangesIfNeeded, workDiscussionService,
  sessionApplicationService, workSessionStartApplicationService, chatResourceService,
  decorateSessionForClient, readSessionUsage, setTaskArchivedForEntityRoutes,
  restartTaskForEntityRoutes, taskDeletionService, clearWorkAvatarFile,
  sessionBindingRepository, createTaskAndSession, getClientDeviceGateway, onReady
}) {
  const startDeviceAccess = process.env.CORPTIE_REMOTE_ACCESS === "1" ? startConfiguredDeviceGateway : createDeviceSetup;
  void startDeviceAccess({ directory: join(store.dataRoot, "client-devices"), preview: developmentPreview,
    readAPI: new ClientReadAPI(store, { environmentName }),
    controlAPI: new ClientControlReadAPI({ lists: {
      automations: () => store.listScheduledSessionTasks({ environment: environmentName }),
      agents: () => store.listAgents(), skills: () => store.listRegistrySkills(),
      repositories: () => worktreeIntegrationJobService.repositories()
    }, repository: id => worktreeIntegrationJobService.repository(id),
    resolveSession: id => store.getLogicalSession(id)?.legacySessionId ?? null }),
    worktreeAPI: new ClientWorktreeManagementAPI({
      worktrees: worktreeIntegrationJobService,
      projects: projectApplicationService,
      emit: emitEvent
    }),
    sessionAPIFactory: () => new ClientSessionAPI({ store,
      searchPage: query => getTimelineReadPool().readUnifiedSearch({ query: query.toString() }), readWindow: readSessionTimelineWindow,
      cancelQueuedMessage: cancelQueuedUserMessage,
      deleteUserMessage,
      quickMessages: sessionId => getTimelineReadPool().readQuickMessages({ sessionId }),
      inspector: new ClientInspectorAPI({ store, resolveSession: requireSessionReference,
        references: sessionContextReferenceService, artifacts: artifactService,
        schedules: scheduledSessionTaskService, observability: turnObservability,
        providers: () => agentProviderRegistry.descriptors().map(descriptor => ({ id: descriptor.id, name: descriptor.displayName,
          available: [AGENT_PROVIDER_CAPABILITIES.SESSION_CREATE, AGENT_PROVIDER_CAPABILITIES.SESSION_RESUME,
            AGENT_PROVIDER_CAPABILITIES.CONVERSATION_SEND].every(capability => agentProviderRegistry.supports(descriptor.id, capability)) })),
        switchProvider: switchSessionProvider, updateTask: (id, fields) => workService.updateTask(id, fields),
        inspectTaskWorktree, reclaimTaskWorktree,
        importFile: inspectorFileImporter({ store, references: sessionContextReferenceService, artifacts: artifactService }) }),
      send: sendUnifiedSessionMessage, admitReliableMessage, stop: interruptUnifiedSession,
      respondToApproval: respondUnifiedSessionApproval,
      respondToUserInput: respondUnifiedSessionUserInput,
      respondToCollaborationConfirmation: resolveCollaborationConfirmation,
      respondToSessionChannelRequest: resolveSessionChannelRequest,
      onReceiptChanged: (deviceId, receipt) => getClientDeviceGateway()?.events.publishReceipt(deviceId, receipt),
      markRead: (sessionId, throughSequence) => {
        const receipt = store.markSessionMessagesRead(sessionId, throughSequence);
        setImmediate(publishStateChangesIfNeeded);
        getClientDeviceGateway()?.events.invalidate({ inventory: true });
        return receipt;
      },
      workDiscussion: {
        options: () => ({ defaultProviderId: agentProviderRegistry.defaultProviderId,
          providers: agentProviderRegistry.descriptors().map(descriptor => ({ id: descriptor.id, name: descriptor.displayName,
            available: [AGENT_PROVIDER_CAPABILITIES.SESSION_CREATE, AGENT_PROVIDER_CAPABILITIES.CONVERSATION_SEND]
              .every(capability => agentProviderRegistry.supports(descriptor.id, capability)) })) }),
        open: input => workDiscussionService.open(input)
      },
      taskCreation: {
        options: async (_id, selectedProviderId) => {
          const required = [AGENT_PROVIDER_CAPABILITIES.SESSION_CREATE, AGENT_PROVIDER_CAPABILITIES.WORKSPACE_BIND,
            AGENT_PROVIDER_CAPABILITIES.SESSION_RESUME, AGENT_PROVIDER_CAPABILITIES.CONVERSATION_SEND];
          const providers = agentProviderRegistry.descriptors().map(descriptor => ({
            id: descriptor.id, name: descriptor.displayName,
            available: required.every(capability => agentProviderRegistry.supports(descriptor.id, capability)),
            supportsModels: agentProviderRegistry.supports(descriptor.id, AGENT_PROVIDER_CAPABILITIES.MODEL_LIST)
          }));
          const defaultProviderId = agentProviderRegistry.defaultProviderId;
          if (!selectedProviderId) return { providers, models: [], defaultProviderId };
          const selected = providers.find(provider => provider.id === selectedProviderId);
          if (!selected?.available) {
            throw Object.assign(new Error("Provider does not support Work Sessions"), { code: "PROVIDER_CAPABILITY_UNAVAILABLE", status: 409 });
          }
          const catalog = selected.supportsModels ? await sessionApplicationService.listModels(selected.id) : {};
          return { providers, defaultProviderId, models: catalog.models ?? [], currentModel: catalog.currentModel ?? null,
            currentReasoningLevel: catalog.currentReasoningLevel ?? null };
        },
        validate: (id, input) => {
          const reference = requireSessionReference(id);
          const logical = store.getLogicalSession(reference.logicalSessionId);
          if (!logical || logical.archived || logical.activeBinding?.state !== "active") {
            throw Object.assign(new Error("Source Session is not active"), { code: "SOURCE_SESSION_NOT_FOUND", status: 409 });
          }
          const providerId = agentProviderRegistry.resolveId(input.providerId);
          if (!providerId || [AGENT_PROVIDER_CAPABILITIES.SESSION_CREATE, AGENT_PROVIDER_CAPABILITIES.WORKSPACE_BIND,
            AGENT_PROVIDER_CAPABILITIES.SESSION_RESUME, AGENT_PROVIDER_CAPABILITIES.CONVERSATION_SEND]
            .some(capability => !agentProviderRegistry.supports(providerId, capability))) {
            throw Object.assign(new Error("Provider does not support Work Sessions"), { code: "PROVIDER_CAPABILITY_UNAVAILABLE", status: 409 });
          }
        },
        create: (id, { taskInput, providerId, model, reasoningLevel, operationID }) => {
          const sourceSessionId = requireSessionReference(id).logicalSessionId;
          return createTaskAndSession({ workService,
            startWorkSession: input => workSessionStartApplicationService.start(input),
            taskInput, sourceSessionId, providerId, model, reasoningLevel, idempotencyKey: operationID,
            creationOrigin: { originType: "session", creatorSessionId: sourceSessionId, operationId: operationID } });
        }
      },
      conversationCommands: {
        list: id => sessionApplicationService.listConversationCommands(id),
        validate: (id, command) => sessionApplicationService.validateConversationCommand(id, command),
        execute: async (id, command, source) => {
          const result = await sendUnifiedSessionMessage(id,
            { text: `/${command.name}${command.arguments ? ` ${command.arguments}` : ""}` }, source);
          return { text: result.warning ?? (result.cleared ? "会话上下文已清空。" : "命令已执行。"),
            messageId: result.commandMessageId, conversationCleared: result.cleared === true };
        }
      },
      schedule: (id, text, schedule, identity) => scheduledSessionTaskService.create({
        logicalSessionId: requireSessionReference(id).logicalSessionId,
        name: text.slice(0, 80), message: { text },
        scheduleType: schedule.intervalSeconds ? "interval" : "at",
        runAt: schedule.runAt, expiresAt: schedule.expiresAt,
        ...(schedule.intervalSeconds ? { intervalSeconds: schedule.intervalSeconds } : {})
      }, pairedDeviceActor(identity)),
      images: {
        available: session => decorateSessionForClient(session).capabilities?.canSendImages === true,
        import: (id, image) => chatResourceService.importImageData(requireSessionReference(id),
          Buffer.from(image.dataBase64, "base64"), image.fileName),
        read: (id, managedPath) => chatResourceService.readImage(requireSessionReference(id), managedPath),
        readResource: (id, itemId, path) => chatResourceService.readMessageResource(requireSessionReference(id), itemId, path)
      },
      composer: {
        read: id => sessionApplicationService.listModelsForSession(id),
        update: async (id, key, value) => {
          const reference = requireSessionReference(id);
          if (key === "model") await sessionApplicationService.switchModel(id, value);
          else await sessionApplicationService.switchReasoning(id, value);
          emitEvent(key === "model" ? "SessionModelChanged" : "SessionReasoningChanged", {
            sessionId: reference.sessionId, logicalSessionId: reference.logicalSessionId, [key]: value
          }, { sessionId: reference.sessionId });
        }
      },
      actions: session => decorateSessionForClient(session).actions ?? {},
      readiness: session => {
        const presented = decorateSessionForClient(session);
        return { readiness: presented.readiness ?? null, notReadyReason: presented.notReadyReason ?? null };
      },
      usage: (sessionId, { requireFreshAccount = false } = {}) =>
        readSessionUsage(sessionId, undefined, { requireFreshAccount }),
      // Same services the desktop entity routes call; the device layer adds permission, DTO and receipt boundaries.
      entityCommands: {
        createWork: input => workService.createWork(input),
        updateTask: (taskId, patch) => workService.updateTask(taskId, patch),
        setTaskArchived: async (taskId, archived) => {
          const task = await setTaskArchivedForEntityRoutes(taskId, archived);
          workService.emit("TaskChanged", task, archived ? "archived" : "unarchived");
          return task;
        },
        restartTask: (taskId, context) => restartTaskForEntityRoutes(taskId, context),
        inspectTaskDeletion: (taskId, actor) => taskDeletionService.inspect(taskId, actor),
        deleteTask: (taskId, input, actor) => taskDeletionService.request(taskId, input, actor),
        updateWork: (workId, patch) => workService.updateWork(workId, patch),
        deleteWork: async workId => {
          await clearWorkAvatarFile(workId, { environmentName });
          return workService.deleteWork(workId);
        }
      },
      resolveSession: id => sessionBindingRepository.resolve(id)?.sessionId
        ?? (store.getSession(id) ? id : null) }) })
    .then(gateway => { onReady(gateway); })
    .catch(() => console.error("[client-devices] remote gateway unavailable; check explicit TLS configuration"));
}
