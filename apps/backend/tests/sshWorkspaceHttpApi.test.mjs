import test from "node:test";
import assert from "node:assert/strict";
import { handleSshWorkspaceHttpRequest } from "../src/application/sshWorkspaceHttpApi.mjs";
import { WorkApplicationService } from "../src/application/workApplicationService.mjs";

async function request(path, { method = "GET", input, origin, contentType = "application/json", connections = {}, repository = {}, probes } = {}) {
  let status;
  let body;
  const handled = await handleSshWorkspaceHttpRequest({
    url: new URL(path, "http://127.0.0.1"),
    request: { method, headers: { ...(origin ? { origin } : {}), "content-type": contentType },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(input ?? {})); } },
    response: { writeHead(code) { status = code; }, end(data) { body = JSON.parse(data); } },
    connections, repository, probes
  });
  return { handled, status, body };
}

test("SSH settings expose registered connections and concrete local aliases without credential references", async () => {
  const result = await request("/ssh/connections", {
    connections: { listAliases: async () => ["dev"] }, repository: { listConnections: () => [{ connectionId: "ssh:one", label: "Dev" }] }
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.aliases, ["dev"]);
  assert.equal(result.body.connections.length, 1);
});

test("only an explicit native probe POST can inspect the persisted Workspace destination", async () => {
  const calls = [];
  const probes = { inspect: async (id) => { calls.push(id); return { observation: { worktrees: [] } }; } };
  const path = "/ssh/workspaces/workspace:abc-def/probe";
  assert.equal((await request(path, { probes })).status, 404);
  assert.equal((await request(path, { method: "POST", input: { rootPath: "/override" }, probes })).status, 400);
  assert.equal((await request(path, { method: "POST", origin: "https://browser.invalid", probes })).status, 403);
  assert.deepEqual(calls, []);
  assert.equal((await request(path, { method: "POST", probes })).status, 200);
  assert.deepEqual(calls, ["workspace:abc-def"]);
  const saved = await request("/ssh/workspaces/workspace:abc-def/observation", { probes,
    repository: { location: () => ({}), observation: () => ({ rootPath: "/saved", worktrees: [] }) } });
  assert.equal(saved.body.observation.rootPath, "/saved");
  assert.deepEqual(calls, ["workspace:abc-def"], "reading a saved observation cannot contact SSH");
});

test("key inspection strips raw public key material and configuration registration performs no remote call", async () => {
  const result = await request("/ssh/connections/inspect", { method: "POST", input: { hostAlias: "dev" },
    connections: { inspectAlias: async () => ({ hostAlias: "dev", keys: [{ algorithm: "ssh-ed25519", publicKey: "blob", fingerprint: "SHA256:key" }] }) } });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.keys, [{ algorithm: "ssh-ed25519", fingerprint: "SHA256:key" }]);
  const saved = await request("/ssh/workspaces", { method: "POST", input: { connectionId: "one", rootPath: "/repo" },
    repository: { registerWorkspace: (input) => ({ workspaceId: "workspace:one", status: "pending", ...input }) } });
  assert.equal(saved.status, 201);
  assert.equal(saved.body.gitCapability, "unverified");
  assert.equal(saved.body.workspace.status, "pending");
});

test("browser origins, credential fields, oversized payloads and wrong content types are rejected", async () => {
  assert.equal((await request("/ssh/connections", { origin: "https://untrusted.example" })).status, 403);
  assert.equal((await request("/ssh/connections", { method: "POST", input: { password: "secret" } })).status, 400);
  assert.equal((await request("/ssh/connections", { method: "POST", input: { label: "x".repeat(9000) } })).status, 413);
  assert.equal((await request("/ssh/connections", { method: "POST", contentType: "text/plain" })).status, 415);
  const failed = await request("/ssh/connections", { connections: { listAliases: async () => { throw new Error("/secret/private-key"); } }, repository: { listConnections: () => [] } });
  assert.equal(failed.status, 500);
  assert.ok(!JSON.stringify(failed.body).includes("private-key"));
});

test("an unverified remote Workspace cannot create a Work or accidentally launch a local Session", () => {
  let creates = 0;
  const service = new WorkApplicationService({ store: {
    getWorkspace: () => ({ location: { transport: "ssh", executionSupported: false } }),
    createWork: () => { creates += 1; }
  } });
  assert.throws(() => service.createWork({ name: "Remote", workspaceId: "workspace:remote", contributorAgentIds: ["agent:one"] }), { code: "SSH_EXECUTION_NOT_VERIFIED" });
  assert.equal(creates, 0);
});
