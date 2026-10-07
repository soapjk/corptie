import { HostToolCatalog } from "./hostToolCatalog.mjs";
import { memoryDynamicTools, callMemoryDynamicTool } from "./memoryDynamicTools.mjs";
import { artifactDynamicTools, authorizeArtifactDynamicTool, callArtifactDynamicTool } from "./artifactDynamicTools.mjs";
import { workspaceDynamicTools } from "../runtime/workspaceDynamicTools.mjs";
import { createProjectCodeHostNamespace } from "../project-code/projectCodeDynamicTools.mjs";
import { collaborationDynamicTools, callCollaborationDynamicTool } from "../collaboration/collaborationDynamicTools.mjs";
import { authorizeCollaborationTool } from "../collaboration/collaborationToolAuthorization.mjs";
import { CollaborationHttpClient } from "../mcp/collaborationHttpClient.mjs";
import { skillDynamicTools, callSkillDynamicTool } from "./skillDynamicTools.mjs";
import { scheduledSessionTaskDynamicTools, callScheduledSessionTaskDynamicTool } from "./scheduledSessionTaskDynamicTools.mjs";
import { taskAcceptanceDynamicTools, callTaskAcceptanceDynamicTool } from "./taskAcceptanceDynamicTools.mjs";
import { platformDynamicTools, callPlatformDynamicTool } from "./platformDynamicTools.mjs";
import { workChatDynamicTools, callWorkChatDynamicTool } from "./workChatDynamicTools.mjs";
import { sceneDynamicTools, callSceneDynamicTool } from "../scenes/sceneDynamicTools.mjs";
import { contextReadDynamicTools, callContextReadDynamicTool } from "./contextReadDynamicTools.mjs";
import { integrationRegistryDynamicTools, callIntegrationRegistryDynamicTool } from "./integrationRegistryDynamicTools.mjs";

export function createHostToolCatalog({
  memoryOperationService, artifactService, callWorkspaceDynamicTool,
  validateProjectCodeHostRoute, getProjectCodeApplicationService,
  sessionCollaborationV2Enabled, port, skillRegistryService,
  scheduledSessionTaskService, getBoundTaskForAgent,
  reportTaskAcceptanceForAgent, completeTaskForSession,
  reviseTaskForSession, sceneService,
  getToolMaterializationPort, getPlatformOperationService,
  getWorkChatOperationService, contextReadService, mcpRegistryService, onIntegrationChanged
}) {
  return new HostToolCatalog([
    {
      id: "integration-registry",
      tools: integrationRegistryDynamicTools,
      authorize: ({ actorId, metadata }) => Boolean(actorId && metadata?.sessionId),
      execute: (input) => callIntegrationRegistryDynamicTool({ mcpRegistryService,
        skillRegistryService, onChanged: onIntegrationChanged }, input)
    },
    {
      id: "memory",
      tools: memoryDynamicTools,
      execute: (input) => callMemoryDynamicTool(memoryOperationService, input)
    },
    {
      id: "artifacts",
      domainRevision: "2",
      tools: artifactDynamicTools,
      authorize: authorizeArtifactDynamicTool,
      execute: (input) => callArtifactDynamicTool(artifactService, input, {
        toolMaterializationPort: getToolMaterializationPort()
      })
    },
    {
      id: "workspace",
      tools: workspaceDynamicTools,
      execute: (input) => callWorkspaceDynamicTool(input)
    },
    createProjectCodeHostNamespace({
      getService: getProjectCodeApplicationService,
      validateRoute: validateProjectCodeHostRoute
    }),
    {
      id: "collaboration",
      tools: sessionCollaborationV2Enabled
        ? collaborationDynamicTools
        : collaborationDynamicTools.filter((tool) => !tool.name.startsWith("corptie_sessions_")
          && !tool.name.startsWith("corptie_collaboration_tasks_")
          && tool.name !== "corptie_collaboration_capabilities"),
      authorize: authorizeCollaborationTool,
      execute: (input) => {
        const client = new CollaborationHttpClient({
          agentId: input.actorId,
          baseUrl: `http://127.0.0.1:${port}`,
          sessionScope: {
            sessionId: input.metadata?.sessionId,
            workId: input.metadata?.workId,
            taskId: input.metadata?.taskId
          }
        });
        return callCollaborationDynamicTool(client, input.tool, input.arguments);
      }
    },
    {
      id: "skills",
      tools: skillDynamicTools,
      execute: (input) => callSkillDynamicTool(skillRegistryService, input)
    },
    {
      id: "scheduled-tasks",
      tools: scheduledSessionTaskDynamicTools,
      // A Provider may advertise tools before a resumed thread has refreshed
      // its authoritative Session binding. Execution still fails closed.
      authorize: ({ actorId }) => Boolean(actorId),
      execute: (input) => {
        if (!input.metadata?.sessionId || !input.metadata?.logicalSessionId) {
          const error = new Error("Automation tools require an authenticated logical Session binding.");
          error.code = "SESSION_AUTHENTICATION_REQUIRED";
          throw error;
        }
        return callScheduledSessionTaskDynamicTool(scheduledSessionTaskService, input);
      }
    },
    {
      id: "task-acceptance",
      tools: taskAcceptanceDynamicTools,
      execute: (input) => callTaskAcceptanceDynamicTool({
        getBoundTask: getBoundTaskForAgent,
        reportAcceptance: reportTaskAcceptanceForAgent,
        completeTask: completeTaskForSession,
        reviseTask: reviseTaskForSession
      }, input)
    },
    {
      id: "platform",
      tools: platformDynamicTools,
      // Catalog visibility is not authorization. Operations revalidate scope.
      authorize: () => true,
      execute: (input) => callPlatformDynamicTool(getPlatformOperationService(), input)
    },
    {
      id: "work-chat",
      tools: workChatDynamicTools,
      authorize: ({ metadata }) => Boolean(metadata?.sessionId),
      execute: (input) => callWorkChatDynamicTool(getWorkChatOperationService(), input)
    },
    {
      id: "context-read",
      tools: contextReadDynamicTools,
      authorize: ({ metadata }) => Boolean(metadata?.sessionId),
      execute: (input) => callContextReadDynamicTool(contextReadService, input)
    },
    {
      id: "scenes",
      domainId: "scenes",
      domainRevision: "1",
      tools: sceneDynamicTools,
      authorize: ({ metadata }) => Boolean(metadata?.sessionId),
      execute: (input) => callSceneDynamicTool(sceneService, input)
    }
  ]);
}
