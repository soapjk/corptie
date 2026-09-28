import { activeStoredSessionProjections } from "./providerSessionProjection.mjs";
import { sortSessionsForList, withLastMessageTimestamp, withSessionMessageCursors } from "./sessionListPresentation.mjs";
import { presentProjectIntegrationRun } from "./projectWorktreeIntegrationService.mjs";
import { presentTaskAcceptance } from "./taskAcceptance.mjs";

// Read-only control-plane projection shared by snapshots and incremental reads.
// Provider callbacks, not this reader, own durable projection repair.
export function createControlPlaneProjection({ store, environmentName, decorateSessionForClient }) {
  function controlPlaneSnapshot() {
    // Strictly read the durable projection. Provider callbacks own writes before
    // publishing wake events; a client snapshot/detail read is never a repair
    // hook. Provider transport caches must not be reachable from this path.
    // Archived Sessions are deliberately absent from the resident global state
    // stream. Their durable rows and Timeline remain available through the
    // explicit archived list/detail endpoints and rejoin this projection when
    // restored. Keeping them here made every archived row a permanent client
    // subscription despite the active-only synchronization contract.
    const persisted = activeStoredSessionProjections(store);
    const residentSessionIds = persisted.map((session) => session.id);
    const latestMessageTimes = store.listLatestSessionMessageTimes(residentSessionIds);
    const messageCursors = store.listSessionMessageCursors(residentSessionIds);
    const timelineRevisions = store.listSessionTimelineRevisions(residentSessionIds);
    const residentTasks = store.listTasks({ includeCompleted: false });
    const pendingScheduledWakeTaskIds = new Set(store.listTaskIdsWithPendingScheduledWake({
      environment: environmentName
    }));
    const pendingWakeSessionIds = new Set(store.listSessionIdsWithPendingScheduledWake({ environment: environmentName }));
    const sessionsById = new Map(persisted.map((session) => [
      session.id,
      presentControlPlaneSession(session, {
        hasPendingScheduledWake: pendingWakeSessionIds.has(session.id),
        latestMessageTime: latestMessageTimes.get(session.id),
        messageCursor: messageCursors.get(session.id),
        timelineRevision: timelineRevisions.get(session.id)
      })
    ]));
    if (process.env.CORPTIE_DEBUG_STATE_SYNC) {
      const openclacky = [...sessionsById.values()].filter((s) => s.id.startsWith("openclacky:"));
      const detail = openclacky.map((s) => `${s.id.slice(10, 18)}:${s.status}`).join(",");
      console.log(`[snapshot] sessions=${sessionsById.size} tasks=${residentTasks.length} ` +
        `openclacky=[${detail}]`);
    }
    return {
      sessions: sortSessionsForList([...sessionsById.values()]),
      // Completed Work Items are cold history. The Work Room loads them through
      // the explicit 50-row Task cursor API only when the user opens that view.
      tasks: residentTasks.map((task) => presentTaskForClient(task, pendingScheduledWakeTaskIds)),
      works: store.listWorks(),
      agents: store.listAgents().map((agent) => ({
        ...agent,
        skillIds: store.listRegistrySkillIdsForAgent(agent.agentId)
      })),
      skills: store.listRegistrySkills(),
      repositories: store.listGitRepositories(),
      integrationRuns: store.listProjectIntegrationRuns(50).map((run) => (
        presentProjectIntegrationRun(run, {
          resolveTask: (taskId) => store.getTask(taskId)
        })
      ))
    };
  }

  function presentControlPlaneSession(session, {
    hasPendingScheduledWake = store.listSessionIdsWithPendingScheduledWake({
      environment: environmentName, sessionId: session.id
    }).length > 0,
    latestMessageTime = null,
    messageCursor = null,
    timelineRevision = 0
  } = {}) {
    return withSessionMessageCursors(
      withLastMessageTimestamp({ ...decorateSessionForClient(session), hasPendingScheduledWake }, latestMessageTime),
      messageCursor,
      timelineRevision
    );
  }

  function readControlPlaneEntity(entityType, entityId) {
    switch (entityType) {
      case "session": {
        const session = store.getSession(entityId);
        if (!session || session.archived === true) return null;
        return presentControlPlaneSession(session, {
          latestMessageTime: store.listLatestSessionMessageTimes([entityId]).get(entityId),
          messageCursor: store.listSessionMessageCursors([entityId]).get(entityId),
          timelineRevision: store.sessionTimelineRevision(entityId)
        });
      }
      case "task": {
        const task = store.getTask(entityId);
        return task && task.lifecycle_state !== "done" ? presentTaskForClient(task) : null;
      }
      case "work": return store.getWork(entityId);
      case "agent": {
        const agent = store.getAgent(entityId);
        return agent ? { ...agent, skillIds: store.listRegistrySkillIdsForAgent(agent.agentId) } : null;
      }
      case "skill": return store.getRegistrySkill(entityId);
      case "repository": return store.getGitRepository(entityId);
      case "integrationRun": {
        const run = store.getProjectIntegrationRun(entityId);
        return run ? presentProjectIntegrationRun(run, {
          resolveTask: (taskId) => store.getTask(taskId)
        }) : null;
      }
      default: return null;
    }
  }

  function presentTaskForClient(task, pendingScheduledWakeTaskIds = null) {
    return presentTaskAcceptance(task, {
      hasPendingScheduledWake: pendingScheduledWakeTaskIds
        ? pendingScheduledWakeTaskIds.has(task.id)
        : store.hasPendingScheduledWakeForTask(task.id, { environment: environmentName })
    });
  }

  return { controlPlaneSnapshot, readControlPlaneEntity, presentTaskForClient };
}
