import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { IndependentComputerUseClient } from "../src/mcp/independentComputerUseClient.mjs";
import { createIndependentComputerUseMcpServer, validateComputerUseArguments } from "../src/mcp/independentComputerUseMcpServer.mjs";

test("reject unscoped operations, unknown arguments and invalid native values", () => {
  for (const args of [{ action: "click", pid: 2, x: 1, y: 2 }, { action: "read", pid: 2, windowId: 4, activate: true },
    { action: "key", pid: 2, windowId: 4, key: "shell" }, { action: "type", pid: -1, windowId: 4, text: "x" },
    { action: "scroll", pid: 2, windowId: 4, deltaX: Infinity }]) assert.throws(() => validateComputerUseArguments(args));
});
async function harness(t, approve, result = {}) {
  const calls = [];
  const native = { call: async (...args) => { calls.push(args); return result; }, close() {} };
  const server = createIndependentComputerUseMcpServer({ client: native, approve });
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  return { client, calls };
}
test("denied elicitation never reaches native; status is prompt-free", async t => {
  const { client, calls } = await harness(t, async () => ({ action: "decline" }));
  const result = await client.callTool({ name: "computer_use", arguments: { action: "apps" } });
  assert.equal(result.isError, true); assert.equal(calls.length, 0);
  await client.callTool({ name: "computer_use", arguments: { action: "status" } });
  assert.equal(calls.length, 1);
});
test("approval binds action and target; returns native PNG with metadata", async t => {
  let prompt;
  const { client, calls } = await harness(t, async p => { prompt = p; return { action: "accept", content: { allow: true } }; }, { image: "cG5n", width: 2 });
  const result = await client.callTool({ name: "computer_use", arguments: { action: "screenshot", pid: 3, windowId: 4 } });
  assert.match(prompt.message, /PID 3, window 4/);
  assert.equal(calls[0][0], "screenshot");
  assert.deepEqual(calls[0][1], { pid: 3, windowId: 4 });
  assert.equal(result.content[1].type, "image"); assert.equal(result.content[1].mimeType, "image/png");
  assert.equal(result.content[1].data, "cG5n");
});
function fakeSpawn(onRequest) {
  let child;
  const spawnProcess = () => {
    child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kills = []; child.kill = signal => { child.kills.push(signal); queueMicrotask(() => child.emit("close", null, signal)); };
    let input = "";
    child.stdin.on("data", data => { input += data; });
    child.stdin.on("finish", () => onRequest?.(JSON.parse(input), child));
    return child;
  };
  return { spawnProcess, get child() { return child; } };
}
test("native JSONL correlates ids and transports structured errors", async () => {
  const spawn = fakeSpawn((request, child) => child.stdout.end(JSON.stringify({ id: request.id, result: { ok: true } }) + "\n"));
  const client = new IndependentComputerUseClient({ helperPath: "/helper", stateRoot: "/state", spawnProcess: spawn.spawnProcess });
  assert.deepEqual(await client.call("status"), { ok: true });
  assert.deepEqual(spawn.child.kills, ["SIGKILL"]);
  client.close();
});
test("cancellation kills native work and closed clients reject new requests", async () => {
  const spawn = fakeSpawn();
  const client = new IndependentComputerUseClient({ helperPath: "/helper", stateRoot: "/state", spawnProcess: spawn.spawnProcess });
  const abort = new AbortController();
  const pending = client.call("read", {}, { signal: abort.signal });
  await assert.rejects(client.call("read"), /busy/);
  abort.abort(new Error("cancelled"));
  await assert.rejects(pending, /cancelled/);
  assert.deepEqual(spawn.child.kills, ["SIGKILL"]);
  client.close(); await assert.rejects(client.call("status"), /closed/);
});
test("timeout and malformed native replies fail closed", async () => {
  const spawn = fakeSpawn();
  const client = new IndependentComputerUseClient({ helperPath: "/helper", stateRoot: "/state", spawnProcess: spawn.spawnProcess, timeoutMs: 5 });
  await assert.rejects(client.call("status"), /timed out/);
  const malformed = fakeSpawn((_, child) => child.stdout.end('{"id":"other","result":{}}\n'));
  const other = new IndependentComputerUseClient({ helperPath: "/helper", stateRoot: "/state", spawnProcess: malformed.spawnProcess });
  await assert.rejects(other.call("status"), /id mismatch/);
  client.close(); other.close();
});

test("clients without elicitation fail closed before native execution", async t => {
  const { client, calls } = await harness(t, undefined);
  const result = await client.callTool({ name: "computer_use", arguments: { action: "apps" } });
  assert.equal(result.isError, true);
  assert.equal(calls.length, 0);
});
