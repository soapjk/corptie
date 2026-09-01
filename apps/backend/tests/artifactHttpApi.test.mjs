import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { handleArtifactHttpRequest } from "../src/application/artifactHttpApi.mjs";

test("WorkItem Artifact HTTP list preserves the scoped service projection", async () => {
  const artifact = {
    artifactId: "artifact:one", currentVersion: 1, approvedVersion: null, resourceVersion: 4,
    versions: [{ version: 1, approvalStatus: "draft" }],
    references: [{ relation: "implementation_spec", required: false, versionPolicy: "fixed",
      pinnedVersion: 1, pinnedHash: "a".repeat(64), revokedAt: null }],
    availableActions: ["read", "publish_and_repin"]
  };
  const calls = [];
  const service = {
    store: {
      getWorkItem: (id) => id === "work_item:one" ? { id, objective_id: "objective:one" } : null,
      countArtifactsReferencedByWorkItem: () => 1
    },
    listForWorkItem(context, workItemId) {
      calls.push({ context, workItemId });
      return [artifact];
    }
  };
  const result = await exchange({ method: "GET", path: "/work-items/work_item%3Aone/artifacts", service });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, { artifacts: [artifact], totalCount: 1, nextOffset: null });
  assert.equal(calls[0].workItemId, "work_item:one");
});

test("WorkItem private publish HTTP maps optimistic pin and idempotency fields", async () => {
  let received = null;
  const service = {
    store: { getWorkItem: () => ({ objective_id: "objective:one" }) },
    async publishAndRepin(context, artifactId, input) {
      received = { context, artifactId, input };
      return { artifactId, version: { version: 2 }, reference: { pinnedVersion: 2 }, operationStatus: "completed" };
    }
  };
  const input = {
    content: "v2", summary: "summary", referenceId: "artifact_reference:one",
    expectedResourceVersion: 4, expectedPinnedVersion: 1,
    expectedPinnedHash: "a".repeat(64), idempotencyKey: "publish-v2"
  };
  const result = await exchange({
    method: "POST", path: "/work-items/work_item%3Aone/artifacts/artifact%3Aone/publish",
    service, body: input
  });
  assert.equal(result.statusCode, 201);
  assert.equal(received.artifactId, "artifact:one");
  assert.equal(received.input.workItemId, "work_item:one");
  assert.equal(received.input.expectedResourceVersion, 4);
  assert.equal(received.input.expectedPinnedHash, input.expectedPinnedHash);
  assert.equal(received.input.idempotencyKey, "publish-v2");
});

test("Artifact HTTP returns a structured deadline failure instead of hanging", async () => {
  const service = {
    async backupObjective() { return new Promise(() => {}); }
  };
  const result = await exchange({
    method: "POST", path: "/objectives/objective%3Aone/artifacts/backup",
    service, body: {}, requestTimeoutMs: 10
  });
  assert.equal(result.statusCode, 503);
  assert.equal(result.body.code, "ARTIFACT_REQUEST_TIMEOUT");
});

function exchange({ method, path, service, body = null, requestTimeoutMs = 100 }) {
  return new Promise((resolve, reject) => {
    const request = new EventEmitter();
    request.method = method;
    request.destroy = () => {};
    const response = {
      writableEnded: false,
      statusCode: null,
      writeHead(statusCode) { this.statusCode = statusCode; },
      end(payload) {
        if (this.writableEnded) return;
        this.writableEnded = true;
        try {
          resolve({ statusCode: this.statusCode, body: JSON.parse(payload) });
        } catch (error) { reject(error); }
      }
    };
    const handled = handleArtifactHttpRequest({
      request, response, url: new URL(`http://127.0.0.1${path}`), service, requestTimeoutMs
    });
    if (!handled) return reject(new Error(`Route was not handled: ${path}`));
    if (body != null) queueMicrotask(() => {
      request.emit("data", Buffer.from(JSON.stringify(body)));
      request.emit("end");
    });
  });
}
