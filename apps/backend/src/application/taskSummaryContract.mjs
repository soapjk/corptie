import { createHash } from "node:crypto";

export const TASK_SUMMARY_SCHEMA_VERSION = 1;
export const TASK_SUMMARY_PROMPT_VERSION = "task-summary:1";
export const TASK_SUMMARY_OUTPUT_SCHEMA = Object.freeze({
  type: "object", additionalProperties: false,
  required: ["focus", "progress", "intervention", "reason", "nextAction", "sourceRefs"],
  properties: {
    focus: { type: "string", maxLength: 120 },
    progress: { type: "string", maxLength: 400 },
    intervention: { type: "string", enum: ["required", "not_required", "unknown"] },
    reason: { type: "string", maxLength: 240 },
    nextAction: { type: "string", maxLength: 240 },
    sourceRefs: { type: "array", minItems: 1, maxItems: 12, items: { type: "string" } }
  }
});

export function taskSummaryDefinitionHash(task) {
  return createHash("sha256").update(JSON.stringify([
    task.title, task.description, task.acceptance_criteria, task.verification_criteria
  ])).digest("hex");
}

export function presentTaskSummary(task) {
  let summary;
  try { summary = JSON.parse(task.user_summary_json ?? "null"); } catch { return null; }
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return null;
  if (summary.state !== "ready") return summary;
  const basis = summary.content?.basis;
  const current = basis && summary.content.schemaVersion === TASK_SUMMARY_SCHEMA_VERSION
    && basis.promptVersion === TASK_SUMMARY_PROMPT_VERSION
    && basis.taskRevision === Number(task.revision ?? 1)
    && basis.sessionID === task.current_session_id
    && basis.lifecycleState === task.lifecycle_state
    && !task.archived && !["deleting", "deleted"].includes(task.deletion_status)
    && !["running", "processing", "starting", "queued"].includes(task.execution_status)
    && basis.definitionHash === taskSummaryDefinitionHash(task);
  // Read-only fallback: legacy mutations and missed events must not promote an
  // obsolete intervention to current. Preserve its text as historical context.
  return current ? summary : { ...summary, state: "stale" };
}

export function validateTaskSummaryOutput(text, { allowedSources, incomplete = false } = {}) {
  if (typeof text !== "string" || text.length > 12_000) throw invalid("Summary output exceeds its budget.");
  let value;
  try { value = JSON.parse(text); } catch { throw invalid("Summary must be a JSON object without Markdown fences."); }
  const fields = ["focus", "progress", "intervention", "reason", "nextAction", "sourceRefs"];
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some((key) => !fields.includes(key))) throw invalid("Unexpected summary field.");
  for (const [field, limit] of [["focus", 120], ["progress", 400], ["reason", 240], ["nextAction", 240]]) {
    if (typeof value[field] !== "string" || value[field].length > limit) throw invalid(`Invalid ${field}.`);
    value[field] = value[field].trim();
  }
  if (!value.focus || !value.progress) throw invalid("Summary needs a focus and progress statement.");
  if (!["required", "not_required", "unknown"].includes(value.intervention)) throw invalid("Invalid intervention state.");
  if (!Array.isArray(value.sourceRefs) || value.sourceRefs.length < 1 || value.sourceRefs.length > 12
      || value.sourceRefs.some((source) => typeof source !== "string" || !allowedSources?.has(source))) {
    throw invalid("Every source must refer to the supplied Task context.");
  }
  if (value.intervention === "required" && (!value.reason || !value.nextAction)) throw invalid("Required intervention needs a reason and action.");
  if (value.intervention !== "required" && value.nextAction) throw invalid("Only required intervention may prescribe a user action.");
  // A partial context is never enough to certify the absence of user work.
  if (incomplete && value.intervention === "not_required") {
    value.intervention = "unknown";
    value.reason = "上下文不完整，暂不能确认是否需要介入。";
  }
  return { schemaVersion: TASK_SUMMARY_SCHEMA_VERSION, ...value, sourceRefs: [...new Set(value.sourceRefs)] };
}

function invalid(message) {
  return Object.assign(new Error(message), { code: "TASK_SUMMARY_INVALID_OUTPUT" });
}
