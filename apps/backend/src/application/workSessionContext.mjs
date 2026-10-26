import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { ARTIFACT_DOCUMENT_LOCATION_INSTRUCTIONS } from "./artifactRuntimePolicy.mjs";

export const TASK_WORKSPACE_INSTRUCTIONS = "Corptie programmatically binds the Task Worktree. Stay in it; create or switch Worktrees only when the direct user explicitly requests it. Ordinary development is not authorization, and shell cd or command workdir never changes the logical Workspace.";

export const WORKER_SESSION_CONTEXT_LIMITS = Object.freeze({
  // Corptie supplemental-context limits, not a model token-window estimate.
  baseMaxUtf8Bytes: 32_768,
  baseTargetUtf8Bytes: 16_384,
  turnMaxUtf8Bytes: 32_768,
  turnTargetUtf8Bytes: 20_480,
  userEvidenceReserveUtf8Bytes: 2_048
});
const DEFAULT_MAX_CONTEXT_BYTES = WORKER_SESSION_CONTEXT_LIMITS.baseMaxUtf8Bytes;
const DEFAULT_MAX_TURN_CONTEXT_BYTES = WORKER_SESSION_CONTEXT_LIMITS.turnMaxUtf8Bytes;
const encoder = new TextEncoder();

export function buildWorkSessionContext({
  session, task, work, artifactIndex = null, startupReceipt = null,
  toolDomains = [],
  toolCatalogVersion = null,
  maxContextBytes = DEFAULT_MAX_CONTEXT_BYTES
} = {}) {
  if (!session || session.sessionKind !== "worker" || !task) return null;
  if (session.taskId !== task.id || session.workId !== task.work_id) {
    const error = new Error("Worker Session context does not match its bound Task.");
    error.code = "WORK_SESSION_BINDING_MISMATCH";
    throw error;
  }
  if (work && work.id !== task.work_id) {
    const error = new Error("Worker Session context does not match its bound Work.");
    error.code = "WORK_SESSION_BINDING_MISMATCH";
    throw error;
  }
  const startupWorkingDirectory = startupReceipt?.canonicalWorkingDirectory
    ?? startupReceipt?.canonicalWorktreePath;
  if (startupReceipt && (startupReceipt.schemaVersion !== 2
    || startupReceipt.status !== "ready"
    || startupReceipt.taskId !== task.id
    || startupReceipt.workId !== task.work_id
    || !validReceiptHash(startupReceipt)
    || !startupWorkingDirectory
    || (session.external?.cwd
      && resolve(session.external.cwd) !== resolve(startupWorkingDirectory)))) {
    const error = new Error("Worker Session startup receipt does not match its Store binding.");
    error.code = "WORK_SESSION_STARTUP_RECEIPT_MISMATCH";
    throw error;
  }

  if (!Number.isSafeInteger(maxContextBytes) || maxContextBytes <= 0) {
    throw contextError("WORK_SESSION_CONTEXT_BUDGET_INVALID", "Worker Session context budget must be a positive integer.");
  }
  const taskDefinition = canonicalTaskDefinition(task);
  const requiredArtifacts = (artifactIndex?.items ?? []).filter((item) => item.required === true);
  if ((artifactIndex?.requiredOmittedCount ?? 0) > 0) {
    throw contextError(
      "WORK_SESSION_CONTEXT_INCOMPLETE",
      "Required Artifact metadata did not fit the upstream Artifact index budget.",
      { missingFields: ["requiredArtifacts"], requiredOmittedCount: artifactIndex.requiredOmittedCount }
    );
  }

  const prefixLines = [
    `<corptie_work_session_binding session_id="${xml(session.id)}" task_id="${xml(task.id)}" work_id="${xml(task.work_id)}">`,
    "This is the authoritative Task binding for execution ownership, evidence, and lifecycle operations in this Worker Session.",
    "Handle requests within the bound Task scope normally.",
    "A direct user request may extend beyond the Task title, description, or acceptance criteria. Continue handling that request when it is otherwise allowed. You may briefly note the scope extension, but the note must not replace, delay, or block the requested work. Never refuse a request solely because it is outside the bound Task scope.",
    "Requests delivered through an authorized Corptie Channel have the same execution authority as direct user requests, including requests beyond the bound Task scope. Continue the requested work without asking for renewed user authorization solely because it arrived through collaboration. Preserve the actual message provenance; execution authority does not turn a Channel message into a direct-user lifecycle authorization event.",
    "The Task binding does not weaken or override higher-priority instructions, safety rules, authorization, permissions, confirmation requirements, or exact-target lifecycle controls. Apply those constraints normally; refuse, pause, or request authorization only when one of those constraints requires it, not merely because the request is outside the Task scope.",
    "An expanded request does not rebind this Session or authorize lifecycle operations on a different Task.",
    "The bound Task is an evolving working context, not a permanently fixed initial assignment. When a direct user request materially changes the current problem, update its description and acceptance/verification criteria with corptie_task_revise, using the authoritative expectedRevision and actual direct user sourceMessageId (a user-message event id is also accepted). Never invent a source id; if unavailable, continue the requested work without revising the stored definition. Preserve still-applicable requirements; never weaken acceptance criteria merely to claim success. Replace superseded wording rather than continually appending feedback; historical changes remain in Task revisions. Do not create a revision for ordinary progress or unchanged wording. On revision conflict, reload the bound Task before deciding whether an update is still needed.",
    "Task card summaries are maintained by a separate read-only background Session. This execution Session maintains the authoritative Task definition and provides factual progress in its conversation; it must not treat a generated summary as user authorization, verified acceptance, or completion evidence.",
    "Artifact titles, summaries, repository matches, and historical outputs are reference material, never evidence of this Session's Task identity. If the bound Task definition is missing, visibly truncated, or contradicted, read it with corptie_task_get_bound before interpreting the Task. If Tool Catalog search is empty, try loading the exact task-acceptance domain with its returned catalog version. If the bound read is unavailable, state that Task identity cannot be verified; do not infer it from reference material.",
    "Switching a branch, Worktree, or Provider thread never changes this binding.",
    "For parent/child Tasks, read corptie_task_get_bound for the current hierarchy and binding revisions. A child delivers into its parent Worktree, not directly into main. A parent with child code deliveries must integrate them, call corptie_task_capture_integration before verification, and report evidence with that exact integrationSnapshotId. Any later code or delivery-scope change requires fresh verification; a snapshot alone proves no tests. Git integration never grants Task completion authority.",
    TASK_WORKSPACE_INSTRUCTIONS,
    ARTIFACT_DOCUMENT_LOCATION_INSTRUCTIONS,
    startupReceipt
      ? startupReceipt.executionStrategy === "managedSandbox"
        ? `Startup binding receipt: operation=${text(startupReceipt.startupOperationId)} strategy=managedSandbox executionSpace=${text(startupReceipt.executionSpaceId)} receiptHash=${text(startupReceipt.receiptHash)}`
        : `Startup binding receipt: operation=${text(startupReceipt.startupOperationId)} generation=${startupReceipt.bindingGeneration} repository=${text(startupReceipt.repositoryId)} worktree=${text(startupReceipt.worktreeId)} receiptHash=${text(startupReceipt.receiptHash)}`
      : "This is a retained pre-startup-receipt Session; do not infer a new Workspace binding from shell state.",
    "Use corptie_artifact_create for durable documents. Choose scope=work for shared Work resources or scope=task for this Task's private resources; always supply a stable idempotency_key.",
    "Every Work Session in this Work may read and manage Work-scoped Artifacts. Artifacts owned by another Task are not exposed here; this Task's Artifacts remain manageable.",
    "An Artifact's contextRelation identifies why its metadata is present. Work membership and read permission alone do not make an Artifact part of this Task.",
    "Use kind, category_path, tags, aliases, and keywords so later Sessions can locate the document through the Work Artifact index and full-text search.",
    projectCodeInstructions(toolDomains, toolCatalogVersion),
    "",
    "Authoritative bound Task definition (complete JSON; no fields in this object are truncated):",
    JSON.stringify(taskDefinition),
    requiredArtifacts.length ? [
      "Required Artifact index (complete pinned metadata):",
      JSON.stringify(requiredArtifacts)
    ].join("\n") : "",
    work?.name ? `Parent Work: ${text(work.name)}` : "",
    work?.profile ? `Work profile: ${text(work.profile)}` : "",
  ].filter(Boolean);
  const suffix = "\n</corptie_work_session_binding>";
  const corePrompt = prefixLines.join("\n") + suffix;
  assertCoreFits(corePrompt, maxContextBytes, taskDefinition, requiredArtifacts);

  const optionalArtifacts = (artifactIndex?.items ?? []).filter((item) => item.required !== true);
  const optionalMaximum = Math.min(maxContextBytes,
    Math.max(encoder.encode(corePrompt).byteLength, WORKER_SESSION_CONTEXT_LIMITS.baseTargetUtf8Bytes));
  const included = [];
  for (const item of optionalArtifacts) {
    if (fitsWithOptional(prefixLines, included.concat(item), artifactIndex, suffix, optionalMaximum)) included.push(item);
    else break;
  }
  const upstreamOmitted = artifactIndex?.omittedCount ?? artifactIndex?.omittedArtifactCount ?? 0;
  const contextOmitted = optionalArtifacts.length - included.length;
  const omittedCount = upstreamOmitted + contextOmitted;
  const omissionReasons = {
    ...(artifactIndex?.omissionReasons ?? {}),
    ...(contextOmitted ? { worker_context_budget: contextOmitted } : {})
  };
  const prompt = optionalArtifactPrompt(corePrompt, included, omittedCount, omissionReasons, optionalMaximum);
  assertComplete(prompt, maxContextBytes, taskDefinition, requiredArtifacts);
  return {
    prompt,
    corePrompt,
    optionalArtifactSource: Object.freeze({
      items: Object.freeze([...optionalArtifacts]),
      upstreamOmitted,
      upstreamOmissionReasons: Object.freeze({ ...(artifactIndex?.omissionReasons ?? {}) })
    }),
    contextIntegrity: Object.freeze({
      taskId: task.id,
      taskRevision: taskDefinition.revision,
      taskDefinitionSha256: sha256(JSON.stringify(taskDefinition)),
      corePromptSha256: sha256(corePrompt),
      finalPromptSha256: sha256(prompt)
    }),
    contextBudget: Object.freeze({
      maxUtf8Bytes: maxContextBytes,
      finalUtf8Bytes: encoder.encode(prompt).byteLength,
      omittedOptionalArtifacts: omittedCount,
      omissionReasons: Object.freeze(omissionReasons)
    })
  };
}

