import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { projectOperationNotification, projectTaskDeletionNotification, presentJob } from "../src/application/worktreeIntegrationJobService.mjs";
import { ClientEventStream } from "../src/application/clientEventStream.mjs";

test("operation projection strips paths, logs, credentials and native diagnostics", () => {
  const job = { id: "job:one", repositoryId: "repo:one", status: "completed", phase: "completed",
    updatedAt: "2026-10-07T00:00:00.000Z", path: "/private/source", error: "secret", credentials: "secret",
    plan: { operationType: "sync", items: [{ path: "/private/source" }] },
    audit: [{ event: "done", output: "secret" }], conflictAutomation: { status: "running", prompt: "secret" } };
  const projection = projectOperationNotification(job);
  assert.equal(projection.schemaVersion, 1);
  assert.equal(projection.revision, 1);
  assert.equal(projection.plan.operationType, "sync");
  assert.deepEqual(projection.conflictAutomation, { status: "running" });
  assert.doesNotMatch(JSON.stringify(projection), /secret|private|prompt|output/);
  assert.equal(presentJob({ ...job, details: {} }).notification.revision, 1);
});

class Response extends EventEmitter {
  frames = []; destroyed = false; writableLength = 0;
  writeHead() {}
  write(value) { this.frames.push(value); return true; }
  destroy() { this.destroyed = true; this.emit("close"); }
}

test("operation stream rechecks device authorization and uses versioned frames", async () => {
  const stream = new ClientEventStream();
  const legacy = new Response();
  const response = new Response();
  let authorized = true;
  try {
    stream.attachV2(legacy, () => ({ deviceId: "device:old" }));
    stream.attachV2(response, () => { if (!authorized) throw new Error("revoked"); return { deviceId: "device:one" }; }, { operationNotifications: true });
    await new Promise(resolve => setImmediate(resolve));
    const projection = projectOperationNotification({ id: "job:one", repositoryId: "repo:one", status: "completed", phase: "completed" });
    stream.publishOperation(projection);
    assert.match(response.frames.at(-1), /event: operation-job/);
    assert.equal(legacy.frames.some(frame => frame.includes("event: operation-job")), false);
    const count = response.frames.length;
    stream.publishOperation({ schemaVersion: 99 });
    assert.equal(response.frames.length, count);
    authorized = false;
    stream.publishOperation(projection);
    assert.equal(response.destroyed, true);
    assert.equal(stream.clients.size, 1);
  } finally { stream.close(); }
});


test("Task deletion projection reports actual cleanup state rather than accepted request", () => {
  const initial = { operationId: "deletion:one", state: "queued", stage: "cleanup", attempt: 1,
    createdAt: "2026-10-07T00:00:00.000Z", input: { private: "secret" }, errorMessage: "/private/data" };
  const queued = projectTaskDeletionNotification(initial);
  const completed = projectTaskDeletionNotification({ ...initial, state: "succeeded", stage: "completed" });
  assert.equal(queued.status, "queued");
  assert.equal(completed.status, "completed");
  assert.equal(completed.plan.operationType, "task_delete");
  assert.ok(completed.revision > queued.revision);
  assert.doesNotMatch(JSON.stringify(completed), /secret|private|errorMessage/);
});
