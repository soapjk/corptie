const active = new Set(["accepted", "preparing", "queued", "waiting_dispatch", "waiting_workspace", "running"]);
const fail = (code, message) => { throw Object.assign(new Error(message), { code, statusCode: 400 }); };

export function validateChecklistDependencies(steps) {
  const ids = new Set(steps.map(step => step.stepId));
  if (ids.size !== steps.length) fail("CHECKLIST_INVALID_DEPENDENCY", "Checklist item identities must be unique.");
  const graph = new Map(steps.map(step => [step.stepId, step.dependsOnStepIds ?? []]));
  if ([...graph.values()].some(value => !Array.isArray(value))) fail("CHECKLIST_INVALID_DEPENDENCY", "Checklist dependencies must be an array of item identities.");
  const visiting = new Set(), visited = new Set();
  function visit(id) {
    if (visiting.has(id)) fail("CHECKLIST_DEPENDENCY_CYCLE", "Checklist dependencies contain a cycle.");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of graph.get(id)) {
      if (!ids.has(dependency)) fail("CHECKLIST_INVALID_DEPENDENCY", "A dependency is outside this checklist.");
      visit(dependency);
    }
    visiting.delete(id); visited.add(id);
  }
  for (const id of ids) visit(id);
}

// Facts are supplied by the application from real operations/Turns. Neither
// a Task's cached status nor a model's claim of "already dispatched" is proof.
export function checklistStepCoverage(step, operations = []) {
  return operations.find(operation => active.has(operation.status)
    && operation.authorized === true && operation.superseded !== true
    && operation.stepIds?.includes(step.stepId)
    && (step.executionRevision ?? 0) === (operation.executionRevision ?? 0)) ?? null;
}

export function selectChecklistWork({ plan, runtime, operations = [], waits = [], budgetPaused = false }) {
  if (!plan || !runtime?.enabled) return { kind: "progress_only", stepIds: [] };
  const steps = plan.steps;
  if (runtime.pauseReason === "user" || runtime.state === "cancelled") return { kind: "paused_user", stepIds: [] };
  if (runtime.pauseReason === "budget" || budgetPaused) return { kind: "paused_budget", stepIds: [] };
  if (runtime.state === "needs_attention") return { kind: "needs_attention", stepIds: [], reason:runtime.reason??null };
  if (!steps.length) return { kind: "needs_attention", stepIds: [], reason: "An empty checklist does not prove the original request was completed." };
  const unfinished = steps.filter(step => step.status !== "completed");
  if (!unfinished.length) return { kind: "complete", stepIds: [] };
  const completed = new Set(steps.filter(step => step.status === "completed").map(step => step.stepId));
  const allDevelopmentDone = steps.filter(step => (step.phase ?? "implementation") === "implementation")
    .every(step => completed.has(step.stepId));
  const eligible = unfinished.filter(step => (step.dependsOnStepIds ?? []).every(id => completed.has(id))
    && (step.phase !== "verification" || allDevelopmentDone)
    && (step.phase !== 'delivery' || steps.filter(s=>s.phase!=='delivery').every(s=>completed.has(s.stepId))));
  const covered = [], waiting = [];
  for (const step of eligible) {
    const coverage = checklistStepCoverage(step, operations);
    if (coverage) { covered.push({ stepId: step.stepId, operationId: coverage.operationId }); continue; }
    const wait = waits.find(value => value.stepId === step.stepId && value.satisfied !== true);
    if (wait) { waiting.push(wait); continue; }
    return { kind: "execute", stepIds: [step.stepId] };
  }
  if (covered.length) return { kind: "covered", stepIds: covered.map(item => item.stepId), coverage: covered };
  if (waiting.length) return { kind: waiting.every(wait => wait.kind === "decision") ? "waiting_user" : "waiting_dependency",
    stepIds: waiting.map(wait => wait.stepId), waits: waiting };
  return { kind: "needs_attention", stepIds: unfinished.map(step => step.stepId), reason: "No eligible checklist item or recoverable dependency could be resolved." };
}
