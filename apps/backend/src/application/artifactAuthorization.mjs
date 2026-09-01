import { createHash, timingSafeEqual } from "node:crypto";

export class SessionAuthorizationResolver {
  constructor({ store } = {}) {
    if (!store) throw new TypeError("SessionAuthorizationResolver requires a store.");
    this.store = store;
  }

  resolve(input = {}) {
    const claimedLogicalSessionId = normalized(input.authenticatedLogicalSessionId ?? input.logicalSessionId);
    const claimedProductSessionId = normalized(input.sessionId);
    const logical = claimedLogicalSessionId
      ? this.store.getLogicalSession(claimedLogicalSessionId)
      : claimedProductSessionId ? this.store.getLogicalSessionByLegacySessionId(claimedProductSessionId) : null;
    if (claimedLogicalSessionId && !logical) throw bindingError("Authenticated logical Session is not active.");
    if (claimedProductSessionId && logical?.legacySessionId && logical.legacySessionId !== claimedProductSessionId) {
      throw bindingError("Logical Session and product Session bindings do not match.");
    }
    const productSessionId = logical?.legacySessionId ?? claimedProductSessionId;
    const session = productSessionId ? this.store.getSession(productSessionId) : null;
    if (!session) throw bindingError("Artifact access requires an authenticated active Session.");
    const agent = session.agentId ? this.store.getAgent(session.agentId) : null;
    if (!agent) throw bindingError("Session Agent binding is invalid.");
    if (input.actorId && input.actorId !== session.agentId) throw bindingError("Authenticated Agent does not match the Session binding.");
    const sessionKind = session.sessionKind;
    if (!["worker", "objectiveChat"].includes(sessionKind)) throw bindingError("Session kind cannot access Objective Artifacts.");
    if (input.expectedSessionKind && input.expectedSessionKind !== sessionKind) throw bindingError("Session kind changed.");
    const objective = session.objectiveId ? this.store.getObjective(session.objectiveId) : null;
    if (!objective) throw bindingError("Session Objective binding is invalid.");
    let workItem = null;
    if (sessionKind === "worker") {
      workItem = session.workItemId ? this.store.getWorkItem(session.workItemId) : null;
      if (!workItem || workItem.objective_id !== objective.id
        || workItem.current_session_id !== session.id
        || workItem.deletion_status === "deleting") {
        throw bindingError("Worker Session no longer owns its exact WorkItem binding.");
      }
    }
    const logicalSessionId = logical?.logicalSessionId ?? session.external?.logicalSessionId ?? session.id;
    const claimedProviderBindingId = normalized(input.providerBindingId);
    const activeProviderBindingId = logical?.activeBinding?.bindingId ?? null;
    if (claimedProviderBindingId && activeProviderBindingId
      && claimedProviderBindingId !== activeProviderBindingId) {
      throw bindingError("Provider binding is not the logical Session's active route.");
    }
    const providerBindingId = activeProviderBindingId
      ?? claimedProviderBindingId
      ?? `product-session:${session.id}`;
    const authorizationRevision = revision([
      logicalSessionId, logical?.routingVersion ?? 0, providerBindingId,
      session.id, session.updatedAt ?? "", sessionKind, session.agentId,
      objective.id, workItem?.id ?? "", workItem?.resource_version ?? 0,
      workItem?.updated_at ?? ""
    ]);
    return Object.freeze({
      logicalSessionId,
      productSessionId: session.id,
      sessionKind,
      agentId: session.agentId,
      objectiveId: objective.id,
      workItemId: workItem?.id ?? null,
      providerBindingId,
      authorizationRevision,
      session,
      workItem
    });
  }
}

export class ArtifactReferenceAuthorizer {
  constructor({ store } = {}) {
    if (!store) throw new TypeError("ArtifactReferenceAuthorizer requires a store.");
    this.store = store;
  }

