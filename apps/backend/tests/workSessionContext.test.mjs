import assert from "node:assert/strict";
import test from "node:test";
import { buildWorkSessionContext } from "../src/application/workSessionContext.mjs";

test("Worker Session context makes its bound WorkItem authoritative", () => {
  const context = buildWorkSessionContext({
    session: {
      id: "session:strict",
      sessionKind: "worker",
      workItemId: "work-item:strict",
      objectiveId: "objective:quality"
    },
    workItem: {
      id: "work-item:strict",
      objective_id: "objective:quality",
      title: "Strict association validation",
      description: "Reject invalid bindings.",
      acceptance_criteria: "No partial writes."
    },
    objective: {
      id: "objective:quality",
      name: "Improve reliability",
      idealState: "Every provider path remains neutral as the system evolves."
    }
  });

  assert.match(context.prompt, /authoritative task identity/);
  assert.match(context.prompt, /Strict association validation/);
  assert.match(context.prompt, /No partial writes/);
  assert.match(context.prompt, /Objective ideal state/);
  assert.match(context.prompt, /Every provider path remains neutral/);
  assert.match(context.prompt, /Switching a branch, Worktree, or Provider thread never changes this binding/);
  assert.match(context.prompt, /corptie_artifact_create/);
  assert.match(context.prompt, /forces work_item_private visibility/);
  assert.match(context.prompt, /relation=acceptance_evidence, required=false, version_policy=fixed/);
});

test("Worker Session context rejects a mismatched WorkItem", () => {
  assert.throws(
    () => buildWorkSessionContext({
      session: {
        id: "session:strict",
        sessionKind: "worker",
        workItemId: "work-item:strict",
        objectiveId: "objective:quality"
      },
      workItem: {
        id: "work-item:other",
        objective_id: "objective:quality",
        title: "Another task"
      }
    }),
    (error) => error.code === "WORK_SESSION_BINDING_MISMATCH"
  );
});

test("non-Worker Sessions do not receive WorkItem authority context", () => {
  assert.equal(buildWorkSessionContext({
    session: { id: "session:chat", sessionKind: "assistantChat" },
    workItem: null
  }), null);
});