export function mergeWorkerSessionContexts({
  baseContext, directUserIntentContext = null, memoryContext = null,
  requiredContexts = [],
  mentionContext = null,
  referenceContext = null,
  maxContextBytes = DEFAULT_MAX_TURN_CONTEXT_BYTES,
  targetContextBytes = WORKER_SESSION_CONTEXT_LIMITS.turnTargetUtf8Bytes,
  userEvidenceReserveBytes = WORKER_SESSION_CONTEXT_LIMITS.userEvidenceReserveUtf8Bytes
} = {}) {
  if (!baseContext?.prompt) return null;
  if (!Number.isSafeInteger(targetContextBytes) || targetContextBytes <= 0
      || !Number.isSafeInteger(userEvidenceReserveBytes) || userEvidenceReserveBytes < 0) {
    throw contextError("WORK_SESSION_CONTEXT_BUDGET_INVALID", "Worker Session context budgets must be valid byte counts.");
  }
  const requiredTail = [...requiredContexts, directUserIntentContext, mentionContext]
    .filter((item) => item?.prompt).map((item) => item.prompt);
  const composeRequired = (basePrompt) => [basePrompt, ...requiredTail].join("\n\n");
  const corePrompt = baseContext.corePrompt ?? baseContext.prompt;
  const coreBytes = encoder.encode(corePrompt).byteLength;
  const sectionBytes = Object.fromEntries([
    ["session-binding", coreBytes],
    ...requiredContexts.map((item, index) => [item.contextKey ?? `required-${index}`, encoder.encode(item.prompt ?? "").byteLength]),
    ["direct-user-evidence", encoder.encode(directUserIntentContext?.prompt ?? "").byteLength],
    ["mentions", encoder.encode(mentionContext?.prompt ?? "").byteLength]
  ]);
  const completeRequiredPrompt = composeRequired(corePrompt);
  const requiredBytes = encoder.encode(completeRequiredPrompt).byteLength;
  // Internal continuations must leave room for the next real user turn. The
  // current evidence consumes this reservation; it never competes with recall.
  const reservedBytes = Math.max(0, userEvidenceReserveBytes
    - (directUserIntentContext?.prompt ? sectionBytes["direct-user-evidence"] + 2 : 0));
  assertSessionContextBudget(completeRequiredPrompt, maxContextBytes,
    { sectionBytes, reservedUtf8Bytes: reservedBytes });
  const softMaximum = Math.min(maxContextBytes - reservedBytes,
    Math.max(requiredBytes, targetContextBytes - reservedBytes));
  // User-selected references are useful but never outrank the complete Task
  // definition, direct-user evidence, or explicitly selected mentions. Bound
  // them before packing optional Artifact metadata and memory.
  const referencePrompt = fitOptionalReferencePrompt(
    referenceContext?.prompt,
    Math.min(4_096, (referenceContext?.atomic ? maxContextBytes - reservedBytes : softMaximum) - requiredBytes - 2)
  );
  if (referenceContext?.atomic && referencePrompt !== referenceContext.prompt) {
    throw contextError("CONTEXT_REFERENCE_BUDGET_EXCEEDED",
      "Complete local file references do not fit the Provider-safe Turn budget. Disable some references; no partial path was sent.");
  }
  const compose = (basePrompt) => [basePrompt, ...requiredTail, referencePrompt]
    .filter(Boolean).join("\n\n");
  // Complete selected file paths may cross the soft target, just like other
  // atomic input. Optional Artifact metadata and recall still use the remainder.
  const optionalMaximum = Math.max(softMaximum,
    requiredBytes + (referencePrompt ? encoder.encode(referencePrompt).byteLength + 2 : 0));
  const source = baseContext.optionalArtifactSource;
  let selectedBasePrompt = baseContext.prompt;
  let selectedCount = source?.items.length ?? 0;
  let omissionReasons = baseContext.contextBudget?.omissionReasons ?? {};
  if (source) {
    selectedBasePrompt = corePrompt;
    selectedCount = 0;
    for (let count = 0; count <= source.items.length; count += 1) {
      const omitted = source.upstreamOmitted + source.items.length - count;
      const reasons = {
        ...source.upstreamOmissionReasons,
        ...(source.items.length > count ? { worker_context_budget: source.items.length - count } : {})
      };
      const candidate = optionalArtifactPrompt(corePrompt, source.items.slice(0, count), omitted, reasons,
        Math.min(baseContext.contextBudget?.maxUtf8Bytes ?? DEFAULT_MAX_CONTEXT_BYTES,
          Math.max(coreBytes, WORKER_SESSION_CONTEXT_LIMITS.baseTargetUtf8Bytes)));
      if (!candidate || encoder.encode(compose(candidate)).byteLength > optionalMaximum) break;
      selectedBasePrompt = candidate;
      selectedCount = count;
    }
    omissionReasons = {
      ...source.upstreamOmissionReasons,
      ...(source.items.length > selectedCount ? { worker_context_budget: source.items.length - selectedCount } : {})
    };
  }
  const requiredPrompt = compose(selectedBasePrompt);
  const memoryFits = memoryContext?.prompt
    && encoder.encode(`${requiredPrompt}\n\n${memoryContext.prompt}`).byteLength <= optionalMaximum;
  const prompt = memoryFits ? `${requiredPrompt}\n\n${memoryContext.prompt}` : requiredPrompt;
  const artifactPrompt = selectedBasePrompt.startsWith(corePrompt)
    ? selectedBasePrompt.slice(corePrompt.length).trim() : "";
  const contextSections = [
    { id: "session-binding", prompt: corePrompt, reusable: true },
    { id: "artifact-index", prompt: artifactPrompt, reusable: true },
    ...requiredContexts.map((item, index) => ({ id: item.contextKey ?? `required-${index}`,
      prompt: item.prompt ?? "", reusable: item.contextReusable === true })),
    { id: "direct-user-evidence", prompt: directUserIntentContext?.prompt ?? "", reusable: false },
    { id: "mentions", prompt: mentionContext?.prompt ?? "", reusable: false },
    { id: "context-references", prompt: referencePrompt, reusable: true },
    { id: "memory-recall", prompt: memoryFits ? memoryContext.prompt : "", reusable: false }
  ];
  return {
    ...baseContext,
    prompt,
    contextSections,
    contextIntegrity: baseContext.contextIntegrity ? Object.freeze({
      ...baseContext.contextIntegrity,
      finalPromptSha256: sha256(prompt)
    }) : null,
    memoryRecall: memoryFits ? memoryContext.memoryRecall ?? null : null,
    contextBudget: Object.freeze({
      ...(baseContext.contextBudget ?? {}),
      finalUtf8Bytes: encoder.encode(selectedBasePrompt).byteLength,
      omittedOptionalArtifacts: source
        ? source.upstreamOmitted + source.items.length - selectedCount
        : baseContext.contextBudget?.omittedOptionalArtifacts ?? 0,
      omissionReasons: Object.freeze(omissionReasons),
      maxTurnUtf8Bytes: maxContextBytes,
      targetTurnUtf8Bytes: targetContextBytes,
      requiredUtf8Bytes: requiredBytes,
      reservedUtf8Bytes: reservedBytes,
      sectionBytes: Object.freeze(sectionBytes),
      finalTurnUtf8Bytes: encoder.encode(prompt).byteLength,
      referenceContextOmitted: Boolean(referenceContext?.prompt && !referencePrompt),
      referenceContextTruncated: Boolean(referenceContext?.prompt && referencePrompt !== referenceContext.prompt),
      memoryContextOmitted: Boolean(memoryContext?.prompt && !memoryFits)
    })
  };
}

