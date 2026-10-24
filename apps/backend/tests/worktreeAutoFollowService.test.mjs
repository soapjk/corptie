import test from "node:test";
import assert from "node:assert/strict";
import { WorktreeAutoFollowService, assertNoAutomaticWorktreeMutation } from "../src/application/worktreeAutoFollowService.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { ClientInspectorAPI } from "../src/application/clientInspectorAPI.mjs";
import { handleSessionGitHttpRequest } from "../src/application/sessionGitHttpApi.mjs";
import { GitWorkspaceManager } from "../src/runtime/gitWorkspaceManager.mjs";

test("hierarchical integration reserves only its closure and permits the exact parent acceptance Session while waiting", () => {
  let workspace = "child";
  const job = { status: "running", phase: "merging", details: { plan: { orchestration: { version: 1 }, reservedWorktreeIds: ["parent", "child", "main"] },
    graphExecution: { index: 0, steps: [{ kind: "acceptance", rootTaskId: "task:parent", targetWorktreeId: "parent" }] } } };
  const store = { getLogicalSessionByLegacySessionId: () => ({ repositoryId: "repo", activeWorkspaceId: workspace, taskId: "task:parent" }), getLatestWorktreeIntegrationJob: () => job };
  assert.throws(() => assertNoAutomaticWorktreeMutation(store, { sessionId: "session" }), { code: "SESSION_BUSY" });
  workspace = "unrelated";
  assert.doesNotThrow(() => assertNoAutomaticWorktreeMutation(store, { sessionId: "session" }));
  workspace = "parent";
  assert.throws(() => assertNoAutomaticWorktreeMutation(store, { sessionId: "session" }), { code: "SESSION_BUSY" });
  job.status = "paused"; job.phase = "awaiting_integration_acceptance";
  assert.doesNotThrow(() => assertNoAutomaticWorktreeMutation(store, { sessionId: "session" }));
  workspace = "child";
  assert.throws(() => assertNoAutomaticWorktreeMutation(store, { sessionId: "session" }), { code: "SESSION_BUSY" });
});

function fixture() {
  let persisted = null, reads = 0, heads = 0, count = 0;
  const logical = { logicalSessionId: "logical", legacySessionId: "session", repositoryId: "repo", activeWorkspaceId: "tree", activeBinding: { boundCwd: "/tree" } };
  const session = { id: "session", status: "completed", archived: false };
  const source = { worktreeId: "tree", branchName: "feature", path: "/tree", isMain: false,
    dirty: false, availability: "available", behindMain: 2 };
  const main = { worktreeId: "main", branchName: "develop", path: "/main", isMain: true, dirty: false };
  const detail = { attached: true, repositoryId: "repo", mainWorktreeId: "main", mainBranch: "develop", blockedReason: null, worktree: source };
  const jobs = new Map(), calls = [], events = [];
  const store = { getRuntimeState: () => structuredClone(persisted), setRuntimeState: (_key, value) => { persisted = structuredClone(value); },
    getLogicalSessionByLegacySessionId: () => logical, getLogicalSession: () => logical,
    getSession: () => session, getTask: () => null, getGitWorktree: id => id === "main" ? main : source,
    listWorktreeIntegrationJobs: () => [...jobs.values()] };
  const jobService = {
    preflight: async (repo, options) => {
      calls.push(["preflight", repo, options]);
      const job = { id: `job-${++count}`, repositoryId: repo, status: "awaiting_confirmation", planFingerprint: "proof",
        automaticFollow: options.automaticFollow, details: { automaticFollow: options.automaticFollow },
        plan: { operationType: "sync", targetWorktreeId: "main", blockingRisks: [], items: [source, main].map(row => ({ ...row, commitStatus: "not_needed" })) } };
      jobs.set(job.id, job); return job;
    },
    confirm: async (id, input) => { calls.push(["confirm", id, input]); const job = jobs.get(id); job.status = "queued"; return job; },
    get: id => jobs.get(id), cancel: async id => { calls.push(["cancel", id]); jobs.get(id).status = "canceled"; }
  };
  const options = { store, readDetail: async () => { reads++; return structuredClone(detail); }, jobs: jobService,
    readHead: async path => { heads++; return path === "/main" ? "main-head" : "source-head"; }, onEvent: (...event) => events.push(event) };
  const service = new WorktreeAutoFollowService(options);
  const enable = () => service.set("session", { enabled: true, expectedWorktreeId: "tree" });
  return { service, enable, options, store, logical, session, source, main, detail, jobs, jobService, calls, events,
    reads: () => reads, heads: () => heads };
}

