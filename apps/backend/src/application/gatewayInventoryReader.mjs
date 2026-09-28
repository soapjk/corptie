import { basename, isAbsolute, resolve } from "node:path";
import { visibleStoredSessionProjections } from "./providerSessionProjection.mjs";

// Read-only inventory shared by external gateway surfaces. Canonical workspace
// paths deduplicate active/archived Session history without replacing favorites.
export function createGatewayInventoryReader({ store, decorateSessionForClient, now }) {
  function listGatewaySessions(options = {}) {
    return visibleStoredSessionProjections(
      store,
      store.listSessions({ archived: options.archived === true })
    ).map((session) => decorateSessionForClient({
      ...session,
      sessionKind: session.sessionKind ?? "legacy"
    }));
  }

  function listGatewaySessionPage(options = {}) {
    const page = store.listSessionPage(options);
    return {
      ...page,
      items: page.items.map((session) => decorateSessionForClient({
        ...session,
        sessionKind: session.sessionKind ?? "legacy"
      }))
    };
  }


  function describeGatewaySession(session) {
    const task = session.taskId
      ? store.getTask(session.taskId)
      : store.getTaskBySessionId(session.id);
    const agentId = session.agentId ?? task?.main_agent_id ?? null;
    const agent = agentId ? store.getAgent(agentId) : null;
    return {
      agentName: agent?.name ?? agentId,
      taskTitle: task?.title ?? null,
      taskStatus: task?.status ?? null
    };
  }

  function listGatewayWorkspaces() {
    const candidates = visibleStoredSessionProjections(store, [
      ...store.listSessions({ archived: false }),
      ...store.listSessions({ archived: true })
    ]);
    const workspaces = new Map();
    for (const path of store.settings().gateway?.trustedWorkspaces ?? []) {
      if (!isAbsolute(path)) continue;
      const canonicalPath = resolve(path);
      workspaces.set(canonicalPath, {
        path: canonicalPath,
        name: basename(canonicalPath) || canonicalPath,
        updatedAt: now(),
        favorite: true
      });
    }
    for (const session of candidates) {
      const cwd = typeof session.external?.cwd === "string" ? session.external.cwd.trim() : "";
      if (!cwd || !isAbsolute(cwd)) continue;
      const canonicalPath = resolve(cwd);
      const previous = workspaces.get(canonicalPath);
      if (!previous || (!previous.favorite && Date.parse(session.updatedAt ?? 0) > Date.parse(previous.updatedAt ?? 0))) {
        workspaces.set(canonicalPath, {
          path: canonicalPath,
          name: basename(canonicalPath) || canonicalPath,
          updatedAt: session.updatedAt ?? session.createdAt ?? now()
        });
      }
    }
    return Array.from(workspaces.values()).sort((left, right) =>
      Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
    );
  }

  return { listGatewaySessions, listGatewaySessionPage, describeGatewaySession, listGatewayWorkspaces };
}
