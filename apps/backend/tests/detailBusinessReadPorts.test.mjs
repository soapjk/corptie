import test from "node:test";
import assert from "node:assert/strict";
import { createDetailBusinessReadPorts } from "../src/application/detailBusinessReadPorts.mjs";
import { DetailBusinessReadCache } from "../src/application/detailBusinessReadCache.mjs";

const scope = { session: { id: "legacy", sessionKind: "worker" }, logicalSessionId: "logical:sample",
  task: { id: "task" }, work: { id: "work" } };
const identity = { sessionId: "logical:sample", serverId: "server", principalId: "device:a", accountId: "account", deviceId: "a", catalogProfile: "business-read-v1" };
test("references and Artifact metadata never expose paths/URLs/content; fixed pending reference survives", async () => {
  const hash = "a".repeat(64), pendingHash = "b".repeat(64);
  const ports = createDetailBusinessReadPorts({ store: { countArtifactsReferencedByTask: () => 1 },
    references: { list: () => [{ referenceId: "ref", targetType: "webURL", locator: "https://evil.invalid", displayName: "https://evil.invalid", metadata: "secret" }] },
    artifacts: { listForTask: () => [{ artifactId: "artifact", title: "Title", storageKey: "/private", content: "secret",
      currentVersion: 8, versions: [{ version: 8, contentHash: pendingHash, storageKey: "/private" }],
      references: [{ referenceId: "fixed", taskId: "task", versionPolicy: "fixed", pinnedVersion: 2, pinnedHash: hash,
        pendingVersion: 8, pendingHash, required: true, resourceVersion: 3, authorizedByActorId: "secret" }],
      audit: [{ auditId: "audit", action: "reference.created", metadata: "secret", storageKey: "/private" }] }] } });
  const references = await ports.references.read(scope, identity), artifacts = await ports.artifacts.read(scope, identity);
  assert.doesNotMatch(JSON.stringify({ references, artifacts }), /private|evil|secret|locator|storageKey/);
  assert.equal(artifacts.items[0].version, 2);
  assert.equal(artifacts.items[0].contentHash, hash);
  assert.equal(artifacts.items[0].references[0].pendingVersion, 8);
  assert.equal(artifacts.items[0].references[0].required, true);
  assert.equal(artifacts.items[0].readAvailable, true);
});
test("focus task navigation only targets its exact non-archived associated Session", () => {
  const tasks = [{ id: "a", title: "A", current_session_id: "session-a" }, { id: "b", title: "B", current_session_id: "session-b" }];
  const ports = createDetailBusinessReadPorts({ store: { listTasksByWork: () => tasks,
    getSession: value => ({ id: value, taskId: "a" }),
    getLogicalSessionByLegacySessionId: value => ({ logicalSessionId: `logical:${value}`, legacySessionId: value }) } });
  const result = ports.focusTasks.read({ ...scope, task: null, session: { ...scope.session, sessionKind: "workChat" } });
  assert.deepEqual(result.items[0].sessionTarget, { resourceType: "session", id: "logical:session-a" });
  assert.equal(result.items[1].sessionTarget, null);
});
test("bounded reads preserve ISO timezone, use paired user authorization and perform no implicit Git/URL reads", () => {
  let actor;
  const ports = createDetailBusinessReadPorts({ schedules: { list: (_, value) => { actor = value;
    return Array.from({ length: 25 }, (_, i) => ({ taskId: `schedule:${i}`, nextRunAt: "2026-10-11T12:00:00+08:00", timezone: "Asia/Shanghai", message: "secret" })); } } });
  const result = ports.schedules.read(scope, identity);
  assert.equal(result.items.length, 20); assert.equal(result.hasMore, true);
  assert.equal(result.items[0].nextRunAt, "2026-10-11T12:00:00+08:00");
  assert.equal(actor.id, "user:paired-device:a");
  assert.doesNotMatch(JSON.stringify(result), /secret/);
});
test("Worktree projection removes paths/files and arbitrary job plans", async () => {
  const ports = createDetailBusinessReadPorts({ readWorktree: async () => ({ attached: true, repositoryId: "repo",
    worktree: { worktreeId: "tree", path: "/private", changedFiles: ["/private/secret"], branchName: "branch", changedFileCount: 1 },
    job: { id: "job", status: "running", plan: { secret: true } } }) });
  const result = await ports.worktree.read(scope);
  assert.doesNotMatch(JSON.stringify(result), /private|secret|plan|changedFiles/);
  assert.deepEqual(result.workspace, { resourceType: "worktree", id: "tree" });
});
test("empty and permission/error states are distinct; exception messages do not leak", async () => {
  const cache = new DetailBusinessReadCache({ empty: { dependencies: ["memory"], read: () => ({ items: [] }) },
    denied: { dependencies: ["artifact"], read: () => { throw Object.assign(new Error("/private/secret"), { status: 403 }); } } });
  assert.equal((await cache.read(scope, "empty", identity)).state, "empty");
  assert.deepEqual(await cache.read(scope, "denied", identity), { state: "error", code: "DETAIL_MODULE_ACCESS_DENIED" });
});
test("singleflight reads retain unaffected cached modules and invalidation rejects late results", async () => {
  let calls = 0, finish;
  const cache = new DetailBusinessReadCache({ memories: { dependencies: ["memory"], read: async () => {
    calls++; return await new Promise(resolve => { finish = resolve; }); } } });
  const a = cache.read(scope, "memories", identity), b = cache.read(scope, "memories", identity);
  await Promise.resolve(); finish({ items: [{ id: "memory" }] });
  assert.deepEqual(await a, await b); assert.equal(calls, 1);
  cache.invalidate({ resourceType: "task", taskId: "different-task" });
  await cache.read(scope, "memories", identity, { force: false }); assert.equal(calls, 1);
  const late = cache.read(scope, "memories", identity);
  await Promise.resolve(); cache.clear({ principalId: identity.principalId }); finish({ items: [{ id: "late" }] });
  await assert.rejects(late, { code: "DETAIL_READ_INVALIDATED" }); assert.equal(cache.scopes.size, 0);
});
test("scope and byte bounds evict cached pages without preserving raw source rows", async () => {
  const cache = new DetailBusinessReadCache({ test: { dependencies: ["reference"], read: () => ({ items: [{ label: "x".repeat(100) }] }) } },
    { maxScopes: 2, maxBytes: 400 });
  for (const principalId of ["a", "b", "c"]) await cache.read(scope, "test", { ...identity, principalId });
  assert.ok(cache.scopes.size <= 2); assert.ok(cache.bytes <= 400);
});