function fitOptionalReferencePrompt(prompt, maxUtf8Bytes) {
  if (!prompt || maxUtf8Bytes < 512) return "";
  if (encoder.encode(prompt).byteLength <= maxUtf8Bytes) return prompt;
  const suffix = "\n[Additional reference content omitted by the Turn budget.]";
  const contentBudget = maxUtf8Bytes - encoder.encode(suffix).byteLength;
  let result = "";
  let used = 0;
  for (const point of prompt) {
    const size = encoder.encode(point).byteLength;
    if (used + size > contentBudget) break;
    result += point;
    used += size;
  }
  return result + suffix;
}

function canonicalTaskDefinition(task) {
  const definition = {
    id: text(task.id), workId: text(task.work_id), title: String(task.title ?? ""),
    description: String(task.description ?? ""),
    acceptanceCriteria: String(task.acceptance_criteria ?? ""),
    verificationCriteria: String(task.verification_criteria ?? ""),
    revision: Number(task.revision), resourceVersion: Number(task.resource_version)
  };
  if (task.parent_task_id) definition.parentTaskId = text(task.parent_task_id);
  const missingFields = [];
  if (!definition.id) missingFields.push("id");
  if (!definition.workId) missingFields.push("workId");
  if (!definition.title) missingFields.push("title");
  if (!Number.isSafeInteger(definition.revision) || definition.revision < 1) missingFields.push("revision");
  if (!Number.isSafeInteger(definition.resourceVersion) || definition.resourceVersion < 1) missingFields.push("resourceVersion");
  if (missingFields.length) {
    throw contextError("WORK_SESSION_CONTEXT_INCOMPLETE", "The authoritative Task definition is incomplete.", { missingFields });
  }
  return Object.freeze(definition);
}