  authorize(context, request = {}) {
    const artifactId = required(request.artifactId, "artifactId");
    const artifact = this.store.getArtifact(artifactId);
    if (!artifact || artifact.objectiveId !== context.objectiveId || artifact.status === "revoked") {
      throw hiddenArtifactError();
    }
    const explicitReferenceId = normalized(request.referenceId);
    // Body access always names the exact authorization record. Merely having
    // some related Reference is not an implicit content grant.
    if (!explicitReferenceId) throw hiddenArtifactError();
    const isManager = ["objectiveChat", "local_user", "platform_admin"].includes(context.kind);
    const references = this.store.listArtifactReferences({ artifactId }).filter((reference) =>
      !reference.revokedAt
      && reference.objectiveId === context.objectiveId
      && (isManager
        || reference.authorizedByActorId === "system:objective-scope-read"
        || (reference.sessionId && reference.sessionId === context.productSessionId)
        || (context.workItemId && reference.workItemId === context.workItemId))
      && reference.referenceId === explicitReferenceId
    );
    if (references.length === 0) throw hiddenArtifactError();
    const version = positiveInteger(request.version, "version");
    const contentHash = canonicalHash(request.contentHash);
    const versionReferences = references.filter((reference) => reference.pinnedVersion === version);
    if (versionReferences.length === 0) {
      throw artifactError("ARTIFACT_VERSION_NOT_PINNED", "Requested Artifact version is not pinned by an active Reference.", 403);
    }
    const reference = versionReferences.find((candidate) => safeHashEqual(candidate.pinnedHash, contentHash));
    if (!reference) {
      throw artifactError("ARTIFACT_VERSION_HASH_MISMATCH", "Requested content hash does not match the pinned Artifact Reference.", 409);
    }
    const artifactVersion = this.store.getArtifactVersion(artifactId, version);
    if (!artifactVersion || !safeHashEqual(artifactVersion.contentHash, contentHash)) {
      throw artifactError("ARTIFACT_VERSION_HASH_MISMATCH", "Pinned Artifact version metadata failed hash validation.", 409);
    }
    const authorizationRevision = revision([
      context.authorizationRevision,
      artifact.resourceVersion,
      reference.referenceId,
      reference.resourceVersion,
      reference.revokedAt ?? "",
      reference.pinnedVersion,
      reference.pinnedHash
    ]);
    return Object.freeze({ artifact, version: artifactVersion, reference, authorizationRevision });
  }
}

export function safeHashEqual(left, right) {
  if (!/^[a-f0-9]{64}$/.test(left ?? "") || !/^[a-f0-9]{64}$/.test(right ?? "")) return false;
  return timingSafeEqual(Buffer.from(left, "ascii"), Buffer.from(right, "ascii"));
}

export function artifactError(code, message, statusCode, details = null) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  if (details) error.details = details;
  return error;
}

function hiddenArtifactError() {
  return artifactError("ARTIFACT_NOT_FOUND_OR_FORBIDDEN", "Artifact was not found or is not authorized for this Session.", 404);
}

function bindingError(message) {
  return artifactError("ARTIFACT_SESSION_BINDING_INVALID", message, 409);
}

function revision(parts) {
  return createHash("sha256").update(parts.map((value) => String(value ?? "")).join("\0")).digest("hex");
}

function canonicalHash(value) {
  const hash = required(value, "contentHash");
  if (!/^[a-f0-9]{64}$/.test(hash)) throw artifactError("ARTIFACT_HASH_INVALID", "contentHash must be a lowercase SHA-256 digest.", 400);
  return hash;
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) throw artifactError("ARTIFACT_INVALID_INPUT", `${field} must be a positive integer.`, 400);
  return value;
}

function required(value, field) {
  const text = normalized(value);
  if (!text) throw artifactError("ARTIFACT_INVALID_INPUT", `${field} is required.`, 400);
  return text;
}

function normalized(value) { return typeof value === "string" && value.trim() ? value.trim() : null; }
