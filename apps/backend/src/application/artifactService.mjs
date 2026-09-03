import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { resolvePlatformAdminSession } from "../utils/platformAssistantIdentity.mjs";
import { ArtifactReferenceAuthorizer, SessionAuthorizationResolver, artifactError as pinnedReadError, safeHashEqual } from "./artifactAuthorization.mjs";
import { buildArtifactContextIndex } from "./artifactContextIndex.mjs";
import { ArtifactReadCoordinator, ARTIFACT_READ_DEFAULT_LIMITS } from "./artifactReadCoordinator.mjs";

export const ARTIFACT_VISIBILITIES = Object.freeze([
  "work_private", "task_private", "session_private", "repository_tracked"
]);
export const ARTIFACT_RELATIONS = Object.freeze([
  "implementation_spec", "security_requirement", "test_plan", "research_evidence",
  "handoff", "acceptance_evidence"
]);
const VISIBILITIES = new Set(ARTIFACT_VISIBILITIES);
const RELATIONS = new Set(ARTIFACT_RELATIONS);
const VERSION_POLICIES = new Set(["fixed", "latest_approved"]);
const ARTIFACT_SCOPES = new Set(["work", "task"]);
const MAX_READ_BYTES = ARTIFACT_READ_DEFAULT_LIMITS.maxPageBytes;
const ARTIFACT_SEARCH_INDEX_STATE_KEY = "artifact-search-index:v1";
const ARTIFACT_USAGE_RECONCILIATION_STATE_KEY = "artifact-turn-read-usage:v1";
const ARTIFACT_ORPHAN_AUDIT_STATE_KEY = "artifact-orphan-audit:v1";
const ARTIFACT_ORPHAN_AUDIT_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export class ArtifactService {
  constructor(options = {}) {
    this.store = options.store;
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? randomUUID;
    this.contentRoot = options.contentRoot ?? null;
    this.sessionAuthorizationResolver = options.sessionAuthorizationResolver
      ?? new SessionAuthorizationResolver({ store: this.store });
    this.referenceAuthorizer = options.referenceAuthorizer
      ?? new ArtifactReferenceAuthorizer({ store: this.store });
    this.readCoordinator = options.readCoordinator
      ?? new ArtifactReadCoordinator({ store: this.store, clock: this.clock });
    if (!this.store) throw new TypeError("ArtifactService requires a store.");
  }

  async initialize({ performMaintenance = true } = {}) {
    this.contentRoot ??= this.store.layout?.artifactsDirectory
      ?? join(this.store.settings().dataRoot, "artifacts");
    await mkdir(join(this.contentRoot, "objects"), { recursive: true, mode: 0o700 });
    await mkdir(join(this.contentRoot, "tmp"), { recursive: true, mode: 0o700 });
    if (!performMaintenance) return [];
    return this.runStartupMaintenance();
  }

  async runStartupMaintenance() {
    const recovered = await this.recoverContentOperations();
    const lastOrphanAudit = this.store.getRuntimeState?.(ARTIFACT_ORPHAN_AUDIT_STATE_KEY);
    const orphanAuditDue = !lastOrphanAudit?.completedAt
      || Date.now() - Date.parse(lastOrphanAudit.completedAt) >= ARTIFACT_ORPHAN_AUDIT_INTERVAL_MS;
    const orphaned = orphanAuditDue ? await this.auditOrphanedContent() : [];
    if (orphanAuditDue) {
      this.store.setRuntimeState?.(ARTIFACT_ORPHAN_AUDIT_STATE_KEY, { completedAt: this.clock() });
    }
    if (!this.store.getRuntimeState?.(ARTIFACT_SEARCH_INDEX_STATE_KEY)?.completedAt) {
      this.searchIndexRebuildPromise = new Promise((resolve) => {
        setTimeout(resolve, 0);
      }).then(async () => {
        const result = await this.rebuildSearchIndex();
        this.store.setRuntimeState?.(ARTIFACT_SEARCH_INDEX_STATE_KEY, { completedAt: this.clock() });
        return result;
      }).catch((error) => {
        this.searchIndexRebuildError = error;
        return { indexedArtifacts: 0, errorCode: error?.code ?? "ARTIFACT_INDEX_REBUILD_FAILED" };
      });
    } else {
      this.searchIndexRebuildPromise = Promise.resolve({ indexedArtifacts: 0, skipped: "already_current" });
    }
    if (!this.store.getRuntimeState?.(ARTIFACT_USAGE_RECONCILIATION_STATE_KEY)?.completedAt) {
      this.store.reconcileArtifactTurnReadUsage?.(this.clock());
      this.store.setRuntimeState?.(ARTIFACT_USAGE_RECONCILIATION_STATE_KEY, { completedAt: this.clock() });
    }
    return [...recovered, ...orphaned];
  }

  async rebuildSearchIndex() {
    let indexedArtifacts = 0;
    for (const artifact of this.store.listArtifacts({ includeRevoked: true })) {
      let body = "";
      const versionNumber = artifact.approvedVersion ?? artifact.currentVersion;
      const version = versionNumber ? this.store.getArtifactVersion(artifact.artifactId, versionNumber) : null;
      if (version?.storageKey && isTextMime(version.mimeType)) {
        try { body = (await readFile(this.#safeStoragePath(version.storageKey))).toString("utf8"); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      const latest = this.store.getArtifact(artifact.artifactId);
      if (!latest || (latest.approvedVersion ?? latest.currentVersion) !== versionNumber) continue;
      this.#indexArtifact(latest, body);
      indexedArtifacts += 1;
    }
    return { indexedArtifacts };
  }

  async useDataRoot(layout) {
    if (!layout?.artifactsDirectory) throw new TypeError("ArtifactService requires a data root layout.");
    this.contentRoot = layout.artifactsDirectory;
    await mkdir(join(this.contentRoot, "objects"), { recursive: true, mode: 0o700 });
    await mkdir(join(this.contentRoot, "tmp"), { recursive: true, mode: 0o700 });
    const integrity = [];
    for (const version of this.store.selectAll(
      "SELECT artifact_id, version, storage_key, content_hash, byte_length FROM artifact_versions WHERE storage_key IS NOT NULL"
    )) {
      const content = await readFile(this.#safeStoragePath(version.storage_key));
      if (sha256(content) !== version.content_hash || content.byteLength !== Number(version.byte_length)) {
        throw artifactError(
          "ARTIFACT_INTEGRITY_FAILED",
          `Artifact content failed verification after data root migration: ${version.artifact_id} v${version.version}.`,
          409
        );
      }
      integrity.push({ artifactId: version.artifact_id, version: Number(version.version) });
    }
    return { verifiedArtifacts: integrity.length };
  }

  context(input = {}) {
    if (input.kind === "platform_admin") {
      const binding = resolvePlatformAdminSession(this.store, input);
      const workId = requiredText(input.workId, "workId");
      if (!this.store.getWork(workId)) {
        throw artifactError("ARTIFACT_WORK_NOT_FOUND", "Work not found.", 404);
      }
      return {
        kind: "platform_admin",
        actorId: binding.agent.agentId,
        workId,
        sessionId: binding.actorSessionId,
        taskId: null
      };
    }
    if (input.kind === "local_user") {
      const workId = requiredText(input.workId, "workId");
      if (!this.store.getWork(workId)) throw artifactError("ARTIFACT_WORK_NOT_FOUND", "Work not found.", 404);
      return { kind: "local_user", actorId: input.actorId ?? "local-user", workId, sessionId: null, taskId: null };
    }
    const resolved = this.sessionAuthorizationResolver.resolve({
      actorId: input.actorId,
      sessionId: input.sessionId,
      authenticatedLogicalSessionId: input.logicalSessionId,
      providerBindingId: input.providerBindingId,
      expectedSessionKind: input.expectedSessionKind
    });
    const actorId = resolved.agentId;
    const sessionId = resolved.productSessionId;
    const workId = resolved.workId;
    const taskId = resolved.taskId;
    if (input.workId && input.workId !== workId) {
      throw artifactError("ARTIFACT_WORK_FORBIDDEN", "Claimed Work does not match the Session binding.", 403);
    }
    if (input.taskId && input.taskId !== taskId) {
      throw artifactError("ARTIFACT_TASK_FORBIDDEN", "Claimed Task does not match the Session binding.", 403);
    }
    return {
      kind: resolved.sessionKind, actorId, workId, sessionId, productSessionId: sessionId, taskId,
      logicalSessionId: resolved.logicalSessionId,
      providerBindingId: resolved.providerBindingId,
      authorizationRevision: resolved.authorizationRevision
    };
  }

  list(contextInput, options = {}) {
    const context = this.context(contextInput);
    const relatedTaskIds = this.#relatedTaskIds(context);
    const artifacts = this.store.listArtifactsByWork(context.workId, {
      includeRevoked: options.includeRevoked === true,
      limit: options.limit ?? null,
      offset: options.offset ?? 0
    });
    return artifacts.filter((artifact) => artifact.status === "revoked"
      ? options.includeRevoked === true && this.#canManageArtifact(context, artifact)
      : this.#canRead(context, artifact, relatedTaskIds))
      .map((artifact) => this.#presentForContext(context, artifact));
  }

  listForTask(contextInput, taskIdValue, options = {}) {
    const context = this.context(contextInput);
    const taskId = requiredText(taskIdValue, "taskId");
    const task = this.store.getTask(taskId);
    if (!task) throw artifactError("ARTIFACT_TASK_NOT_FOUND", "Task not found.", 404);
    if (task.work_id !== context.workId) {
      throw artifactError("ARTIFACT_TASK_FORBIDDEN", "Task belongs to another Work.", 403);
    }
    const artifacts = this.store.listArtifactsReferencedByTask(taskId, {
      includeRevokedReferences: options.includeRevokedReferences === true,
      limit: options.limit ?? null,
      offset: options.offset ?? 0
    });
    const artifactIds = artifacts.map((artifact) => artifact.artifactId);
    const versionsByArtifact = groupByArtifactId(this.store.listArtifactVersionsByArtifactIds(artifactIds));
    const referencesByArtifact = groupByArtifactId(this.store.listArtifactReferencesByArtifactIds(artifactIds, {
      taskId, includeRevoked: options.includeRevokedReferences === true
    }));
    const auditByArtifact = groupByArtifactId(this.store.listArtifactAuditByArtifactIds(artifactIds));
    const results = [];
    for (const artifact of artifacts) {
      if (!this.#canRead(context, artifact)) continue;
      const manageable = this.#canManageArtifact(context, artifact);
      const scopedReferences = referencesByArtifact.get(artifact.artifactId) ?? [];
      if (scopedReferences.length === 0) continue;
      const canPublishAndRepin = artifact.status === "active"
        && artifact.visibility === "task_private"
        && artifact.boundTaskId === taskId
        && scopedReferences.some((reference) => reference.versionPolicy === "fixed" && !reference.revokedAt)
        && (context.kind !== "worker" || context.taskId === taskId);
      const canPublishShared = artifact.status === "active" && artifact.scope === "work"
        && manageable;
      results.push({
        ...artifact,
        versions: versionsByArtifact.get(artifact.artifactId) ?? [],
        references: scopedReferences,
        audit: auditByArtifact.get(artifact.artifactId) ?? [],
        access: { read: true, write: manageable, delete: manageable, manageReferences: manageable },
        availableActions: ["read", ...(canPublishAndRepin ? ["publish_and_repin"] : []),
          ...(canPublishShared ? ["publish"] : [])]
      });
    }
    return results;
  }

  async get(contextInput, artifactId, options = {}) {
    const context = this.#pinnedReadContext(contextInput);
    if (options.version == null) throw artifactError("ARTIFACT_INVALID_INPUT", "version is required.", 400);
    const requestedVersion = boundedInteger(options.version, 1, Number.MAX_SAFE_INTEGER, null, "version");
    const requestedHash = requiredText(options.contentHash, "contentHash");
    if (!/^[a-f0-9]{64}$/.test(requestedHash)) throw artifactError("ARTIFACT_HASH_INVALID", "contentHash must be a lowercase SHA-256 digest.", 400);
    let referenceId = optionalText(options.referenceId);
    if (!referenceId) {
      const readable = this.#readableArtifact(context, artifactId);
      const version = this.store.getArtifactVersion(artifactId, requestedVersion);
      if (!version || !safeHashEqual(version.contentHash, requestedHash)) {
        throw artifactError("ARTIFACT_VERSION_HASH_MISMATCH", "Requested content hash does not match the immutable Artifact version.", 409);
      }
      referenceId = this.#ensureWorkScopeReadReference(context, readable, version).referenceId;
    }
    const authorized = this.referenceAuthorizer.authorize(context, {
      artifactId, version: requestedVersion, contentHash: requestedHash,
      referenceId
    });
    const offset = boundedInteger(options.offset, 0, Number.MAX_SAFE_INTEGER, 0, "offset");
    const limit = boundedInteger(options.limit, 1, MAX_READ_BYTES, ARTIFACT_READ_DEFAULT_LIMITS.defaultPageBytes, "limit");
    const format = options.format ?? (isTextMime(authorized.version.mimeType) ? "text" : "base64");
    if (!["text", "base64"].includes(format)) throw artifactError("ARTIFACT_INVALID_INPUT", "format must be text or base64.", 400);
    if (format === "text" && !isTextMime(authorized.version.mimeType)) {
      throw artifactError("ARTIFACT_TEXT_ENCODING_INVALID", "Text format is unavailable for this MIME type.", 415);
    }
    if (offset > authorized.version.byteLength) throw artifactError("ARTIFACT_RANGE_INVALID", "Artifact offset exceeds total bytes.", 416);
    const turnExecutionId = requiredText(options.turnExecutionId ?? contextInput.turnExecutionId, "turnExecutionId");
    if (format === "text" && !this.store.hasArtifactTextReadBoundary({
      logicalSessionId: context.logicalSessionId,
      providerBindingId: context.providerBindingId,
      turnExecutionId,
      artifactId,
      version: requestedVersion,
      contentHash: requestedHash,
      referenceId: authorized.reference.referenceId,
      authorizationRevision: authorized.authorizationRevision,
      offset
    })) throw artifactError("ARTIFACT_RANGE_INVALID", "Text offset must continue an authorized page from this exact Turn and Reference.", 416);
    const anticipatedBytes = Math.min(limit, Math.max(0, authorized.version.byteLength - offset));
    const reauthorize = async () => {
      const currentContext = this.#pinnedReadContext(contextInput);
      const current = this.referenceAuthorizer.authorize(currentContext, {
        artifactId, version: requestedVersion, contentHash: requestedHash,
        referenceId
      });
      if (current.authorizationRevision !== authorized.authorizationRevision
        || currentContext.providerBindingId !== context.providerBindingId) {
        throw pinnedReadError("ARTIFACT_READ_CONCURRENT_UPDATE", "Artifact authorization changed during the page read.", 409);
      }
      return current;
    };
    const page = await this.readCoordinator.read({
      logicalSessionId: context.logicalSessionId,
      providerBindingId: context.providerBindingId,
      turnExecutionId,
      artifactId,
      version: requestedVersion,
      contentHash: requestedHash,
      offset,
      limit,
      format,
      referenceId,
      authorizationRevision: authorized.authorizationRevision,
      anticipatedBytes,
      signal: options.signal ?? contextInput.signal,
      reauthorize,
      load: () => this.#readPinnedPage(authorized.version, { offset, limit, format }),
      recordUsage: (_receipt, loadedPage) => this.#recordUsage(
        context, authorized.artifact, authorized.version, "get", offset, loadedPage.byteLength
      )
    });
    const pendingUpdate = page.authorization.reference.pendingVersion == null ? null : {
      version: page.authorization.reference.pendingVersion,
      contentHash: page.authorization.reference.pendingHash
    };
    return Object.freeze({
      artifactId,
      version: requestedVersion,
      contentHash: requestedHash,
      mimeType: authorized.version.mimeType,
      totalBytes: authorized.version.byteLength,
      encoding: page.encoding,
      content: page.content,
      range: Object.freeze({ offset, byteLength: page.byteLength, nextOffset: page.nextOffset }),
      complete: page.nextOffset == null,
      pendingUpdate,
      readReceiptId: page.readReceiptId,
      deduplicated: page.deduplicated,
      turnBudget: page.turnBudget
    });
  }

  async readPinnedEvidence(contextInput, artifactId, options = {}) {
    const context = this.context(contextInput);
    const artifact = this.#readableArtifact(context, artifactId);
    const selected = this.#selectedVersion(context, artifact, options.version);
    if (!selected?.storageKey) throw artifactError("ARTIFACT_PINNED_READ_UNAVAILABLE", "Pinned Artifact content is unavailable.", 404);
    const buffer = await readFile(this.#safeStoragePath(selected.storageKey));
    if (buffer.byteLength !== selected.byteLength || sha256(buffer) !== selected.contentHash) throw artifactError("ARTIFACT_INTEGRITY_FAILED", "Artifact content failed hash or length verification.", 409);
    const readReceiptId = this.#recordUsage(context, artifact, selected, "get", 0, buffer.byteLength);
    if (!readReceiptId) throw artifactError("ARTIFACT_READ_RECEIPT_UNAVAILABLE", "Pinned Artifact reads require a Session-scoped read receipt.", 409);
    const references = this.store.listArtifactReferences({ artifactId: artifact.artifactId, includeRevoked: context.kind !== "worker" });
    const reference = references.find((item) => item.relation === "implementation_spec" && item.versionPolicy === "fixed" && item.pinnedVersion === selected.version && !item.revokedAt);
    return {
      artifactId: artifact.artifactId, version: selected.version, contentHash: selected.contentHash,
      approvalStatus: selected.approvalStatus, relation: reference?.relation ?? null,
      versionPolicy: reference?.versionPolicy ?? null, complete: true,
      content: buffer.toString("utf8"), readReceiptId, byteLength: buffer.byteLength
    };
  }

  async search(contextInput, queryValue, options = {}) {
    const context = this.context(contextInput);
    const relatedTaskIds = this.#relatedTaskIds(context);
    const query = requiredText(queryValue, "query");
    const limit = boundedInteger(options.limit, 1, 50, 20, "limit");
    const results = [];
    const requestedKinds = normalizedStringList(options.kinds);
    const requestedTags = normalizedStringList(options.tags);
    const categoryPrefix = normalizeCategoryPath(options.categoryPrefix ?? "");
    const requestedScope = optionalText(options.scope);
    if (requestedScope && !ARTIFACT_SCOPES.has(requestedScope)) {
      throw artifactError("ARTIFACT_SCOPE_INVALID", `Unsupported Artifact scope: ${requestedScope}`, 400);
    }
    const matches = this.store.searchArtifactDocuments(context.workId, query, Math.max(limit * 4, 50));
    for (const match of matches) {
      const artifact = this.store.getArtifact(match.artifactId);
      if (!artifact) continue;
      if (!this.#canRead(context, artifact, relatedTaskIds)) continue;
      if (requestedScope && artifact.scope !== requestedScope) continue;
      if (requestedKinds.length > 0 && !requestedKinds.includes(artifact.kind)) continue;
      if (categoryPrefix && artifact.categoryPath !== categoryPrefix
        && !artifact.categoryPath.startsWith(`${categoryPrefix}/`)) continue;
      if (requestedTags.length > 0 && !requestedTags.every((tag) => artifact.tags.includes(tag))) continue;
      const version = this.#selectedVersion(context, artifact, null, relatedTaskIds);
      if (version) {
        results.push({
          artifact: this.#presentForContext(context, artifact),
          version,
          referenceId: this.#matchingReferences(context, artifact, relatedTaskIds)[0]?.referenceId ?? null,
          relevance: match.score,
          excerpt: null
        });
        this.#recordUsage(context, artifact, version, "search", 0, 0);
      }
      if (results.length >= limit) break;
    }
    return { query: queryValue, count: results.length, results };
  }

  async create(contextInput, input = {}) {
    const context = this.context(contextInput);
    const requestedScope = input.scope
      ?? (input.visibility ? artifactScope(input.visibility) : (context.kind === "worker" ? "task" : "work"));
    if (context.kind === "worker" && requestedScope !== "work") return this.#createWorkerArtifact(context, input);
    if (context.kind === "worker") this.#assertActiveWorkerBinding(context);
    else this.#assertManager(context);
    const visibility = enumValue(
      input.visibility ?? (requestedScope === "work" ? "work_private" : "task_private"),
      VISIBILITIES,
      "ARTIFACT_VISIBILITY_INVALID"
    );
    const scope = artifactScope(visibility, input.scope);
    if (context.kind === "worker" && scope !== "work") {
      throw artifactError("ARTIFACT_WORKER_SCOPE_FORBIDDEN", "Worker may create only Work-public or current-Task Artifacts.", 403);
    }
    const binding = this.#validateBinding(context.workId, visibility, input);
    if (scope === "work" && (binding.boundTaskId || binding.boundSessionId)) {
      throw artifactError("ARTIFACT_SCOPE_INVALID", "Work-scoped Artifacts cannot be privately bound to a Task or Session.", 400);
    }
    const taxonomy = normalizeArtifactTaxonomy(input);
    const workerIdempotencyKey = context.kind === "worker" ? requiredText(input.idempotencyKey, "idempotencyKey") : null;
    const artifactId = input.artifactId
      ? canonicalId(input.artifactId, "artifact")
      : workerIdempotencyKey
        ? `artifact:worker-work:${sha256(Buffer.from(`${context.sessionId}\0${workerIdempotencyKey}`))}`
        : `artifact:${this.idFactory()}`;
    const existingArtifact = this.store.getArtifact(artifactId);
    if (existingArtifact) {
      const expectedHash = visibility === "repository_tracked"
        ? sha256(Buffer.from(requiredText(input.repositoryLocator, "repositoryLocator")))
        : sha256(contentBuffer(input.content));
      const existingVersion = this.store.getArtifactVersion(
        existingArtifact.artifactId,
        existingArtifact.currentVersion
      );
      if (existingArtifact.workId !== context.workId
        || existingArtifact.title !== requiredText(input.title, "title")
        || existingArtifact.summary !== (optionalText(input.summary) ?? "")
        || existingArtifact.scope !== scope
        || existingArtifact.kind !== taxonomy.kind
        || existingArtifact.categoryPath !== taxonomy.categoryPath
        || !sameStringSet(existingArtifact.tags, taxonomy.tags)
        || !sameStringSet(existingArtifact.aliases, taxonomy.aliases)
        || !sameStringSet(existingArtifact.keywords, taxonomy.keywords)
        || !existingVersion || !safeHashEqual(existingVersion.contentHash, expectedHash)) {
        throw artifactError("ARTIFACT_IDEMPOTENCY_CONFLICT", "idempotencyKey is already associated with different Work Artifact input.", 409);
      }
      return { ...this.present(existingArtifact), idempotentReplay: true };
    }
    const createdAt = this.clock();
    const actorId = context.kind === "worker" ? context.sessionId : context.actorId;
    if (visibility === "repository_tracked") {
      if (input.confirmedRepositoryTracked !== true) throw artifactError("ARTIFACT_CONFIRMATION_REQUIRED", "Repository-tracked Artifact creation requires explicit confirmation.", 409);
      if (input.content != null) throw artifactError("ARTIFACT_REPOSITORY_CONTENT_FORBIDDEN", "Repository-tracked content is not copied into private storage.", 400);
      this.store.runInTransaction(() => {
        const locator = requiredText(input.repositoryLocator, "repositoryLocator");
        const locatorHash = createHash("sha256").update(locator).digest("hex");
        this.store.createArtifactMetadata({
          artifactId, workId: context.workId, title: requiredText(input.title, "title"),
          summary: optionalText(input.summary) ?? "", visibility, scope, ...taxonomy, ...binding,
          repositoryLocator: locator,
          sourceSessionId: context.sessionId, sourceEventId: optionalText(input.sourceEventId),
          actorId, createdAt
        });
        this.store.createArtifactVersion({
          artifactId, version: 1, contentHash: locatorHash, byteLength: 0,
          mimeType: "application/vnd.corptie.repository-reference", storageKey: null,
          sourceSessionId: context.sessionId, sourceEventId: optionalText(input.sourceEventId),
          supersedesVersion: null, approvalStatus: "approved", actorId, createdAt
        });
        this.store.updateArtifact(artifactId, { currentVersion: 1, approvedVersion: 1, updatedAt: createdAt });
        this.#audit(context, artifactId, "artifact.created", { visibility, repositoryLocator: locator }, null, 1);
      });
      const created = this.store.getArtifact(artifactId);
      this.#indexArtifact(created, "");
      return this.present(created);
    }
    const buffer = contentBuffer(input.content);
    const prepared = await this.#prepareContent(artifactId, 1, buffer);
    try {
      this.store.runInTransaction(() => {
        this.store.createArtifactMetadata({
          artifactId, workId: context.workId, title: requiredText(input.title, "title"),
          summary: optionalText(input.summary) ?? "", visibility, scope, ...taxonomy, ...binding,
          sourceSessionId: context.sessionId, sourceEventId: optionalText(input.sourceEventId),
          actorId, createdAt
        });
        this.store.createArtifactVersion({
          artifactId, version: 1, contentHash: prepared.hash, byteLength: buffer.byteLength,
          mimeType: optionalText(input.mimeType) ?? "text/markdown", storageKey: prepared.storageKey,
          sourceSessionId: context.sessionId, sourceEventId: optionalText(input.sourceEventId),
          supersedesVersion: null, approvalStatus: input.approvalStatus === "draft" ? "draft" : "approved",
          actorId, createdAt
        });
        this.store.updateArtifact(artifactId, {
          currentVersion: 1, approvedVersion: input.approvalStatus === "draft" ? null : 1, updatedAt: createdAt
        });
        this.#audit(context, artifactId, "artifact.created", { visibility, contentHash: prepared.hash }, null, 1);
      });
      this.store.updateArtifactContentOperation(prepared.operationId, "completed");
      const created = this.store.getArtifact(artifactId);
      this.#indexArtifact(created, isTextMime(optionalText(input.mimeType) ?? "text/markdown") ? buffer.toString("utf8") : "");
      return this.present(created);
    } catch (error) {
      await this.#rollbackPrepared(prepared, error);
      throw error;
    }
  }

  async #createWorkerArtifact(context, input) {
    const idempotencyKey = requiredText(input.idempotencyKey, "idempotencyKey");
    if (idempotencyKey.length > 200) {
      throw artifactError("ARTIFACT_IDEMPOTENCY_KEY_INVALID", "idempotencyKey must not exceed 200 characters.", 400);
    }
    if (input.visibility != null && input.visibility !== "task_private") {
      throw artifactError("ARTIFACT_WORKER_SCOPE_FORBIDDEN", "Worker Artifact visibility is fixed to task_private.", 403);
    }
    if (input.boundTaskId != null && input.boundTaskId !== context.taskId) {
      throw artifactError("ARTIFACT_TASK_FORBIDDEN", "Worker Artifact binding is fixed to the current Task.", 403);
    }
    if (input.boundSessionId != null || input.repositoryLocator != null || input.confirmedRepositoryTracked != null) {
      throw artifactError("ARTIFACT_WORKER_SCOPE_FORBIDDEN", "Workers cannot choose Session, Repository, or visibility scope for an Artifact.", 403);
    }

    // Revalidate the authoritative binding immediately before the write. The
    // caller's Work/Task metadata is never used to choose these values.
    const task = this.store.getTask(context.taskId);
    if (!task || task.work_id !== context.workId
      || task.current_session_id !== context.sessionId
      || task.deletion_status === "deleting") {
      throw artifactError("ARTIFACT_TASK_FORBIDDEN", "Worker Session no longer has an active authoritative Task binding.", 403);
    }

    const title = requiredText(input.title, "title");
    const summary = optionalText(input.summary) ?? "";
    const taxonomy = normalizeArtifactTaxonomy(input);
    const buffer = contentBuffer(input.content);
    const mimeType = optionalText(input.mimeType) ?? "text/markdown";
    const approvalStatus = input.approvalStatus == null
      ? "approved"
      : enumValue(input.approvalStatus, new Set(["draft", "approved"]), "ARTIFACT_APPROVAL_STATUS_INVALID");
    const relation = enumValue(input.relation ?? "acceptance_evidence", RELATIONS, "ARTIFACT_RELATION_INVALID");
    if (input.required != null && typeof input.required !== "boolean") {
      throw artifactError("ARTIFACT_INVALID_INPUT", "required must be a boolean.", 400);
    }
    const required = input.required === true;
    const versionPolicy = enumValue(input.versionPolicy ?? "fixed", VERSION_POLICIES, "ARTIFACT_VERSION_POLICY_INVALID");
    const contentHash = sha256(buffer);
    const requestFingerprint = sha256(Buffer.from(JSON.stringify({
      title, summary, taxonomy, contentHash, mimeType, approvalStatus, relation, required, versionPolicy
    }), "utf8"));

    const existing = this.store.getArtifactWorkerCreateOperation(context.sessionId, idempotencyKey);
    if (existing) return this.#workerCreateReplay(context, existing, requestFingerprint);

    const artifactId = `artifact:${this.idFactory()}`;
    const referenceId = `artifact_reference:${this.idFactory()}`;
    const createdAt = this.clock();
    const workerActorId = context.sessionId;
    const workerAuditContext = { ...context, actorId: workerActorId };
    const prepared = await this.#prepareContent(artifactId, 1, buffer);
    try {
      this.store.runInTransaction(() => {
        // The Task can be completed/unbound while content is prepared. Check
        // once more under the same write transaction as every persisted record.
        const currentTask = this.store.getTask(context.taskId);
        if (!currentTask || currentTask.work_id !== context.workId
          || currentTask.current_session_id !== context.sessionId
          || currentTask.deletion_status === "deleting") {
          throw artifactError("ARTIFACT_TASK_FORBIDDEN", "Worker Session no longer has an active authoritative Task binding.", 403);
        }
        this.store.createArtifactMetadata({
          artifactId, workId: context.workId, title, summary,
          visibility: "task_private", scope: "task", ...taxonomy,
          boundTaskId: context.taskId,
          boundSessionId: null, sourceSessionId: context.sessionId,
          sourceEventId: null, actorId: workerActorId, createdAt
        });
        this.store.createArtifactVersion({
          artifactId, version: 1, contentHash: prepared.hash, byteLength: buffer.byteLength,
          mimeType, storageKey: prepared.storageKey, sourceSessionId: context.sessionId,
          sourceEventId: null, supersedesVersion: null, approvalStatus,
          actorId: workerActorId, createdAt
        });
        this.store.updateArtifact(artifactId, {
          currentVersion: 1, approvedVersion: approvalStatus === "approved" ? 1 : null, updatedAt: createdAt
        });
        this.store.createArtifactReference({
          referenceId, artifactId, workId: context.workId,
          taskId: context.taskId, sessionId: null, relation, required,
          versionPolicy, pinnedVersion: 1, pinnedHash: prepared.hash,
          actorId: workerActorId, authorizedAt: createdAt
        });
        this.#audit(workerAuditContext, artifactId, "artifact.created", {
          visibility: "task_private", contentHash: prepared.hash, source: "worker"
        }, null, 1);
        this.#audit(workerAuditContext, artifactId, "artifact.reference_created", {
          referenceId, taskId: context.taskId, relation, required,
          versionPolicy, pinnedVersion: 1, pinnedHash: prepared.hash, source: "worker"
        }, null, 1);
        this.#audit(workerAuditContext, artifactId, "artifact.worker_created_and_referenced", {
          referenceId, idempotencyKey, relation, required, versionPolicy,
          pinnedVersion: 1, pinnedHash: prepared.hash
        }, null, 1);
        this.store.createArtifactWorkerCreateOperation({
          sessionId: context.sessionId, workId: context.workId,
          taskId: context.taskId, idempotencyKey, requestFingerprint,
          artifactId, referenceId, createdAt
        });
      });
      this.store.updateArtifactContentOperation(prepared.operationId, "completed");
      const created = this.store.getArtifact(artifactId);
      this.#indexArtifact(created, isTextMime(mimeType) ? buffer.toString("utf8") : "");
      return { ...this.present(created), idempotentReplay: false };
    } catch (error) {
      await this.#rollbackPrepared(prepared, error);
      const raced = this.store.getArtifactWorkerCreateOperation(context.sessionId, idempotencyKey);
      if (raced) return this.#workerCreateReplay(context, raced, requestFingerprint);
      throw error;
    }
  }

  #workerCreateReplay(context, operation, requestFingerprint) {
    if (operation.request_fingerprint !== requestFingerprint) {
      throw artifactError(
        "ARTIFACT_IDEMPOTENCY_CONFLICT",
        "idempotencyKey is already associated with different Worker Artifact input.",
        409
      );
    }
    if (operation.work_id !== context.workId || operation.task_id !== context.taskId) {
      throw artifactError("ARTIFACT_IDEMPOTENCY_SCOPE_INVALID", "Stored Worker Artifact operation does not match the current authoritative binding.", 409);
    }
    const artifact = this.store.getArtifact(operation.artifact_id);
    const reference = this.store.getArtifactReference(operation.reference_id);
    if (!artifact || !reference
      || artifact.workId !== context.workId
      || artifact.visibility !== "task_private"
      || artifact.boundTaskId !== context.taskId
      || reference.artifactId !== artifact.artifactId
      || reference.workId !== context.workId
      || reference.taskId !== context.taskId
      || reference.sessionId != null
      || reference.revokedAt != null) {
      throw artifactError("ARTIFACT_IDEMPOTENCY_STATE_INVALID", "Stored Worker Artifact operation is incomplete or outside its authoritative scope.", 409);
    }
    return { ...this.present(artifact), idempotentReplay: true };
  }

  async importLocalFile(contextInput, input = {}) {
    const path = resolve(requiredText(input.path, "path"));
    const info = await stat(path);
    if (!info.isFile()) throw artifactError("ARTIFACT_IMPORT_NOT_FILE", "Import path must be a local regular file.", 400);
    const content = await readFile(path);
    const artifact = await this.create(contextInput, { ...input, content, title: input.title ?? path.split("/").pop() });
    return { artifact, receipt: { sourcePath: path, sourcePreserved: true, byteLength: content.byteLength, contentHash: sha256(content), remoteWrite: false } };
  }

  async publishVersion(contextInput, artifactId, input = {}) {
    const context = this.context(contextInput);
    const artifact = this.#sameWorkArtifact(context, artifactId);
    if (context.kind === "worker" && artifact.scope === "task") {
      return this.publishAndRepin(contextInput, artifactId, input);
    }
    this.#assertCanManageArtifact(context, artifact);
    if (artifact.visibility === "repository_tracked") throw artifactError("ARTIFACT_REPOSITORY_CONTENT_FORBIDDEN", "Repository-tracked Artifacts do not store private versions.", 400);
    if (artifact.status === "revoked") throw artifactError("ARTIFACT_REVOKED", "Revoked Artifact is immutable.", 409);
    const versionNumber = artifact.currentVersion + 1;
    const buffer = contentBuffer(input.content);
    const prepared = await this.#prepareContent(artifact.artifactId, versionNumber, buffer);
    const createdAt = this.clock();
    const approvalStatus = input.approvalStatus === "draft" ? "draft" : "approved";
    try {
      let affected = [];
      this.store.runInTransaction(() => {
        this.store.createArtifactVersion({
          artifactId: artifact.artifactId, version: versionNumber, contentHash: prepared.hash,
          byteLength: buffer.byteLength, mimeType: optionalText(input.mimeType) ?? "text/markdown",
          storageKey: prepared.storageKey, sourceSessionId: context.sessionId,
          sourceEventId: optionalText(input.sourceEventId), supersedesVersion: artifact.currentVersion,
          approvalStatus, actorId: context.actorId, createdAt
        });
        this.store.updateArtifact(artifact.artifactId, {
          currentVersion: versionNumber,
          approvedVersion: approvalStatus === "approved" ? versionNumber : artifact.approvedVersion,
          summary: input.summary == null ? artifact.summary : optionalText(input.summary) ?? "",
          updatedAt: createdAt
        });
        affected = this.#advanceLatestApprovedReferences(context, artifact, versionNumber, prepared.hash, approvalStatus);
        this.#audit(context, artifact.artifactId, "artifact.version_published", {
          contentHash: prepared.hash, approvalStatus, affectedReferences: affected
        }, artifact.currentVersion, versionNumber);
      });
      this.store.updateArtifactContentOperation(prepared.operationId, "completed");
      const updated = this.store.getArtifact(artifact.artifactId);
      const indexedBody = isTextMime(optionalText(input.mimeType) ?? "text/markdown") ? buffer.toString("utf8") : "";
      this.#indexArtifact(updated, indexedBody);
      return { artifact: this.present(updated), version: this.store.getArtifactVersion(artifact.artifactId, versionNumber), affected };
    } catch (error) {
      await this.#rollbackPrepared(prepared, error);
      throw error;
    }
  }

  async publishAndRepin(contextInput, artifactId, input = {}) {
    const context = this.context(contextInput);
    const artifact = this.#sameWorkArtifact(context, artifactId);
    const taskId = context.kind === "worker"
      ? context.taskId
      : requiredText(input.taskId, "taskId");
    if (context.kind === "worker") this.#assertActiveWorkerBinding(context);
    else this.#assertManager(context);
    if (artifact.visibility !== "task_private" || artifact.scope !== "task"
      || artifact.boundTaskId !== taskId) {
      throw artifactError(
        "ARTIFACT_PRIVATE_PUBLISH_FORBIDDEN",
        "Restricted publish requires a private Artifact owned by the current Task.",
        403
      );
    }
    if (artifact.status !== "active") {
      throw artifactError("ARTIFACT_VERSION_APPEND_FORBIDDEN", "Artifact status does not allow a new version.", 409);
    }
    const expectedResourceVersion = boundedInteger(
      input.expectedResourceVersion, 1, Number.MAX_SAFE_INTEGER, null, "expectedResourceVersion"
    );
    const expectedPinnedVersion = boundedInteger(
      input.expectedPinnedVersion, 1, Number.MAX_SAFE_INTEGER, null, "expectedPinnedVersion"
    );
    const expectedPinnedHash = requiredText(input.expectedPinnedHash, "expectedPinnedHash");
    if (!/^[a-f0-9]{64}$/.test(expectedPinnedHash)) {
      throw artifactError("ARTIFACT_HASH_INVALID", "expectedPinnedHash must be a lowercase SHA-256 digest.", 400);
    }
    const idempotencyKey = requiredText(input.idempotencyKey, "idempotencyKey");
    if (idempotencyKey.length > 200) {
      throw artifactError("ARTIFACT_IDEMPOTENCY_KEY_INVALID", "idempotencyKey must not exceed 200 characters.", 400);
    }
    const actorScopeId = context.sessionId ?? `local-actor:${context.actorId}`;
    const buffer = contentBuffer(input.content);
    const mimeType = optionalText(input.mimeType) ?? "text/markdown";
    const summary = input.summary == null ? artifact.summary : String(input.summary).trim();
    const approvalStatus = input.approvalStatus == null
      ? "approved"
      : enumValue(input.approvalStatus, new Set(["draft", "approved"]), "ARTIFACT_APPROVAL_STATUS_INVALID");
    const contentHash = sha256(buffer);
    const requestFingerprint = sha256(Buffer.from(JSON.stringify({
      artifactId: artifact.artifactId, taskId, expectedResourceVersion,
      expectedPinnedVersion, expectedPinnedHash, contentHash, mimeType, summary, approvalStatus,
      referenceId: optionalText(input.referenceId)
    }), "utf8"));
    const replay = this.store.getArtifactWorkerPublishOperation(actorScopeId, idempotencyKey);
    if (replay) return this.#publishAndRepinReplay(context, replay, requestFingerprint);

    if (artifact.resourceVersion !== expectedResourceVersion) {
      throw artifactError("ARTIFACT_RESOURCE_VERSION_CONFLICT", "Artifact resource version changed before publish.", 409);
    }
    const candidates = this.store.listArtifactReferences({ artifactId: artifact.artifactId })
      .filter((reference) => reference.taskId === taskId
        && reference.versionPolicy === "fixed"
        && reference.pinnedVersion === expectedPinnedVersion
        && safeHashEqual(reference.pinnedHash, expectedPinnedHash)
        && (!input.referenceId || reference.referenceId === input.referenceId));
    if (candidates.length === 0) {
      throw artifactError("ARTIFACT_REFERENCE_PIN_CONFLICT", "Current Task has no active fixed Reference with the expected pin.", 409);
    }
    if (candidates.length > 1) {
      throw artifactError("ARTIFACT_REFERENCE_AMBIGUOUS", "referenceId is required when multiple fixed References share the expected pin.", 409);
    }
    const reference = candidates[0];
    const versionNumber = artifact.currentVersion + 1;
    const prepared = await this.#prepareContent(artifact.artifactId, versionNumber, buffer);
    const createdAt = this.clock();
    const actorContext = context.kind === "worker" ? { ...context, actorId: context.sessionId } : context;
    try {
      this.store.runInTransaction(() => {
        const currentArtifact = this.store.getArtifact(artifact.artifactId);
        const currentReference = this.store.getArtifactReference(reference.referenceId);
        if (!currentArtifact || currentArtifact.resourceVersion !== expectedResourceVersion
          || currentArtifact.currentVersion !== artifact.currentVersion) {
          throw artifactError("ARTIFACT_RESOURCE_VERSION_CONFLICT", "Artifact changed while the version was being prepared.", 409);
        }
        if (!currentReference || currentReference.revokedAt
          || currentReference.resourceVersion !== reference.resourceVersion
          || currentReference.pinnedVersion !== expectedPinnedVersion
          || !safeHashEqual(currentReference.pinnedHash, expectedPinnedHash)) {
          throw artifactError("ARTIFACT_REFERENCE_PIN_CONFLICT", "Artifact Reference pin changed while the version was being prepared.", 409);
        }
        if (context.kind === "worker") this.#assertActiveWorkerBinding(context);
        this.store.createArtifactVersion({
          artifactId: artifact.artifactId, version: versionNumber,
          contentHash: prepared.hash, byteLength: buffer.byteLength, mimeType,
          storageKey: prepared.storageKey, sourceSessionId: context.sessionId,
          sourceEventId: optionalText(input.sourceEventId), supersedesVersion: artifact.currentVersion,
          approvalStatus, actorId: actorContext.actorId, createdAt
        });
        this.store.updateArtifact(artifact.artifactId, {
          currentVersion: versionNumber,
          approvedVersion: approvalStatus === "approved" ? versionNumber : artifact.approvedVersion,
          summary, updatedAt: createdAt
        });
        this.store.updateArtifactReference(reference.referenceId, {
          pinnedVersion: versionNumber, pinnedHash: prepared.hash,
          pendingVersion: null, pendingHash: null
        });
        this.#audit(actorContext, artifact.artifactId, "artifact.private_version_published", {
          referenceId: reference.referenceId, idempotencyKey, contentHash: prepared.hash,
          previousPinnedVersion: expectedPinnedVersion, previousPinnedHash: expectedPinnedHash
        }, artifact.currentVersion, versionNumber);
        this.#audit(actorContext, artifact.artifactId, "artifact.reference_repinned", {
          referenceId: reference.referenceId,
          fromVersion: expectedPinnedVersion, fromHash: expectedPinnedHash,
          toVersion: versionNumber, toHash: prepared.hash
        }, expectedPinnedVersion, versionNumber);
        this.store.createArtifactWorkerPublishOperation({
          actorScopeId, workId: context.workId, taskId,
          idempotencyKey, requestFingerprint, artifactId: artifact.artifactId,
          referenceId: reference.referenceId, version: versionNumber,
          contentHash: prepared.hash, operationStatus: "completed", createdAt
        });
      });
      this.store.updateArtifactContentOperation(prepared.operationId, "completed");
      const updated = this.store.getArtifact(artifact.artifactId);
      this.#indexArtifact(updated, isTextMime(mimeType) ? buffer.toString("utf8") : "");
      return this.#publishAndRepinResult(updated, reference.referenceId, versionNumber, "completed", false);
    } catch (error) {
      await this.#rollbackPrepared(prepared, error);
      const raced = this.store.getArtifactWorkerPublishOperation(actorScopeId, idempotencyKey);
      if (raced) return this.#publishAndRepinReplay(context, raced, requestFingerprint);
      throw error;
    }
  }

  #publishAndRepinReplay(context, operation, requestFingerprint) {
    if (operation.request_fingerprint !== requestFingerprint
      || operation.work_id !== context.workId) {
      throw artifactError("ARTIFACT_IDEMPOTENCY_CONFLICT", "idempotencyKey is associated with different publish input.", 409);
    }
    const artifact = this.store.getArtifact(operation.artifact_id);
    const reference = this.store.getArtifactReference(operation.reference_id);
    const version = this.store.getArtifactVersion(operation.artifact_id, Number(operation.version));
    if (!artifact || !reference || !version
      || reference.pinnedVersion !== Number(operation.version)
      || !safeHashEqual(reference.pinnedHash, operation.content_hash)
      || !safeHashEqual(version.contentHash, operation.content_hash)) {
      throw artifactError("ARTIFACT_PUBLISH_NEEDS_REPAIR", "Stored publish operation requires repair before retry.", 409);
    }
    return this.#publishAndRepinResult(
      artifact, reference.referenceId, version.version,
      operation.operation_status ?? "completed", true
    );
  }

  #publishAndRepinResult(artifact, referenceId, versionNumber, operationStatus, idempotentReplay) {
    const reference = this.store.getArtifactReference(referenceId);
    const version = this.store.getArtifactVersion(artifact.artifactId, versionNumber);
    return {
      artifact: this.present(artifact), version, reference,
      artifactId: artifact.artifactId, contentHash: version.contentHash,
      byteLength: version.byteLength, resourceVersion: artifact.resourceVersion,
      referenceId: reference.referenceId, pinnedVersion: reference.pinnedVersion,
      pinnedHash: reference.pinnedHash, operationStatus, idempotentReplay
    };
  }

  createReference(contextInput, artifactId, input = {}) {
    const context = this.context(contextInput);
    const artifact = this.#sameWorkArtifact(context, artifactId);
    const taskId = optionalText(input.taskId);
    const sessionId = optionalText(input.sessionId);
    if (!taskId && !sessionId) throw artifactError("ARTIFACT_REFERENCE_TARGET_REQUIRED", "taskId or sessionId is required.", 400);
    if (context.kind === "worker"
      && ((taskId && taskId !== context.taskId) || (sessionId && sessionId !== context.sessionId))) {
      throw artifactError("ARTIFACT_REFERENCE_TARGET_FORBIDDEN", "Worker may create References only for its current Task or Session.", 403);
    }
    if (context.kind !== "worker") this.#assertManager(context);
    const task = taskId ? this.store.getTask(taskId) : null;
    if (taskId && (!task || task.work_id !== context.workId)) {
      throw artifactError("ARTIFACT_CROSS_WORK_FORBIDDEN", "Artifact references cannot cross Work boundaries.", 403);
    }
    const session = sessionId ? this.store.getSession(sessionId) : null;
    if (sessionId && (!session || (session.workId ?? session.work_id) !== context.workId)) {
      throw artifactError("ARTIFACT_CROSS_WORK_FORBIDDEN", "Artifact references cannot target another Work's Session.", 403);
    }
    const relation = enumValue(input.relation, RELATIONS, "ARTIFACT_RELATION_INVALID");
    const versionPolicy = enumValue(input.versionPolicy ?? "fixed", VERSION_POLICIES, "ARTIFACT_VERSION_POLICY_INVALID");
    const pinnedVersion = input.version == null ? artifact.approvedVersion ?? artifact.currentVersion : boundedInteger(input.version, 1, artifact.currentVersion, null, "version");
    const version = this.store.getArtifactVersion(artifact.artifactId, pinnedVersion);
    if (!version && artifact.visibility !== "repository_tracked") throw artifactError("ARTIFACT_VERSION_NOT_FOUND", "Artifact version not found.", 404);
    const pinnedHash = version?.contentHash;
    const authorizedAt = this.clock();
    const reference = this.store.runInTransaction(() => {
      const created = this.store.createArtifactReference({
        referenceId: `artifact_reference:${this.idFactory()}`, artifactId: artifact.artifactId,
        workId: context.workId, taskId, sessionId, relation,
        required: input.required === true, versionPolicy, pinnedVersion,
        pinnedHash, actorId: context.actorId, authorizedAt
      });
      this.#audit(context, artifact.artifactId, "artifact.reference_created", { referenceId: created.referenceId, relation, versionPolicy, required: created.required, pinnedHash }, null, pinnedVersion);
      return created;
    });
    return reference;
  }

  prepareTaskCreationReference(contextInput, artifactId, input = {}) {
    const context = this.context(contextInput);
    const artifact = this.#sameWorkArtifact(context, artifactId);
    if (!this.#canAuthorizeReference(context, artifact)) {
      throw artifactError("ARTIFACT_READ_FORBIDDEN", "Artifact is not authorized for this Session to reference.", 403);
    }
    const relation = enumValue(
      input.relation ?? "implementation_spec",
      RELATIONS,
      "ARTIFACT_RELATION_INVALID"
    );
    const versionPolicy = enumValue(
      input.versionPolicy ?? "fixed",
      VERSION_POLICIES,
      "ARTIFACT_VERSION_POLICY_INVALID"
    );
    if (input.required != null && typeof input.required !== "boolean") {
      throw artifactError("ARTIFACT_INVALID_INPUT", "required must be a boolean.", 400);
    }
    const selected = this.#selectedVersion(context, artifact, input.version);
    if (!selected) throw artifactError("ARTIFACT_VERSION_NOT_FOUND", "Artifact version not found.", 404);
    return Object.freeze({
      context, artifactId: artifact.artifactId, workId: context.workId,
      relation, required: input.required === true, versionPolicy,
      pinnedVersion: selected.version, pinnedHash: selected.contentHash
    });
  }

  createPreparedTaskReference(prepared, taskId) {
    const task = this.store.getTask(requiredText(taskId, "taskId"));
    if (!task) throw artifactError("ARTIFACT_TASK_NOT_FOUND", "Task not found.", 404);
    if (task.work_id !== prepared?.workId) {
      throw artifactError(
        "ARTIFACT_CROSS_WORK_FORBIDDEN",
        "Artifact references cannot cross Work boundaries.",
        403
      );
    }
    if (task.deletion_status === "deleting") {
      throw artifactError("TASK_DELETION_IN_PROGRESS", "Cannot reference an Artifact while the Task is being deleted.", 409);
    }
    const artifact = this.#sameWorkArtifact(prepared.context, prepared.artifactId);
    const version = this.store.getArtifactVersion(artifact.artifactId, prepared.pinnedVersion);
    if (!version || version.contentHash !== prepared.pinnedHash) {
      throw artifactError("ARTIFACT_VERSION_NOT_FOUND", "The selected Artifact version is no longer available.", 409);
    }
    const authorizedAt = this.clock();
    const reference = this.store.createArtifactReference({
      referenceId: `artifact_reference:${this.idFactory()}`,
      artifactId: artifact.artifactId,
      workId: prepared.workId,
      taskId: task.id,
      sessionId: null,
      relation: prepared.relation,
      required: prepared.required,
      versionPolicy: prepared.versionPolicy,
      pinnedVersion: prepared.pinnedVersion,
      pinnedHash: prepared.pinnedHash,
      actorId: prepared.context.sessionId ?? prepared.context.actorId,
      authorizedAt
    });
    this.#audit(prepared.context, artifact.artifactId, "artifact.reference_created", {
      referenceId: reference.referenceId,
      taskId: task.id,
      relation: reference.relation,
      required: reference.required,
      versionPolicy: reference.versionPolicy,
      pinnedHash: reference.pinnedHash,
      source: "task_creation"
    }, null, reference.pinnedVersion);
    return reference;
  }

  revokeReference(contextInput, referenceId, reason) {
    const context = this.context(contextInput);
    const reference = this.store.getArtifactReference(requiredText(referenceId, "referenceId"));
    if (!reference || reference.workId !== context.workId) throw artifactError("ARTIFACT_REFERENCE_NOT_FOUND", "Artifact reference not found.", 404);
    this.#assertCanManageReference(context, reference);
    if (reference.revokedAt) return reference;
    const revoked = this.store.updateArtifactReference(reference.referenceId, {
      revokedAt: this.clock(), revokedByActorId: context.actorId, revocationReason: requiredText(reason, "reason")
    });
    this.#audit(context, reference.artifactId, "artifact.access_revoked", { referenceId, reason });
    return revoked;
  }

  updateMetadata(contextInput, artifactId, patch = {}) {
    const context = this.context(contextInput);
    const artifact = this.#sameWorkArtifact(context, artifactId);
    this.#assertCanManageArtifact(context, artifact);
    const next = {};
    if (patch.title != null) next.title = requiredText(patch.title, "title");
    if (patch.summary != null) next.summary = String(patch.summary).trim();
    if (patch.kind != null) next.kind = normalizeTaxonomyValue(patch.kind, "kind");
    if (patch.categoryPath != null) next.categoryPath = normalizeCategoryPath(patch.categoryPath);
    if (patch.tags != null) next.tags = normalizedStringList(patch.tags);
    if (patch.aliases != null) next.aliases = normalizedStringList(patch.aliases);
    if (patch.keywords != null) next.keywords = normalizedStringList(patch.keywords);
    if (Object.keys(next).length === 0) {
      throw artifactError("ARTIFACT_INVALID_INPUT", "At least one Artifact metadata field is required.", 400);
    }
    next.updatedAt = this.clock();
    const updated = this.store.updateArtifact(artifact.artifactId, next);
    this.#indexArtifact(updated);
    this.#audit(context, artifact.artifactId, "artifact.metadata_updated", {
      changedFields: Object.keys(next).filter((key) => key !== "updatedAt")
    });
    return this.#presentForContext(context, updated);
  }

  restoreArtifact(contextInput, artifactId) {
    const context = this.context(contextInput);
    const artifact = this.#sameWorkArtifact(context, artifactId);
    this.#assertCanManageArtifact(context, artifact);
    const updated = this.store.updateArtifact(artifact.artifactId, { status: "active", updatedAt: this.clock() });
    this.#indexArtifact(updated);
    this.#audit(context, artifact.artifactId, "artifact.restored", {});
    return this.#presentForContext(context, updated);
  }

  changeVisibility(contextInput, artifactId, visibilityValue, { confirmed = false } = {}) {
    const context = this.context(contextInput);
    const artifact = this.#sameWorkArtifact(context, artifactId);
    this.#assertCanManageArtifact(context, artifact);
    const visibility = enumValue(visibilityValue, VISIBILITIES, "ARTIFACT_VISIBILITY_INVALID");
    if (visibility !== artifact.visibility && confirmed !== true) {
      throw artifactError("ARTIFACT_CONFIRMATION_REQUIRED", "Visibility changes require explicit confirmation.", 409);
    }
    if (visibility !== artifact.visibility && (visibility === "repository_tracked" || artifact.visibility === "repository_tracked")) {
      throw artifactError("ARTIFACT_VISIBILITY_TRANSITION_FORBIDDEN", "Repository-tracked registration cannot be converted to or from private content.", 409);
    }
    this.#validateBinding(context.workId, visibility, artifact);
    const updated = this.store.updateArtifact(artifact.artifactId, {
      visibility, scope: artifactScope(visibility), updatedAt: this.clock()
    });
    this.#indexArtifact(updated);
    this.#audit(context, artifact.artifactId, "artifact.visibility_changed", { from: artifact.visibility, to: visibility });
    return this.present(updated);
  }

  supersede(contextInput, artifactId) {
    const context = this.context(contextInput);
    const artifact = this.#sameWorkArtifact(context, artifactId);
    this.#assertCanManageArtifact(context, artifact);
    const updated = this.store.updateArtifact(artifact.artifactId, { status: "superseded", updatedAt: this.clock() });
    this.#indexArtifact(updated);
    this.#audit(context, artifact.artifactId, "artifact.superseded", {});
    return this.present(updated);
  }

  revokeArtifact(contextInput, artifactId, reason) {
    const context = this.context(contextInput);
    const artifact = this.#sameWorkArtifact(context, artifactId);
    this.#assertCanManageArtifact(context, artifact);
    const updated = this.store.updateArtifact(artifact.artifactId, { status: "revoked", updatedAt: this.clock() });
    this.#indexArtifact(updated);
    this.#audit(context, artifact.artifactId, "artifact.revoked", { reason: requiredText(reason, "reason") });
    return this.present(updated);
  }

  disposeBoundArtifactsForTaskDeletion(contextInput, taskIdValue, disposition) {
    const context = this.context(contextInput);
    const taskId = requiredText(taskIdValue, "taskId");
    const task = this.store.getTask(taskId);
    if (!task || task.work_id !== context.workId) {
      throw artifactError("ARTIFACT_TASK_NOT_FOUND", "Task not found for Artifact disposal.", 404);
    }
    if (!["delete", "work", "retain"].includes(disposition)) {
      throw artifactError("TASK_ARTIFACT_DISPOSITION_INVALID", `Unsupported Artifact disposition: ${disposition}`, 400);
    }
    const artifacts = this.store.listTaskDeletionBlockingAssociations(taskId).artifacts
      .map((item) => this.store.getArtifact(item.artifactId))
      .filter(Boolean);
    if (disposition === "retain") {
      return { disposition, artifactIds: artifacts.map((artifact) => artifact.artifactId) };
    }
    const updated = [];
    for (const artifact of artifacts) {
      const patch = disposition === "delete"
        ? { status: "revoked", boundTaskId: null, boundSessionId: null, updatedAt: this.clock() }
        : {
            visibility: "work_private", scope: "work",
            boundTaskId: null, boundSessionId: null, updatedAt: this.clock()
          };
      const next = this.store.updateArtifact(artifact.artifactId, patch);
      this.#indexArtifact(next);
      this.#audit(context, artifact.artifactId,
        disposition === "delete" ? "artifact.revoked" : "artifact.moved_to_work",
        { reason: "task_deleted", taskId });
      updated.push(artifact.artifactId);
    }
    return { disposition, artifactIds: updated };
  }

  acknowledgePendingReference(contextInput, referenceId) {
    const context = this.context(contextInput);
    const reference = this.store.getArtifactReference(requiredText(referenceId, "referenceId"));
    if (!reference || reference.workId !== context.workId) throw artifactError("ARTIFACT_REFERENCE_NOT_FOUND", "Artifact reference not found.", 404);
    this.#assertCanManageReference(context, reference);
    if (!reference.pendingVersion) return reference;
    const updated = this.store.updateArtifactReference(reference.referenceId, {
      pinnedVersion: reference.pendingVersion, pinnedHash: reference.pendingHash,
      pendingVersion: null, pendingHash: null
    });
    this.#audit(context, reference.artifactId, "artifact.reference_update_acknowledged", { referenceId }, reference.pinnedVersion, updated.pinnedVersion);
    return updated;
  }

  indexForSession(session) {
    return buildArtifactContextIndex({ store: this.store, session });
  }

  present(artifact) {
    if (!artifact) return null;
    return {
      ...artifact,
      versions: this.store.listArtifactVersions(artifact.artifactId),
      references: this.store.listArtifactReferences({ artifactId: artifact.artifactId, includeRevoked: true }),
      audit: this.store.listArtifactAudit(artifact.workId, artifact.artifactId).slice(0, 100)
    };
  }

  async verifyIntegrity(artifactId) {
    const artifact = this.store.getArtifact(artifactId);
    if (!artifact) throw artifactError("ARTIFACT_NOT_FOUND", "Artifact not found.", 404);
    const results = [];
    for (const version of this.store.listArtifactVersions(artifactId)) {
      if (!version.storageKey) { results.push({ version: version.version, ok: true, repositoryTracked: true }); continue; }
      try {
        const buffer = await readFile(this.#safeStoragePath(version.storageKey));
        results.push({ version: version.version, ok: buffer.byteLength === version.byteLength && sha256(buffer) === version.contentHash });
      } catch (error) {
        results.push({ version: version.version, ok: false, error: error.code ?? error.message });
      }
    }
    return { artifactId, ok: results.every((item) => item.ok), versions: results };
  }

  async exportArtifact(contextInput, artifactId, input = {}) {
    const context = this.#pinnedReadContext(contextInput);
    this.#assertManager(context);
    if (input.confirmed !== true) throw artifactError("ARTIFACT_CONFIRMATION_REQUIRED", "Export requires explicit confirmation.", 409);
    const authorized = this.referenceAuthorizer.authorize(context, {
      artifactId,
      version: input.version,
      contentHash: input.contentHash,
      referenceId: input.referenceId
    });
    const { artifact, version } = authorized;
    if (!version?.storageKey) throw artifactError("ARTIFACT_EXPORT_UNAVAILABLE", "This Artifact has no private content to export.", 400);
    const destination = resolve(requiredText(input.destinationPath, "destinationPath"));
    const repository = this.store.listGitRepositories().find((entry) => {
      const root = resolve(entry.path);
      return destination === root || destination.startsWith(`${root}/`);
    });
    if (repository && input.confirmedRepositoryWrite !== true) {
      throw artifactError("ARTIFACT_REPOSITORY_WRITE_CONFIRMATION_REQUIRED", "Export destination is inside a Git Repository and requires separate confirmation.", 409);
    }
    const buffer = await readFile(this.#safeStoragePath(version.storageKey));
    if (buffer.byteLength !== version.byteLength || sha256(buffer) !== version.contentHash) {
      throw artifactError("ARTIFACT_INTEGRITY_FAILED", "Artifact export failed integrity verification.", 409);
    }
    await mkdir(dirname(destination), { recursive: true });
    try {
      await access(destination, constants.F_OK);
      if (input.confirmedOverwrite !== true) throw artifactError("ARTIFACT_EXPORT_EXISTS", "Export destination exists; overwrite requires explicit confirmation.", 409);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const temp = `${destination}.corptie-export-${this.idFactory()}.tmp`;
    await writeFile(temp, buffer, { mode: 0o600, flag: "wx" });
    const handle = await open(temp, "r+");
    try { await handle.sync(); } finally { await handle.close(); }
    await rename(temp, destination);
    this.#audit(context, artifact.artifactId, "artifact.exported", {
      destinationPath: destination, repositoryId: repository?.id ?? null, contentHash: version.contentHash
    }, version.version, version.version);
    return { artifactId: artifact.artifactId, version: version.version, contentHash: version.contentHash, destinationPath: destination, repositoryWrite: Boolean(repository) };
  }

  async localFile(contextInput, artifactId, input = {}) {
    const context = this.#pinnedReadContext(contextInput);
    const authorized = this.referenceAuthorizer.authorize(context, {
      artifactId,
      version: input.version,
      contentHash: input.contentHash,
      referenceId: input.referenceId
    });
    const { artifact, version } = authorized;

    let path;
    if (version.storageKey) {
      path = this.#safeStoragePath(version.storageKey);
    } else {
      const locator = requiredText(artifact.repositoryLocator, "repositoryLocator");
      const candidates = isAbsolute(locator)
        ? [resolve(locator)]
        : this.store.listGitRepositories().map((repository) => {
            const root = resolve(repository.path);
            const candidate = resolve(root, locator);
            return candidate === root || candidate.startsWith(`${root}/`) ? candidate : null;
          }).filter(Boolean);
      path = await firstExistingFileCandidate(candidates);
      if (!path) {
        throw artifactError(
          "ARTIFACT_LOCAL_FILE_NOT_FOUND",
          "The Artifact's local file does not exist or its repository location is unavailable.",
          404
        );
      }
    }

    let info;
    try {
      info = await stat(path);
      if (!info.isFile()) {
        throw artifactError("ARTIFACT_LOCAL_FILE_NOT_FILE", "The Artifact's local path is not a regular file.", 400);
      }
      await access(path, constants.R_OK);
    } catch (error) {
      if (error.code === "EACCES" || error.code === "EPERM") {
        throw artifactError("ARTIFACT_LOCAL_FILE_PERMISSION_DENIED", "Corptie does not have permission to open this Artifact file.", 403);
      }
      if (error.code === "ENOENT") {
        throw artifactError("ARTIFACT_LOCAL_FILE_NOT_FOUND", "The Artifact's local file no longer exists.", 404);
      }
      throw error;
    }
    if (version.storageKey && Number(info.size) !== Number(version.byteLength)) {
      throw artifactError("ARTIFACT_INTEGRITY_FAILED", "The Artifact file size no longer matches its recorded version.", 409);
    }

    return {
      artifactId: artifact.artifactId,
      version: version.version,
      path,
      suggestedFilename: artifactSuggestedFilename(artifact.title, version.mimeType),
      mimeType: version.mimeType
    };
  }

  async backupWork(contextInput, input = {}) {
    const context = this.context(contextInput);
    this.#assertManager(context);
    if (input.confirmed !== true) throw artifactError("ARTIFACT_CONFIRMATION_REQUIRED", "Backup requires explicit confirmation.", 409);
    const destination = resolve(requiredText(input.destinationPath, "destinationPath"));
    await mkdir(destination, { recursive: false, mode: 0o700 });
    const artifacts = this.store.listArtifactsByWork(context.workId, { includeRevoked: true });
    const manifest = {
      format: "corptie-work-artifact-backup-v1", workId: context.workId,
      environment: this.store.settings().environment, createdAt: this.clock(), artifacts: []
    };
    try {
      for (const artifact of artifacts) {
        const versions = this.store.listArtifactVersions(artifact.artifactId);
        const backupVersions = [];
        for (const version of versions) {
          let relativePath = null;
          if (version.storageKey) {
            const buffer = await readFile(this.#safeStoragePath(version.storageKey));
            if (buffer.byteLength !== version.byteLength || sha256(buffer) !== version.contentHash) {
              throw artifactError("ARTIFACT_INTEGRITY_FAILED", `Backup integrity failed for ${artifact.artifactId} v${version.version}.`, 409);
            }
            relativePath = join("objects", artifact.artifactId.replaceAll(":", "_"), `v${version.version}.bin`);
            const output = resolve(destination, relativePath);
            await mkdir(dirname(output), { recursive: true, mode: 0o700 });
            await writeFile(output, buffer, { mode: 0o600, flag: "wx" });
          }
          backupVersions.push({ ...version, storageKey: null, backupPath: relativePath });
        }
        manifest.artifacts.push({
          artifact, versions: backupVersions,
          references: this.store.listArtifactReferences({ artifactId: artifact.artifactId, includeRevoked: true })
        });
      }
      await writeFile(join(destination, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600, flag: "wx" });
      this.store.appendArtifactAudit({
        auditId: `artifact_audit:${this.idFactory()}`, artifactId: null, workId: context.workId,
        action: "artifact.backup_created", actorId: context.actorId, sessionId: context.sessionId,
        details: { destinationPath: destination, artifactCount: artifacts.length }, createdAt: this.clock()
      });
      return { destinationPath: destination, artifactCount: artifacts.length, format: manifest.format };
    } catch (error) {
      throw artifactError(error.code ?? "ARTIFACT_BACKUP_FAILED", `Artifact backup failed without reporting success: ${error.message}`, error.statusCode ?? 500);
    }
  }

  async restoreWork(contextInput, input = {}) {
    const context = this.context(contextInput);
    this.#assertManager(context);
    if (input.confirmed !== true) throw artifactError("ARTIFACT_CONFIRMATION_REQUIRED", "Restore requires explicit confirmation.", 409);
    const source = resolve(requiredText(input.sourcePath, "sourcePath"));
    const manifest = JSON.parse(await readFile(join(source, "manifest.json"), "utf8"));
    if (manifest?.format !== "corptie-work-artifact-backup-v1") throw artifactError("ARTIFACT_BACKUP_FORMAT_INVALID", "Unsupported Artifact backup format.", 400);
    if (manifest.workId !== context.workId) throw artifactError("ARTIFACT_CROSS_WORK_FORBIDDEN", "Backup belongs to another Work; restore will not widen access.", 403);
    const verified = [];
    for (const entry of manifest.artifacts ?? []) {
      if (entry.artifact?.workId !== context.workId) throw artifactError("ARTIFACT_CROSS_WORK_FORBIDDEN", "Backup contains a cross-Work Artifact.", 403);
      for (const version of entry.versions ?? []) {
        if (!version.backupPath) continue;
        const path = resolve(source, version.backupPath);
        if (!path.startsWith(`${source}/`)) throw artifactError("ARTIFACT_BACKUP_FORMAT_INVALID", "Backup content path escaped its bundle.", 400);
        const buffer = await readFile(path);
        if (buffer.byteLength !== version.byteLength || sha256(buffer) !== version.contentHash) {
          throw artifactError("ARTIFACT_INTEGRITY_FAILED", `Restore integrity failed for ${entry.artifact.artifactId} v${version.version}.`, 409);
        }
        verified.push({ artifactId: entry.artifact.artifactId, version: version.version, buffer });
      }
    }
    let restoredArtifacts = 0;
    for (const entry of manifest.artifacts ?? []) {
      const artifact = entry.artifact;
      let current = this.store.getArtifact(artifact.artifactId);
      if (current && current.workId !== context.workId) throw artifactError("ARTIFACT_CROSS_WORK_FORBIDDEN", "Stable Artifact ID already belongs to another Work.", 403);
      if (!current) {
        this.store.createArtifactMetadata({
          artifactId: artifact.artifactId, workId: context.workId, title: artifact.title,
          summary: artifact.summary, visibility: artifact.visibility, boundTaskId: artifact.boundTaskId,
          boundSessionId: artifact.boundSessionId, repositoryLocator: artifact.repositoryLocator,
          sourceSessionId: artifact.sourceSessionId, sourceEventId: artifact.sourceEventId,
          actorId: context.actorId, createdAt: artifact.createdAt ?? this.clock()
        });
        restoredArtifacts += 1;
        current = this.store.getArtifact(artifact.artifactId);
      }
      for (const version of entry.versions ?? []) {
        const item = verified.find((candidate) => candidate.artifactId === artifact.artifactId && candidate.version === version.version);
        const existingVersion = this.store.getArtifactVersion(artifact.artifactId, version.version);
        if (existingVersion) {
          if (item && existingVersion.storageKey) {
            let intact = false;
            try {
              const currentBuffer = await readFile(this.#safeStoragePath(existingVersion.storageKey));
              intact = currentBuffer.byteLength === existingVersion.byteLength && sha256(currentBuffer) === existingVersion.contentHash;
            } catch {}
            if (!intact) await this.#restoreExistingContent(existingVersion, item.buffer);
          }
          continue;
        }
        let prepared = null;
        if (item) prepared = await this.#prepareContent(artifact.artifactId, version.version, item.buffer);
        try {
          this.store.createArtifactVersion({
            artifactId: artifact.artifactId, version: version.version, contentHash: version.contentHash,
            byteLength: version.byteLength, mimeType: version.mimeType, storageKey: prepared?.storageKey ?? null,
            sourceSessionId: version.sourceSessionId, sourceEventId: version.sourceEventId,
            supersedesVersion: version.supersedesVersion, approvalStatus: version.approvalStatus,
            actorId: version.createdByActorId ?? context.actorId, createdAt: version.createdAt ?? this.clock()
          });
          if (prepared) this.store.updateArtifactContentOperation(prepared.operationId, "completed");
        } catch (error) {
          if (prepared) await this.#rollbackPrepared(prepared, error);
          throw error;
        }
      }
      this.store.updateArtifact(artifact.artifactId, {
        currentVersion: artifact.currentVersion, approvedVersion: artifact.approvedVersion,
        status: artifact.status, updatedAt: this.clock()
      });
      for (const reference of entry.references ?? []) {
        if (this.store.getArtifactReference(reference.referenceId)) continue;
        if (reference.taskId && !this.store.getTask(reference.taskId)) continue;
        if (reference.sessionId && !this.store.getSession(reference.sessionId)) continue;
        const created = this.store.createArtifactReference({
          referenceId: reference.referenceId, artifactId: artifact.artifactId, workId: context.workId,
          taskId: reference.taskId, sessionId: reference.sessionId, relation: reference.relation,
          required: reference.required, versionPolicy: reference.versionPolicy,
          pinnedVersion: reference.pinnedVersion, pinnedHash: reference.pinnedHash,
          actorId: context.actorId, authorizedAt: reference.authorizedAt ?? this.clock()
        });
        if (reference.revokedAt) this.store.updateArtifactReference(created.referenceId, {
          revokedAt: reference.revokedAt, revokedByActorId: reference.revokedByActorId ?? context.actorId,
          revocationReason: reference.revocationReason ?? "Restored revoked reference"
        });
      }
    }
    this.store.appendArtifactAudit({
      auditId: `artifact_audit:${this.idFactory()}`, artifactId: null, workId: context.workId,
      action: "artifact.backup_restored", actorId: context.actorId, sessionId: context.sessionId,
      details: { sourcePath: source, restoredArtifacts }, createdAt: this.clock()
    });
    return { sourcePath: source, restoredArtifacts, verifiedContentObjects: verified.length };
  }

  async recoverContentOperations() {
    const recovered = [];
    for (const operation of this.store.listIncompleteArtifactContentOperations()) {
      const version = this.store.getArtifactVersion(operation.artifact_id, Number(operation.version));
      if (version) {
        this.store.updateArtifactContentOperation(operation.operation_id, "completed");
        recovered.push({ operationId: operation.operation_id, action: "completed_existing_metadata" });
        continue;
      }
      await unlink(operation.temp_path).catch(() => {});
      const referenced = this.store.selectOne(`SELECT 1 FROM artifact_versions WHERE storage_key = ?`, [this.#storageKeyForHash(operation.content_hash)]);
      if (!referenced) await unlink(operation.final_path).catch(() => {});
      this.store.updateArtifactContentOperation(operation.operation_id, "rolled_back", "ARTIFACT_RECOVERED_ORPHAN");
      recovered.push({ operationId: operation.operation_id, action: "rolled_back_orphan" });
    }
    return recovered;
  }

  async auditOrphanedContent() {
    const objectsRoot = join(this.contentRoot, "objects");
    const detected = [];
    for (const prefix of await readdir(objectsRoot, { withFileTypes: true })) {
      if (!prefix.isDirectory() || !/^[a-f0-9]{2}$/.test(prefix.name)) continue;
      for (const entry of await readdir(join(objectsRoot, prefix.name), { withFileTypes: true })) {
        if (!entry.isFile() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
        const storageKey = join("objects", prefix.name, entry.name);
        const referenced = this.store.selectOne(`SELECT 1 FROM artifact_versions WHERE storage_key = ?`, [storageKey]);
        if (referenced) continue;
        const path = this.#safeStoragePath(storageKey);
        const info = await stat(path);
        this.store.appendArtifactStorageAudit({
          auditId: `artifact_storage_audit:${this.idFactory()}`,
          action: "orphan_content_detected",
          storageKey,
          contentHash: entry.name,
          byteLength: info.size,
          details: { retained: true, path },
          createdAt: this.clock()
        });
        detected.push({ action: "orphan_content_detected", storageKey, contentHash: entry.name, byteLength: info.size });
      }
    }
    return detected;
  }

  #assertManager(context) {
    if (!['workChat', 'local_user', 'platform_admin'].includes(context.kind)) {
      throw artifactError("ARTIFACT_WRITE_FORBIDDEN", "Worker Sessions cannot manage Work Artifacts.", 403);
    }
  }

  #assertActiveWorkerBinding(context) {
    if (context.kind !== "worker") return;
    const task = this.store.getTask(context.taskId);
    if (!task || task.work_id !== context.workId
      || task.current_session_id !== context.sessionId
      || task.deletion_status === "deleting") {
      throw artifactError("ARTIFACT_TASK_FORBIDDEN", "Worker Session no longer has an active authoritative Task binding.", 403);
    }
  }

  #assertCanManageArtifact(context, artifact) {
    if (this.#canManageArtifact(context, artifact)) return;
    if (context.kind !== "worker") throw artifactError("ARTIFACT_WRITE_FORBIDDEN", "Session cannot manage Work Artifacts.", 403);
    throw artifactError(
      "ARTIFACT_READ_ONLY",
      "Artifacts owned by another Task are read-only for this Work Session.",
      403
    );
  }

  #canManageArtifact(context, artifact) {
    if (artifact.workId !== context.workId) return false;
    if (["workChat", "local_user", "platform_admin"].includes(context.kind)) return true;
    if (context.kind !== "worker") return false;
    this.#assertActiveWorkerBinding(context);
    return artifact.scope === "work"
      || (artifact.scope === "task" && artifact.boundTaskId === context.taskId);
  }

  #assertCanManageReference(context, reference) {
    if (["workChat", "local_user", "platform_admin"].includes(context.kind)) return;
    if (context.kind === "worker"
      && ((reference.taskId && reference.taskId === context.taskId)
        || (reference.sessionId && reference.sessionId === context.sessionId))) return;
    throw artifactError("ARTIFACT_REFERENCE_READ_ONLY", "Another Task's Artifact Reference is read-only.", 403);
  }

  #sameWorkArtifact(context, artifactIdValue) {
    const artifact = this.store.getArtifact(requiredText(artifactIdValue, "artifactId"));
    if (!artifact) throw artifactError("ARTIFACT_NOT_FOUND", "Artifact not found.", 404);
    if (artifact.workId !== context.workId) throw artifactError("ARTIFACT_CROSS_WORK_FORBIDDEN", "Artifact belongs to another Work.", 403);
    return artifact;
  }

  #readableArtifact(context, artifactId) {
    const artifact = this.store.getArtifact(requiredText(artifactId, "artifactId"));
    if (!artifact || !this.#canRead(context, artifact)) {
      throw artifactError("ARTIFACT_NOT_FOUND_OR_FORBIDDEN", "Artifact was not found or is not authorized for this Session.", 404);
    }
    if (artifact.status === "revoked") throw artifactError("ARTIFACT_REVOKED", "Artifact access has been revoked.", 403);
    return artifact;
  }

  #canRead(context, artifact, relatedTaskIds = null) {
    if (artifact.workId !== context.workId || artifact.status === "revoked") return false;
    if (["workChat", "local_user", "platform_admin"].includes(context.kind)) return true;
    if (context.kind !== "worker") return false;
    if (artifact.scope === "session") return artifact.boundSessionId === context.sessionId;
    return ["work", "task"].includes(artifact.scope);
  }

  #canAuthorizeReference(context, artifact) {
    if (artifact.status === "revoked") return false;
    if (["workChat", "local_user", "platform_admin"].includes(context.kind)) return true;
    if (context.kind !== "worker") return false;
    return this.#canRead(context, artifact);
  }

  #matchingReferences(context, artifact, relatedTaskIds = null) {
    const references = this.store.listArtifactReferences({ artifactId: artifact.artifactId });
    return references.filter((reference) =>
      (reference.taskId && reference.taskId === context.taskId)
      || (reference.sessionId && reference.sessionId === context.sessionId)
    );
  }

  #tasksRelated(firstTaskId, secondTaskId) {
    if (firstTaskId === secondTaskId) return true;
    const first = this.store.getTask(firstTaskId);
    const second = this.store.getTask(secondTaskId);
    if (!first || !second || first.work_id !== second.work_id) return false;
    return this.store.listTaskDependencies(firstTaskId)
      .some((edge) => edge.target_task_id === secondTaskId)
      || this.store.listTaskDependents(firstTaskId)
        .some((edge) => edge.task_id === secondTaskId);
  }

  #relatedTaskIds(context) {
    if (context.kind !== "worker" || !context.taskId) return null;
    const related = new Set([context.taskId]);
    const current = this.store.getTask(context.taskId);
    if (!current) return related;
    for (const edge of this.store.listTaskDependencies(context.taskId)) related.add(edge.target_task_id);
    for (const edge of this.store.listTaskDependents(context.taskId)) related.add(edge.task_id);
    return related;
  }

  #selectedVersion(context, artifact, requestedVersion, relatedTaskIds = null) {
    let version = requestedVersion == null ? null : boundedInteger(requestedVersion, 1, artifact.currentVersion, null, "version");
    if (context.kind === "worker") {
      const references = this.#matchingReferences(context, artifact, relatedTaskIds);
      const allowed = new Set(references.map((reference) => reference.pinnedVersion));
      version ??= references[0]?.pinnedVersion ?? artifact.approvedVersion ?? artifact.currentVersion;
      if (references.length > 0 && !allowed.has(version)) {
        throw artifactError("ARTIFACT_VERSION_FORBIDDEN", "Requested version is not pinned for this Worker Session.", 403);
      }
    } else {
      version ??= artifact.approvedVersion ?? artifact.currentVersion;
    }
    return this.store.getArtifactVersion(artifact.artifactId, version);
  }

  #ensureWorkScopeReadReference(context, artifact, version) {
    if (!this.#canRead(context, artifact)) {
      throw artifactError("ARTIFACT_READ_FORBIDDEN", "Artifact is not readable by this Session.", 403);
    }
    const existing = this.store.listArtifactReferences({ artifactId: artifact.artifactId })
      .find((reference) => !reference.revokedAt
        && reference.authorizedByActorId === "system:work-scope-read"
        && reference.pinnedVersion === version.version
        && safeHashEqual(reference.pinnedHash, version.contentHash));
    if (existing) return existing;
    const referenceId = `artifact_reference:work-scope:${sha256(Buffer.from(`${artifact.artifactId}\0${version.version}\0${version.contentHash}`))}`;
    const input = {
      referenceId,
      artifactId: artifact.artifactId,
      workId: artifact.workId,
      taskId: null,
      sessionId: null,
      relation: "research_evidence",
      required: false,
      versionPolicy: "fixed",
      pinnedVersion: version.version,
      pinnedHash: version.contentHash,
      actorId: "system:work-scope-read",
      authorizedAt: this.clock()
    };
    try { return this.store.createArtifactReference(input); }
    catch (error) {
      const raced = this.store.getArtifactReference(referenceId);
      if (raced) return raced;
      throw error;
    }
  }

  #presentForContext(context, artifact) {
    const manageable = this.#canManageArtifact(context, artifact);
    return {
      ...this.present(artifact),
      access: {
        read: this.#canRead(context, artifact),
        write: manageable,
        delete: manageable,
        manageReferences: manageable
      }
    };
  }

  #indexArtifact(artifact, body = undefined) {
    if (!artifact) return;
    this.store.upsertArtifactSearchDocument({
      artifactId: artifact.artifactId,
      workId: artifact.workId,
      title: artifact.title,
      summary: artifact.summary,
      kind: artifact.kind,
      categoryPath: artifact.categoryPath,
      tags: artifact.tags,
      aliases: artifact.aliases,
      keywords: artifact.keywords,
      body
    });
  }

  #validateBinding(workId, visibility, input) {
    const boundTaskId = optionalText(input.boundTaskId);
    const boundSessionId = optionalText(input.boundSessionId);
    if (visibility === "task_private" && !boundTaskId) throw artifactError("ARTIFACT_TASK_REQUIRED", "task_private requires boundTaskId.", 400);
    if (visibility === "session_private" && !boundSessionId) throw artifactError("ARTIFACT_SESSION_REQUIRED", "session_private requires boundSessionId.", 400);
    if (boundTaskId) {
      const task = this.store.getTask(boundTaskId);
      if (!task || task.work_id !== workId) throw artifactError("ARTIFACT_CROSS_WORK_FORBIDDEN", "Bound Task must belong to the current Work.", 403);
      if (task.deletion_status === "deleting") {
        throw artifactError(
          "TASK_DELETION_IN_PROGRESS",
          "Cannot bind an Artifact while the Task is being deleted.",
          409
        );
      }
    }
    if (boundSessionId) {
      const session = this.store.getSession(boundSessionId);
      if (!session || (session.workId ?? session.work_id) !== workId) throw artifactError("ARTIFACT_CROSS_WORK_FORBIDDEN", "Bound Session must belong to the current Work.", 403);
    }
    return { boundTaskId, boundSessionId };
  }

  #advanceLatestApprovedReferences(context, artifact, version, hash, approvalStatus) {
    if (approvalStatus !== "approved") return [];
    const affected = [];
    for (const reference of this.store.listArtifactReferences({ artifactId: artifact.artifactId })) {
      if (reference.versionPolicy !== "latest_approved") continue;
      const task = reference.taskId ? this.store.getTask(reference.taskId) : null;
      const started = Boolean(task?.current_session_id) || ["starting", "running"].includes(task?.execution_status)
        || ["in_progress", "doing", "running"].includes(task?.status);
      if (started) {
        this.store.updateArtifactReference(reference.referenceId, { pendingVersion: version, pendingHash: hash });
        this.#audit(context, artifact.artifactId, "artifact.reference_update_pending", { referenceId: reference.referenceId, taskId: reference.taskId }, reference.pinnedVersion, version);
        affected.push({ referenceId: reference.referenceId, taskId: reference.taskId, action: "approval_required" });
      } else {
        this.store.updateArtifactReference(reference.referenceId, { pinnedVersion: version, pinnedHash: hash, pendingVersion: null, pendingHash: null });
        this.#audit(context, artifact.artifactId, "artifact.reference_advanced", { referenceId: reference.referenceId, taskId: reference.taskId }, reference.pinnedVersion, version);
        affected.push({ referenceId: reference.referenceId, taskId: reference.taskId, action: "advanced" });
      }
    }
    return affected;
  }

  async #prepareContent(artifactId, version, buffer) {
    const hash = sha256(buffer);
    const storageKey = this.#storageKeyForHash(hash);
    const finalPath = this.#safeStoragePath(storageKey);
    const operationId = `artifact_content_operation:${this.idFactory()}`;
    const tempPath = join(this.contentRoot, "tmp", `${operationId.replaceAll(":", "-")}.tmp`);
    const createdAt = this.clock();
    this.store.createArtifactContentOperation({ operationId, artifactId, version, contentHash: hash, tempPath, finalPath, createdAt });
    await mkdir(dirname(finalPath), { recursive: true, mode: 0o700 });
    let createdFinal = false;
    try {
      await access(finalPath, constants.F_OK);
      const existing = await readFile(finalPath);
      if (sha256(existing) !== hash) throw artifactError("ARTIFACT_CONTENT_COLLISION", "Existing content-addressed object failed hash verification.", 409);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await writeFile(tempPath, buffer, { mode: 0o600, flag: "wx" });
      const handle = await open(tempPath, "r+");
      try { await handle.sync(); } finally { await handle.close(); }
      await rename(tempPath, finalPath);
      createdFinal = true;
    }
    this.store.updateArtifactContentOperation(operationId, "file_committed");
    return { operationId, hash, storageKey, finalPath, tempPath, createdFinal };
  }

  async #rollbackPrepared(prepared, error) {
    await unlink(prepared.tempPath).catch(() => {});
    if (prepared.createdFinal) {
      const referenced = this.store.selectOne(`SELECT 1 FROM artifact_versions WHERE storage_key = ?`, [prepared.storageKey]);
      if (!referenced) await unlink(prepared.finalPath).catch(() => {});
    }
    this.store.updateArtifactContentOperation(prepared.operationId, "rolled_back", error?.code ?? "ARTIFACT_METADATA_COMMIT_FAILED");
  }

  async #restoreExistingContent(version, buffer) {
    const finalPath = this.#safeStoragePath(version.storageKey);
    const operationId = `artifact_content_operation:${this.idFactory()}`;
    const tempPath = join(this.contentRoot, "tmp", `${operationId.replaceAll(":", "-")}.restore.tmp`);
    this.store.createArtifactContentOperation({
      operationId, artifactId: version.artifactId, version: version.version,
      contentHash: version.contentHash, tempPath, finalPath, createdAt: this.clock()
    });
    try {
      await mkdir(dirname(finalPath), { recursive: true, mode: 0o700 });
      await writeFile(tempPath, buffer, { mode: 0o600, flag: "wx" });
      const handle = await open(tempPath, "r+");
      try { await handle.sync(); } finally { await handle.close(); }
      await rename(tempPath, finalPath);
      this.store.updateArtifactContentOperation(operationId, "completed");
    } catch (error) {
      await unlink(tempPath).catch(() => {});
      this.store.updateArtifactContentOperation(operationId, "rolled_back", error.code ?? "ARTIFACT_RESTORE_FAILED");
      throw error;
    }
  }

  #storageKeyForHash(hash) { return join("objects", hash.slice(0, 2), hash); }

  #safeStoragePath(storageKey) {
    const path = resolve(this.contentRoot, storageKey);
    const root = `${resolve(this.contentRoot)}/`;
    if (!path.startsWith(root)) throw artifactError("ARTIFACT_STORAGE_KEY_INVALID", "Artifact storage key escaped private storage.", 500);
    return path;
  }

  #pinnedReadContext(contextInput) {
    const context = this.context(contextInput);
    if (!["local_user", "platform_admin"].includes(context.kind)) return context;
    const logicalSessionId = contextInput.logicalSessionId ?? `${context.kind}:${context.actorId}`;
    return {
      ...context,
      productSessionId: context.sessionId,
      logicalSessionId,
      providerBindingId: contextInput.providerBindingId ?? `${context.kind}:local`,
      authorizationRevision: sha256(Buffer.from([
        context.kind, context.actorId, context.workId, context.sessionId ?? ""
      ].join("\0")))
    };
  }

  async #readPinnedPage(version, { offset, limit, format }) {
    return readVerifiedArtifactPage({
      path: version.storageKey ? this.#safeStoragePath(version.storageKey) : null,
      version, offset, limit, format
    });
  }

  #recordUsage(context, artifact, version, operation, byteOffset, byteLength) {
    if (!context.sessionId) return null;
    const usageId = `artifact_usage:${this.idFactory()}`;
    this.store.recordArtifactUsage({
      usageId, artifactId: artifact.artifactId,
      version: version.version, contentHash: version.contentHash, actorId: context.actorId,
      sessionId: context.sessionId, taskId: context.taskId, operation,
      byteOffset, byteLength, createdAt: this.clock()
    });
    return usageId;
  }

  #audit(context, artifactId, action, details, fromVersion = null, toVersion = null) {
    this.store.appendArtifactAudit({
      auditId: `artifact_audit:${this.idFactory()}`, artifactId, workId: context.workId,
      action, actorId: context.actorId, sessionId: context.sessionId, taskId: context.taskId,
      fromVersion, toVersion, details, createdAt: this.clock()
    });
  }
}

