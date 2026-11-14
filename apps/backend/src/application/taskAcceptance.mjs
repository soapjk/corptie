import { EXECUTION_CHECKLIST_INSTRUCTIONS } from "./executionChecklistInstructions.mjs";

const VERDICTS = new Set(["passed", "failed", "unknown"]);

function assertKnownKeys(value, allowed, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new TaskAcceptanceError(
      "UNKNOWN_ACCEPTANCE_FIELD",
      `${path} contains unsupported field(s): ${unknown.join(", ")}.`
    );
  }
}

export class TaskAcceptanceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TaskAcceptanceError";
    this.code = code;
  }
}

export function taskExecutionPrompt(task) {
  return [
    `请完成工作项「${task?.title ?? "未命名"}」。`,
    EXECUTION_CHECKLIST_INSTRUCTIONS
  ].filter(Boolean).join("\n");
}

export function parseAcceptanceAssessment(value) {
  let parsed = value;
  if (typeof value === "string") {
    if (!value.trim()) return null;
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  // Historical collaboration Tasks stored delivery metadata in the same
  // column before acceptance assessments had a wire contract. Never publish
  // such objects as an assessment: one malformed entity must not make the
  // complete application snapshot undecodable for every client.
  if (typeof parsed.status !== "string"
    || typeof parsed.sourceSessionId !== "string"
    || typeof parsed.assessedAt !== "string"
    || !Array.isArray(parsed.results)) {
    return null;
  }
  const validResults = parsed.results.every((result) => (
    result
    && typeof result === "object"
    && !Array.isArray(result)
    && typeof result.criterion === "string"
    && typeof result.verdict === "string"
    && Array.isArray(result.evidence)
    && result.evidence.every((evidence) => (
      evidence
      && typeof evidence === "object"
      && !Array.isArray(evidence)
      && typeof evidence.summary === "string"
      && typeof evidence.reference === "string"
    ))
  ));
  return validResults ? parsed : null;
}

export function buildAcceptanceAssessment(task, input, { now = new Date().toISOString() } = {}) {
  assertKnownKeys(input, new Set(["sourceSessionId", "results", "integrationSnapshotId"]), "assessment");
  const taskRevision = Number(task?.revision ?? 1);
  if (!Number.isSafeInteger(taskRevision) || taskRevision < 1) {
    throw new TaskAcceptanceError("TASK_REVISION_INVALID", "A current Task revision is required.");
  }

  const sourceSessionId = String(input?.sourceSessionId ?? "").trim();
  if (!sourceSessionId) {
    throw new TaskAcceptanceError(
      "ACCEPTANCE_SOURCE_REQUIRED",
      "sourceSessionId is required for an acceptance assessment."
    );
  }
  if (!Array.isArray(input?.results) || input.results.length === 0) {
    throw new TaskAcceptanceError("INVALID_ACCEPTANCE_RESULTS", "results must be a non-empty array of checked outcomes.");
  }

  const results = input.results.map((result, index) => {
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new TaskAcceptanceError("INVALID_ACCEPTANCE_RESULTS", `results[${index}] must be an object.`);
    }
    assertKnownKeys(result, new Set(["criterion", "verdict", "evidence"]), `results[${index}]`);
    const criterion = String(result.criterion ?? "").trim();
    const verdict = String(result.verdict ?? "").trim();
    if (!criterion || input.results.slice(0, index).some(previous => String(previous?.criterion ?? "").trim() === criterion)) {
      throw new TaskAcceptanceError(
        "INVALID_ACCEPTANCE_RESULTS",
        `results[${index}].criterion must be non-empty and unique.`
      );
    }
    if (!VERDICTS.has(verdict)) {
      throw new TaskAcceptanceError(
        "INVALID_ACCEPTANCE_VERDICT",
        `results[${index}].verdict must be passed, failed, or unknown.`
      );
    }
    const evidence = Array.isArray(result.evidence) ? result.evidence.map((item, evidenceIndex) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new TaskAcceptanceError(
          "INVALID_ACCEPTANCE_EVIDENCE",
          `results[${index}].evidence[${evidenceIndex}] must be an object.`
        );
      }
      assertKnownKeys(
        item,
        new Set(["summary", "reference"]),
        `results[${index}].evidence[${evidenceIndex}]`
      );
      const summary = String(item.summary ?? "").trim();
      const reference = String(item.reference ?? "").trim();
      if (!summary || !reference) {
        throw new TaskAcceptanceError(
          "INVALID_ACCEPTANCE_EVIDENCE",
          `results[${index}].evidence[${evidenceIndex}] requires summary and reference.`
        );
      }
      return { summary, reference };
    }) : [];
    if (verdict === "passed" && evidence.length === 0) {
      throw new TaskAcceptanceError(
        "ACCEPTANCE_EVIDENCE_REQUIRED",
        `Passed criterion ${index + 1} requires verifiable evidence.`
      );
    }
    return { criterion, verdict, evidence };
  });

  return {
    status: results.every((result) => result.verdict === "passed") ? "passed" : "not_proven",
    taskRevision,
    sourceSessionId,
    assessedAt: now,
    results
  };
}