test("default off performs no Git work and a persisted opt-in survives service recreation", async () => {
  const f = fixture();
  assert.equal(f.service.state("tree").enabled, false);
  await f.service.tick(); assert.equal(f.reads(), 0); assert.equal(f.heads(), 0);
  await f.enable();
  const restored = new WorktreeAutoFollowService(f.options);
  assert.equal(restored.state("tree").enabled, true);
  await restored.tick();
  assert.deepEqual(f.calls[0], ["preflight", "repo", { operationType: "one_way_sync", sourceWorktreeIds: ["tree"], targetWorktreeId: "main",
    automaticFollow: { worktreeId: "tree", revision: 1 } }]);
  assert.equal(f.calls[1][2].confirmed, true);
  assert.equal(f.calls[1][2].planFingerprint, "proof");
  assert.deepEqual(f.calls[1][2].commitProtectionDecisions, []);
  assert.equal(restored.state("tree").status, "running");
});

test("all Providers share a dispatch barrier only for the affected automatic Git job", () => {
  const job = { status: "running", details: { automaticFollow: { revision: 1 }, plan: { items: [{ worktreeId: "tree" }, { worktreeId: "main" }] } } };
  const logical = { repositoryId: "repo", activeWorkspaceId: "tree" };
  const store = { getLogicalSession: () => logical, getLatestWorktreeIntegrationJob: () => job };
  for (const providerId of ["codex-app-server", "claude-code", "future-provider"]) {
    assert.throws(() => assertNoAutomaticWorktreeMutation(store, { logicalSessionId: "logical", providerId }), { code: "SESSION_BUSY" });
  }
  logical.activeWorkspaceId = "unrelated";
  assert.doesNotThrow(() => assertNoAutomaticWorktreeMutation(store, { logicalSessionId: "logical" }));
  logical.activeWorkspaceId = "tree"; job.status = "paused";
  assert.doesNotThrow(() => assertNoAutomaticWorktreeMutation(store, { logicalSessionId: "logical" }));
  job.status = "completed";
  assert.doesNotThrow(() => assertNoAutomaticWorktreeMutation(store, { logicalSessionId: "logical" }));
});

test("manual batch sync blocks queued Session work only in unfinished source Worktrees", () => {
  const job = { status: "running", details: { plan: { operationType: "sync", items: [
    { worktreeId: "source", mergeStatus: "running", isMain: false },
    { worktreeId: "finished", mergeStatus: "completed", isMain: false },
    { worktreeId: "target", isMain: true }
  ] } } };
  const logical = { repositoryId: "repo", activeWorkspaceId: "source" };
  const store = { getLogicalSession: () => logical, getLatestWorktreeIntegrationJob: () => job };
  assert.throws(() => assertNoAutomaticWorktreeMutation(store, { logicalSessionId: "logical" }), { code: "SESSION_BUSY" });
  for (const id of ["target", "finished", "unrelated"]) {
    logical.activeWorkspaceId = id;
    assert.doesNotThrow(() => assertNoAutomaticWorktreeMutation(store, { logicalSessionId: "logical" }));
  }
});

