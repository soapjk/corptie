import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Ajv from "ajv";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { WorkApplicationService } from "../src/application/workApplicationService.mjs";
import { WorkDiscussionApplicationService } from "../src/application/workDiscussionApplicationService.mjs";
import { createPlatformOperationComposition, createWorkInitializationComposition } from "../src/application/platformOperationComposition.mjs";
import { platformDynamicTools, callPlatformDynamicTool } from "../src/application/platformDynamicTools.mjs";
import { HostToolCatalog } from "../src/application/hostToolCatalog.mjs";
import { resolvePlatformAdminSession } from "../src/utils/platformAssistantIdentity.mjs";

const run = promisify(execFile);
async function fixture(t, options = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "corptie-work-initialization-")));
  const store = new CorptieStore({ dataRoot: directory, dbPath: join(directory, "db.sqlite"), configPath: join(directory, "config.json") });
  await store.initialize();
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  const agent = store.createAgent({ name: "Contributor", role: "independentContributor" });
  const events = [];
  const workService = new WorkApplicationService({ store, onEntityChanged: (...args) => events.push(args) });
  store.createSession({ id: "provider:admin", title: "Admin", agentId: "assistant", sessionKind: "assistantChat" });
  store.createLogicalSessionRoute({ logicalSessionId: "logical:admin", legacySessionId: "provider:admin",
    providerThreadId: "provider:admin", providerSessionId: "provider:admin", providerId: "test-provider",
    boundCwd: directory, sessionName: "Admin" });
  store.grantSessionCapability("provider:admin", "platform.manage");
  const launches = [], deletions = [];
  const discussion = new WorkDiscussionApplicationService({ workService, launch: async ({ work, agent, providerId }) => {
    if (options.failBeforeSession) throw new Error("injected launch failure");
    const id = `${providerId}:work:${launches.length}`;
    launches.push({ work, agent, providerId });
    store.createSession({ id, title: `${work.name}_Chat`, agentId: agent.agentId,
      sessionKind: "workChat", workId: work.id, cwd: store.resolveWorkspaceRoot(work.workspaceId) });
    store.createLogicalSessionRoute({ logicalSessionId: `logical:${id}`, legacySessionId: id,
      providerThreadId: id, providerSessionId: id, providerId,
      boundCwd: store.resolveWorkspaceRoot(work.workspaceId), sessionName: `${work.name}_Chat` });
    if (options.missingLogical) store.deleteLogicalSessionByLegacySessionId(id);
    if (options.revokeGrant) store.revokeSessionCapability("provider:admin", "platform.manage");
    if (options.failAfterSession) throw new Error("injected post-session failure");
    return store.getSession(id);
  } });
  const registry = { supports: provider => provider !== "unsupported" };
  const sessionService = { deleteUnusableSession: async id => {
    deletions.push(id);
    if (options.failCleanup) throw Object.assign(new Error("Provider unavailable"), { code: "PROVIDER_OFFLINE" });
    store.deleteLogicalSessionByLegacySessionId(id);
    store.deleteSession(id);
    return { ok: true, deleted: true, providerDeleted: !options.offlineProvider, providerId: "test-provider", providerErrorCode: options.offlineProvider ? "PROVIDER_OFFLINE" : null };
  } };
  const initialization = createWorkInitializationComposition({ store, workService, sessionApplicationService: sessionService,
    workDiscussionService: discussion, agentProviderRegistry: registry, getDefaultProviderId: () => "test-provider" });
  const service = createPlatformOperationComposition({ store, workService, sessionApplicationService: sessionService, workInitializationService: initialization,
    workDiscussionService: discussion, agentProviderRegistry: registry, getDefaultProviderId: () => "test-provider",
    emitEvent: () => {}, launchAgentSession: () => {}, startWorkSession: () => {} });
  const root = join(directory, "NewWork");
  const args = { action: "create", name: "MarketCowSDK", patch: { profile: "software", contributorAgentIds: [agent.agentId] },
    directory: { mode: "create", path: root }, idempotency_key: "work-create" };
  const catalog = new HostToolCatalog([{ id: "platform", tools: platformDynamicTools,
    authorize: ({ actorId, metadata }) => {
      try { resolvePlatformAdminSession(store, { actorId, sessionId: metadata?.sessionId }); return true; }
      catch { return false; }
    }, execute: input => callPlatformDynamicTool(service, input) }]);
  const execute = patch => catalog.execute({ actorId: "assistant", metadata: { sessionId: "provider:admin" },
    tool: "corptie_platform_works_manage", arguments: { ...args, ...patch } });
  return { store, directory, root, agent, workService, discussion, sessionService, service, initialization, args, execute, launches, deletions, events };
}

