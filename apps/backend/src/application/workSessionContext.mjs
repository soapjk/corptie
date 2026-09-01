import { createHash } from "node:crypto";
import { resolve } from "node:path";

export function buildWorkSessionContext({ session, workItem, objective, artifactIndex = null, startupReceipt = null } = {}) {
  if (!session || session.sessionKind !== "worker" || !workItem) return null;
  if (session.workItemId !== workItem.id || session.objectiveId !== workItem.objective_id) {
    const error = new Error("Worker Session context does not match its bound WorkItem.");
    error.code = "WORK_SESSION_BINDING_MISMATCH";
    throw error;
  }
  if (objective && objective.id !== workItem.objective_id) {
    const error = new Error("Worker Session context does not match its bound Objective.");
    error.code = "WORK_SESSION_BINDING_MISMATCH";
    throw error;
  }
  if (startupReceipt && (startupReceipt.schemaVersion !== 2
    || startupReceipt.status !== "ready"
    || startupReceipt.workItemId !== workItem.id
    || startupReceipt.objectiveId !== workItem.objective_id
    || startupReceipt.repositoryId !== workItem.main_workspace_id
    || !validReceiptHash(startupReceipt)
    || (session.external?.cwd
      && resolve(session.external.cwd) !== resolve(startupReceipt.canonicalWorktreePath)))) {
    const error = new Error("Worker Session startup receipt does not match its Store binding.");
    error.code = "WORK_SESSION_STARTUP_RECEIPT_MISMATCH";
    throw error;
  }

  const lines = [
    `<corptie_work_session_binding session_id="${xml(session.id)}" work_item_id="${xml(workItem.id)}" objective_id="${xml(workItem.objective_id)}">`,
    "This is the authoritative WorkItem binding for execution ownership, evidence, and lifecycle operations in this Worker Session.",
    "Handle requests within the bound WorkItem scope normally.",
    "A direct user request may extend beyond the WorkItem title, description, or acceptance criteria. Continue handling that request when it is otherwise allowed. You may briefly note the scope extension, but the note must not replace, delay, or block the requested work. Never refuse a request solely because it is outside the bound WorkItem scope.",
    "The WorkItem binding does not weaken or override higher-priority instructions, safety rules, authorization, permissions, confirmation requirements, or exact-target lifecycle controls. Apply those constraints normally; refuse, pause, or request authorization only when one of those constraints requires it, not merely because the request is outside the WorkItem scope.",
    "An expanded request does not rebind this Session or authorize lifecycle operations on a different WorkItem.",
    "Switching a branch, Worktree, or Provider thread never changes this binding.",
    startupReceipt
      ? `Startup binding receipt: operation=${text(startupReceipt.startupOperationId)} generation=${startupReceipt.bindingGeneration} repository=${text(startupReceipt.repositoryId)} worktree=${text(startupReceipt.worktreeId)} receiptHash=${text(startupReceipt.receiptHash)}`
      : "This is a retained pre-startup-receipt Session; do not infer a new Workspace binding from shell state.",
    "Use corptie_artifact_create for durable documents. Choose scope=objective for shared Objective resources or scope=work_item for this WorkItem's private resources; always supply a stable idempotency_key.",
    "Every Work Session in this Objective may read and manage Objective-scoped Artifacts. Artifacts owned by another WorkItem are readable but immutable here; this WorkItem's Artifacts remain manageable.",
    "Use kind, category_path, tags, aliases, and keywords so later Sessions can locate the document through the Objective Artifact index and full-text search.",
    "",
    `WorkItem title: ${text(workItem.title)}`,
    workItem.description ? `WorkItem description:\n${text(workItem.description)}` : "",
    workItem.acceptance_criteria ? `WorkItem acceptance criteria:\n${text(workItem.acceptance_criteria)}` : "",
    objective?.name ? `Parent Objective: ${text(objective.name)}` : "",
    objective?.idealState ? `Objective ideal state:\n${text(objective.idealState)}` : "",
    artifactIndex?.items?.length ? [
      "Authorized Artifact index (metadata only; bodies must be read on demand):",
      JSON.stringify({ artifacts: artifactIndex.items, omittedCount: artifactIndex.omittedCount ?? 0 }),
      "Use the exact pinned version/hash shown. A pendingUpdate is an impact notice, not permission to silently change versions."
    ].join("\n") : "",
    "</corptie_work_session_binding>"
  ].filter(Boolean);
  return { prompt: lines.join("\n") };
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
