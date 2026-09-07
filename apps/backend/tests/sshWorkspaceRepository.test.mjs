import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CorptieStore } from "../src/store/corptieStore.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "ssh-workspace-store-"));
  const options = { dbPath: join(directory, "fixture.sqlite"), configPath: join(directory, "config.json"), manageProcessEnvironment: false };
  let store = new CorptieStore(options);
  await store.initialize();
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  return { get store() { return store; }, async restart() { await store.close(); store = new CorptieStore(options); await store.initialize(); return store; } };
}

function connection(connectionId = "ssh-connection:one", hostIdentity = "known-host-key-one") {
  return { connectionId, label: "Development host", hostIdentity,
    credentialRef: "ssh-credential:keychain-reference", hostAlias: "development", hostKeyAlias: "development-key" };
}

test("remote host+path identity and connection references survive restart without local path aliasing", async (t) => {
  const f = await fixture(t);
  const local = f.store.createWorkspace({ rootPath: "/same/repository", kind: "linkedLocal" });
  f.store.sshWorkspaces.registerConnection(connection());
  f.store.sshWorkspaces.registerConnection(connection("ssh-connection:two", "another-host-key"));
  const remote = f.store.sshWorkspaces.registerWorkspace({ connectionId: "ssh-connection:one", rootPath: "/same/repository" });
  const second = f.store.sshWorkspaces.registerWorkspace({ connectionId: "ssh-connection:two", rootPath: "/same/repository" });
  assert.equal(new Set([local.workspaceId, remote.workspaceId, second.workspaceId]).size, 3);
  assert.equal(remote.kind, "sshRemote");
  assert.equal(remote.status, "pending");
  assert.equal(remote.location.connectionState, "unknown");
  assert.equal(remote.location.cwdIsSandbox, false);
  assert.equal(f.store.sshWorkspaces.registerWorkspace({ connectionId: "ssh-connection:one", rootPath: "/same/../same/repository" }).workspaceId, remote.workspaceId);
  await f.restart();
  assert.deepEqual(f.store.getWorkspace(remote.workspaceId), remote);
  assert.equal(f.store.resolveWorkspaceRoot(local.workspaceId), "/same/repository");
  assert.throws(() => f.store.resolveWorkspaceRoot(remote.workspaceId), { code: "REMOTE_WORKSPACE_LOCAL_PATH_FORBIDDEN" });
  assert.equal(f.store.sshWorkspaces.connection("ssh-connection:one").credentialRef, "ssh-credential:keychain-reference");
  assert.ok(!JSON.stringify(f.store.sshWorkspaces.listConnections()).includes("credentialRef"));
  assert.ok(!JSON.stringify(f.store.listWorkspaces()).includes("credentialRef"));
});

test("connections cannot be silently retargeted or accept embedded credentials", async (t) => {
  const { store } = await fixture(t);
  const first = store.sshWorkspaces.registerConnection(connection());
  assert.deepEqual(store.sshWorkspaces.registerConnection(connection()), first);
  assert.throws(() => store.sshWorkspaces.registerConnection({ ...connection(), hostIdentity: "replacement" }), { code: "SSH_CONNECTION_IMMUTABLE" });
  for (const input of [{ ...connection(), privateKey: "sensitive" }, { ...connection(), password: "sensitive" }, { ...connection(), hostAlias: "-oProxyCommand=evil" }]) {
    assert.throws(() => store.sshWorkspaces.registerConnection(input), { code: "SSH_CONFIGURATION_INVALID" });
  }
  assert.throws(() => store.sshWorkspaces.registerWorkspace({ connectionId: "missing", rootPath: "/repo" }), { code: "SSH_CONNECTION_NOT_FOUND" });
  assert.throws(() => store.sshWorkspaces.registerWorkspace({ connectionId: first.connectionId, rootPath: "relative" }), { code: "SSH_WORKSPACE_INPUT_INVALID" });
});

test("disconnection retains remote Workspace identity, path and last successful observation", async (t) => {
  const { store } = await fixture(t);
  store.sshWorkspaces.registerConnection(connection());
  const remote = store.sshWorkspaces.registerWorkspace({ connectionId: "ssh-connection:one", rootPath: "/repo with spaces/远程" });
  const observed = store.sshWorkspaces.recordConnectionState(remote.workspaceId, "connected");
  assert.ok(observed.location.lastValidatedAt);
  const disconnected = store.sshWorkspaces.recordConnectionState(remote.workspaceId, "disconnected");
  assert.equal(disconnected.location.lastValidatedAt, observed.location.lastValidatedAt);
  assert.equal(disconnected.location.identity, observed.location.identity);
  assert.equal(disconnected.rootPath, remote.rootPath);
  assert.equal(disconnected.status, "pending");
  assert.equal(store.listWorkspaces().filter((workspace) => workspace.workspaceId === remote.workspaceId).length, 1);
});

test("remote inventory observations survive restart and disconnect without enabling execution", async (t) => {
  const f = await fixture(t);
  f.store.sshWorkspaces.registerConnection(connection());
  const workspace = f.store.sshWorkspaces.registerWorkspace({ connectionId: "ssh-connection:one", rootPath: "/remote" });
  const inventory = { rootPath: "/remote", worktrees: [{ path: "/remote", headOid: "a".repeat(40), branchRef: "refs/heads/main" }] };
  const result = f.store.sshWorkspaces.recordObservation(workspace.workspaceId, inventory);
  assert.equal(result.workspace.location.executionSupported, false);
  await f.restart();
  f.store.sshWorkspaces.recordConnectionState(workspace.workspaceId, "unknown");
  assert.deepEqual(f.store.sshWorkspaces.observation(workspace.workspaceId), result.observation);
  assert.equal(f.store.getWorkspace(workspace.workspaceId).location.executionSupported, false);
});

test("Workspace listing uses bounded queries and local-only listing adds no SSH lookups", async (t) => {
  const { store } = await fixture(t);
  store.createWorkspace({ rootPath: "/local" });
  const original = store.selectAll.bind(store);
  let queries = 0;
  store.selectAll = (...args) => { queries += 1; return original(...args); };
  store.listWorkspaces();
  assert.equal(queries, 1);
  store.sshWorkspaces.registerConnection(connection());
  for (let index = 0; index < 30; index += 1) store.sshWorkspaces.registerWorkspace({ connectionId: "ssh-connection:one", rootPath: `/remote/${index}` });
  queries = 0;
  assert.equal(store.listWorkspaces().length, 31);
  assert.equal(queries, 2);
  assert.deepEqual(store.selectAll("PRAGMA foreign_key_check"), []);
});