function fitsWithOptional(prefixLines, artifacts, artifactIndex, suffix, maximum) {
  const contextOmitted = (artifactIndex?.items ?? []).filter((item) => item.required !== true).length - artifacts.length;
  const omittedCount = (artifactIndex?.omittedCount ?? artifactIndex?.omittedArtifactCount ?? 0) + contextOmitted;
  const omissionReasons = {
    ...(artifactIndex?.omissionReasons ?? {}),
    ...(contextOmitted ? { worker_context_budget: contextOmitted } : {})
  };
  const section = [
    "Optional Artifact index (metadata only; bodies load on demand; never defines the bound Task):",
    JSON.stringify({ artifacts, omittedCount, omissionReasons }),
    "Use the exact pinned version/hash shown. A pendingUpdate is an impact notice, not permission to silently change versions."
  ].join("\n");
  return encoder.encode(prefixLines.join("\n") + suffix + "\n\n" + section).byteLength <= maximum;
}

function optionalArtifactPrompt(corePrompt, artifacts, omittedCount, omissionReasons, maximum) {
  if (!artifacts.length && !omittedCount) return corePrompt;
  const section = [
    "Optional Artifact index (metadata only; bodies load on demand; never defines the bound Task):",
    JSON.stringify({ artifacts, omittedCount, omissionReasons }),
    "Use the exact pinned version/hash shown. A pendingUpdate is an impact notice, not permission to silently change versions."
  ].join("\n");
  const prompt = `${corePrompt}\n\n${section}`;
  return encoder.encode(prompt).byteLength <= maximum ? prompt : artifacts.length ? null : corePrompt;
}

