import { deviceError } from "./clientDeviceAuthority.mjs";

const projectors = {
  works: row => ({ id: row.id, name: row.name, status: row.status, updatedAt: row.updated_at }),
  tasks: row => ({ id: row.id, title: row.title, workId: row.work_id,
    lifecycleState: row.lifecycle_state, executionStatus: row.execution_status,
    currentSessionId: row.current_session_id ?? null, updatedAt: row.updated_at }),
  sessions: row => ({ id: row.id, title: row.title, workId: row.workId ?? null,
    taskId: row.taskId ?? null, sessionKind: row.sessionKind, executionStatus: row.executionStatus ?? row.status,
    updatedAt: row.updatedAt }),
};

/** Read-only v1 inventory. Explicit projection; never expose paths, credentials, or Provider payloads. */
export class ClientReadAPI {
  constructor(store) { this.store = store; }
  list(kind, parameters) {
    if (!Object.hasOwn(projectors, kind)) throw deviceError("ROUTE_NOT_AVAILABLE", 404);
    if ([...parameters.keys()].some(key => !["limit", "cursor"].includes(key))
        || parameters.getAll("limit").length > 1 || parameters.getAll("cursor").length > 1) throw deviceError("INVALID_QUERY", 400);
    const rawLimit = parameters.get("limit") ?? "50";
    if (!/^[1-9][0-9]?$|^100$/.test(rawLimit)) throw deviceError("INVALID_LIMIT", 400);
    const limit = Number(rawLimit);
    let cursor = null;
    const encoded = parameters.get("cursor");
    if (encoded != null) {
      try {
        if (!/^[A-Za-z0-9_-]{1,2048}$/.test(encoded)) throw new Error();
        const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
        cursor = value.position;
        if (value.kind !== kind || value.version !== 1 || typeof cursor?.id !== "string" || cursor.id.length > 512
          || typeof cursor.updatedAt !== "string" || cursor.updatedAt.length > 64
          || (kind === "tasks" && ![0, 1].includes(cursor.completionRank))) throw new Error();
      } catch { throw deviceError("INVALID_CURSOR", 400); }
    }
    const page = kind === "works" ? this.store.listClientWorkPage({ limit, cursor })
      : kind === "tasks" ? this.store.listTaskPage({ limit, cursor, includeCompleted: true })
        : this.store.listSessionPage({ limit, cursor, archived: false });
    return { schemaVersion: 1, items: page.items.map(projectors[kind]), hasMore: page.hasMore,
      nextCursor: page.nextCursor ? Buffer.from(JSON.stringify({ version: 1, kind, position: page.nextCursor })).toString("base64url") : null };
  }
}
