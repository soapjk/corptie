import assert from "node:assert/strict";
import test from "node:test";
import { buildWorkSessionContext } from "../src/application/workSessionContext.mjs";

function workerContext() {
  return buildWorkSessionContext({
    session: {
      id: "session:strict",
      sessionKind: "worker",
      taskId: "task:strict",
      objectiveId: "objective:quality"
    },
    task: {
      id: "task:strict",
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
}

test("Worker Session context preserves normal handling for in-scope requests", () => {
  const context = workerContext();

  assert.match(context.prompt, /authoritative Task binding/);
  assert.match(context.prompt, /Handle requests within the bound Task scope normally/);
  assert.match(context.prompt, /Strict association validation/);
  assert.match(context.prompt, /No partial writes/);
  assert.match(context.prompt, /Objective ideal state/);
  assert.match(context.prompt, /Every provider path remains neutral/);
  assert.match(context.prompt, /Switching a branch, Worktree, or Provider thread never changes this binding/);
  assert.match(context.prompt, /corptie_artifact_create/);
  assert.match(context.prompt, /scope=objective/);
  assert.match(context.prompt, /another Task are readable but immutable/);
});

test("Worker Session context continues otherwise-allowed requests outside the Task scope", () => {
  const context = workerContext();

  assert.match(context.prompt, /direct user request may extend beyond the Task title, description, or acceptance criteria/);
  assert.match(context.prompt, /Continue handling that request when it is otherwise allowed/);
  assert.match(context.prompt, /note must not replace, delay, or block the requested work/);
  assert.match(context.prompt, /Never refuse a request solely because it is outside the bound Task scope/);
  assert.doesNotMatch(context.prompt, /do not execute the unrelated task/);
});

test("Worker Session context retains safety, permission, and lifecycle constraints", () => {
  const context = workerContext();

  assert.match(context.prompt, /does not weaken or override higher-priority instructions, safety rules, authorization, permissions, confirmation requirements, or exact-target lifecycle controls/);
  assert.match(context.prompt, /refuse, pause, or request authorization only when one of those constraints requires it/);
  assert.match(context.prompt, /does not rebind this Session or authorize lifecycle operations on a different Task/);
});

test("Worker Session context includes its bound Task and Objective details", () => {
  const context = buildWorkSessionContext({
    session: {
      id: "session:strict",
      sessionKind: "worker",
      taskId: "task:strict",
      objectiveId: "objective:quality"
    },
    task: {
      id: "task:strict",
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

  assert.match(context.prompt, /Strict association validation/);
  assert.match(context.prompt, /No partial writes/);
  assert.match(context.prompt, /Objective ideal state/);
  assert.match(context.prompt, /Every provider path remains neutral/);
  assert.match(context.prompt, /Switching a branch, Worktree, or Provider thread never changes this binding/);
  assert.match(context.prompt, /corptie_artifact_create/);
  assert.match(context.prompt, /scope=task/);
  assert.match(context.prompt, /full-text search/);
});

test("Worker Session context rejects a mismatched Task", () => {
  assert.throws(
    () => buildWorkSessionContext({
      session: {
        id: "session:strict",
        sessionKind: "worker",
        taskId: "task:strict",
        objectiveId: "objective:quality"
      },
      task: {
        id: "task:other",
        objective_id: "objective:quality",
        title: "Another task"
      }
    }),
    (error) => error.code === "WORK_SESSION_BINDING_MISMATCH"
  );
});

test("non-Worker Sessions do not receive Task authority context", () => {
  assert.equal(buildWorkSessionContext({
    session: { id: "session:chat", sessionKind: "assistantChat" },
    task: null
  }), null);
});
