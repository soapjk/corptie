import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { ClientSessionAPI } from "../src/application/clientSessionAPI.mjs";
import { executeClientCommand } from "../src/application/clientEntityCommands.mjs";
import { clientCommandPrincipalKey } from "../src/application/clientCommandPrincipal.mjs";

test("existing receipt journal isolates local users and devices and survives restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-principal-journal-"));
  const store = new CorptieStore({ dbPath: join(directory, "db.sqlite"), configPath: join(directory, "config.json") });
  await store.initialize();
  try {
    const local = { kind: "local_user", principalId: "desktop" };
    const device = { deviceId: "desktop" };
    let api = new ClientSessionAPI({ store });
    let calls = 0;
    const input = { kind: "inspector:detail-test", entityId: "logical:a", sessionId: "logical:a",
      requestId: "principal-request-001", fields: { value: true }, uncertainCode: "OUTCOME_UNCERTAIN",
      run: async () => { calls++; return { done: true }; } };
    const first = await executeClientCommand(api, local, async () => local, input);
    assert.equal(first.status, "completed");
    assert.equal(first.sessionId, "logical:a");
    assert.deepEqual(first.inspectorResult, { done: true });
    assert.throws(() => api.receipt(device, input.requestId), { code: "COMMAND_NOT_FOUND" });
    api = new ClientSessionAPI({ store });
    assert.deepEqual(await executeClientCommand(api, local, () => local, input), first);
    assert.equal(calls, 1);
    await assert.rejects(executeClientCommand(api, local, async () => { await Promise.resolve(); throw Object.assign(new Error(), { code: "INVALID_CREDENTIAL" }); }, input), { code: "INVALID_CREDENTIAL" });
    await assert.rejects(executeClientCommand(api, local, async () => { await Promise.resolve(); return { kind: "local_user", principalId: "other" }; }, input), { code: "INVALID_CREDENTIAL" });
    await assert.rejects(executeClientCommand(api, local, () => local, { ...input, fields: { value: false } }), { code: "IDEMPOTENCY_CONFLICT" });
    await executeClientCommand(api, device, () => device, input);
    assert.equal(calls, 2);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("device identity cannot claim the reserved local-user journal namespace", () => {
  assert.throws(() => clientCommandPrincipalKey({ deviceId: "local-user:desktop" }), { code: "INVALID_CREDENTIAL" });
  assert.throws(() => clientCommandPrincipalKey({ kind: "local_user", principalId: "" }), { code: "LOCAL_USER_REQUIRED" });
});

test("concurrent revalidation merges a request and restarted dispatching is unknown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-principal-race-"));
  const store = new CorptieStore({ dbPath: join(directory, "db.sqlite"), configPath: join(directory, "config.json") });
  await store.initialize();
  try {
    const identity = { kind: "local_user", principalId: "desktop" };
    const api = new ClientSessionAPI({ store });
    let finish, calls = 0;
    const wait = new Promise(resolve => { finish = resolve; });
    const input = { kind: "inspector:detail-test", entityId: "logical:a", sessionId: "logical:a",
      requestId: "principal-race-001", fields: {}, uncertainCode: "OUTCOME_UNCERTAIN",
      run: async () => { calls++; await wait; return {}; } };
    const first = executeClientCommand(api, identity, async () => identity, input);
    const duplicate = await executeClientCommand(api, identity, async () => identity, input);
    assert.equal(duplicate.status, "dispatching");
    assert.equal(new ClientSessionAPI({ store }).receipt(identity, input.requestId).status, "unknown");
    finish();
    assert.equal((await first).status, "completed");
    assert.equal(calls, 1);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});
