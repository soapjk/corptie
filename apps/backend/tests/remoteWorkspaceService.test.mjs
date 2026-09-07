import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile, rm, realpath, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { RemoteWorkspaceService } from "../src/application/remoteWorkspaceService.mjs";
import { SshWorkspaceProbeService } from "../src/application/sshWorkspaceProbeService.mjs";
import { SshWorkspaceTransport, sshWorkspaceIdentity } from "../src/runtime/sshWorkspaceTransport.mjs";

const runFile = promisify(execFile);
const hash = (value) => createHash("sha256").update(value).digest("hex");

async function setup(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "corptie ssh ' ; fixture-")));
  const repo = join(root, "repository");
  const git = (...args) => runFile("git", ["-C", repo, ...args]);
  await runFile("git", ["init", "-b", "main", repo]);
  await git("config", "user.name", "Fixture");
  await git("config", "user.email", "fixture@example.invalid");
  await git("config", "commit.gpgsign", "false");
  await writeFile(join(repo, "file.txt"), "initial\n");
  await writeFile(join(repo, ".gitignore"), "ignored/\n");
  await git("add", ".");
  await git("commit", "-m", "initial");
  const baseOid = (await git("rev-parse", "HEAD")).stdout.trim();
  const hostIdentity = "fixture-key-identity";
  const workspace = { transport: "ssh", rootPath: repo, hostIdentity,
    identity: sshWorkspaceIdentity(hostIdentity, repo), connectionRef: "credential:fixture" };
  const routes = new Map([
    ["session:a", { sessionId: "session:a", taskId: "task:a", workId: "work:fixture", workspace, worktreePath: join(root, "task a ' $(echo injection)") }],
    ["session:b", { sessionId: "session:b", taskId: "task:b", workId: "work:fixture", workspace, worktreePath: join(root, "task b") }]
  ]);
  const states = [];
  const approvals = [];
  const transport = new SshWorkspaceTransport({
    maxOutputBytes: 4 * 1024 * 1024,
    resolveConnection: async () => ({ hostIdentity, hostAlias: "fixture", hostKeyAlias: "fixture", configPath: "/fixture/config", knownHostsPath: "/fixture/known_hosts" }),
    // Explicit local subprocess fixture: no sshd, network or remote writes.
    spawnProcess: (_binary, args, options) => spawn("/bin/sh", ["-c", args.at(-1)], options)
  });
  const options = {
    transport, resolveSessionBinding: async (sessionId) => routes.get(sessionId),
    authorizeMutation: async (request) => { approvals.push(request); return { authorized: true }; },
    onConnectionState: (state) => states.push(state)
  };
  const service = new RemoteWorkspaceService(options);
  let sequence = 0;
  const call = (action, input = {}, sessionId = "session:a", key = `fixture-${sequence++}`) => service.perform(sessionId, action, input, { idempotencyKey: key });
  const create = (sessionId = "session:a") => call("create", { path: routes.get(sessionId).worktreePath, branch: sessionId.replace(":", "-"), baseOid }, sessionId);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, repo, git, baseOid, routes, states, approvals, transport, service, options, call, create };
}

test("resource probing executes the shared helper without creating bindings or receipts", async (t) => {
  const f = await setup(t);
  const location = { ...f.routes.get("session:a").workspace, connectionId: "credential:fixture" };
  const observed = [];
  const states = [];
  const repository = { location: () => location,
    recordObservation: (_id, value) => { observed.push(value); return value; },
    recordConnectionState: (_id, state) => states.push(state) };
  const probes = new SshWorkspaceProbeService({ repository, transport: f.transport });
  const result = await probes.inspect("workspace:fixture");
  assert.equal(result.worktrees.length, 1);
  assert.equal(result.worktrees[0].branchRef, "refs/heads/main");
  assert.equal(result.rootPath, f.repo);
  await assert.rejects(access(join(f.repo, ".git", "corptie-ssh-workspace-v1")), { code: "ENOENT" });
  const failing = new SshWorkspaceProbeService({ repository, transport: { execute: async () => ({ state: "unknown" }) } });
  await assert.rejects(failing.inspect("workspace:fixture"), { code: "SSH_PROBE_OUTCOME_UNKNOWN" });
  assert.equal(observed.length, 1);
  assert.deepEqual(states, ["unknown"]);
});