export async function readVerifiedArtifactPage({ path, version, offset, limit, format }) {
  if (!version.storageKey) {
    return Object.freeze({ encoding: null, content: null, byteLength: 0, nextOffset: null });
  }
  let handle;
  try {
    handle = await open(path, "r");
    const info = await handle.stat();
    if (!info.isFile() || info.size !== version.byteLength) {
      throw artifactError("ARTIFACT_CONTENT_INTEGRITY_FAILED", "Artifact content length failed verification.", 409);
    }
    const hash = createHash("sha256");
    const decoder = isTextMime(version.mimeType) ? new TextDecoder("utf-8", { fatal: true }) : null;
    const verificationBuffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, version.byteLength)));
    let position = 0;
    while (position < version.byteLength) {
      const expected = Math.min(verificationBuffer.byteLength, version.byteLength - position);
      const { bytesRead } = await handle.read(verificationBuffer, 0, expected, position);
      if (bytesRead <= 0) throw artifactError("ARTIFACT_CONTENT_INTEGRITY_FAILED", "Artifact content ended before its recorded length.", 409);
      const chunk = verificationBuffer.subarray(0, bytesRead);
      hash.update(chunk);
      if (decoder) {
        try { decoder.decode(chunk, { stream: position + bytesRead < version.byteLength }); }
        catch { throw artifactError("ARTIFACT_TEXT_ENCODING_INVALID", "Artifact text is not valid UTF-8.", 415); }
      }
      position += bytesRead;
    }
    if (!safeHashEqual(hash.digest("hex"), version.contentHash)) {
      throw artifactError("ARTIFACT_CONTENT_INTEGRITY_FAILED", "Artifact content hash failed verification.", 409);
    }
    const requestedBytes = Math.min(limit, Math.max(0, version.byteLength - offset));
    const pageBuffer = Buffer.allocUnsafe(Math.max(1, requestedBytes));
    const { bytesRead } = requestedBytes > 0
      ? await handle.read(pageBuffer, 0, requestedBytes, offset)
      : { bytesRead: 0 };
    let raw = pageBuffer.subarray(0, bytesRead);
    if (format === "text" && raw.byteLength > 0) {
      let completeLength = raw.byteLength;
      while (completeLength > 0) {
        try {
          new TextDecoder("utf-8", { fatal: true }).decode(raw.subarray(0, completeLength));
          break;
        } catch {
          completeLength -= 1;
        }
      }
      if (completeLength === 0) {
        throw artifactError("ARTIFACT_RANGE_INVALID", "The requested text page is too small for the next UTF-8 code point.", 416);
      }
      raw = raw.subarray(0, completeLength);
    }
    const nextOffset = offset + raw.byteLength < version.byteLength ? offset + raw.byteLength : null;
    return Object.freeze({
      encoding: format === "text" ? "utf-8" : "base64",
      content: format === "text"
        ? new TextDecoder("utf-8", { fatal: true }).decode(raw)
        : raw.toString("base64"),
      byteLength: raw.byteLength,
      nextOffset
    });
  } catch (error) {
    if (error.code === "ENOENT") throw artifactError("ARTIFACT_CONTENT_INTEGRITY_FAILED", "Artifact content object is missing.", 409);
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function sha256(buffer) { return createHash("sha256").update(buffer).digest("hex"); }
function isTextMime(value) {
  const mimeType = String(value ?? "").toLowerCase();
  return mimeType.startsWith("text/")
    || ["application/json", "application/xml", "application/yaml", "application/x-yaml"].includes(mimeType)
    || mimeType.endsWith("+json") || mimeType.endsWith("+xml");
}
async function firstExistingFileCandidate(candidates) {
  for (const candidate of candidates) {
    try {
      await stat(candidate);
      return candidate;
    } catch (error) {
      if (error.code === "EACCES" || error.code === "EPERM") return candidate;
      if (error.code !== "ENOENT") throw error;
    }
  }
  return null;
}
function artifactSuggestedFilename(title, mimeType) {
  const fallbackExtension = new Map([
    ["text/markdown", ".md"],
    ["text/plain", ".txt"],
    ["application/json", ".json"],
    ["text/html", ".html"],
    ["text/csv", ".csv"]
  ]).get(mimeType) ?? "";
  const filename = basename(optionalText(title) ?? "Artifact").replaceAll("\0", "");
  return extname(filename) || !fallbackExtension ? filename : `${filename}${fallbackExtension}`;
}
function contentBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value !== "string") throw artifactError("ARTIFACT_CONTENT_REQUIRED", "Artifact content is required.", 400);
  return Buffer.from(value, "utf8");
}
function optionalText(value) { const text = typeof value === "string" ? value.trim() : ""; return text || null; }
function artifactScope(visibility, explicitScope = null) {
  const derived = visibility === "task_private" ? "task"
    : visibility === "session_private" ? "session" : "work";
  if (explicitScope != null && explicitScope !== derived) {
    throw artifactError("ARTIFACT_SCOPE_INVALID", "Artifact scope and visibility describe different ownership boundaries.", 400);
  }
  const scope = explicitScope ?? derived;
  if (![...ARTIFACT_SCOPES, "session"].includes(scope)) {
    throw artifactError("ARTIFACT_SCOPE_INVALID", `Unsupported Artifact scope: ${scope}`, 400);
  }
  return scope;
}
function normalizeArtifactTaxonomy(input = {}) {
  return {
    kind: normalizeTaxonomyValue(input.kind ?? "other", "kind"),
    categoryPath: normalizeCategoryPath(input.categoryPath ?? ""),
    tags: normalizedStringList(input.tags),
    aliases: normalizedStringList(input.aliases),
    keywords: normalizedStringList(input.keywords)
  };
}
function normalizeTaxonomyValue(value, field) {
  const text = requiredText(value, field).toLocaleLowerCase().replace(/[\s_]+/gu, "-");
  if (!/^[\p{L}\p{N}][\p{L}\p{N}.-]{0,63}$/u.test(text)) {
    throw artifactError("ARTIFACT_TAXONOMY_INVALID", `${field} must be a stable name up to 64 characters.`, 400);
  }
  return text;
}
function normalizeCategoryPath(value) {
  if (value == null || value === "") return "";
  const parts = String(value).split("/").map((part) => normalizeTaxonomyValue(part, "categoryPath"));
  if (parts.length > 8) throw artifactError("ARTIFACT_TAXONOMY_INVALID", "categoryPath supports at most 8 levels.", 400);
  return parts.join("/");
}
function normalizedStringList(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw artifactError("ARTIFACT_TAXONOMY_INVALID", "Taxonomy lists must be arrays.", 400);
  return [...new Set(value.map((entry) => requiredText(entry, "taxonomy item").toLocaleLowerCase()))].slice(0, 64);
}
function sameStringSet(left, right) {
  return JSON.stringify([...(left ?? [])].sort()) === JSON.stringify([...(right ?? [])].sort());
}
function groupByArtifactId(items) {
  const groups = new Map();
  for (const item of items ?? []) {
    const group = groups.get(item.artifactId) ?? [];
    group.push(item);
    groups.set(item.artifactId, group);
  }
  return groups;
}
function requiredText(value, field) { const text = optionalText(value); if (!text) throw artifactError("ARTIFACT_INVALID_INPUT", `${field} is required.`, 400); return text; }
function enumValue(value, allowed, code) { const text = requiredText(value, "value"); if (!allowed.has(text)) throw artifactError(code, `Unsupported value: ${text}`, 400); return text; }
function canonicalId(value, prefix) { const id = requiredText(value, `${prefix}Id`); if (!id.startsWith(`${prefix}:`)) throw artifactError("ARTIFACT_INVALID_ID", `${prefix}Id must use the ${prefix}: namespace.`, 400); return id; }
function boundedInteger(value, min, max, fallback, field) {
  if (value == null && fallback != null) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw artifactError("ARTIFACT_INVALID_INPUT", `${field} must be an integer from ${min} to ${max}.`, 400);
  return number;
}
export function artifactError(code, message, statusCode = 400) { const error = new Error(message); error.code = code; error.statusCode = statusCode; return error; }
