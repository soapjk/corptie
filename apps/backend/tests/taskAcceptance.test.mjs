import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptanceCriteriaList,
  buildAcceptanceAssessment,
  completionSuggestionForTask,
  parseAcceptanceAssessment,
  presentTaskAcceptance,
  taskExecutionPatch,
  taskExecutionPrompt,
  TaskAcceptanceError
} from "../src/application/taskAcceptance.mjs";
import {
  callTaskAcceptanceDynamicTool,
  taskAcceptanceDynamicTools
} from "../src/application/taskAcceptanceDynamicTools.mjs";

const task = {
  id: "wi-1",
  status: "in_progress",
  acceptance_criteria: "- Unit tests pass\n- Development app and backend start"
};

const passingInput = {
  sourceSessionId: "session-1",
  results: [
    {
      criterion: "Unit tests pass",
      verdict: "passed",
      evidence: [{ summary: "Test suite passed", reference: "npm test" }]
    },
    {
      criterion: "Development app and backend start",
      verdict: "passed",
      evidence: [{ summary: "Both processes are healthy", reference: "scripts/dev-rebuild-restart.sh" }]
    }
  ]
};

test("acceptance criteria are canonicalized into an ordered checklist", () => {
  assert.deepEqual(
    acceptanceCriteriaList(" 1. First\n- Second\n\n* Third "),
    ["First", "Second", "Third"]
  );
});

test("invalid acceptance objects are rejected without changing the canonical Task DTO", () => {
  assert.equal(parseAcceptanceAssessment("{}"), null);
  assert.equal(parseAcceptanceAssessment({}), null);
  const presented = presentTaskAcceptance({
    id: "task:canonical",
    objective_id: "objective:1",
    title: "Canonical Task",
    description: "Description",
    goal: "Goal",
    acceptance_criteria: "Acceptance",
    verification_criteria: "Verification",
    priority: 3,
    lifecycle_state: "in_progress",
    main_workspace_id: "workspace:1",
    main_agent_id: "agent:1",
    current_session_id: "session:1",
    execution_status: "running",
    acceptance_assessment_json: "{}",
    current_snapshot_id: "snapshot:1",
    revision: 2,
    resource_version: 4,
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T01:00:00.000Z"
  });
  assert.deepEqual(presented, {
    id: "task:canonical",
    objectiveId: "objective:1",
    title: "Canonical Task",
    description: "Description",
    goal: "Goal",
    acceptanceCriteria: "Acceptance",
    verificationCriteria: "Verification",
    priority: 3,
    lifecycleState: "in_progress",
    mainWorkspaceId: "workspace:1",
    mainAgentId: "agent:1",
    currentSessionId: "session:1",
    executionStatus: "running",
    acceptanceAssessment: null,
    completionSuggestion: null,
    currentSnapshotId: "snapshot:1",
    revision: 2,
    resourceVersion: 4,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T01:00:00.000Z"
  });
  assert.equal(Object.hasOwn(presented, "status"), false);
  assert.equal(Object.hasOwn(presented, "objective_id"), false);
});

test("worker prompt carries the Task acceptance criteria", () => {
  const prompt = taskExecutionPrompt({
    title: "Ship feature",
    description: "Implement the requested behavior",
    acceptance_criteria: "Task-specific criterion"
  });
  assert.match(prompt, /验收标准：\nTask-specific criterion/);
});

test("passing acceptance requires every criterion and verifiable evidence", () => {
  const assessment = buildAcceptanceAssessment(task, passingInput, {
    now: "2026-08-18T00:00:00.000Z"
  });
  assert.equal(assessment.status, "passed");
  const suggestion = completionSuggestionForTask({
    ...task,
    acceptance_assessment_json: JSON.stringify(assessment)
  });
  assert.equal(suggestion?.recommended, true);
  assert.equal(suggestion.results[0].evidence[0].reference, "npm test");

  assert.throws(
    () => buildAcceptanceAssessment(task, {
      ...passingInput,
      results: [{ ...passingInput.results[0], evidence: [] }, passingInput.results[1]]
    }),
    (error) => error instanceof TaskAcceptanceError
      && error.code === "ACCEPTANCE_EVIDENCE_REQUIRED"
  );
});

test("failed, evidence-insufficient, stale, or incomplete assessments never suggest completion", () => {
  const assessment = buildAcceptanceAssessment(task, passingInput);
  assert.equal(completionSuggestionForTask({
    ...task,
    acceptance_criteria: "Changed criterion",
    acceptance_assessment_json: JSON.stringify(assessment)
  }), null);

  const notProven = buildAcceptanceAssessment(task, {
    ...passingInput,
    results: [
      passingInput.results[0],
      { criterion: passingInput.results[1].criterion, verdict: "unknown", evidence: [] }
    ]
  });
  assert.equal(notProven.status, "not_proven");
  assert.equal(completionSuggestionForTask({
    ...task,
    acceptance_assessment_json: JSON.stringify(notProven)
  }), null);

  const failed = buildAcceptanceAssessment(task, {
    ...passingInput,
    results: [
      { ...passingInput.results[0], verdict: "failed" },
      passingInput.results[1]
    ]
  });
  assert.equal(failed.status, "not_proven");
  assert.equal(completionSuggestionForTask({
    ...task,
    acceptance_assessment_json: JSON.stringify(failed)
  }), null);

  assert.throws(
    () => buildAcceptanceAssessment(task, {
      ...passingInput,
      results: [passingInput.results[0]]
    }),
    (error) => error instanceof TaskAcceptanceError
      && error.code === "ACCEPTANCE_CRITERIA_MISMATCH"
  );
});