test("desktop/device creation allocates a real managed directory, Workspace and logical Work Chat", async t => {
  const f = await fixture(t);
  const input = { id: "work:client:one", name: "ClientWork", contributorAgentIds: [f.agent.agentId] };
  const created = await f.initialization.createForClient(input);
  assert.ok((await stat(created.directory)).isDirectory());
  assert.ok(created.directory.startsWith(join(f.directory, "workspaces")));
  assert.ok(created.workChat.logicalSessionId);
  assert.equal(created.workspace.workspaceId, f.store.getWork(created.id).workspaceId);
  const replay = await f.initialization.createForClient(input);
  assert.equal(replay.workChat.logicalSessionId, created.workChat.logicalSessionId);
  assert.equal(f.launches.length, 1);
  await assert.rejects(f.initialization.createForClient({ ...input, name: "Changed" }), { code: "ENTITY_CREATION_CONFLICT" });
});

test("desktop/device creation failure rolls back metadata and the managed Work directory", async t => {
  const f = await fixture(t, { failAfterSession: true });
  await assert.rejects(f.initialization.createForClient({ name: "ClientWork", contributorAgentIds: [f.agent.agentId] }), /post-session failure/);
  assert.equal(f.store.listWorks().length, 0);
  assert.equal(f.store.listWorkspaces().length, 0);
  assert.deepEqual(await readdir(join(f.directory, "workspaces")), []);
});

