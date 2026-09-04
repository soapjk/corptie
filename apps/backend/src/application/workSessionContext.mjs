import { createHash } from "node:crypto";
import { resolve } from "node:path";

const DEFAULT_MAX_CONTEXT_BYTES = 7_168;
const DEFAULT_MAX_TURN_CONTEXT_BYTES = 8_192;
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
  if (startupReceipt && (startupReceipt.schemaVersion !== 2
    || startupReceipt.status !== "ready"
    || startupReceipt.taskId !== task.id
    || startupReceipt.workId !== task.work_id
    || !validReceiptHash(startupReceipt)
    || (session.external?.cwd
      && resolve(session.external.cwd) !== resolve(startupReceipt.canonicalWorktreePath)))) {
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
    "The Task binding does not weaken or override higher-priority instructions, safety rules, authorization, permissions, confirmation requirements, or exact-target lifecycle controls. Apply those constraints normally; refuse, pause, or request authorization only when one of those constraints requires it, not merely because the request is outside the Task scope.",
    "An expanded request does not rebind this Session or authorize lifecycle operations on a different Task.",
    "Switching a branch, Worktree, or Provider thread never changes this binding.",
    startupReceipt
      ? `Startup binding receipt: operation=${text(startupReceipt.startupOperationId)} generation=${startupReceipt.bindingGeneration} repository=${text(startupReceipt.repositoryId)} worktree=${text(startupReceipt.worktreeId)} receiptHash=${text(startupReceipt.receiptHash)}`
      : "This is a retained pre-startup-receipt Session; do not infer a new Workspace binding from shell state.",
    "Use corptie_artifact_create for durable documents. Choose scope=work for shared Work resources or scope=task for this Task's private resources; always supply a stable idempotency_key.",
    "Every Work Session in this Work may read and manage Work-scoped Artifacts. Artifacts owned by another Task are not exposed here; this Task's Artifacts remain manageable.",
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
  assertCoreFits(prefixLines.join("\n") + suffix, maxContextBytes, taskDefinition, requiredArtifacts);

  const optionalArtifacts = (artifactIndex?.items ?? []).filter((item) => item.required !== true);
  const included = [];
  for (const item of optionalArtifacts) {
    if (fitsWithOptional(prefixLines, included.concat(item), artifactIndex, suffix, maxContextBytes)) included.push(item);
    else break;
  }
  const upstreamOmitted = artifactIndex?.omittedCount ?? artifactIndex?.omittedArtifactCount ?? 0;
  const contextOmitted = optionalArtifacts.length - included.length;
  const omittedCount = upstreamOmitted + contextOmitted;
  const omissionReasons = {
    ...(artifactIndex?.omissionReasons ?? {}),
    ...(contextOmitted ? { worker_context_budget: contextOmitted } : {})
  };
  const optionalSection = (included.length || omittedCount) ? [
    "Optional Artifact index (metadata only; bodies load on demand):",
    JSON.stringify({ artifacts: included, omittedCount, omissionReasons }),
    "Use the exact pinned version/hash shown. A pendingUpdate is an impact notice, not permission to silently change versions."
  ].join("\n") : "";
  const prompt = [...prefixLines, optionalSection].filter(Boolean).join("\n") + suffix;
  assertComplete(prompt, maxContextBytes, taskDefinition, requiredArtifacts);
  return {
    prompt,
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
  maxContextBytes = DEFAULT_MAX_TURN_CONTEXT_BYTES
} = {}) {
  if (!baseContext?.prompt) return null;
  const required = [baseContext, directUserIntentContext].filter((item) => item?.prompt);
  const requiredPrompt = required.map((item) => item.prompt).join("\n\n");
  const requiredBytes = encoder.encode(requiredPrompt).byteLength;
  if (requiredBytes > maxContextBytes) {
    throw contextError(
      "WORK_SESSION_CONTEXT_INCOMPLETE",
      "The complete Task context and direct-user evidence exceed the Provider-safe Turn budget.",
      { missingFields: [], maxUtf8Bytes: maxContextBytes, requiredUtf8Bytes: requiredBytes }
    );
  }
  const memoryFits = memoryContext?.prompt
    && encoder.encode(`${requiredPrompt}\n\n${memoryContext.prompt}`).byteLength <= maxContextBytes;
  const prompt = memoryFits ? `${requiredPrompt}\n\n${memoryContext.prompt}` : requiredPrompt;
  return {
    ...baseContext,
    prompt,
    memoryRecall: memoryFits ? memoryContext.memoryRecall ?? null : null,
    contextBudget: Object.freeze({
      ...(baseContext.contextBudget ?? {}),
      maxTurnUtf8Bytes: maxContextBytes,
      finalTurnUtf8Bytes: encoder.encode(prompt).byteLength,
      memoryContextOmitted: Boolean(memoryContext?.prompt && !memoryFits)
    })
  };
}

function canonicalTaskDefinition(task) {
  const definition = {
    id: text(task.id), workId: text(task.work_id), title: String(task.title ?? ""),
    description: String(task.description ?? ""), goal: String(task.goal ?? ""),
    acceptanceCriteria: String(task.acceptance_criteria ?? ""),
    verificationCriteria: String(task.verification_criteria ?? ""),
    revision: Number(task.revision), resourceVersion: Number(task.resource_version)
  };
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
    "Optional Artifact index (metadata only; bodies load on demand):",
    JSON.stringify({ artifacts, omittedCount, omissionReasons }),
    "Use the exact pinned version/hash shown. A pendingUpdate is an impact notice, not permission to silently change versions."
  ].join("\n");
  return encoder.encode([...prefixLines, section].join("\n") + suffix).byteLength <= maximum;
}

function assertCoreFits(prompt, maximum, taskDefinition, requiredArtifacts) {
  if (encoder.encode(prompt).byteLength > maximum) {
    throw contextError("WORK_SESSION_CONTEXT_INCOMPLETE", "The non-truncatable Worker Session context exceeds the Provider-safe budget.", {
      missingFields: [], maxUtf8Bytes: maximum, requiredUtf8Bytes: encoder.encode(prompt).byteLength
    });
  }
  assertComplete(prompt, maximum, taskDefinition, requiredArtifacts);
}

function assertComplete(prompt, maximum, taskDefinition, requiredArtifacts) {
  const missingFields = [];
  if (!prompt.includes(JSON.stringify(taskDefinition))) missingFields.push("taskDefinition");
  if (requiredArtifacts.length && !prompt.includes(JSON.stringify(requiredArtifacts))) missingFields.push("requiredArtifacts");
  if (!prompt.endsWith("</corptie_work_session_binding>")) missingFields.push("closingBindingTag");
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