test("probe concurrency and malformed inventory fail closed without accepting remote capabilities", async () => {
  let finish;
  const repository = { location: () => ({ connectionId: "one", hostIdentity: "host", rootPath: "/repo" }),
    recordConnectionState: () => {}, recordObservation: () => assert.fail("must reject malformed inventory") };
  const probes = new SshWorkspaceProbeService({ repository, transport: { execute: () => new Promise((resolve) => { finish = resolve; }) } });
  const first = probes.inspect("workspace:one");
  await assert.rejects(probes.inspect("workspace:one"), { code: "SSH_WORKSPACE_BUSY" });
  while (!finish) await new Promise((resolve) => setImmediate(resolve));
  finish({ state: "completed", exitCode: 0, stdout: JSON.stringify({ version: 1, ok: true,
    result: { rootPath: "/repo", capabilities: { executionSupported: true }, worktrees: [{ path: "relative", headOid: "invalid" }] } }) });
  await assert.rejects(first, { code: "SSH_PROBE_PROTOCOL_INVALID" });
});

test("remote lifecycle: discover/create/explicit bind/edit/search/stage/commit/publish/unbind/protected cleanup", async (t) => {
  const fixture = await setup(t);
  const { call, create, baseOid, routes, repo } = fixture;
  const initial = await call("inspect");
  assert.equal(initial.worktrees.length, 1);
  assert.equal(initial.cwdIsSandbox, false);
  assert.equal(initial.capabilities.processSupervision, false);
  const created = await create();
  assert.equal(created.bound, false);
  assert.equal((await call("inspect")).worktrees.length, 2);
  await assert.rejects(call("read", { path: "file.txt" }), { code: "REMOTE_SESSION_BINDING_MISMATCH" });
  await call("bind");
  const before = await call("read", { path: "file.txt" });
  assert.equal(before.content, "initial\n");
  const content = "updated from bound remote worktree\n";
  const edit = await call("write", { path: "file.txt", expectedSha256: before.sha256, content });
  assert.equal(await readFile(join(repo, "file.txt"), "utf8"), "initial\n");
  assert.match((await call("search", { query: "updated" })).output, /file.txt:1:updated/);
  await call("stage", { files: [{ path: "file.txt", sha256: edit.sha256 }] });
  const status = await call("status");
  const committed = await call("commit", { expectedHeadOid: baseOid, expectedSnapshotHash: status.snapshotHash, message: "reviewed fixture change" });
  assert.notEqual(committed.headOid, baseOid);
  await call("merge", { expectedHeadOid: baseOid, sourceOid: committed.headOid });
  assert.equal(await readFile(join(repo, "file.txt"), "utf8"), content);
  await assert.rejects(call("remove", { expectedHeadOid: committed.headOid }), { code: "REMOTE_WORKTREE_BUSY" });
  await call("unbind");
  const result = await call("remove", { expectedHeadOid: committed.headOid });
  assert.equal(result.branchPreserved, true);
  await assert.rejects(access(routes.get("session:a").worktreePath));
  assert.equal((await call("inspect")).worktrees.length, 1);
  assert.ok(fixture.approvals.every((approval) => approval.sessionId === "session:a" && approval.hostIdentity === "fixture-key-identity"));
});