test("external creation adapters never call the metadata-only Work primitive", async () => {
  for (const name of ["platformOperationService", "entityHttpApi", "entityHttpComposition", "clientDeviceGatewayComposition"]) {
    const source = await readFile(new URL(`../src/application/${name}.mjs`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /(?:workService|store)\.createWork\s*\(/, name);
  }
});

async function assertRolledBack(f) {
  assert.equal(f.store.listWorks().length, 0);
  assert.equal(f.store.listWorkspaces().length, 0);
  assert.equal(f.store.listGitRepositories().length, 0);
  assert.equal(f.store.listSessions().filter(session => session.sessionKind === "workChat").length, 0);
  assert.equal(f.store.selectAll("SELECT * FROM platform_admin_operations").length, 0);
  await assert.rejects(stat(f.root), { code: "ENOENT" });
  assert.equal(f.events.length, 0);
}

test("Work create schema rejects legacy metadata-only input and describes explicit directory/Git strategies", () => {
  const tool = platformDynamicTools.find(entry => entry.name === "corptie_platform_works_manage");
  const validate = new Ajv({ strict: false }).compile(tool.inputSchema);
  assert.equal(validate({ action: "create", name: "MarketCowSDK", patch: { profile: "software" } }), false);
  assert.equal(validate({ action: "create", name: "MarketCowSDK", patch: { contributorAgentIds: ["agent:one"] },
    directory: { mode: "create", path: "/tmp/NewWork" }, git: { mode: "init" }, idempotency_key: "create" }), true);
  assert.equal(validate({ action: "create", name: "MarketCowSDK", patch: { contributorAgentIds: [] },
    directory: { mode: "create", path: "/tmp/NewWork" }, idempotency_key: "create" }), false);
  assert.equal(validate({ action: "list" }), true);
});

test("platform create completes a real non-Git Work and logical Work Chat before audit; replay/concurrency do not duplicate", async t => {
  const f = await fixture(t);
  const [created, replay] = await Promise.all([f.execute(), f.execute()]);
  assert.equal(created.ok, true);
  assert.equal(replay.idempotentReplay, true);
  assert.equal(created.auditId, replay.auditId);
  assert.equal(created.target.id, created.result.id);
  assert.equal(created.result.directory, f.root);
  assert.equal(created.result.repository, null);
  assert.ok((await stat(f.root)).isDirectory());
  assert.equal(created.result.workspace.workspaceId, f.store.getWork(created.result.id).workspaceId);
  assert.equal(created.result.workChat.logicalSessionId, f.store.getLogicalSessionByLegacySessionId(created.result.workChat.sessionId).logicalSessionId);
  assert.equal(f.launches.length, 1);
  assert.equal(f.store.listTasks().length, 0);
  assert.equal(f.events.length, 1);
  assert.equal(JSON.parse(f.store.selectOne("SELECT result_json FROM platform_admin_operations").result_json).result.directory, f.root);
  await assert.rejects(f.execute({ name: "Different" }), { code: "IDEMPOTENCY_CONFLICT" });
});

test("legacy metadata-only success receipts cannot be replayed as complete Work creation", async t => {
  const f = await fixture(t);
  const receipt = await f.execute();
  const legacy = { ...receipt, result: f.store.getWork(receipt.result.id) };
  f.store.db.run("UPDATE platform_admin_operations SET result_json=? WHERE operation_id=?", [JSON.stringify(legacy), receipt.auditId]);
  await assert.rejects(f.execute(), { code: "WORK_CREATION_RECEIPT_INCOMPLETE" });
  assert.equal(f.store.listWorks().length, 1);
  assert.equal(f.launches.length, 1);
});

test("idempotent replay checks actual directory availability instead of returning stale success", async t => {
  const f = await fixture(t);
  await f.execute();
  await rm(f.root, { recursive: true });
  await assert.rejects(f.execute(), { code: "ENOENT" });
  assert.equal(f.launches.length, 1);
});

for (const provider of ["codex-app-server", "claude-sdk", "openclacky"]) {
  test(`Work Chat initialization uses shared Provider contract: ${provider}`, async t => {
    const f = await fixture(t);
    const created = await f.execute({ provider_id: provider });
    assert.equal(created.result.workChat.providerId, provider);
    assert.equal(f.launches[0].providerId, provider);
  });
}

test("a new Git Work binds its own unborn repository without generating or committing Markdown", async t => {
  const f = await fixture(t);
  const receipt = await f.execute({ git: { mode: "init" } });
  assert.ok(receipt.result.repository.id);
  assert.equal(receipt.result.repository.workspaceId, receipt.result.workspace.workspaceId);
  assert.equal(receipt.result.workspace.ownership, "corptieManaged");
  assert.deepEqual((await readdir(f.root)).filter(name => name !== ".git"), []);
  assert.equal(f.store.listGitRepositories().length, 1);
});

test("bind detects an existing Git repository and preserves existing files on a later failure", async t => {
  const f = await fixture(t, { failAfterSession: true });
  await mkdir(f.root);
  await run("git", ["-C", f.root, "init"]);
  await writeFile(join(f.root, "keep.txt"), "user data");
  await assert.rejects(f.execute({ directory: { mode: "bind", path: f.root } }), /post-session failure/);
  assert.equal(await readFile(join(f.root, "keep.txt"), "utf8"), "user data");
  assert.ok((await stat(join(f.root, ".git"))).isDirectory());
  assert.equal(f.store.listWorks().length, 0);
  assert.equal(f.store.listWorkspaces().length, 0);
  assert.equal(f.store.listGitRepositories().length, 0);
  assert.equal(f.deletions.length, 1);
});

test("bind existing non-Git directory completes without changing its contents", async t => {
  const f = await fixture(t);
  await mkdir(f.root);
  await writeFile(join(f.root, "keep.txt"), "user data");
  const receipt = await f.execute({ directory: { mode: "bind", path: f.root } });
  assert.equal(receipt.result.workspace.ownership, "userManaged");
  assert.equal(receipt.result.repository, null);
  assert.deepEqual(await readdir(f.root), ["keep.txt"]);
});

test("local Git clone checks out an explicit commit and returns the bound repository", async t => {
  const f = await fixture(t);
  const source = join(f.directory, "source");
  await mkdir(source);
  await run("git", ["-C", source, "init"]);
  await run("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "--allow-empty", "-m", "Initial"]);
  const { stdout } = await run("git", ["-C", source, "rev-parse", "HEAD"]);
  const receipt = await f.execute({ git: { mode: "clone", url: source, commit: stdout.trim() } });
  assert.ok(receipt.result.repository);
  const head = await run("git", ["-C", f.root, "rev-parse", "HEAD"]);
  assert.equal(head.stdout.trim(), stdout.trim());
});

for (const options of [{ failBeforeSession: true }, { failAfterSession: true }]) {
  for (const git of [{ mode: "none" }, { mode: "init" }]) {
    test(`rollback cleans every new resource: ${JSON.stringify({ options, git })}`, async t => {
      const f = await fixture(t, options);
      await assert.rejects(f.execute({ git }), /injected/);
      await assertRolledBack(f);
    });
  }
}

test("audit failure compensates the already initialized directory, repository and logical Work Chat", async t => {
  const f = await fixture(t);
  f.store.db.run("CREATE TRIGGER fail_work_audit BEFORE INSERT ON platform_admin_operations BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END");
  await assert.rejects(f.execute({ git: { mode: "init" } }), /injected audit failure/);
  await assertRolledBack(f);
});

test("invalid inputs and unavailable Provider fail before allocating any resources", async t => {
  const f = await fixture(t);
  for (const patch of [
    { directory: undefined }, { directory: { mode: "create", path: "relative" } },
    { provider_id: "unsupported" }, { agent_id: "other" }, { idempotency_key: undefined },
    { git: { mode: "clone" } }, { git: { mode: "init", url: "unused" } },
    { patch: { contributorAgentIds: ["missing"] } },
    { directory: { mode: "bind", path: f.root }, git: { mode: "init" } }
  ]) await assert.rejects(f.execute(patch));
  await assertRolledBack(f);
});

test("failed Git clone removes only the newly allocated directory", async t => {
  const f = await fixture(t);
  await assert.rejects(f.execute({ git: { mode: "clone", url: join(f.directory, "missing-repo") } }));
  await assertRolledBack(f);
});

test("Store Work insertion failure compensates the directory and Workspace", async t => {
  const f = await fixture(t);
  f.store.db.run("CREATE TRIGGER fail_work BEFORE INSERT ON works BEGIN SELECT RAISE(ABORT, 'injected Work failure'); END");
  await assert.rejects(f.execute(), /injected Work failure/);
  await assertRolledBack(f);
});

test("a Work Chat without a live logical route is rolled back rather than reported successful", async t => {
  const f = await fixture(t, { missingLogical: true });
  await assert.rejects(f.execute(), { code: "WORK_CHAT_INITIALIZATION_INCOMPLETE" });
  await assertRolledBack(f);
});

test("revoking platform permission during initialization prevents commit and rolls back new resources", async t => {
  const f = await fixture(t, { revokeGrant: true });
  await assert.rejects(f.execute(), { code: "PLATFORM_ADMIN_SESSION_REQUIRED" });
  await assertRolledBack(f);
});

test("unavailable Provider cleanup retires local resources and keeps a durable Provider recovery record", async t => {
  const f = await fixture(t, { failAfterSession: true, offlineProvider: true });
  await assert.rejects(f.execute(), /post-session failure/);
  await assertRolledBack(f);
  const record = f.store.selectOne("SELECT value_json FROM runtime_state WHERE key LIKE 'work-initialization-recovery:%'");
  const recovery = JSON.parse(record.value_json);
  assert.equal(recovery.localRollbackComplete, true);
  assert.equal(recovery.providerCleanup[0].providerErrorCode, "PROVIDER_OFFLINE");
});

test("create cannot adopt an existing directory or delete its contents on failure", async t => {
  const f = await fixture(t);
  await mkdir(f.root);
  await writeFile(join(f.root, "keep.txt"), "original");
  await assert.rejects(f.execute(), { code: "EEXIST" });
  assert.equal(await readFile(join(f.root, "keep.txt"), "utf8"), "original");
  assert.equal(f.store.listWorks().length, 0);
  assert.equal(f.store.listWorkspaces().length, 0);
});

test("binding a Git subdirectory never substitutes its parent repository for the Work", async t => {
  const f = await fixture(t);
  await mkdir(f.root);
  await run("git", ["-C", f.root, "init"]);
  const nested = join(f.root, "nested");
  await mkdir(nested);
  await assert.rejects(f.execute({ directory: { mode: "bind", path: nested } }), { code: "WORK_REPOSITORY_ROOT_REQUIRED" });
  assert.equal(f.store.listWorkspaces().length, 0);
  assert.ok((await stat(nested)).isDirectory());
});

test("bind reuses an unbound registered Workspace and preserves it when initialization fails", async t => {
  const f = await fixture(t, { failAfterSession: true });
  await mkdir(f.root);
  const workspace = f.store.createWorkspace({ kind: "linkedLocal", ownership: "userManaged", rootPath: f.root });
  await assert.rejects(f.execute({ directory: { mode: "bind", path: f.root } }), /post-session failure/);
  assert.deepEqual(f.store.getWorkspace(workspace.workspaceId), workspace);
  assert.equal(f.store.listWorks().length, 0);
  assert.ok((await stat(f.root)).isDirectory());
});

test("a second create cannot take over a complete Work's Workspace", async t => {
  const f = await fixture(t);
  const receipt = await f.execute();
  await assert.rejects(f.execute({ idempotency_key: "second", directory: { mode: "bind", path: f.root } }), { code: "WORKSPACE_ALREADY_BOUND" });
  assert.equal(f.store.listWorks().length, 1);
  assert.equal(f.store.getWork(receipt.result.id).workspaceId, receipt.result.workspace.workspaceId);
  assert.equal(f.launches.length, 1);
});

test("rollback failure is explicit and records recovery identities instead of issuing a success receipt", async t => {
  const f = await fixture(t, { failAfterSession: true, failCleanup: true });
  await assert.rejects(f.execute(), error => {
    assert.equal(error.code, "WORK_INITIALIZATION_ROLLBACK_FAILED");
    assert.equal(error.cleanupErrors[0].code, "PROVIDER_OFFLINE");
    assert.equal(f.store.getRuntimeState(`work-initialization-recovery:${error.workId}`).directory, f.root);
    return true;
  });
  assert.equal(f.store.selectAll("SELECT * FROM platform_admin_operations").length, 0);
  assert.ok((await stat(f.root)).isDirectory());
});
