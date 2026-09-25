const VALID_STATUSES = new Set(["pending", "inProgress", "completed", "failed", "cancelled", "unknown"]);

export function replaceExecutionPlan(previous, snapshot, { planId, updatedAt }) {
  // undefined means the update cannot be trusted; null means it was a valid
  // no-op. The Projector must surface the former as an uncertain plan state.
  if (!snapshot || snapshot.operation !== "replace" || !Array.isArray(snapshot.steps)) return undefined;
  if (snapshot.steps.length > 200) return undefined;
  if (snapshot.explanation != null && (typeof snapshot.explanation !== "string"
    || snapshot.explanation.length > 4_000)) return undefined;
  const oldSteps = previous?.steps ?? [];
  const available = new Map();
  for (const step of oldSteps) {
    const key = matchKey(step.text);
    if (!available.has(key)) available.set(key, { ids: [], cursor: 0 });
    available.get(key).ids.push(step.stepId);
  }
  const used = new Set();
  let nextId = Math.max(0, ...oldSteps.map((step) => Number(step.stepId?.match(/^step:(\d+)$/)?.[1] ?? 0))) + 1;
  const steps = [];
  for (const [ordinal, source] of snapshot.steps.entries()) {
    if (typeof source?.text !== "string" || !source.text.trim() || source.text.length > 2_000
      || !VALID_STATUSES.has(source.status)) return undefined;
    if (source.stepId != null && (typeof source.stepId !== "string"
      || !/^task:[^\s]{1,200}$/.test(source.stepId))) return undefined;
    const nativeId = typeof source.stepId === "string" && /^task:[^\s]{1,200}$/.test(source.stepId)
      ? source.stepId : null;
    const candidates = available.get(matchKey(source.text));
    // Duplicate step labels are common. Consume each old identity at most
    // once instead of rescanning an ever-growing used prefix on every update.
    if (!nativeId) {
      while (candidates && candidates.cursor < candidates.ids.length
        && used.has(candidates.ids[candidates.cursor])) candidates.cursor++;
    }
    const matched = nativeId ? null : candidates?.ids[candidates.cursor];
    if (matched && candidates) candidates.cursor++;
    const stepId = nativeId ?? matched ?? null;
    if (stepId && used.has(stepId)) return undefined;
    if (stepId) used.add(stepId);
    steps.push({ stepId, ordinal, text: source.text, status: source.status });
  }
  // Codex snapshots do not carry step IDs. A renamed step may keep its old
  // identity only when its position and the unchanged neighbours establish a
  // unique correspondence. Ambiguous edits intentionally receive fresh IDs.
  if (steps.length === oldSteps.length && steps.length > 1) {
    for (let index = 0; index < steps.length; index++) {
      if (steps[index].stepId || !oldSteps[index] || used.has(oldSteps[index].stepId)) continue;
      const leftMatches = index === 0 || steps[index - 1].stepId === oldSteps[index - 1].stepId;
      const rightMatches = index === steps.length - 1
        || steps[index + 1].stepId === oldSteps[index + 1].stepId;
      if (!leftMatches || !rightMatches) continue;
      steps[index].stepId = oldSteps[index].stepId;
      used.add(steps[index].stepId);
    }
  }
  for (const step of steps) {
    if (step.stepId) continue;
    step.stepId = `step:${nextId++}`;
  }
  const plan = {
    schemaVersion: 1,
    planId,
    revision: (previous?.revision ?? 0) + 1,
    lifecycle: "active",
    explanation: snapshot.explanation ?? null,
    steps,
    updatedAt
  };
  return sameExecutionPlanContent(previous, plan) ? null : plan;
}

export function finishExecutionPlan(previous, lifecycle, updatedAt, { incrementRevision = true } = {}) {
  if (!previous) return null;
  const steps = previous.steps.map((step) => step.status === "inProgress"
    ? { ...step, status: "unknown" } : step);
  const nextLifecycle = previous.lifecycle === "unknown" ? "unknown" : lifecycle;
  if (previous.lifecycle === nextLifecycle && steps.every((step, index) => step === previous.steps[index])) return null;
  return { ...previous, revision: previous.revision + (incrementRevision ? 1 : 0),
    lifecycle: nextLifecycle, steps, updatedAt };
}

export function uncertainExecutionPlan(previous, { planId, updatedAt }) {
  if (previous?.lifecycle === "unknown") return null;
  return {
    schemaVersion: 1,
    planId,
    revision: (previous?.revision ?? 0) + 1,
    lifecycle: "unknown",
    explanation: "Latest plan update could not be displayed; prior steps may be stale.",
    steps: previous?.steps ?? [],
    updatedAt
  };
}

export function patchExecutionPlan(previous, patch, { planId, updatedAt }) {
  if (!patch || !["upsert", "remove"].includes(patch.operation)) return undefined;
  const source = patch.step;
  if (!source || typeof source.stepId !== "string" || !/^task:[^\s]{1,200}$/.test(source.stepId)) return undefined;
  const oldSteps = previous?.steps ?? [];
  const existingIndex = oldSteps.findIndex((step) => step.stepId === source.stepId);
  const oldStep = existingIndex >= 0 ? oldSteps[existingIndex] : null;
  const text = source.text ?? oldStep?.text;
  const status = source.status ?? oldStep?.status ?? "pending";
  if (patch.operation === "upsert" && (typeof text !== "string" || !text.trim()
    || text.length > 2_000 || !VALID_STATUSES.has(status))) return undefined;
  if (patch.operation === "upsert" && existingIndex < 0 && oldSteps.length >= 200) return undefined;
  const steps = oldSteps.map((step) => ({ ...step }));
  if (patch.operation === "remove") {
    if (existingIndex < 0) return null;
    steps.splice(existingIndex, 1);
  } else if (existingIndex >= 0) {
    steps[existingIndex] = { ...steps[existingIndex], text, status };
  } else {
    steps.push({ stepId: source.stepId, ordinal: steps.length, text, status });
  }
  steps.forEach((step, ordinal) => { step.ordinal = ordinal; });
  const plan = {
    schemaVersion: 1,
    planId,
    revision: (previous?.revision ?? 0) + 1,
    lifecycle: "active",
    explanation: previous?.explanation ?? null,
    steps,
    updatedAt
  };
  return sameExecutionPlanContent(previous, plan) ? null : plan;
}

export function executionPlanItem(plan, { turnId, turnStatus, createdAt }) {
  const completed = plan.steps.filter((step) => step.status === "completed").length;
  return {
    id: plan.planId,
    turnId,
    turnStatus,
    type: "executionPlan",
    title: "Execution plan",
    text: plan.lifecycle === "unknown" ? "Plan update unavailable" : `Plan ${completed}/${plan.steps.length}`,
    status: plan.lifecycle === "active"
      ? (["completed", "failed", "cancelled"].includes(turnStatus) ? turnStatus : "running")
      : plan.lifecycle,
    createdAt,
    rawMetadataJSON: JSON.stringify({ executionPlan: plan })
  };
}

function matchKey(text) {
  return String(text ?? "").trim().replace(/\s+/g, " ");
}

export function sameExecutionPlanContent(left, right) {
  return left?.planId === right.planId
    && left?.lifecycle === right.lifecycle
    && left?.explanation === right.explanation
    && JSON.stringify(left?.steps ?? []) === JSON.stringify(right.steps);
}