test("two Sessions remain isolated and cannot bind each other's active Worktree", async (t) => {
  const { call, create, routes } = await setup(t);
  await create();
  await create("session:b");
  await call("bind");
  await call("bind", {}, "session:b");
  await call("write", { path: "file.txt", expectedSha256: hash("initial\n"), content: "only a" });
  assert.equal((await call("read", { path: "file.txt" }, "session:b")).content, "initial\n");
  await call("unbind", {}, "session:b");
  routes.get("session:b").worktreePath = routes.get("session:a").worktreePath;
  await assert.rejects(call("bind", {}, "session:b"), { code: "REMOTE_WORKTREE_BUSY" });
  await assert.rejects(call("read", { path: "file.txt" }, "session:b"), { code: "REMOTE_SESSION_BINDING_MISMATCH" });
});

test("mutation receipts survive new service instances and reject changed input", async (t) => {
  const { call, routes, baseOid, options } = await setup(t);
  const input = { path: routes.get("session:a").worktreePath, branch: "receipt-branch", baseOid };
  await call("create", input, "session:a", "stable-key");
  const restarted = new RemoteWorkspaceService(options);
  const replay = await restarted.perform("session:a", "create", input, { idempotencyKey: "stable-key" });
  assert.equal(replay.replayedReceipt, true);
  assert.equal((await call("inspect")).worktrees.length, 2);
  await assert.rejects(restarted.perform("session:a", "create", { ...input, branch: "different" }, { idempotencyKey: "stable-key" }), { code: "REMOTE_IDEMPOTENCY_CONFLICT" });
});

test("partial mutation receipts prevent automatic replay after process loss", async (t) => {
  const { call, create, repo, routes } = await setup(t);
  await create();
  const input = {};
  const operationId = hash(JSON.stringify([routes.get("session:a").workspace.identity, "session:a", "lost-bind"]));
  const request = { version: 1, sessionId: "session:a", taskId: "task:a", repositoryRoot: repo,
    worktreePath: routes.get("session:a").worktreePath, action: "bind", input, operationId };
  const canonical = (value) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
  await writeFile(join(repo, ".git", "corptie-ssh-workspace-v1", `${operationId}.json`), JSON.stringify({ fingerprint: hash(JSON.stringify(canonical(request))), state: "started" }));
  await assert.rejects(call("bind", input, "session:a", "lost-bind"), { code: "REMOTE_OPERATION_OUTCOME_UNKNOWN" });
  await assert.rejects(call("status"), { code: "REMOTE_SESSION_BINDING_MISMATCH" });
});

test("cross-client repository lock rejects concurrent mutations", async (t) => {
  const { call, create, repo } = await setup(t);
  await create();
  const lock = join(repo, ".git", "corptie-ssh-workspace-v1", "lock");
  const child = spawn("python3", ["-c", "import fcntl,sys,time; f=open(sys.argv[1],'r+');fcntl.flock(f,fcntl.LOCK_EX);print('ready',flush=True);time.sleep(60)", lock]);
  try {
    await once(child.stdout, "data");
    await assert.rejects(call("bind"), { code: "REMOTE_REPOSITORY_BUSY" });
  } finally { child.kill(); await once(child, "close"); }
  await call("bind");
});

test("dirty, ignored, active-process, main and stale-HEAD cleanup protections", async (t) => {
  const { call, create, baseOid, routes, repo } = await setup(t);
  await create();
  const tree = routes.get("session:a").worktreePath;
  await writeFile(join(tree, "user-work.txt"), "preserve");
  await assert.rejects(call("remove", { expectedHeadOid: baseOid }), { code: "REMOTE_WORKTREE_DIRTY" });
  await rm(join(tree, "user-work.txt"));
  await assert.rejects(call("remove", { expectedHeadOid: "a".repeat(40) }), { code: "REMOTE_HEAD_CHANGED" });
  await writeFile(join(tree, "ignored"), "local cache");
  // Make the fixture ignore a file as well as the ignored/ directory.
  await writeFile(join(repo, ".git", "info", "exclude"), "ignored\n");
  await assert.rejects(call("remove", { expectedHeadOid: baseOid }), { code: "REMOTE_IGNORED_FILES_PRESENT" });
  await rm(join(tree, "ignored"));
  const child = spawn(process.execPath, ["-e", "process.stdout.write('ready');setInterval(()=>{},1000)"], { cwd: tree });
  try {
    await once(child.stdout, "data");
    await assert.rejects(call("remove", { expectedHeadOid: baseOid }), { code: "REMOTE_WORKTREE_PROCESS_ACTIVE" });
  } finally { child.kill(); await once(child, "close"); }
  routes.get("session:a").worktreePath = repo;
  await assert.rejects(call("remove", { expectedHeadOid: baseOid }), { code: "REMOTE_WORKTREE_PROTECTED" });
  await assert.rejects(call("bind"), { code: "REMOTE_MAIN_BIND_FORBIDDEN" });
});

