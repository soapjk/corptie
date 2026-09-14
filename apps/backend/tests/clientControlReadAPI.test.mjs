import test from "node:test";
import assert from "node:assert/strict";
import { ClientControlReadAPI } from "../src/application/clientControlReadAPI.mjs";

function fixture() {
  const rows = Array.from({ length: 203 }, (_, i) => ({ agentId: `agent:${String(i).padStart(4, "0")}`,
    name: `Agent${i}`, description: "description", agentKind: "user", updatedAt: "now",
    systemPrompt: "private prompt", workDir: "/private/path", provider: { token: "secret" } }));
  const api = new ClientControlReadAPI({ lists: {
    agents: () => rows,
    skills: () => [{ skillId: "skill:1", name: "One", source: "https://token@private", cachePath: "/private", description: "summary" }],
    automations: () => [{ taskId: "auto:1", name: "Wake", status: "active", logicalSessionId: "logical:1",
      sessionId: "session:1", message: { text: "private message" }, actions: [{ command: "private command" }] }],
    repositories: () => [{ id: "repo:1", name: "Project", availability: "available", worktreeCount: 1, path: "/private" }]
  }, repository: async id => ({ repository: { id, name: "Project", availability: "available", worktreeCount: 1 },
    project: { worktrees: [{ worktreeId: "tree:1", isMain: true, branchName: "main", availability: "available",
      state: "clean", pendingIntegration: false, path: "/private", changedFiles: ["secret"] }] },
    latestJob: { id: "job:1", status: "completed", details: { token: "private" } } }) });
  return { api, rows };
}

test("control lists keyset-page without overlap and never expose internal fields", async () => {
  const { api, rows } = fixture();
  const first = await api.list("agents");
  assert.equal(first.items.length, 50);
  assert.equal(first.hasMore, true);
  rows[0].name = "Rename does not move the cursor";
  const second = await api.list("agents", new URLSearchParams({ cursor: first.nextCursor }));
  assert.equal(second.items[0].id, "agent:0050");
  assert.equal(new Set([...first.items, ...second.items].map(row => row.id)).size, 100);
  assert.deepEqual(Object.keys(first.items[0]).sort(), ["id", "name", "description", "kind", "updatedAt"].sort());
  for (const kind of ["skills", "automations", "repositories"]) {
    assert.doesNotMatch(JSON.stringify(await api.list(kind)), /private|secret|token/);
  }
  const detail = await api.repository("repo:1");
  assert.deepEqual(detail.latestJob, { id: "job:1", status: "completed" });
  assert.equal(detail.worktrees[0].branchName, "main");
  assert.doesNotMatch(JSON.stringify(detail), /private|secret|token/);
});

test("control query boundaries and cross-resource cursors reject ambiguous requests", async () => {
  const { api } = fixture();
  for (const query of ["limit=0", "limit=101", "limit=1.5", "limit=2&limit=3", "path=anything", "cursor=not-json"]) {
    await assert.rejects(api.list("agents", new URLSearchParams(query)), error => error.status === 400);
  }
  const page = await api.list("agents");
  await assert.rejects(api.list("skills", new URLSearchParams({ cursor: page.nextCursor })), { code: "INVALID_CURSOR" });
  await assert.rejects(api.list("__proto__"), { code: "ROUTE_NOT_AVAILABLE" });
});

test("oversized descriptions fail explicitly instead of silently truncating", async () => {
  const { api, rows } = fixture();
  rows[0].description = "x".repeat(2 * 1024 * 1024);
  await assert.rejects(api.list("agents"), { code: "CONTROL_RESPONSE_TOO_LARGE" });
});

test("Git reads are single-flight with bounded parallel inspections", async () => {
  let calls = 0;
  const finish = [];
  const api = new ClientControlReadAPI({ lists: {}, repository: id => {
    calls += 1;
    return new Promise(resolve => finish.push(() => resolve({ repository: { id, name: id }, project: { worktrees: [] } })));
  } });
  const reads = [api.repository("one"), api.repository("one"), api.repository("two"), api.repository("three"), api.repository("four")];
  assert.equal(calls, 4);
  await assert.rejects(api.repository("five"), { code: "REPOSITORY_INSPECTION_BUSY" });
  for (const resolve of finish) resolve();
  const results = await Promise.all(reads);
  assert.deepEqual(results[0], results[1]);
  assert.equal(api.repositoryFlights.size, 0);
});