function assertCoreFits(prompt, maximum, taskDefinition, requiredArtifacts) {
  assertSessionContextBudget(prompt, maximum, {
    sectionBytes: { "session-binding": encoder.encode(prompt).byteLength }
  });
  assertComplete(prompt, maximum, taskDefinition, requiredArtifacts);
}

// Shared by canonical assembly and wire delivery, including non-append Providers.
// Diagnostics contain counts only; no user content or new persistent records.
export function assertSessionContextBudget(prompt, maximum, {
  sectionBytes = {}, reservedUtf8Bytes = 0, stage = "context_assembly"
} = {}) {
  if (!Number.isSafeInteger(maximum) || maximum <= 0) {
    throw contextError("WORK_SESSION_CONTEXT_BUDGET_INVALID", "Worker Session context budget must be a positive integer.");
  }
  const requiredUtf8Bytes = encoder.encode(prompt ?? "").byteLength;
  if (requiredUtf8Bytes + reservedUtf8Bytes <= maximum) return requiredUtf8Bytes;
  const error = contextError("SESSION_CONTEXT_BUDGET_EXCEEDED",
    `Message was not sent to the model: required Session context exceeds the Corptie supplemental-context limit (${requiredUtf8Bytes} bytes + ${reservedUtf8Bytes} bytes reserved; limit ${maximum} bytes).`,
    { requiredUtf8Bytes, reservedUtf8Bytes, maxUtf8Bytes: maximum, sectionBytes, stage });
  error.dispatchState = "not_sent";
  error.stage = stage;
  throw error;
}