test("reviewed content/HEAD checks and file boundaries protect user changes", async (t) => {
  const { call, create, routes, baseOid } = await setup(t);
  await create(); await call("bind");
  const path = join(routes.get("session:a").worktreePath, "file.txt");
  await writeFile(path, "external change");
  await assert.rejects(call("write", { path: "file.txt", expectedSha256: hash("initial\n"), content: "overwrite" }), { code: "REMOTE_FILE_CHANGED" });
  assert.equal(await readFile(path, "utf8"), "external change");
  await assert.rejects(call("read", { path: "../repository/file.txt" }), { code: "REMOTE_FILE_OUTSIDE_WORKTREE" });
  await assert.rejects(call("read", { path: ".git" }), { code: "REMOTE_FILE_OUTSIDE_WORKTREE" });
  await assert.rejects(call("commit", { expectedHeadOid: baseOid, expectedSnapshotHash: "stale", message: "bad" }), { code: "REMOTE_CHANGES_CHANGED" });
});

test("authorization, stale routes and disconnect fail closed without invoking local fallback", async (t) => {
  const fixture = await setup(t);
  let calls = 0;
  const options = { ...fixture.options, transport: { execute: async () => { calls += 1; return { state: "unknown", remoteProcessTermination: "unverified" }; } } };
  const denied = new RemoteWorkspaceService({ ...options, authorizeMutation: async () => ({ authorized: false }) });
  await assert.rejects(denied.perform("session:a", "bind", {}, { idempotencyKey: "denied" }), { code: "REMOTE_WRITE_NOT_AUTHORIZED" });
  const stale = new RemoteWorkspaceService({ ...options, authorizeMutation: async () => {
    fixture.routes.get("session:a").taskId = "task:changed"; return { authorized: true };
  } });
  await assert.rejects(stale.perform("session:a", "bind", {}, { idempotencyKey: "stale" }), { code: "REMOTE_SESSION_ROUTE_CHANGED" });
  assert.equal(calls, 0);
  const service = new RemoteWorkspaceService(options);
  await assert.rejects(service.perform("session:a", "inspect"), (error) => error.code === "REMOTE_OPERATION_OUTCOME_UNKNOWN" && error.details.retrySafe === false);
  assert.equal(calls, 1);
  assert.equal(fixture.states.at(-1).state, "unknown");
  assert.ok(fixture.routes.has("session:a"));
});

test("remote login Git environment cannot redirect operations outside the bound repository", async (t) => {
  const f = await setup(t);
  const original = f.transport.spawnProcess;
  f.transport.spawnProcess = (binary, args, options) => original(binary, args, {
    ...options, env: { ...options.env, GIT_DIR: "/nonexistent-wrong-git-dir", GIT_WORK_TREE: "/wrong-worktree", GIT_INDEX_FILE: "/wrong-index" }
  });
  assert.equal((await f.call("inspect")).rootPath, f.repo);
  await f.create();
  await f.call("bind");
  assert.equal((await f.call("read", { path: "file.txt" })).content, "initial\n");
});