export function completionSuggestionForTask(task) {
  const assessment = parseAcceptanceAssessment(task?.acceptance_assessment_json ?? task?.acceptanceAssessment);
  if (!assessment || assessment.status !== "passed") return null;
  const taskRevision = Number(task?.revision ?? 1);
  if (assessment.taskRevision !== taskRevision || !assessment.results.length) return null;
  const criteria = new Set();
  const valid = assessment.results.every((result, index) => (
    typeof result?.criterion === "string" && result.criterion.trim()
    && !criteria.has(result.criterion) && criteria.add(result.criterion)
    && result?.verdict === "passed"
    && Array.isArray(result.evidence)
    && result.evidence.length > 0
    && result.evidence.every((item) => (
      typeof item?.summary === "string" && item.summary.trim()
      && typeof item?.reference === "string" && item.reference.trim()
    ))
  ));
  if (!valid) return null;
  return {
    recommended: true,
    sourceSessionId: assessment.sourceSessionId,
    assessedAt: assessment.assessedAt,
    taskRevision,
    results: assessment.results
  };
}

export function presentTaskAcceptance(task, options = {}) {
  const acceptanceAssessment = parseAcceptanceAssessment(task?.acceptance_assessment_json) ?? null;
  const completed = task.lifecycle_state === "done";
  return {
    id: task.id,
    workId: task.work_id,
    parentTaskId: task.parent_task_id ?? null,
    ...(options.hierarchy ? { hierarchy: options.hierarchy } : {}),
    title: task.title,

    priority: task.priority,
    lifecycleState: task.lifecycle_state,
    autoTitleEnabled: task.auto_title_enabled !== 0,
    coordinationEnabled: task.coordination_enabled === 1,
    coordinationDispatches: options.coordinationDispatches ?? [],
    archived: Boolean(task.archived),
    mainAgentId: task.main_agent_id ?? null,
    currentSessionId: task.current_session_id ?? null,
    creationState: task.creation_state ?? "ready",
    creationErrorCode: task.creation_error_code ?? null,
    executionStatus: task.execution_status,
    hasPendingScheduledWake: options.hasPendingScheduledWake === true,
    userSummary: presentTaskSummary(task),
    deletionStatus: task.deletion_status ?? null,
    deletionError: task.deletion_error ?? null,
    acceptanceAssessment,
    completionSuggestion: completionSuggestionForTask(task),
    currentSnapshotId: task.current_snapshot_id ?? null,
    revision: Number(task.revision),
    resourceVersion: Number(task.resource_version),
    createdAt: task.created_at,
    updatedAt: task.updated_at,
    ...(completed && task.completion_operation_id ? {
      completionSource: {
        sourceType: task.completion_source_type,
        operationId: task.completion_operation_id,
        completedAt: task.updated_at
      }
    } : {})
  };
}

export function taskExecutionPatch(task, sessionStatus) {
  const executionStatus = {
    running: "running",
    blocked: "blocked",
    paused: "paused",
    idle: "idle",
    complete: "completed",
    completed: "completed",
    done: "completed",
    failed: "failed",
    cancelled: "cancelled",
    canceled: "cancelled"
  }[sessionStatus];
  if (!executionStatus) return null;

  // Session/Turn lifecycle is execution evidence only. Task review state is
  // advanced by Task start/review workflows, never by Provider projection.
  return { executionStatus };
}
import { presentTaskSummary } from "./taskSummaryContract.mjs";