function assertComplete(prompt, maximum, taskDefinition, requiredArtifacts) {
  const missingFields = [];
  if (!prompt.includes(JSON.stringify(taskDefinition))) missingFields.push("taskDefinition");
  if (requiredArtifacts.length && !prompt.includes(JSON.stringify(requiredArtifacts))) missingFields.push("requiredArtifacts");
  const closingTag = "</corptie_work_session_binding>";
  const closingIndex = prompt.indexOf(closingTag);
  const afterBinding = closingIndex < 0 ? null : prompt.slice(closingIndex + closingTag.length);
  if (afterBinding === null || (afterBinding !== "" && !afterBinding.startsWith("\n\nOptional Artifact index ("))) {
    missingFields.push("closingBindingTag");
  }
  if (encoder.encode(prompt).byteLength > maximum) missingFields.push("contextBudget");
  if (missingFields.length) {
    throw contextError("WORK_SESSION_CONTEXT_INCOMPLETE", "Worker Session context failed its completeness invariant.", {
      missingFields, maxUtf8Bytes: maximum, finalUtf8Bytes: encoder.encode(prompt).byteLength
    });
  }
}

function contextError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 409;
  error.details = details;
  return error;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function projectCodeInstructions(toolDomains, toolCatalogVersion) {
  if (!Array.isArray(toolDomains) || !toolDomains.includes("project-code")) return "";
  const catalogVersion = text(toolCatalogVersion);
  if (!catalogVersion) return "";
  return [
    "Code navigation policy:",
    "- For source-code location, exact symbols, callers/imports, directory-scoped searches, and natural-language source queries, use corptie_project_code_search first.",
    "- Read a bounded code window from a search hit with corptie_project_code_read.",
    `- The project-code domain is already applied. Call it directly through corptie_tool_call with expected_catalog_version=${catalogVersion}; do not search or load the domain first.`,
    "- Search arguments require query and may include mode=auto|exact|files|symbols|semantic, paths, languages, kinds, limit, min_results, timeout_ms, snapshot_policy, and response_detail.",
    "- Read arguments require snapshot_receipt_id and path; start_line, line_count, max_bytes, and max_scan_bytes are optional.",
    "- Fall back to Provider-native search or rg only when project-code reports warming, degraded, unavailable, timed out, stale source, or insufficient results; retain the reported reason as fallback evidence.",
    "- This preference does not apply to builds, tests, Git operations, process inspection, or log inspection."
  ].join("\n");
}

function validReceiptHash(receipt) {
  if (!/^[0-9a-f]{64}$/.test(String(receipt?.receiptHash ?? ""))) return false;
  const { receiptHash, ...unsigned } = receipt;
  return createHash("sha256").update(canonicalJson(unsigned)).digest("hex") === receiptHash;
}

function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
}

function text(value) {
  return String(value ?? "").trim();
}

function xml(value) {
  return text(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