test("Session lifecycle states update execution only and never prove Task acceptance", () => {
  const expected = new Map([
    ["complete", "completed"],
    ["paused", "paused"],
    ["idle", "idle"]
  ]);
  for (const [sessionStatus, executionStatus] of expected) {
    const patch = taskExecutionPatch(task, sessionStatus);
    assert.deepEqual(patch, { executionStatus });
    assert.equal(Object.hasOwn(patch, "acceptanceAssessment"), false);
    assert.equal(Object.hasOwn(patch, "completionSuggestion"), false);
    assert.equal(Object.hasOwn(patch, "status"), false);
  }
  assert.deepEqual(taskExecutionPatch({ ...task, status: "review" }, "complete"), {
    executionStatus: "completed"
  });
});

test("a paused Session can continue without creating or preserving an unsupported review", () => {
  assert.deepEqual(taskExecutionPatch(task, "paused"), { executionStatus: "paused" });
  assert.deepEqual(taskExecutionPatch(task, "running"), {
    executionStatus: "running"
  });
  assert.deepEqual(taskExecutionPatch({ ...task, status: "review" }, "paused"), {
    executionStatus: "paused"
  });
});

test("provider-neutral Task tool reports evidence as the authenticated Agent", async () => {
  assert.equal(taskAcceptanceDynamicTools[0].name, "corptie_task_report_acceptance");
  assert.equal(taskAcceptanceDynamicTools[0].inputSchema.additionalProperties, false);
  const calls = [];
  const result = await callTaskAcceptanceDynamicTool((actorId, input, metadata) => {
    calls.push({ actorId, input, metadata });
    return { completionSuggestion: { recommended: true } };
  }, {
    actorId: "agent-one",
    tool: "corptie_task_report_acceptance",
    metadata: { sessionId: "session-one", taskId: "task-one" },
    arguments: { results: passingInput.results }
  });
  assert.equal(result.completionSuggestion.recommended, true);
  assert.deepEqual(calls, [{
    actorId: "agent-one",
    input: { results: passingInput.results },
    metadata: { sessionId: "session-one", taskId: "task-one" }
  }]);
});

test("provider-neutral completion tool carries exact direct-user Session evidence", async () => {
  const definition = taskAcceptanceDynamicTools.find((tool) => tool.name === "corptie_task_complete");
  assert.ok(definition);
  assert.equal(definition.inputSchema.additionalProperties, false);
  assert.deepEqual(new Set(definition.inputSchema.required), new Set([
    "targetTaskId", "objectiveId", "logicalSessionId", "userMessageEventId",
    "userMessageSequence", "turnId", "requestId", "idempotencyKey"
  ]));
  const calls = [];
  const argumentsValue = {
    targetTaskId: "task:one", objectiveId: "objective:one",
    logicalSessionId: "session:logical", userMessageEventId: "user-message:one",
    userMessageSequence: 7, turnId: "turn:one", requestId: "request:one",
    idempotencyKey: "completion:one"
  };
  const result = await callTaskAcceptanceDynamicTool({
    reportAcceptance() { throw new Error("wrong handler"); },
    completeTask(actorId, input, metadata) {
      calls.push({ actorId, input, metadata });
      return { task: { id: input.targetTaskId, status: "done" } };
    }
  }, {
    actorId: "agent:one", tool: "corptie_task_complete",
    arguments: argumentsValue,
    metadata: { sessionId: "provider-session:one", logicalSessionId: "session:logical" }
  });
  assert.equal(result.task.status, "done");
  assert.deepEqual(calls[0], {
    actorId: "agent:one", input: argumentsValue,
    metadata: { sessionId: "provider-session:one", logicalSessionId: "session:logical" }
  });
});

test("provider-neutral revision tool carries only the new problem definition", async () => {
  const definition = taskAcceptanceDynamicTools.find((tool) => tool.name === "corptie_task_revise");
  assert.ok(definition);
  assert.deepEqual(new Set(definition.inputSchema.required), new Set(["expectedRevision", "next"]));
  assert.equal(definition.inputSchema.additionalProperties, false);
  const calls = [];
  const argumentsValue = {
    expectedRevision: 3,
    next: { title: "Next problem", goal: "Next goal" },
    executionSummary: "Previous problem completed."
  };
  const result = await callTaskAcceptanceDynamicTool({
    reviseTask(actorId, input, metadata) {
      calls.push({ actorId, input, metadata });
      return { task: { id: "task:one", revision: 4 }, snapshot: { version: 3 } };
    }
  }, {
    actorId: "agent:one",
    tool: "corptie_task_revise",
    arguments: argumentsValue,
    metadata: { sessionId: "provider-session:one", taskId: "task:one" }
  });
  assert.equal(result.task.revision, 4);
  assert.deepEqual(calls, [{
    actorId: "agent:one",
    input: argumentsValue,
    metadata: { sessionId: "provider-session:one", taskId: "task:one" }
  }]);
});
