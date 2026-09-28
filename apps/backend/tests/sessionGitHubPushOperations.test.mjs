import assert from "node:assert/strict";
import test from "node:test";
import { createSessionGitHubPushOperations } from "../src/application/sessionGitHubPushOperations.mjs";

function fixture() {
  const calls = [];
  const manager = {
    prepare: async (input) => { calls.push(["prepare", input]); return { confirmationToken: "token" }; },
    generateCommitMessage: async (input) => {
      calls.push(["generate", input]);
      return input.generateCommitMessage({ diff: "plan" });
    },
    confirm: async (input) => {
      calls.push(["confirm", input]);
      return { branch: "main", destinationUrl: "test:destination", headOid: "head", committed: true };
    }
  };
  const operations = createSessionGitHubPushOperations({
    sessionApplicationService: { referenceFor: async (id) => calls.push(["reference", id]) },
    gitHubPushes: manager,
    projectWorkingDirectoryForSession: (id) => "/project/" + id,
    generateSessionCommitMessage: async (id, plan) => { calls.push(["message", id, plan]); return "message"; },
    emitEvent: (...args) => calls.push(["event", ...args])
  });
  return { calls, manager, operations };
}

test("prepare resolves the session before constructing a scoped push plan", async () => {
  const f = fixture();
  assert.deepEqual(await f.operations.prepareGitHubPush("one"), { confirmationToken: "token" });
  assert.deepEqual(f.calls, [
    ["reference", "one"], ["prepare", { sessionId: "one", workingDirectory: "/project/one" }]
  ]);
});

test("blank confirmation tokens cannot generate or confirm a push", async () => {
  const f = fixture();
  for (const operation of [f.operations.generateGitHubPushCommitMessage, f.operations.confirmGitHubPush]) {
    await assert.rejects(operation("one", { confirmationToken: " " }), /confirmation token is required/);
  }
  assert.deepEqual(f.calls, []);
});

test("message generation binds its callback to the requesting session", async () => {
  const f = fixture();
  assert.deepEqual(await f.operations.generateGitHubPushCommitMessage("one", {
    confirmationToken: " token "
  }), { commitMessage: "message" });
  assert.equal(f.calls[0][1].confirmationToken, "token");
  assert.deepEqual(f.calls[1], ["message", "one", { diff: "plan" }]);
});

test("confirmation passes decisions through and emits completion only after success", async () => {
  const f = fixture();
  await f.operations.confirmGitHubPush("one", {
    confirmationToken: " token ", privateFilesDecision: "exclude",
    neverRemindPrivateFiles: true, commitMessage: "requested"
  });
  assert.equal(f.calls[0][1].sessionId, "one");
  assert.equal(f.calls[0][1].confirmationToken, "token");
  assert.equal(f.calls[0][1].privateFilesDecision, "exclude");
  assert.equal(f.calls[0][1].neverRemindPrivateFiles, true);
  assert.equal(f.calls[0][1].commitMessage, "requested");
  assert.equal(f.calls[1][1], "GitHubPushCompleted");
  assert.deepEqual(f.calls[1][3], { sessionId: "one" });
  f.calls.length = 0;
  f.manager.confirm = async () => { throw new Error("rejected"); };
  await assert.rejects(f.operations.confirmGitHubPush("one", { confirmationToken: "token" }), /rejected/);
  assert.deepEqual(f.calls, []);
});
