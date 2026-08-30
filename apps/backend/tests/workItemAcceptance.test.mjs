import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptanceCriteriaList,
  buildAcceptanceAssessment,
  completionSuggestionForWorkItem,
  parseAcceptanceAssessment,
  presentWorkItemAcceptance,
  workItemExecutionPatch,
  workItemExecutionPrompt,
  WorkItemAcceptanceError
} from "../src/application/workItemAcceptance.mjs";
import {
  callWorkItemAcceptanceDynamicTool,
  workItemAcceptanceDynamicTools
} from "../src/application/workItemAcceptanceDynamicTools.mjs";

const workItem = {
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

test("legacy empty acceptance objects are presented as absent", () => {
  assert.equal(parseAcceptanceAssessment("{}"), null);
  assert.equal(parseAcceptanceAssessment({}), null);
  assert.deepEqual(presentWorkItemAcceptance({
    id: "wi-legacy",
    acceptance_assessment_json: "{}"
  }), {
    id: "wi-legacy",
    acceptanceCriteria: "",
    acceptanceAssessment: null,
    completionSuggestion: null
  });
});

test("legacy collaboration acceptance metadata and nullable criteria are normalized at the wire boundary", () => {
  const legacyAssessment = {
    status: "passed",
    source: "collaboration",
    collaborationTaskId: "task-legacy",
    assessedAt: "2026-08-19T23:59:34.703Z"
  };
  assert.equal(parseAcceptanceAssessment(legacyAssessment), null);
  assert.deepEqual(presentWorkItemAcceptance({
    id: "wi-collaboration-legacy",
    acceptanceCriteria: null,
    acceptance_assessment_json: JSON.stringify(legacyAssessment)
  }), {
    id: "wi-collaboration-legacy",
    acceptanceCriteria: "",
    acceptanceAssessment: null,
    completionSuggestion: null
  });
});

test("worker prompt carries the WorkItem acceptance criteria", () => {
  const prompt = workItemExecutionPrompt({
    title: "Ship feature",
    description: "Implement the requested behavior",
    acceptance_criteria: "WorkItem-specific criterion"
  });
  assert.match(prompt, /验收标准：\nWorkItem-specific criterion/);
});

test("passing acceptance requires every criterion and verifiable evidence", () => {
  const assessment = buildAcceptanceAssessment(workItem, passingInput, {
    now: "2026-08-18T00:00:00.000Z"
  });
  assert.equal(assessment.status, "passed");
  const suggestion = completionSuggestionForWorkItem({
    ...workItem,
    acceptance_assessment_json: JSON.stringify(assessment)
  });
  assert.equal(suggestion?.recommended, true);
  assert.equal(suggestion.results[0].evidence[0].reference, "npm test");

  assert.throws(
    () => buildAcceptanceAssessment(workItem, {
      ...passingInput,
      results: [{ ...passingInput.results[0], evidence: [] }, passingInput.results[1]]
    }),
    (error) => error instanceof WorkItemAcceptanceError
      && error.code === "ACCEPTANCE_EVIDENCE_REQUIRED"
  );
});

test("failed, evidence-insufficient, stale, or incomplete assessments never suggest completion", () => {
  const assessment = buildAcceptanceAssessment(workItem, passingInput);
  assert.equal(completionSuggestionForWorkItem({
    ...workItem,
    acceptance_criteria: "Changed criterion",
    acceptance_assessment_json: JSON.stringify(assessment)
  }), null);

  const notProven = buildAcceptanceAssessment(workItem, {
    ...passingInput,
    results: [
      passingInput.results[0],
      { criterion: passingInput.results[1].criterion, verdict: "unknown", evidence: [] }
    ]
  });
  assert.equal(notProven.status, "not_proven");
  assert.equal(completionSuggestionForWorkItem({
    ...workItem,
    acceptance_assessment_json: JSON.stringify(notProven)
  }), null);

  const failed = buildAcceptanceAssessment(workItem, {
    ...passingInput,
    results: [
      { ...passingInput.results[0], verdict: "failed" },
      passingInput.results[1]
    ]
  });
  assert.equal(failed.status, "not_proven");
  assert.equal(completionSuggestionForWorkItem({
    ...workItem,
    acceptance_assessment_json: JSON.stringify(failed)
  }), null);

  assert.throws(
    () => buildAcceptanceAssessment(workItem, {
      ...passingInput,
      results: [passingInput.results[0]]
    }),
    (error) => error instanceof WorkItemAcceptanceError
      && error.code === "ACCEPTANCE_CRITERIA_MISMATCH"
  );
});

test("Session lifecycle states update execution only and never prove WorkItem acceptance", () => {
  const expected = new Map([
    ["complete", "completed"],
    ["paused", "paused"],
    ["idle", "idle"]
  ]);
  for (const [sessionStatus, executionStatus] of expected) {
    const patch = workItemExecutionPatch(workItem, sessionStatus);
    assert.deepEqual(patch, { executionStatus });
    assert.equal(Object.hasOwn(patch, "acceptanceAssessment"), false);
    assert.equal(Object.hasOwn(patch, "completionSuggestion"), false);
    assert.equal(Object.hasOwn(patch, "status"), false);
  }
  assert.deepEqual(workItemExecutionPatch({ ...workItem, status: "review" }, "complete"), {
    executionStatus: "completed"
  });
});

test("a paused Session can continue without creating or preserving an unsupported review", () => {
  assert.deepEqual(workItemExecutionPatch(workItem, "paused"), { executionStatus: "paused" });
  assert.deepEqual(workItemExecutionPatch(workItem, "running"), {
    executionStatus: "running"
  });
  assert.deepEqual(workItemExecutionPatch({ ...workItem, status: "review" }, "paused"), {
    executionStatus: "paused"
  });
});

test("provider-neutral WorkItem tool reports evidence as the authenticated Agent", async () => {
  assert.equal(workItemAcceptanceDynamicTools[0].name, "corptie_work_item_report_acceptance");
  assert.equal(workItemAcceptanceDynamicTools[0].inputSchema.additionalProperties, false);
  const calls = [];
  const result = await callWorkItemAcceptanceDynamicTool((actorId, input, metadata) => {
    calls.push({ actorId, input, metadata });
    return { completionSuggestion: { recommended: true } };
  }, {
    actorId: "agent-one",
    tool: "corptie_work_item_report_acceptance",
    metadata: { sessionId: "session-one", workItemId: "work-item-one" },
    arguments: { results: passingInput.results }
  });
  assert.equal(result.completionSuggestion.recommended, true);
  assert.deepEqual(calls, [{
    actorId: "agent-one",
    input: { results: passingInput.results },
    metadata: { sessionId: "session-one", workItemId: "work-item-one" }
  }]);
});

test("provider-neutral completion tool carries exact direct-user Session evidence", async () => {
  const definition = workItemAcceptanceDynamicTools.find((tool) => tool.name === "corptie_work_item_complete");
  assert.ok(definition);
  assert.equal(definition.inputSchema.additionalProperties, false);
  assert.deepEqual(new Set(definition.inputSchema.required), new Set([
    "targetWorkItemId", "objectiveId", "logicalSessionId", "userMessageEventId",
    "userMessageSequence", "turnId", "requestId", "idempotencyKey"
  ]));
  const calls = [];
  const argumentsValue = {
    targetWorkItemId: "work_item:one", objectiveId: "objective:one",
    logicalSessionId: "session:logical", userMessageEventId: "user-message:one",
    userMessageSequence: 7, turnId: "turn:one", requestId: "request:one",
    idempotencyKey: "completion:one"
  };
  const result = await callWorkItemAcceptanceDynamicTool({
    reportAcceptance() { throw new Error("wrong handler"); },
    completeWorkItem(actorId, input, metadata) {
      calls.push({ actorId, input, metadata });
      return { workItem: { id: input.targetWorkItemId, status: "done" } };
    }
  }, {
    actorId: "agent:one", tool: "corptie_work_item_complete",
    arguments: argumentsValue,
    metadata: { sessionId: "provider-session:one", logicalSessionId: "session:logical" }
  });
  assert.equal(result.workItem.status, "done");
  assert.deepEqual(calls[0], {
    actorId: "agent:one", input: argumentsValue,
    metadata: { sessionId: "provider-session:one", logicalSessionId: "session:logical" }
  });
});
