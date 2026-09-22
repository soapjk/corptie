import assert from "node:assert/strict";
import test from "node:test";
import { WorkDiscussionApplicationService } from "../src/application/workDiscussionApplicationService.mjs";

function fixture(launchOverride) {
  const works = new Map(["one", "two"].map(id => [id, { id, name: id, contributorAgentIds: ["agent"] }]));
  const sessions = new Map();
  const calls = [];
  const workService = {
    getWork(id) {
      if (!works.has(id)) throw Object.assign(new Error("Work not found"), { code: "WORK_NOT_FOUND" });
      return works.get(id);
    },
    store: {
      getAgent: id => ["agent", "outsider"].includes(id) ? { agentId: id, name: id } : null,
      getWorkChatSession: id => sessions.get(id)
    }
  };
  const service = new WorkDiscussionApplicationService({ workService, launch: async input => {
    calls.push(input);
    if (launchOverride) await launchOverride(input);
    const session = { id: `discussion:${input.work.id}`, workId: input.work.id, sessionKind: "workChat" };
    sessions.set(input.work.id, session);
    return session;
  } });
  return { service, works, sessions, calls };
}
const input = { workId: "one", agentId: "agent", providerId: "codex-app-server" };

test("concurrent clients and startup repair share one launch, without replaying opening prompts", async () => {
  const { service, calls } = fixture();
  const results = await Promise.all([
    service.open({ ...input, prompt: " first " }),
    service.open({ ...input, providerId: "claude-sdk", prompt: "do not send twice" }),
    service.ensure("one", "another-provider")
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].prompt, "first");
  assert.equal(results[0].created, true);
  assert.equal(results[1].created, false);
  assert.equal(results[0].session.id, results[2].id);
  assert.equal((await service.open(input)).created, false);
  assert.equal(service.pending.size, 0);
});

test("validation is enforced even when a discussion already exists", async () => {
  const { service, calls } = fixture();
  await service.open(input);
  for (const [change, code] of [
    [{ agentId: "outsider" }, "AGENT_OUTSIDE_WORK"],
    [{ agentId: "missing" }, "AGENT_NOT_FOUND"],
    [{ agentId: "" }, "INVALID_INPUT"],
    [{ providerId: "" }, "INVALID_INPUT"],
    [{ workId: "missing" }, "WORK_NOT_FOUND"]
  ]) await assert.rejects(service.open({ ...input, ...change }), { code });
  assert.equal(calls.length, 1);
});

test("joining callers are revalidated after asynchronous creation", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { service, works } = fixture(() => gate);
  const first = service.open(input);
  const second = service.open(input);
  await Promise.resolve();
  works.get("one").contributorAgentIds = [];
  release();
  await first;
  await assert.rejects(second, { code: "AGENT_OUTSIDE_WORK" });
  assert.equal(service.pending.size, 0);
});

test("different Works do not block each other and every Provider goes through the same launcher", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { service, calls } = fixture(input => input.work.id === "one" ? gate : undefined);
  const first = service.open(input);
  const second = await service.open({ ...input, workId: "two", providerId: "claude-sdk" });
  assert.equal(second.session.workId, "two");
  assert.deepEqual(calls.map(call => call.providerId), ["codex-app-server", "claude-sdk"]);
  release();
  await first;
});

test("failed concurrent requests never auto-relaunch and release the in-memory guard", async () => {
  const failure = Object.assign(new Error("Unavailable"), { code: "PROVIDER_UNAVAILABLE" });
  const { service, calls } = fixture(() => { throw failure; });
  const results = await Promise.allSettled([service.open(input), service.open(input), service.ensure("one", input.providerId)]);
  assert.equal(calls.length, 1);
  assert.ok(results.every(result => result.status === "rejected" && result.reason === failure));
  assert.equal(service.pending.size, 0);
});

test("startup requires a valid Contributor only if a discussion is missing", async () => {
  const { service, works, sessions, calls } = fixture();
  works.get("one").contributorAgentIds = ["deleted"];
  await assert.rejects(service.ensure("one", "any-provider"), { code: "WORK_CONTRIBUTOR_REQUIRED" });
  sessions.set("one", { id: "existing" });
  assert.equal((await service.ensure("one", "any-provider")).id, "existing");
  assert.equal(calls.length, 0);
});
