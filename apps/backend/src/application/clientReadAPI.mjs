import { stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { deviceError } from "./clientDeviceAuthority.mjs";
import { resolveAgentAvatarsRoot } from "../runtime/agentAvatar.mjs";

const AVATAR_CONTENT_TYPES = {
  ".gif": "image/gif", ".png": "image/png", ".jpeg": "image/jpeg", ".jpg": "image/jpeg",
  ".heic": "image/heic", ".tiff": "image/tiff", ".webp": "image/webp", ".svg": "image/svg+xml",
};

const projectors = {
  // `hasAvatar` is the only avatar signal; bytes travel through `workAvatar()` and the path never leaves the host.
  works: row => ({ id: row.id, name: row.name, status: row.status, hasAvatar: typeof row.avatar_path === "string" && row.avatar_path.length > 0,
    updatedAt: row.updated_at }),
  tasks: (row, store, context) => {
    let boundSession = null;
    if (row.current_session_id) {
      const session = store.getSession(row.current_session_id);
      if (session && session.archived !== true) {
        boundSession = session;
      }
    }
    const executionStatus = boundSession?.executionStatus ?? row.execution_status;
    return {
      id: row.id,
      title: row.title,
      workId: row.work_id,
      lifecycleState: row.lifecycle_state,
      executionStatus,
      currentSessionId: boundSession ? row.current_session_id : null,
      // Presentation-only flags mirrored from the macOS outline (ConsoleScheduledWakeIcon / deleting spinner).
      hasPendingScheduledWake: context.pendingWakeTaskIds.has(row.id),
      deletionStatus: ["deleting", "delete_failed"].includes(row.deletion_status) ? row.deletion_status : null,
      // The desktop outline hides archived Tasks; the device needs the flag to apply the same filter.
      archived: Boolean(row.archived),
      updatedAt: row.updated_at
    };
  },
  sessions: (row, _store, context) => ({ id: row.id, title: row.title, workId: row.workId ?? null,
    taskId: row.taskId ?? null, sessionKind: row.sessionKind, executionStatus: row.executionStatus ?? row.status,
    activityStatus: typeof row.activityStatus === "string" ? row.activityStatus : null,
    // Same read-receipt inputs the desktop unread policy consumes; the device applies the identical rule.
    lastAgentMessageSequence: context.messageCursors.get(row.id)?.lastAgentMessageSequence ?? 0,
    lastReadMessageSequence: context.messageCursors.get(row.id)?.lastReadMessageSequence ?? 0,
    updatedAt: row.updatedAt }),
};

/** Read-only v1 inventory. Explicit projection; never expose paths, credentials, or Provider payloads. */
export class ClientReadAPI {
  constructor(store, options = {}) {
    this.store = store;
    this.avatarsRoot = options.avatarsRoot ?? resolveAgentAvatarsRoot(options).avatarsRoot;
  }
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
    // One wake / read-cursor query per page instead of one per row.
    const context = { pendingWakeTaskIds: new Set(), messageCursors: new Map() };
    if (kind === "tasks" && page.items.length > 0 && typeof this.store.listTaskIdsWithPendingScheduledWake === "function") {
      context.pendingWakeTaskIds = new Set(this.store.listTaskIdsWithPendingScheduledWake());
    }
    if (kind === "sessions" && page.items.length > 0 && typeof this.store.listSessionMessageCursors === "function") {
      context.messageCursors = this.store.listSessionMessageCursors(page.items.map(row => row.id));
    }
    return { schemaVersion: 1, items: page.items.map(row => projectors[kind](row, this.store, context)), hasMore: page.hasMore,
      nextCursor: page.nextCursor ? Buffer.from(JSON.stringify({ version: 1, kind, position: page.nextCursor })).toString("base64url") : null };
  }

  /**
   * Resolves the managed avatar file of an active Work for streaming by the gateway.
   * Only files beneath `<avatarsRoot>/works/` qualify; anything else is reported as absent so a
   * stale or hand-edited `avatar_path` can never turn the device API into a file reader.
   */
  async workAvatar(workId) {
    if (typeof workId !== "string" || !workId || workId.length > 512) throw deviceError("INVALID_WORK_ID", 400);
    const work = this.store.getWork(workId);
    if (!work || work.status !== "active") throw deviceError("WORK_NOT_FOUND", 404);
    const path = typeof work.avatarPath === "string" ? resolve(work.avatarPath) : "";
    const managedRoot = resolve(this.avatarsRoot, "works") + sep;
    if (!path.startsWith(managedRoot)) throw deviceError("AVATAR_NOT_FOUND", 404);
    const contentType = AVATAR_CONTENT_TYPES[extname(path).toLowerCase()];
    if (!contentType) throw deviceError("AVATAR_NOT_FOUND", 404);
    let info;
    try { info = await stat(path); } catch { throw deviceError("AVATAR_NOT_FOUND", 404); }
    if (!info.isFile() || info.size > 8 * 1024 * 1024) throw deviceError("AVATAR_NOT_FOUND", 404);
    return { path, contentType, size: info.size, etag: `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"` };
  }
}
