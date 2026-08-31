import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { resolvePlatformAdminSession } from "../utils/platformAssistantIdentity.mjs";
import { ArtifactReferenceAuthorizer, SessionAuthorizationResolver, artifactError as pinnedReadError, safeHashEqual } from "./artifactAuthorization.mjs";
import { buildArtifactContextIndex } from "./artifactContextIndex.mjs";
import { ArtifactReadCoordinator, ARTIFACT_READ_DEFAULT_LIMITS } from "./artifactReadCoordinator.mjs";

export const ARTIFACT_VISIBILITIES = Object.freeze([
  "objective_private", "work_item_private", "session_private", "repository_tracked"
]);
export const ARTIFACT_RELATIONS = Object.freeze([
  "implementation_spec", "security_requirement", "test_plan", "research_evidence",
  "handoff", "acceptance_evidence"
]);
const VISIBILITIES = new Set(ARTIFACT_VISIBILITIES);
const RELATIONS = new Set(ARTIFACT_RELATIONS);
const VERSION_POLICIES = new Set(["fixed", "latest_approved"]);
const MAX_READ_BYTES = ARTIFACT_READ_DEFAULT_LIMITS.maxPageBytes;

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

  async initialize() {
    this.contentRoot ??= this.store.layout?.artifactsDirectory
      ?? join(this.store.settings().dataRoot, "artifacts");
    await mkdir(join(this.contentRoot, "objects"), { recursive: true, mode: 0o700 });
    await mkdir(join(this.contentRoot, "tmp"), { recursive: true, mode: 0o700 });
    const recovered = await this.recoverContentOperations();
    const orphaned = await this.auditOrphanedContent();
    this.store.reconcileArtifactTurnReadUsage?.(this.clock());
    return [...recovered, ...orphaned];
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
      const objectiveId = requiredText(input.objectiveId, "objectiveId");
      if (!this.store.getObjective(objectiveId)) {
        throw artifactError("ARTIFACT_OBJECTIVE_NOT_FOUND", "Objective not found.", 404);
      }
      return {
        kind: "platform_admin",
        actorId: binding.agent.agentId,
        objectiveId,
        sessionId: binding.actorSessionId,
        workItemId: null
      };
    }
    if (input.kind === "local_user") {
      const objectiveId = requiredText(input.objectiveId, "objectiveId");
      if (!this.store.getObjective(objectiveId)) throw artifactError("ARTIFACT_OBJECTIVE_NOT_FOUND", "Objective not found.", 404);
      return { kind: "local_user", actorId: input.actorId ?? "local-user", objectiveId, sessionId: null, workItemId: null };
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
    const objectiveId = resolved.objectiveId;
    const workItemId = resolved.workItemId;
    if (input.objectiveId && input.objectiveId !== objectiveId) {
      throw artifactError("ARTIFACT_OBJECTIVE_FORBIDDEN", "Claimed Objective does not match the Session binding.", 403);
    }
    if (input.workItemId && input.workItemId !== workItemId) {
      throw artifactError("ARTIFACT_WORK_ITEM_FORBIDDEN", "Claimed WorkItem does not match the Session binding.", 403);
    }
    return {
      kind: resolved.sessionKind, actorId, objectiveId, sessionId, productSessionId: sessionId, workItemId,
      logicalSessionId: resolved.logicalSessionId,
      providerBindingId: resolved.providerBindingId,
      authorizationRevision: resolved.authorizationRevision
    };
  }

  list(contextInput, options = {}) {
    const context = this.context(contextInput);
    const relatedWorkItemIds = this.#relatedWorkItemIds(context);
    const artifacts = this.store.listArtifactsByObjective(context.objectiveId, {
      includeRevoked: options.includeRevoked === true && context.kind !== "worker"
    });
    return artifacts.filter((artifact) => this.#canRead(context, artifact, relatedWorkItemIds)).map((artifact) => this.present(artifact));
  }

  async get(contextInput, artifactId, options = {}) {
    const context = this.#pinnedReadContext(contextInput);
    if (options.version == null) throw artifactError("ARTIFACT_INVALID_INPUT", "version is required.", 400);
    const requestedVersion = boundedInteger(options.version, 1, Number.MAX_SAFE_INTEGER, null, "version");
    const requestedHash = requiredText(options.contentHash, "contentHash");
    if (!/^[a-f0-9]{64}$/.test(requestedHash)) throw artifactError("ARTIFACT_HASH_INVALID", "contentHash must be a lowercase SHA-256 digest.", 400);
    const authorized = this.referenceAuthorizer.authorize(context, {
      artifactId, version: requestedVersion, contentHash: requestedHash,
      referenceId: options.referenceId
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
        referenceId: options.referenceId
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
      referenceId: authorized.reference.referenceId,
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
    const relatedWorkItemIds = this.#relatedWorkItemIds(context);
    const query = requiredText(queryValue, "query").toLocaleLowerCase();
    const limit = boundedInteger(options.limit, 1, 50, 20, "limit");
    const results = [];
    for (const artifact of this.store.listArtifactsByObjective(context.objectiveId)) {
      if (!this.#canRead(context, artifact, relatedWorkItemIds)) continue;
      const metadata = `${artifact.title}\n${artifact.summary}`.toLocaleLowerCase();
      let match = metadata.includes(query);
      const excerpt = null;
      const version = this.#selectedVersion(context, artifact, null, relatedWorkItemIds);
      if (match && version) {
        results.push({ artifact: this.present(artifact), version, excerpt });
        this.#recordUsage(context, artifact, version, "search", 0, 0);
      }
      if (results.length >= limit) break;
    }
    return { query: queryValue, count: results.length, results };
  }

  async create(contextInput, input = {}) {
    const context = this.context(contextInput);
    if (context.kind === "worker") return this.#createWorkerArtifact(context, input);
    this.#assertManager(context);
    const visibility = enumValue(input.visibility ?? "objective_private", VISIBILITIES, "ARTIFACT_VISIBILITY_INVALID");
    const binding = this.#validateBinding(context.objectiveId, visibility, input);
    const artifactId = input.artifactId ? canonicalId(input.artifactId, "artifact") : `artifact:${this.idFactory()}`;
    const createdAt = this.clock();
    if (visibility === "repository_tracked") {
      if (input.confirmedRepositoryTracked !== true) throw artifactError("ARTIFACT_CONFIRMATION_REQUIRED", "Repository-tracked Artifact creation requires explicit confirmation.", 409);
      if (input.content != null) throw artifactError("ARTIFACT_REPOSITORY_CONTENT_FORBIDDEN", "Repository-tracked content is not copied into private storage.", 400);
      this.store.runInTransaction(() => {
        const locator = requiredText(input.repositoryLocator, "repositoryLocator");
        const locatorHash = createHash("sha256").update(locator).digest("hex");
        this.store.createArtifactMetadata({
          artifactId, objectiveId: context.objectiveId, title: requiredText(input.title, "title"),
          summary: optionalText(input.summary) ?? "", visibility, ...binding,
          repositoryLocator: locator,
          sourceSessionId: context.sessionId, sourceEventId: optionalText(input.sourceEventId),
          actorId: context.actorId, createdAt
        });
        this.store.createArtifactVersion({
          artifactId, version: 1, contentHash: locatorHash, byteLength: 0,
          mimeType: "application/vnd.corptie.repository-reference", storageKey: null,
          sourceSessionId: context.sessionId, sourceEventId: optionalText(input.sourceEventId),
          supersedesVersion: null, approvalStatus: "approved", actorId: context.actorId, createdAt
        });
        this.store.updateArtifact(artifactId, { currentVersion: 1, approvedVersion: 1, updatedAt: createdAt });
        this.#audit(context, artifactId, "artifact.created", { visibility, repositoryLocator: locator }, null, 1);
      });
      return this.present(this.store.getArtifact(artifactId));
    }
    const buffer = contentBuffer(input.content);
    const prepared = await this.#prepareContent(artifactId, 1, buffer);
    try {
      this.store.runInTransaction(() => {
        this.store.createArtifactMetadata({
          artifactId, objectiveId: context.objectiveId, title: requiredText(input.title, "title"),
          summary: optionalText(input.summary) ?? "", visibility, ...binding,
          sourceSessionId: context.sessionId, sourceEventId: optionalText(input.sourceEventId),
          actorId: context.actorId, createdAt
        });
        this.store.createArtifactVersion({
          artifactId, version: 1, contentHash: prepared.hash, byteLength: buffer.byteLength,
          mimeType: optionalText(input.mimeType) ?? "text/markdown", storageKey: prepared.storageKey,
          sourceSessionId: context.sessionId, sourceEventId: optionalText(input.sourceEventId),
          supersedesVersion: null, approvalStatus: input.approvalStatus === "draft" ? "draft" : "approved",
          actorId: context.actorId, createdAt
        });
        this.store.updateArtifact(artifactId, {
          currentVersion: 1, approvedVersion: input.approvalStatus === "draft" ? null : 1, updatedAt: createdAt
        });
        this.#audit(context, artifactId, "artifact.created", { visibility, contentHash: prepared.hash }, null, 1);
      });
      this.store.updateArtifactContentOperation(prepared.operationId, "completed");
      return this.present(this.store.getArtifact(artifactId));
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
    if (input.visibility != null && input.visibility !== "work_item_private") {
      throw artifactError("ARTIFACT_WORKER_SCOPE_FORBIDDEN", "Worker Artifact visibility is fixed to work_item_private.", 403);
    }
    if (input.boundWorkItemId != null && input.boundWorkItemId !== context.workItemId) {
      throw artifactError("ARTIFACT_WORK_ITEM_FORBIDDEN", "Worker Artifact binding is fixed to the current WorkItem.", 403);
    }
    if (input.boundSessionId != null || input.repositoryLocator != null || input.confirmedRepositoryTracked != null) {
      throw artifactError("ARTIFACT_WORKER_SCOPE_FORBIDDEN", "Workers cannot choose Session, Repository, or visibility scope for an Artifact.", 403);
    }

    // Revalidate the authoritative binding immediately before the write. The
    // caller's Objective/WorkItem metadata is never used to choose these values.
    const workItem = this.store.getWorkItem(context.workItemId);
    if (!workItem || workItem.objective_id !== context.objectiveId
      || workItem.current_session_id !== context.sessionId
      || workItem.deletion_status === "deleting") {
      throw artifactError("ARTIFACT_WORK_ITEM_FORBIDDEN", "Worker Session no longer has an active authoritative WorkItem binding.", 403);
    }

    const title = requiredText(input.title, "title");
    const summary = optionalText(input.summary) ?? "";
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
      title, summary, contentHash, mimeType, approvalStatus, relation, required, versionPolicy
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
        // The WorkItem can be completed/unbound while content is prepared. Check
        // once more under the same write transaction as every persisted record.
        const currentWorkItem = this.store.getWorkItem(context.workItemId);
        if (!currentWorkItem || currentWorkItem.objective_id !== context.objectiveId
          || currentWorkItem.current_session_id !== context.sessionId
          || currentWorkItem.deletion_status === "deleting") {
          throw artifactError("ARTIFACT_WORK_ITEM_FORBIDDEN", "Worker Session no longer has an active authoritative WorkItem binding.", 403);
        }
        this.store.createArtifactMetadata({
          artifactId, objectiveId: context.objectiveId, title, summary,
          visibility: "work_item_private", boundWorkItemId: context.workItemId,
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
          referenceId, artifactId, objectiveId: context.objectiveId,
          workItemId: context.workItemId, sessionId: null, relation, required,
          versionPolicy, pinnedVersion: 1, pinnedHash: prepared.hash,
          actorId: workerActorId, authorizedAt: createdAt
        });
        this.#audit(workerAuditContext, artifactId, "artifact.created", {
          visibility: "work_item_private", contentHash: prepared.hash, source: "worker"
        }, null, 1);
        this.#audit(workerAuditContext, artifactId, "artifact.reference_created", {
          referenceId, workItemId: context.workItemId, relation, required,
          versionPolicy, pinnedVersion: 1, pinnedHash: prepared.hash, source: "worker"
        }, null, 1);
        this.#audit(workerAuditContext, artifactId, "artifact.worker_created_and_referenced", {
          referenceId, idempotencyKey, relation, required, versionPolicy,
          pinnedVersion: 1, pinnedHash: prepared.hash
        }, null, 1);
        this.store.createArtifactWorkerCreateOperation({
          sessionId: context.sessionId, objectiveId: context.objectiveId,
          workItemId: context.workItemId, idempotencyKey, requestFingerprint,
          artifactId, referenceId, createdAt
        });
      });
      this.store.updateArtifactContentOperation(prepared.operationId, "completed");
      return { ...this.present(this.store.getArtifact(artifactId)), idempotentReplay: false };
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
    if (operation.objective_id !== context.objectiveId || operation.work_item_id !== context.workItemId) {
      throw artifactError("ARTIFACT_IDEMPOTENCY_SCOPE_INVALID", "Stored Worker Artifact operation does not match the current authoritative binding.", 409);
    }
    const artifact = this.store.getArtifact(operation.artifact_id);
    const reference = this.store.getArtifactReference(operation.reference_id);
    if (!artifact || !reference
      || artifact.objectiveId !== context.objectiveId
      || artifact.visibility !== "work_item_private"
      || artifact.boundWorkItemId !== context.workItemId
      || reference.artifactId !== artifact.artifactId
      || reference.objectiveId !== context.objectiveId
      || reference.workItemId !== context.workItemId
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
    this.#assertManager(context);
    const artifact = this.#sameObjectiveArtifact(context, artifactId);
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
      return { artifact: this.present(this.store.getArtifact(artifact.artifactId)), version: this.store.getArtifactVersion(artifact.artifactId, versionNumber), affected };
    } catch (error) {
      await this.#rollbackPrepared(prepared, error);
      throw error;
    }
  }

  createReference(contextInput, artifactId, input = {}) {
    const context = this.context(contextInput);
    this.#assertManager(context);
    const artifact = this.#sameObjectiveArtifact(context, artifactId);
    const workItemId = optionalText(input.workItemId);
    const sessionId = optionalText(input.sessionId);
    if (!workItemId && !sessionId) throw artifactError("ARTIFACT_REFERENCE_TARGET_REQUIRED", "workItemId or sessionId is required.", 400);
    const workItem = workItemId ? this.store.getWorkItem(workItemId) : null;
    if (workItemId && (!workItem || workItem.objective_id !== context.objectiveId)) {
      throw artifactError("ARTIFACT_CROSS_OBJECTIVE_FORBIDDEN", "Artifact references cannot cross Objective boundaries.", 403);
    }
    const session = sessionId ? this.store.getSession(sessionId) : null;
    if (sessionId && (!session || (session.objectiveId ?? session.objective_id) !== context.objectiveId)) {
      throw artifactError("ARTIFACT_CROSS_OBJECTIVE_FORBIDDEN", "Artifact references cannot target another Objective's Session.", 403);
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
        objectiveId: context.objectiveId, workItemId, sessionId, relation,
        required: input.required === true, versionPolicy, pinnedVersion,
        pinnedHash, actorId: context.actorId, authorizedAt
      });
      this.#audit(context, artifact.artifactId, "artifact.reference_created", { referenceId: created.referenceId, relation, versionPolicy, required: created.required, pinnedHash }, null, pinnedVersion);
      return created;
    });
    return reference;
  }

  prepareWorkItemCreationReference(contextInput, artifactId, input = {}) {
    const context = this.context(contextInput);
    const artifact = this.#sameObjectiveArtifact(context, artifactId);
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
      context, artifactId: artifact.artifactId, objectiveId: context.objectiveId,
      relation, required: input.required === true, versionPolicy,
      pinnedVersion: selected.version, pinnedHash: selected.contentHash
    });
  }

  createPreparedWorkItemReference(prepared, workItemId) {
    const workItem = this.store.getWorkItem(requiredText(workItemId, "workItemId"));
    if (!workItem) throw artifactError("ARTIFACT_WORK_ITEM_NOT_FOUND", "WorkItem not found.", 404);
    if (workItem.objective_id !== prepared?.objectiveId) {
      throw artifactError(
        "ARTIFACT_CROSS_OBJECTIVE_FORBIDDEN",
        "Artifact references cannot cross Objective boundaries.",
        403
      );
    }
    if (workItem.deletion_status === "deleting") {
      throw artifactError("WORK_ITEM_DELETION_IN_PROGRESS", "Cannot reference an Artifact while the WorkItem is being deleted.", 409);
    }
    const artifact = this.#sameObjectiveArtifact(prepared.context, prepared.artifactId);
    const version = this.store.getArtifactVersion(artifact.artifactId, prepared.pinnedVersion);
    if (!version || version.contentHash !== prepared.pinnedHash) {
      throw artifactError("ARTIFACT_VERSION_NOT_FOUND", "The selected Artifact version is no longer available.", 409);
    }
    const authorizedAt = this.clock();
    const reference = this.store.createArtifactReference({
      referenceId: `artifact_reference:${this.idFactory()}`,
      artifactId: artifact.artifactId,
      objectiveId: prepared.objectiveId,
      workItemId: workItem.id,
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
      workItemId: workItem.id,
      relation: reference.relation,
      required: reference.required,
      versionPolicy: reference.versionPolicy,
      pinnedHash: reference.pinnedHash,
      source: "work_item_creation"
    }, null, reference.pinnedVersion);
    return reference;
  }

  revokeReference(contextInput, referenceId, reason) {
    const context = this.context(contextInput);
    this.#assertManager(context);
    const reference = this.store.getArtifactReference(requiredText(referenceId, "referenceId"));
    if (!reference || reference.objectiveId !== context.objectiveId) throw artifactError("ARTIFACT_REFERENCE_NOT_FOUND", "Artifact reference not found.", 404);
    if (reference.revokedAt) return reference;
    const revoked = this.store.updateArtifactReference(reference.referenceId, {
      revokedAt: this.clock(), revokedByActorId: context.actorId, revocationReason: requiredText(reason, "reason")
    });
    this.#audit(context, reference.artifactId, "artifact.access_revoked", { referenceId, reason });
    return revoked;
  }

  changeVisibility(contextInput, artifactId, visibilityValue, { confirmed = false } = {}) {
    const context = this.context(contextInput);
    this.#assertManager(context);
    const artifact = this.#sameObjectiveArtifact(context, artifactId);
    const visibility = enumValue(visibilityValue, VISIBILITIES, "ARTIFACT_VISIBILITY_INVALID");
    if (visibility !== artifact.visibility && confirmed !== true) {
      throw artifactError("ARTIFACT_CONFIRMATION_REQUIRED", "Visibility changes require explicit confirmation.", 409);
    }
    if (visibility !== artifact.visibility && (visibility === "repository_tracked" || artifact.visibility === "repository_tracked")) {
      throw artifactError("ARTIFACT_VISIBILITY_TRANSITION_FORBIDDEN", "Repository-tracked registration cannot be converted to or from private content.", 409);
    }
    this.#validateBinding(context.objectiveId, visibility, artifact);
    const updated = this.store.updateArtifact(artifact.artifactId, { visibility, updatedAt: this.clock() });
    this.#audit(context, artifact.artifactId, "artifact.visibility_changed", { from: artifact.visibility, to: visibility });
    return this.present(updated);
  }

  supersede(contextInput, artifactId) {
    const context = this.context(contextInput);
    this.#assertManager(context);
    const artifact = this.#sameObjectiveArtifact(context, artifactId);
    const updated = this.store.updateArtifact(artifact.artifactId, { status: "superseded", updatedAt: this.clock() });
    this.#audit(context, artifact.artifactId, "artifact.superseded", {});
    return this.present(updated);
  }

  revokeArtifact(contextInput, artifactId, reason) {
    const context = this.context(contextInput);
    this.#assertManager(context);
    const artifact = this.#sameObjectiveArtifact(context, artifactId);
    const updated = this.store.updateArtifact(artifact.artifactId, { status: "revoked", updatedAt: this.clock() });
    this.#audit(context, artifact.artifactId, "artifact.revoked", { reason: requiredText(reason, "reason") });
    return this.present(updated);
  }

  acknowledgePendingReference(contextInput, referenceId) {
    const context = this.context(contextInput);
    this.#assertManager(context);
    const reference = this.store.getArtifactReference(requiredText(referenceId, "referenceId"));
    if (!reference || reference.objectiveId !== context.objectiveId) throw artifactError("ARTIFACT_REFERENCE_NOT_FOUND", "Artifact reference not found.", 404);
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
      audit: this.store.listArtifactAudit(artifact.objectiveId, artifact.artifactId).slice(0, 100)
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

  async backupObjective(contextInput, input = {}) {
    const context = this.context(contextInput);
    this.#assertManager(context);
    if (input.confirmed !== true) throw artifactError("ARTIFACT_CONFIRMATION_REQUIRED", "Backup requires explicit confirmation.", 409);
    const destination = resolve(requiredText(input.destinationPath, "destinationPath"));
    await mkdir(destination, { recursive: false, mode: 0o700 });
    const artifacts = this.store.listArtifactsByObjective(context.objectiveId, { includeRevoked: true });
    const manifest = {
      format: "corptie-objective-artifact-backup-v1", objectiveId: context.objectiveId,
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
        auditId: `artifact_audit:${this.idFactory()}`, artifactId: null, objectiveId: context.objectiveId,
        action: "artifact.backup_created", actorId: context.actorId, sessionId: context.sessionId,
        details: { destinationPath: destination, artifactCount: artifacts.length }, createdAt: this.clock()
      });
      return { destinationPath: destination, artifactCount: artifacts.length, format: manifest.format };
    } catch (error) {
      throw artifactError(error.code ?? "ARTIFACT_BACKUP_FAILED", `Artifact backup failed without reporting success: ${error.message}`, error.statusCode ?? 500);
    }
  }

  async restoreObjective(contextInput, input = {}) {
    const context = this.context(contextInput);
    this.#assertManager(context);
    if (input.confirmed !== true) throw artifactError("ARTIFACT_CONFIRMATION_REQUIRED", "Restore requires explicit confirmation.", 409);
    const source = resolve(requiredText(input.sourcePath, "sourcePath"));
    const manifest = JSON.parse(await readFile(join(source, "manifest.json"), "utf8"));
    if (manifest?.format !== "corptie-objective-artifact-backup-v1") throw artifactError("ARTIFACT_BACKUP_FORMAT_INVALID", "Unsupported Artifact backup format.", 400);
    if (manifest.objectiveId !== context.objectiveId) throw artifactError("ARTIFACT_CROSS_OBJECTIVE_FORBIDDEN", "Backup belongs to another Objective; restore will not widen access.", 403);
    const verified = [];
    for (const entry of manifest.artifacts ?? []) {
      if (entry.artifact?.objectiveId !== context.objectiveId) throw artifactError("ARTIFACT_CROSS_OBJECTIVE_FORBIDDEN", "Backup contains a cross-Objective Artifact.", 403);
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
      if (current && current.objectiveId !== context.objectiveId) throw artifactError("ARTIFACT_CROSS_OBJECTIVE_FORBIDDEN", "Stable Artifact ID already belongs to another Objective.", 403);
      if (!current) {
        this.store.createArtifactMetadata({
          artifactId: artifact.artifactId, objectiveId: context.objectiveId, title: artifact.title,
          summary: artifact.summary, visibility: artifact.visibility, boundWorkItemId: artifact.boundWorkItemId,
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
        if (reference.workItemId && !this.store.getWorkItem(reference.workItemId)) continue;
        if (reference.sessionId && !this.store.getSession(reference.sessionId)) continue;
        const created = this.store.createArtifactReference({
          referenceId: reference.referenceId, artifactId: artifact.artifactId, objectiveId: context.objectiveId,
          workItemId: reference.workItemId, sessionId: reference.sessionId, relation: reference.relation,
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
      auditId: `artifact_audit:${this.idFactory()}`, artifactId: null, objectiveId: context.objectiveId,
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
    if (!['objectiveChat', 'local_user', 'platform_admin'].includes(context.kind)) {
      throw artifactError("ARTIFACT_WRITE_FORBIDDEN", "Worker Sessions cannot manage Objective Artifacts.", 403);
    }
  }

  #sameObjectiveArtifact(context, artifactIdValue) {
    const artifact = this.store.getArtifact(requiredText(artifactIdValue, "artifactId"));
    if (!artifact) throw artifactError("ARTIFACT_NOT_FOUND", "Artifact not found.", 404);
    if (artifact.objectiveId !== context.objectiveId) throw artifactError("ARTIFACT_CROSS_OBJECTIVE_FORBIDDEN", "Artifact belongs to another Objective.", 403);
    return artifact;
  }

  #readableArtifact(context, artifactId) {
    const artifact = this.#sameObjectiveArtifact(context, artifactId);
    if (!this.#canRead(context, artifact)) throw artifactError("ARTIFACT_READ_FORBIDDEN", "Artifact is not authorized for this Session.", 403);
    if (artifact.status === "revoked") throw artifactError("ARTIFACT_REVOKED", "Artifact access has been revoked.", 403);
    return artifact;
  }

  #canRead(context, artifact, relatedWorkItemIds = null) {
    if (artifact.objectiveId !== context.objectiveId || artifact.status === "revoked") return false;
    if (["objectiveChat", "local_user", "platform_admin"].includes(context.kind)) return true;
    if (context.kind !== "worker") return false;
    return this.#matchingReferences(context, artifact, relatedWorkItemIds).length > 0;
  }

  #canAuthorizeReference(context, artifact) {
    if (artifact.status === "revoked") return false;
    if (["objectiveChat", "local_user", "platform_admin"].includes(context.kind)) return true;
    if (context.kind !== "worker") return false;
    if (artifact.visibility === "session_private" && artifact.boundSessionId === context.sessionId) return true;
    return this.#matchingReferences(context, artifact).length > 0;
  }

  #matchingReferences(context, artifact, relatedWorkItemIds = null) {
    const references = this.store.listArtifactReferences({ artifactId: artifact.artifactId });
    return references.filter((reference) =>
      (reference.workItemId && reference.workItemId === context.workItemId)
      || (reference.sessionId && reference.sessionId === context.sessionId)
    );
  }

  #workItemsRelated(firstWorkItemId, secondWorkItemId) {
    if (firstWorkItemId === secondWorkItemId) return true;
    const first = this.store.getWorkItem(firstWorkItemId);
    const second = this.store.getWorkItem(secondWorkItemId);
    if (!first || !second || first.objective_id !== second.objective_id) return false;
    return this.store.listWorkItemDependencies(firstWorkItemId)
      .some((edge) => edge.target_work_item_id === secondWorkItemId)
      || this.store.listWorkItemDependents(firstWorkItemId)
        .some((edge) => edge.work_item_id === secondWorkItemId);
  }

  #relatedWorkItemIds(context) {
    if (context.kind !== "worker" || !context.workItemId) return null;
    const related = new Set([context.workItemId]);
    const current = this.store.getWorkItem(context.workItemId);
    if (!current) return related;
    for (const edge of this.store.listWorkItemDependencies(context.workItemId)) related.add(edge.target_work_item_id);
    for (const edge of this.store.listWorkItemDependents(context.workItemId)) related.add(edge.work_item_id);
    return related;
  }

  #selectedVersion(context, artifact, requestedVersion, relatedWorkItemIds = null) {
    let version = requestedVersion == null ? null : boundedInteger(requestedVersion, 1, artifact.currentVersion, null, "version");
    if (context.kind === "worker") {
      const references = this.#matchingReferences(context, artifact, relatedWorkItemIds);
      const allowed = new Set(references.map((reference) => reference.pinnedVersion));
      version ??= references[0]?.pinnedVersion ?? artifact.approvedVersion ?? artifact.currentVersion;
      if (!allowed.has(version)) throw artifactError("ARTIFACT_VERSION_FORBIDDEN", "Requested version is not pinned for this Worker Session.", 403);
    } else {
      version ??= artifact.approvedVersion ?? artifact.currentVersion;
    }
    return this.store.getArtifactVersion(artifact.artifactId, version);
  }

  #validateBinding(objectiveId, visibility, input) {
    const boundWorkItemId = optionalText(input.boundWorkItemId);
    const boundSessionId = optionalText(input.boundSessionId);
    if (visibility === "work_item_private" && !boundWorkItemId) throw artifactError("ARTIFACT_WORK_ITEM_REQUIRED", "work_item_private requires boundWorkItemId.", 400);
    if (visibility === "session_private" && !boundSessionId) throw artifactError("ARTIFACT_SESSION_REQUIRED", "session_private requires boundSessionId.", 400);
    if (boundWorkItemId) {
      const workItem = this.store.getWorkItem(boundWorkItemId);
      if (!workItem || workItem.objective_id !== objectiveId) throw artifactError("ARTIFACT_CROSS_OBJECTIVE_FORBIDDEN", "Bound WorkItem must belong to the current Objective.", 403);
      if (workItem.deletion_status === "deleting") {
        throw artifactError(
          "WORK_ITEM_DELETION_IN_PROGRESS",
          "Cannot bind an Artifact while the WorkItem is being deleted.",
          409
        );
      }
    }
    if (boundSessionId) {
      const session = this.store.getSession(boundSessionId);
      if (!session || (session.objectiveId ?? session.objective_id) !== objectiveId) throw artifactError("ARTIFACT_CROSS_OBJECTIVE_FORBIDDEN", "Bound Session must belong to the current Objective.", 403);
    }
    return { boundWorkItemId, boundSessionId };
  }

  #advanceLatestApprovedReferences(context, artifact, version, hash, approvalStatus) {
    if (approvalStatus !== "approved") return [];
    const affected = [];
    for (const reference of this.store.listArtifactReferences({ artifactId: artifact.artifactId })) {
      if (reference.versionPolicy !== "latest_approved") continue;
      const workItem = reference.workItemId ? this.store.getWorkItem(reference.workItemId) : null;
      const started = Boolean(workItem?.current_session_id) || ["starting", "running"].includes(workItem?.execution_status)
        || ["in_progress", "doing", "running"].includes(workItem?.status);
      if (started) {
        this.store.updateArtifactReference(reference.referenceId, { pendingVersion: version, pendingHash: hash });
        this.#audit(context, artifact.artifactId, "artifact.reference_update_pending", { referenceId: reference.referenceId, workItemId: reference.workItemId }, reference.pinnedVersion, version);
        affected.push({ referenceId: reference.referenceId, workItemId: reference.workItemId, action: "approval_required" });
      } else {
        this.store.updateArtifactReference(reference.referenceId, { pinnedVersion: version, pinnedHash: hash, pendingVersion: null, pendingHash: null });
        this.#audit(context, artifact.artifactId, "artifact.reference_advanced", { referenceId: reference.referenceId, workItemId: reference.workItemId }, reference.pinnedVersion, version);
        affected.push({ referenceId: reference.referenceId, workItemId: reference.workItemId, action: "advanced" });
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
        context.kind, context.actorId, context.objectiveId, context.sessionId ?? ""
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
      sessionId: context.sessionId, workItemId: context.workItemId, operation,
      byteOffset, byteLength, createdAt: this.clock()
    });
    return usageId;
  }

  #audit(context, artifactId, action, details, fromVersion = null, toVersion = null) {
    this.store.appendArtifactAudit({
      auditId: `artifact_audit:${this.idFactory()}`, artifactId, objectiveId: context.objectiveId,
      action, actorId: context.actorId, sessionId: context.sessionId, workItemId: context.workItemId,
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
