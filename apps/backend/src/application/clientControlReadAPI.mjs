import { deviceError } from "./clientDeviceAuthority.mjs";

const text = value => typeof value === "string" ? value : "";
// Explicit read DTOs: never serialize prompts, credential-bearing Skill sources,
// filesystem paths, automation commands or raw Provider payloads to devices.
const projections = {
  automations: row => ({ id: row.taskId, name: row.name, status: row.status,
    logicalSessionId: row.logicalSessionId, sessionId: row.sessionId ?? null, scheduleType: row.scheduleType,
    nextRunAt: row.nextRunAt ?? null, expiresAt: row.expiresAt ?? null,
    lastRunStatus: row.lastRunStatus ?? null, updatedAt: row.updatedAt }),
  agents: row => ({ id: row.agentId, name: row.name, description: text(row.description),
    kind: text(row.agentKind), updatedAt: row.updatedAt }),
  skills: row => ({ id: row.skillId, name: row.name, description: text(row.description),
    sourceType: text(row.sourceType), updatedAt: row.updatedAt }),
  repositories: row => ({ id: row.id, name: row.name, availability: row.availability,
    worktreeCount: row.worktreeCount })
};

/** Provider-neutral, read-only projections. Services are injected, not HTTP-forwarded.
 * ID keyset paging remains stable across renames/status changes. The source list
 * services currently materialize their inventory; response size is bounded here.
 */
export class ClientControlReadAPI {
  constructor({ lists, repository, resolveSession = () => null }) {
    this.lists = lists; this.readRepository = repository; this.resolveSession = resolveSession;
    this.repositoryFlights = new Map();
  }
  async list(kind, params = new URLSearchParams()) {
    if (!Object.hasOwn(projections, kind) || !this.lists[kind]) throw deviceError("ROUTE_NOT_AVAILABLE", 404);
    if ([...params.keys()].some(key => !["limit", "cursor"].includes(key))
        || [...params.keys()].some(key => params.getAll(key).length !== 1)) throw deviceError("INVALID_QUERY", 400);
    const limitText = params.get("limit") ?? "50";
    const limit = Number(limitText);
    if (!/^\d+$/.test(limitText) || limit < 1 || limit > 100) throw deviceError("INVALID_LIMIT", 400);
    let after = "";
    if (params.has("cursor")) {
      try {
        const raw = params.get("cursor");
        if (!raw || raw.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error();
        const cursor = JSON.parse(Buffer.from(raw, "base64url").toString());
        if (cursor.version !== 1 || cursor.kind !== kind || typeof cursor.id !== "string" || !cursor.id) throw new Error();
        after = cursor.id;
      } catch { throw deviceError("INVALID_CURSOR", 400); }
    }
    const rows = (await this.lists[kind]()).map(projections[kind])
      .filter(row => row.id > after).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const items = rows.slice(0, limit);
    if (kind === "automations") {
      for (const item of items) item.sessionId ??= this.resolveSession(item.logicalSessionId);
    }
    const hasMore = rows.length > limit;
    const result = { schemaVersion: 1, items, hasMore, nextCursor: hasMore
      ? Buffer.from(JSON.stringify({ version: 1, kind, id: items.at(-1).id })).toString("base64url") : null };
    return bounded(result);
  }
  async repository(id) {
    if (!id || id.length > 256) throw deviceError("INVALID_REPOSITORY_ID", 400);
    // Git inspection can be expensive; share concurrent reads and bound fan-out.
    if (this.repositoryFlights.has(id)) return this.repositoryFlights.get(id);
    if (this.repositoryFlights.size >= 4) throw deviceError("REPOSITORY_INSPECTION_BUSY", 429);
    const flight = this.projectRepository(id);
    this.repositoryFlights.set(id, flight);
    try { return await flight; } finally { this.repositoryFlights.delete(id); }
  }
  async projectRepository(id) {
    let result;
    try { result = await this.readRepository(id); }
    catch (error) { throw deviceError("REPOSITORY_UNAVAILABLE", error.statusCode === 404 ? 404 : 503); }
    return bounded({ schemaVersion: 1, repository: projections.repositories(result.repository),
      worktrees: result.project.worktrees.map(row => ({ id: row.worktreeId, branchName: row.branchName ?? null,
        isMain: row.isMain, availability: row.availability, state: row.state, dirty: row.dirty ?? null,
        aheadOfMain: row.aheadOfMain ?? null, behindMain: row.behindMain ?? null,
        pendingIntegration: row.pendingIntegration })),
      latestJob: result.latestJob ? { id: result.latestJob.id, status: result.latestJob.status } : null });
  }
}

function bounded(value) {
  if (Buffer.byteLength(JSON.stringify(value)) > 2 * 1024 * 1024) throw deviceError("CONTROL_RESPONSE_TOO_LARGE", 413);
  return value;
}
