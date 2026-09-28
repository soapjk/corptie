import test from "node:test";
import assert from "node:assert/strict";
import { createCollaborationHttpRoutes } from "../src/application/collaborationHttpComposition.mjs";

function responseCapture() {
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const response = {
    writeHead(status) { this.status = status; },
    end(body) { finish({ status: this.status, body: JSON.parse(body) }); }
  };
  return { response, done };
}

test("unrelated paths fall through without touching collaboration services", () => {
  const route = createCollaborationHttpRoutes({});
  assert.equal(route({ request: { method: "GET" }, response: {}, url: new URL("http://localhost/health") }), false);
});

test("context-reference route forwards the decoded Session identity", async () => {
  const calls = [];
  const route = createCollaborationHttpRoutes({
    sessionContextReferenceService: { list: (id) => { calls.push(id); return [{ id: "reference" }]; } }
  });
  const { response, done } = responseCapture();
  assert.equal(route({ request: { method: "GET" }, response,
    url: new URL("http://localhost/sessions/session%3A1/context-references") }), true);
  assert.deepEqual(await done, { status: 200, body: { references: [{ id: "reference" }] } });
  assert.deepEqual(calls, ["session:1"]);
});

test("automation route retains actor and current logical Session resolution", async () => {
  const actor = { sessionId: "actor" };
  const calls = [];
  const route = createCollaborationHttpRoutes({
    scheduledSessionHttpActor: () => actor,
    scheduledSessionHttpLogicalSessionId: (_request, actual) => {
      assert.equal(actual, actor);
      return "logical";
    },
    scheduledSessionTaskService: { list: (query, actual) => { calls.push({ query, actual }); return []; } }
  });
  const { response, done } = responseCapture();
  assert.equal(route({ request: { method: "GET" }, response,
    url: new URL("http://localhost/automations?currentSession=true") }), true);
  assert.deepEqual(await done, { status: 200, body: { tasks: [] } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].actual, actor);
  assert.equal(calls[0].query.logicalSessionId, "logical");
});
