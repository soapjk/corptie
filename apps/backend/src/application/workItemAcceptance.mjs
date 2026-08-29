const VERDICTS = new Set(["passed", "failed", "unknown"]);

function assertKnownKeys(value, allowed, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new WorkItemAcceptanceError(
      "UNKNOWN_ACCEPTANCE_FIELD",
      `${path} contains unsupported field(s): ${unknown.join(", ")}.`
    );
  }
}

export class WorkItemAcceptanceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WorkItemAcceptanceError";
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

export function workItemExecutionPrompt(workItem) {
  return [
    `请完成工作项「${workItem?.title ?? "未命名"}」。`,
    workItem?.description ? `\n任务描述：\n${workItem.description}` : "",
    workItem?.acceptance_criteria ? `\n验收标准：\n${workItem.acceptance_criteria}` : "",
    workItem?.acceptance_criteria
      ? "\n完成实现与验证后：只有在每条验收标准均有可复现证据时，才调用 corptie_work_item_report_acceptance；逐条原样填写标准、passed 结论、证据摘要与命令/文件/结果引用。证据不足时不得调用，也不得因 Session 或本轮结束而推断验收通过。"
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

  // Historical collaboration WorkItems stored delivery metadata in the same
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

export function buildAcceptanceAssessment(workItem, input, { now = new Date().toISOString() } = {}) {
  assertKnownKeys(input, new Set(["sourceSessionId", "results"]), "assessment");
  const criteriaSnapshot = String(workItem?.acceptance_criteria ?? "").trim();
  const criteria = acceptanceCriteriaList(criteriaSnapshot);
  if (criteria.length === 0) {
    throw new WorkItemAcceptanceError(
      "ACCEPTANCE_CRITERIA_REQUIRED",
      "WorkItem must define acceptance criteria before acceptance can be assessed."
    );
  }

  const sourceSessionId = String(input?.sourceSessionId ?? "").trim();
  if (!sourceSessionId) {
    throw new WorkItemAcceptanceError(
      "ACCEPTANCE_SOURCE_REQUIRED",
      "sourceSessionId is required for an acceptance assessment."
    );
  }
  if (!Array.isArray(input?.results)) {
    throw new WorkItemAcceptanceError("INVALID_ACCEPTANCE_RESULTS", "results must be an array.");
  }

  const results = input.results.map((result, index) => {
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new WorkItemAcceptanceError("INVALID_ACCEPTANCE_RESULTS", `results[${index}] must be an object.`);
    }
    assertKnownKeys(result, new Set(["criterion", "verdict", "evidence"]), `results[${index}]`);
    const criterion = String(result.criterion ?? "").trim();
    const verdict = String(result.verdict ?? "").trim();
    if (criterion !== criteria[index]) {
      throw new WorkItemAcceptanceError(
        "ACCEPTANCE_CRITERIA_MISMATCH",
        `results[${index}].criterion must exactly match the current WorkItem acceptance criterion.`
      );
    }
    if (!VERDICTS.has(verdict)) {
      throw new WorkItemAcceptanceError(
        "INVALID_ACCEPTANCE_VERDICT",
        `results[${index}].verdict must be passed, failed, or unknown.`
      );
    }
    const evidence = Array.isArray(result.evidence) ? result.evidence.map((item, evidenceIndex) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new WorkItemAcceptanceError(
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
        throw new WorkItemAcceptanceError(
          "INVALID_ACCEPTANCE_EVIDENCE",
          `results[${index}].evidence[${evidenceIndex}] requires summary and reference.`
        );
      }
      return { summary, reference };
    }) : [];
    if (verdict === "passed" && evidence.length === 0) {
      throw new WorkItemAcceptanceError(
        "ACCEPTANCE_EVIDENCE_REQUIRED",
        `Passed criterion ${index + 1} requires verifiable evidence.`
      );
    }
    return { criterion, verdict, evidence };
  });

  if (results.length !== criteria.length) {
    throw new WorkItemAcceptanceError(
      "ACCEPTANCE_CRITERIA_MISMATCH",
      "Assessment results must cover every current WorkItem acceptance criterion exactly once and in order."
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

export function completionSuggestionForWorkItem(workItem) {
  const assessment = parseAcceptanceAssessment(workItem?.acceptance_assessment_json ?? workItem?.acceptanceAssessment);
  if (!assessment || assessment.status !== "passed") return null;
  const criteriaSnapshot = String(workItem?.acceptance_criteria ?? workItem?.acceptanceCriteria ?? "").trim();
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

export function presentWorkItemAcceptance(workItem) {
  const acceptanceAssessment = parseAcceptanceAssessment(workItem?.acceptance_assessment_json) ?? null;
  const {
    acceptance_assessment_json: _storedAssessment,
    completion_operation_id: completionOperationId,
    completion_source_type: completionSourceType,
    ...presented
  } = workItem;
  const completed = ["done", "complete", "completed"].includes(String(workItem?.status ?? "").toLowerCase());
  return {
    ...presented,
    // Rows created before acceptance criteria became part of the WorkItem
    // contract legitimately contain NULL. The public state contract is a
    // string, so normalize at the presentation boundary.
    acceptanceCriteria: String(presented.acceptanceCriteria ?? ""),
    acceptanceAssessment,
    completionSuggestion: completionSuggestionForWorkItem(workItem),
    ...(completed ? { completionSource: completionOperationId
        ? { sourceType: completionSourceType, operationId: completionOperationId, completedAt: workItem.updated_at ?? null }
        : { sourceType: "legacy/unattributed", operationId: null, completedAt: null } } : {})
  };
}

export function workItemExecutionPatch(workItem, sessionStatus) {
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

  const patch = { executionStatus };
  const terminal = ["done", "complete", "completed"].includes(workItem?.status);
  if (!terminal && ["running", "blocked"].includes(sessionStatus)) {
    patch.status = "in_progress";
  }
  return patch;
}
