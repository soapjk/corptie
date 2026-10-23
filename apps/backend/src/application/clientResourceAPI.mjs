import { createHash } from "node:crypto";
import { deviceError } from "./clientDeviceAuthority.mjs";

const bounded = (value, max = 512) => typeof value === "string" ? value.slice(0, max) : "";
/** User-facing, Provider-neutral catalog. Only summary DTOs leave the host.
 * Local/paired users have project read authority; Agent ownership is unchanged.
 */
export class ClientResourceAPI {
  constructor({ store, artifacts, writesAllowed = true }) { Object.assign(this, { store, artifacts, writesAllowed }); }
  context(row, identity) { return { kind: "local_user", actorId: `resource-user:${identity.deviceId}`, workId: row.workId ?? null, revalidateUser: identity.revalidate }; }
  row(id) {
    const row = this.store.getArtifact(id);
    if (!row || row.status === "revoked") throw deviceError("RESOURCE_NOT_FOUND", 404);
    return row;
  }
  works(params) {
    if ([...params.keys()].some(key => !["cursor", "limit"].includes(key) || params.getAll(key).length !== 1)) throw deviceError("INVALID_QUERY", 400);
    const limit = Number(params.get("limit") ?? 50);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw deviceError("INVALID_QUERY", 400);
    let after = "";
    if (params.has("cursor")) {
      try {
        const raw = params.get("cursor"); if (raw.length > 2048) throw Error();
        const cursor = JSON.parse(Buffer.from(raw, "base64url").toString());
        if (cursor.kind !== "resource-works" || typeof cursor.id !== "string") throw Error();
        after = cursor.id;
      } catch { throw deviceError("INVALID_CURSOR", 400); }
    }
    const rows = this.store.selectAll("SELECT id, name FROM works WHERE id > ? ORDER BY id LIMIT ?", [after, limit + 1]);
    const items = rows.slice(0, limit), hasMore = rows.length > limit;
    return { schemaVersion: 1, items, hasMore, nextCursor: hasMore ? Buffer.from(JSON.stringify({ kind: "resource-works", id: items.at(-1).id })).toString("base64url") : null };
  }
  summary(row) {
    const source = Object.hasOwn(row, "sourceTitle") ? (row.sourceTitle == null || row.sourceDeleted ? null : { id: row.sourceSessionId, title: row.sourceTitle })
      : row.sourceSessionId ? this.store.getSession(row.sourceSessionId) : null;
    return { id: row.artifactId, type: "artifact", title: bounded(row.title), summary: bounded(row.summary, 1000),
      owner: { type: row.scope, id: row.scope === "task" ? row.boundTaskId : row.scope === "session" ? row.boundSessionId : row.workId },
      workId: row.workId ?? null, workName: bounded(row.workName ?? (row.workId ? this.store.getWork(row.workId)?.name : null)),
      sourceSessionId: source && !source.deletedAt ? source.id : null, sourceTitle: bounded(source?.title),
      updatedAt: row.updatedAt, createdAt: row.createdAt, revision: row.resourceVersion,
      status: row.status, currentVersion: row.currentVersion, approvedVersion: row.approvedVersion,
      previewHash: row.previewHash ?? null, previewState: row.previewState ?? null,
      capabilities: ["read", ...(this.writesAllowed ? ["metadata", "reference", "revoke", ...(row.visibility !== "repository_tracked" ? ["publish", "export"] : [])] : [])] };
  }
  list(params) {
    const allowed = ["workId", "query", "status", "sort", "cursor", "limit", "sourceSessionId"];
    if ([...params.keys()].some(key => !allowed.includes(key) || params.getAll(key).length !== 1)) throw deviceError("INVALID_QUERY", 400);
    const workId = params.get("workId") || null, query = params.get("query") ?? "", status = params.get("status") ?? "all", sort = params.get("sort") ?? "updated";
    const limit = Number(params.get("limit") ?? 50);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || query.length > 256 || !["all", "draft", "approved"].includes(status) || !["updated", "created"].includes(sort)) throw deviceError("INVALID_QUERY", 400);
    const sourceSessionId = params.get("sourceSessionId") || null;
    const source = sourceSessionId ? this.store.getSession(sourceSessionId) : null;
    if (sourceSessionId && !source) throw deviceError("SESSION_NOT_FOUND", 404);
    const filter = createHash("sha256").update(JSON.stringify([workId, query, status, sort, sourceSessionId])).digest("hex");
    let after = null;
    if (params.has("cursor")) {
      try {
        const raw = params.get("cursor");
        if (raw.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw Error();
        const cursor = JSON.parse(Buffer.from(raw, "base64url").toString());
        if (cursor.v !== 1 || cursor.filter !== filter || typeof cursor.id !== "string" || typeof cursor.time !== "string") throw Error();
        after = cursor;
      } catch { throw deviceError("INVALID_CURSOR", 400); }
    }
    const rows = this.store.resourceArtifactPage({ workId, query, status, sort, after, sourceSessionId, taskId: source?.taskId, limit: limit + 1 });
    const items = rows.slice(0, limit).map(row => this.summary(row));
    const last = items.at(-1), hasMore = rows.length > limit;
    return { schemaVersion: 1, items, capabilities: this.writesAllowed ? ["create"] : [], hasMore, nextCursor: hasMore ? Buffer.from(JSON.stringify({ v: 1, filter, id: last.id, time: sort === "created" ? last.createdAt : last.updatedAt })).toString("base64url") : null };
  }
  async create(identity, input) {
    if (!this.writesAllowed) throw deviceError("RESOURCE_READ_ONLY", 403);
    let content = input.content;
    if (input.dataBase64 != null) {
      if (typeof input.dataBase64 !== "string" || input.dataBase64.length > 174764 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.dataBase64)) throw deviceError("RESOURCE_INPUT_INVALID", 400);
      content = Buffer.from(input.dataBase64, "base64");
      if (content.toString("base64") !== input.dataBase64) throw deviceError("RESOURCE_INPUT_INVALID", 400);
    }
    if (typeof input.workId !== "string" || !this.store.getWork(input.workId) || typeof input.title !== "string" || !input.title.trim()
      || input.title.length > 512 || !(typeof content === "string" || Buffer.isBuffer(content)) || Buffer.byteLength(content) > 131072
      || !/^[A-Za-z0-9_-]{8,128}$/.test(input.requestId ?? "")) throw deviceError("RESOURCE_INPUT_INVALID", 400);
    const mimeType = input.mimeType ?? "text/markdown";
    if (typeof mimeType !== "string" || mimeType.length > 128 || !/^[a-zA-Z0-9.+_-]+\/[a-zA-Z0-9.+_-]+$/.test(mimeType)) throw deviceError("RESOURCE_INPUT_INVALID", 400);
    const id = `artifact:user:${createHash("sha256").update(`${identity.deviceId}:${input.requestId}`).digest("hex")}`;
    await this.artifacts.create(this.context({ workId: input.workId }, identity), { artifactId: id,
      title: input.title, summary: input.summary, content, mimeType, approvalStatus: "draft", visibility: "work_private" });
    return this.detail(identity, id);
  }
  detail(identity, id, requestedVersion = null) {
    if (requestedVersion != null && (!Number.isSafeInteger(requestedVersion) || requestedVersion < 1)) throw deviceError("RESOURCE_VERSION_INVALID", 400);
    const row = this.row(id), versions = this.store.listArtifactVersions(id, { limit: 100 });
    if (requestedVersion && !versions.some(v => v.version === requestedVersion)) {
      const selected = this.store.getArtifactVersion(id, requestedVersion);
      if (!selected) throw deviceError("RESOURCE_VERSION_NOT_FOUND", 404);
      versions.push(selected);
    }
    const current = versions.find(v => v.version === row.currentVersion);
    const references = this.store.listArtifactReferences({ artifactId: id, limit: 101, targetedOnly: true });
    return { schemaVersion: 1, resource: this.summary({ ...row, previewHash: current?.contentHash, previewState: current?.approvalStatus }),
      versions: versions.map(({ version, contentHash, byteLength, mimeType, approvalStatus, createdAt }) => ({ version, contentHash, byteLength, mimeType, approvalStatus, createdAt })),
      versionsTruncated: row.currentVersion > 100, referencesTruncated: references.length > 100,
      references: references.slice(0, 100).map(ref => ({ id: ref.referenceId, taskId: ref.taskId,
        sessionId: ref.sessionId ?? (ref.taskId ? this.store.getTask(ref.taskId)?.current_session_id : null) ?? null,
        version: ref.pinnedVersion, hash: ref.pinnedHash, policy: ref.versionPolicy })),
      targets: this.store.selectAll("SELECT id, title, task_id FROM sessions WHERE work_id IS ? AND deleted_at IS NULL AND archived = 0 ORDER BY updated_at DESC LIMIT 100", [row.workId ?? null])
        .map(s => ({ id: s.id, title: bounded(s.title), taskId: s.task_id ?? null })) };
  }
  async read(identity, id, params) {
    const row = this.row(id);
    if ([...params.keys()].some(key => !["version", "hash", "offset", "readId"].includes(key) || params.getAll(key).length !== 1)) throw deviceError("INVALID_QUERY", 400);
    const readId = params.get("readId");
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(readId ?? "")) throw deviceError("INVALID_READ_ID", 400);
    const result = await this.artifacts.get(this.context(row, identity), id, { version: Number(params.get("version")), contentHash: params.get("hash"),
      offset: Number(params.get("offset") ?? 0), limit: 65536, userRead: true, turnExecutionId: `resources:${identity.deviceId}:${readId}` });
    return { artifactId: result.artifactId, version: result.version, contentHash: result.contentHash, mimeType: result.mimeType,
      content: result.content, encoding: result.encoding, range: result.range, complete: result.complete };
  }
  async command(identity, id, input) {
    if (!this.writesAllowed) throw deviceError("RESOURCE_READ_ONLY", 403);
    const row = this.row(id), context = this.context(row, identity);
    if (input.expectedRevision !== row.resourceVersion) throw deviceError("RESOURCE_REVISION_CONFLICT", 409);
    if (input.action === "metadata") await this.artifacts.updateMetadata(context, id, { title: input.title, summary: input.summary });
    else if (input.action === "export") return this.artifacts.downloadForUser(context, id, { version: input.version, contentHash: input.hash, confirmed: input.confirmed });
    else if (input.action === "publish") {
      if (typeof input.content !== "string" || Buffer.byteLength(input.content) > 131072) throw deviceError("RESOURCE_INPUT_INVALID", 400);
      await this.artifacts.publishVersion(context, id, { content: input.content, approvalStatus: input.approved === true ? "approved" : "draft", expectedResourceVersion: input.expectedRevision });
    }
    else if (input.action === "revoke") {
      if (input.confirmed !== true) throw deviceError("CONFIRMATION_REQUIRED", 409);
      this.artifacts.revokeArtifact(context, id, "User deleted in Resources");
      return { schemaVersion: 1, deleted: true };
    } else if (input.action === "reference") {
      const task = input.taskId ? this.store.getTask(input.taskId) : null;
      const session = input.sessionId ? this.store.getSession(input.sessionId) : null;
      if (Boolean(task) === Boolean(session) || (task?.work_id ?? session?.workId ?? null) !== row.workId) throw deviceError("REFERENCE_TARGET_INVALID", 400);
      const version = this.store.getArtifactVersion(id, input.version);
      if (!version) throw deviceError("RESOURCE_VERSION_NOT_FOUND", 404);
      this.store.runInTransaction(() => {
        const exists = this.store.listArtifactReferences({ artifactId: id }).some(r => r.taskId === (task?.id ?? null) && r.sessionId === (session?.id ?? null) && r.pinnedVersion === version.version);
        if (!exists) this.artifacts.createReference(context, id, { taskId: task?.id, sessionId: session?.id, version: version.version, relation: "implementation_spec", versionPolicy: "fixed" });
      });
    } else if (input.action === "unreference") {
      if (input.confirmed !== true) throw deviceError("CONFIRMATION_REQUIRED", 409);
      const ref = this.store.getArtifactReference(input.referenceId);
      if (!ref || ref.artifactId !== id) throw deviceError("REFERENCE_NOT_FOUND", 404);
      this.artifacts.revokeReference(context, ref.referenceId, "User removed reference in Resources");
    } else throw deviceError("RESOURCE_ACTION_UNAVAILABLE", 400);
    return this.detail(identity, id);
  }
}