test("SQLite persists opt-in through Store close and reopen", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "corptie-auto-follow-store-"));
  let store;
  try {
    const open = async () => {
      const next = new CorptieStore({ dbPath: join(dir, "db.sqlite"), configPath: join(dir, "config.json"), manageProcessEnvironment: false });
      await next.initialize({ resolveDataPath: false }); return next;
    };
    store = await open();
    const f = fixture(); f.options.store = { ...f.store,
      getRuntimeState: key => store.getRuntimeState(key), setRuntimeState: (key, value) => store.setRuntimeState(key, value) };
    const first = new WorktreeAutoFollowService(f.options);
    await first.set("session", { enabled: true, expectedWorktreeId: "tree" });
    store.close(); store = await open();
    assert.equal(new WorktreeAutoFollowService(f.options).state("tree").enabled, true);
  } finally { store?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("busy, dirty, conflict and locked Worktrees wait then resume only when safe", async () => {
  for (const reason of ["SESSION_BUSY", "UNCOMMITTED_CHANGES", "GIT_OPERATION_IN_PROGRESS", "WORKTREE_LOCKED", "DETACHED_HEAD", "WORKTREE_UNAVAILABLE"]) {
    const f = fixture(); await f.enable(); f.detail.blockedReason = reason;
    await f.service.tick(); assert.equal(f.calls.length, 0); assert.equal(f.service.state("tree").reason, reason);
    f.detail.blockedReason = null; await f.service.tick(); assert.equal(f.calls.filter(call => call[0] === "confirm").length, 1);
  }
});

test("an aligned branch avoids full Git inspections until its tips change", async () => {
  const f = fixture(); f.source.behindMain = 0; await f.enable(); await f.service.tick();
  const reads = f.reads();
  await f.service.tick(); assert.equal(f.reads(), reads); assert.equal(f.calls.length, 0);
  assert.equal(f.service.state("tree").status, "aligned");
  f.service.readHead = async () => "new-main-head"; f.source.behindMain = 1;
  await f.service.tick(); assert.equal(f.calls[0][0], "preflight");
});

test("replacement binding, target branch changes and archived Sessions do not inherit authorization", async () => {
  for (const change of [f => f.logical.activeWorkspaceId = "replacement", f => f.main.branchName = "other",
    f => f.session.archived = true, f => f.logical.repositoryId = "other"]) {
    const f = fixture(); await f.enable(); change(f); await f.service.tick();
    assert.equal(f.calls.length, 0); assert.equal(f.service.state("tree").status, "paused");
  }
  const f = fixture();
  await assert.rejects(f.service.set("session", { enabled: true, expectedWorktreeId: "other" }), { code: "WORKTREE_STATE_CHANGED" });
  await assert.rejects(f.service.set("session", { enabled: "true", expectedWorktreeId: "tree" }), { code: "INVALID_AUTO_FOLLOW" });
});

test("a conflict pauses indefinitely, never generates automatic recovery or duplicate jobs", async () => {
  const f = fixture(); await f.enable(); await f.service.tick();
  const id = f.service.state("tree").jobId; f.jobs.get(id).status = "paused";
  const restored = new WorktreeAutoFollowService(f.options);
  for (let i = 0; i < 3; i++) await restored.tick();
  assert.equal(f.calls.length, 2); assert.equal(restored.state("tree").status, "paused");
  f.jobs.get(id).status = "completed"; f.source.behindMain = 0;
  await restored.tick(); assert.equal(restored.state("tree").status, "aligned");
});

test("turning off during preflight cancels the draft without confirm or rebase", async () => {
  const f = fixture(); await f.enable();
  const original = f.jobService.preflight;
  f.jobService.preflight = async (...args) => {
    const job = await original(...args);
    await f.service.set("session", { enabled: false, expectedWorktreeId: "tree" }); return job;
  };
  await f.service.tick();
  assert.deepEqual(f.calls.map(call => call[0]), ["preflight", "cancel"]);
  const heads = f.heads(); await f.service.tick(); assert.equal(f.heads(), heads);
});

test("unsafe plans and changes before confirmation cancel without auto-committing", async () => {
  for (const change of [job => job.plan.items[0].dirty = true, job => job.plan.items[0].commitStatus = "pending",
    job => job.plan.blockingRisks.push({ code: "CONFLICT" })]) {
    const f = fixture(); await f.enable(); const original = f.jobService.preflight;
    f.jobService.preflight = async (...args) => { const job = await original(...args); change(job); return job; };
    await f.service.tick(); assert.deepEqual(f.calls.map(call => call[0]), ["preflight", "cancel"]);
  }
  const f = fixture(); await f.enable(); const original = f.jobService.preflight;
  f.jobService.preflight = async (...args) => { const job = await original(...args); f.detail.blockedReason = "SESSION_BUSY"; return job; };
  await f.service.tick(); assert.deepEqual(f.calls.map(call => call[0]), ["preflight", "cancel"]);
});

test("repository-wide jobs exclude automatic rebase and concurrent checks coalesce", async () => {
  const f = fixture(); await f.enable(); f.jobs.set("manual", { status: "running" });
  await Promise.all([f.service.tick(), f.service.tick()]);
  assert.equal(f.calls.length, 0); assert.equal(f.heads(), 2);
});

test("restart discards only its own unconfirmed auto draft and creates a fresh safe plan", async () => {
  for (const recorded of [true, false]) {
    const f = fixture(); await f.enable();
    const draft = await f.jobService.preflight("repo", { automaticFollow: { worktreeId: "tree", revision: 1 } });
    if (recorded) f.service.save("tree", { jobId: draft.id });
    const restored = new WorktreeAutoFollowService(f.options);
    await restored.tick();
    assert.equal(f.jobs.get(draft.id).status, "canceled");
    assert.deepEqual(f.calls.map(call => call[0]), ["preflight", "cancel", "preflight", "confirm"]);
    assert.equal(restored.state("tree").status, "running");
  }
});

test("shutdown during preflight leaves no confirmed automatic Git job", async () => {
  const f = fixture(); await f.enable(); const original = f.jobService.preflight;
  f.jobService.preflight = async (...args) => { const draft = await original(...args); f.service.stop(); return draft; };
  await f.service.tick();
  assert.deepEqual(f.calls.map(call => call[0]), ["preflight", "cancel"]);
});

test("desktop and paired commands use the same exact-bound setting service", async () => {
  const calls = [];
  const set = async (...args) => { calls.push(args); return { enabled: true, status: "waiting" }; };
  const scope = { sessionId: "session" };
  const api = new ClientInspectorAPI({ setWorktreeAutoFollow: set });
  const body = { enabled: true, expectedWorktreeId: "tree" };
  await api.perform(scope, "worktree.autoFollow", body);
  await new Promise((resolve, reject) => {
    assert.equal(handleSessionGitHttpRequest({ request: { method: "POST" }, response: {},
      url: new URL("http://localhost/sessions/session/worktree-auto-follow"), readJson: async () => body,
      setWorktreeAutoFollow: set, sendJson: (_res, code) => code === 200 ? resolve() : reject(new Error(String(code))), errorStatus: () => 400 }), true);
  });
  assert.deepEqual(calls, [["session", body], ["session", body]]);
});

test("persisted authorization covers one exact sync, not merge, another tree or a stale grant", async () => {
  const f = fixture(); await f.enable();
  const entry = f.service.entries().tree;
  const draft = await f.jobService.preflight("repo", {});
  const job = { repositoryId: "repo", details: { plan: draft.plan, automaticFollow: { worktreeId: "tree", revision: entry.revision } } };
  assert.equal(f.service.authorizes(job), true);
  job.details.plan.operationType = "merge"; assert.equal(f.service.authorizes(job), false);
  job.details.plan.operationType = "sync"; f.logical.activeWorkspaceId = "another";
  assert.equal(f.service.authorizes(job), false); f.logical.activeWorkspaceId = "tree";
  await f.service.set("session", { enabled: false, expectedWorktreeId: "tree" });
  assert.equal(f.service.authorizes(job), false);
});

for (const conflict of [false, true]) {
  test(`automatic follow runs real local Git rebase (${conflict ? "conflict preserved" : "clean diverged branches"})`, async () => {
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);
    const dir = await mkdtemp(join(tmpdir(), "corptie-auto-follow-git-"));
    const main = join(dir, "main"), source = join(dir, "feature");
    const git = async (cwd, ...args) => (await exec("git", ["-C", cwd, ...args])).stdout.trim();
    try {
      await exec("git", ["init", "-b", "develop", main]);
      await git(main, "config", "user.name", "Test"); await git(main, "config", "user.email", "test@example.invalid");
      await writeFile(join(main, "shared.txt"), "base\n");
      await git(main, "add", "."); await git(main, "commit", "-m", "base");
      await git(main, "worktree", "add", "-b", "feature", source);
      await writeFile(join(source, conflict ? "shared.txt" : "feature.txt"), "feature\n");
      await git(source, "add", "."); await git(source, "commit", "-m", "feature");
      await writeFile(join(main, conflict ? "shared.txt" : "main.txt"), "main\n");
      await git(main, "add", "."); await git(main, "commit", "-m", "main");
      const mainHead = await git(main, "rev-parse", "HEAD");
      const f = fixture(); f.source.path = source; f.main.path = main; f.logical.activeBinding.boundCwd = source;
      f.service.readHead = path => git(path, "rev-parse", "HEAD");
      const original = f.jobService.confirm;
      const manager = new GitWorkspaceManager({ store: {} });
      f.jobService.confirm = async (id, input) => {
        const job = await original(id, input);
        try {
          await manager.rebaseIntegrationSource({ path: source, targetHead: mainHead,
            expectedSourceHead: await git(source, "rev-parse", "HEAD"), jobId: id });
          job.status = "completed"; f.source.behindMain = 0;
        } catch (error) { assert.equal(error.code, "REBASE_CONFLICT"); job.status = "paused"; }
        return job;
      };
      await f.enable(); await f.service.tick(); await f.service.tick();
      assert.equal(await git(main, "rev-parse", "HEAD"), mainHead);
      if (conflict) {
        assert.equal(f.service.state("tree").status, "paused");
        assert.equal(await git(source, "diff", "--name-only", "--diff-filter=U"), "shared.txt");
        const calls = f.calls.length; await f.service.tick(); assert.equal(f.calls.length, calls);
      } else {
        await git(source, "merge-base", "--is-ancestor", mainHead, "HEAD");
        assert.equal(await git(source, "status", "--porcelain"), "");
        assert.equal(f.service.state("tree").status, "aligned");
        assert.equal(await git(source, "log", "-1", "--format=%s"), "feature");
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}
