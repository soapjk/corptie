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

export function acceptanceCriteriaList(value) {
  const text = String(value ?? "").trim();
  if (!text) return [];
  const lines = text.split(/\r?\n/)
    .map((line) => line.trim().replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, "").trim())
    .filter(Boolean);
  return lines.length > 0 ? lines : [text];
}

export function taskExecutionPrompt(task) {
  return [
    `请完成工作项「${task?.title ?? "未命名"}」。`,
    task?.acceptance_criteria
      ? "\n请依据已注入的 Task 上下文执行与验证；只有在每条验收标准均有可复现证据时，才调用 corptie_task_report_acceptance。"
      : ""
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
    || typeof parsed.criteriaSnapshot !== "string"
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
  assertKnownKeys(input, new Set(["sourceSessionId", "results"]), "assessment");
  const criteriaSnapshot = String(task?.acceptance_criteria ?? "").trim();
  const criteria = acceptanceCriteriaList(criteriaSnapshot);
  if (criteria.length === 0) {
    throw new TaskAcceptanceError(
      "ACCEPTANCE_CRITERIA_REQUIRED",
      "Task must define acceptance criteria before acceptance can be assessed."
    );
  }

  const sourceSessionId = String(input?.sourceSessionId ?? "").trim();
  if (!sourceSessionId) {
    throw new TaskAcceptanceError(
      "ACCEPTANCE_SOURCE_REQUIRED",
      "sourceSessionId is required for an acceptance assessment."
    );
  }
  if (!Array.isArray(input?.results)) {
    throw new TaskAcceptanceError("INVALID_ACCEPTANCE_RESULTS", "results must be an array.");
  }

  const results = input.results.map((result, index) => {
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new TaskAcceptanceError("INVALID_ACCEPTANCE_RESULTS", `results[${index}] must be an object.`);
    }
    assertKnownKeys(result, new Set(["criterion", "verdict", "evidence"]), `results[${index}]`);
    const criterion = String(result.criterion ?? "").trim();
    const verdict = String(result.verdict ?? "").trim();
    if (criterion !== criteria[index]) {
      throw new TaskAcceptanceError(
        "ACCEPTANCE_CRITERIA_MISMATCH",
        `results[${index}].criterion must exactly match the current Task acceptance criterion.`
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

  if (results.length !== criteria.length) {
    throw new TaskAcceptanceError(
      "ACCEPTANCE_CRITERIA_MISMATCH",
      "Assessment results must cover every current Task acceptance criterion exactly once and in order."
    );
  }

  return {
    status: results.every((result) => result.verdict === "passed") ? "passed" : "not_proven",
    criteriaSnapshot,
    sourceSessionId,
    assessedAt: now,
    results
  };
}

export function completionSuggestionForTask(task) {
  const assessment = parseAcceptanceAssessment(task?.acceptance_assessment_json ?? task?.acceptanceAssessment);
  if (!assessment || assessment.status !== "passed") return null;
  const criteriaSnapshot = String(task?.acceptance_criteria ?? task?.acceptanceCriteria ?? "").trim();
  if (!criteriaSnapshot || assessment.criteriaSnapshot !== criteriaSnapshot) return null;
  const criteria = acceptanceCriteriaList(criteriaSnapshot);
  if (!Array.isArray(assessment.results) || assessment.results.length !== criteria.length) return null;
  const valid = assessment.results.every((result, index) => (
    result?.criterion === criteria[index]
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
    criteriaSnapshot,
    results: assessment.results
  };
}

export function presentTaskAcceptance(task) {
  const acceptanceAssessment = parseAcceptanceAssessment(task?.acceptance_assessment_json) ?? null;
  const completed = task.lifecycle_state === "done";
  return {
    id: task.id,
    workId: task.work_id,
    title: task.title,
    description: task.description,
    acceptanceCriteria: task.acceptance_criteria,
    verificationCriteria: task.verification_criteria,
    priority: task.priority,
    lifecycleState: task.lifecycle_state,
    mainAgentId: task.main_agent_id ?? null,
    currentSessionId: task.current_session_id ?? null,
    executionStatus: task.execution_status,
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
