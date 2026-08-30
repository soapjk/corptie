import {
  ARTIFACT_CONTEXT_DEFAULT_LIMITS,
  ARTIFACT_CONTEXT_POLICY_REVISION,
  ArtifactContextBudgetPolicy,
  boundArtifactSummary
} from "./artifactContextBudgetPolicy.mjs";

const RELATION_ORDER = new Map([
  "implementation_spec", "security_requirement", "test_plan", "research_evidence",
  "handoff", "acceptance_evidence"
].map((value, index) => [value, index]));

export function buildArtifactContextIndex({ store, session, policy = new ArtifactContextBudgetPolicy(), limits = null } = {}) {
  const objectiveId = session?.objectiveId ?? session?.objective_id ?? null;
  const sessionKind = session?.sessionKind ?? session?.session_kind ?? null;
  const sessionId = session?.id ?? null;
  const workItemId = session?.workItemId ?? session?.work_item_id ?? null;
  if (!store || !objectiveId || !sessionId || !["worker", "objectiveChat"].includes(sessionKind)) {
    return emptyIndex(sessionKind);
  }
  const references = store.listArtifactReferences({ includeRevoked: false }).filter((reference) =>
    reference.objectiveId === objectiveId
    && ((reference.sessionId && reference.sessionId === sessionId)
      || (sessionKind === "worker" && reference.workItemId && reference.workItemId === workItemId))
  );
  const byArtifact = new Map();
  for (const reference of references) {
    const group = byArtifact.get(reference.artifactId) ?? [];
    group.push(reference);
    byArtifact.set(reference.artifactId, group);
  }
  const candidates = [];
  for (const [artifactId, activeReferences] of byArtifact) {
    const artifact = store.getArtifact(artifactId);
    if (!artifact || artifact.objectiveId !== objectiveId || artifact.status === "revoked") continue;
    const pin = canonicalPin(activeReferences);
    if (!pin) continue;
    const version = store.getArtifactVersion(artifactId, pin.pinnedVersion);
    if (!version || version.contentHash !== pin.pinnedHash) continue;
    const summary = boundArtifactSummary(artifact.summary);
    const pending = canonicalPending(activeReferences);
    candidates.push({
      artifactId,
      title: artifact.title,
      ...summary,
      visibility: artifact.visibility,
      pinnedVersion: pin.pinnedVersion,
      contentHash: pin.pinnedHash,
      byteLength: version.byteLength,
      mimeType: version.mimeType,
      required: activeReferences.some((reference) => reference.required),
      relations: [...new Set(activeReferences.map((reference) => reference.relation))]
        .sort((left, right) => relationRank(left) - relationRank(right) || left.localeCompare(right)),
      referenceIds: activeReferences.map((reference) => reference.referenceId).sort(),
      pendingUpdate: pending,
      authorizedAt: activeReferences.reduce((latest, reference) =>
        reference.authorizedAt > latest ? reference.authorizedAt : latest, "")
    });
  }
  const section = sessionKind === "worker" ? "workerArtifactIndex" : "objectiveArtifactIndex";
  candidates.sort(artifactIndexOrder);
  const packed = policy.measureAndPack({
    section,
    candidates: candidates.map(({ authorizedAt: _authorizedAt, ...item }) => item),
    limits: limits ?? ARTIFACT_CONTEXT_DEFAULT_LIMITS[section],
    stableOrder: null
  });
  return Object.freeze({
    policyRevision: ARTIFACT_CONTEXT_POLICY_REVISION,
    items: packed.items,
    usage: packed.usage,
    limits: packed.limits,
    omittedArtifactCount: packed.omittedCount,
    omittedCount: packed.omittedCount,
    omissionReasons: packed.omissionReasons,
    estimatorRevision: packed.estimatorRevision
  });
}

export function artifactIndexOrder(left, right) {
  if (left.required !== right.required) return left.required ? -1 : 1;
  if (Boolean(left.pendingUpdate) !== Boolean(right.pendingUpdate)) return left.pendingUpdate ? -1 : 1;
  const leftRelation = Math.min(...left.relations.map(relationRank));
  const rightRelation = Math.min(...right.relations.map(relationRank));
  if (leftRelation !== rightRelation) return leftRelation - rightRelation;
  if (left.authorizedAt !== right.authorizedAt) return right.authorizedAt.localeCompare(left.authorizedAt);
  return left.artifactId.localeCompare(right.artifactId);
}

function canonicalPin(references) {
  const pins = new Map(references.map((reference) => [
    `${reference.pinnedVersion}:${reference.pinnedHash}`,
    { pinnedVersion: reference.pinnedVersion, pinnedHash: reference.pinnedHash }
  ]));
  if (pins.size !== 1) return null;
  return pins.values().next().value;
}

function canonicalPending(references) {
  const pending = references
    .filter((reference) => reference.pendingVersion != null && reference.pendingHash)
    .sort((left, right) => right.pendingVersion - left.pendingVersion || left.pendingHash.localeCompare(right.pendingHash))[0];
  return pending ? { version: pending.pendingVersion, contentHash: pending.pendingHash } : null;
}

function relationRank(value) { return RELATION_ORDER.get(value) ?? Number.MAX_SAFE_INTEGER; }

function emptyIndex(sessionKind) {
  const section = sessionKind === "objectiveChat" ? "objectiveArtifactIndex" : "workerArtifactIndex";
  const limits = ARTIFACT_CONTEXT_DEFAULT_LIMITS[section];
  return Object.freeze({
    policyRevision: ARTIFACT_CONTEXT_POLICY_REVISION,
    items: Object.freeze([]),
    usage: Object.freeze({ estimatedTokens: 0, serializedUtf8Bytes: 0, itemCount: 0 }),
    limits,
    omittedArtifactCount: 0,
    omittedCount: 0,
    omissionReasons: Object.freeze({}),
    estimatorRevision: "unicode-scalars-or-utf8-div3-v1"
  });
}
