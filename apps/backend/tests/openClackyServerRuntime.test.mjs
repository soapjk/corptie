import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { OpenClackyServerRuntime, resolveOpenClackyCommand, resolveOpenClackyManagedPort } from "../src/runtime/openClackyServerRuntime.mjs";

test("managed OpenClacky runtime starts in the Corptie process context and waits for health", async () => {
  const calls = [];
  let healthy = false;
  class FakeChild extends EventEmitter {
    constructor() { super(); this.exitCode = null; this.killed = false; this.stderr = new EventEmitter(); }
    kill(signal) { this.killed = true; calls.push({ type: "kill", signal }); }
  }
  const child = new FakeChild();
  const runtime = new OpenClackyServerRuntime({
    command: "/opt/openclacky",
    port: 47123,
    cwd: "/corptie/runtime",
    env: () => ({ HOME: "/provider/home" }),
    spawn: (command, args, options) => {
      calls.push({ type: "spawn", command, args, options });
      healthy = true;
      return child;
    },
    fetch: async () => Response.json(healthy ? { status: "ok" } : {}, { status: healthy ? 200 : 503 }),
    pollIntervalMs: 1,
    startupTimeoutMs: 100
  });

  const result = await runtime.ensureRunning();

  assert.equal(result.baseURL, "http://127.0.0.1:47123");
  assert.equal(calls[0].command, "/opt/openclacky");
  assert.deepEqual(calls[0].args, ["server", "--host", "127.0.0.1", "--port", "47123"]);
  assert.equal(calls[0].options.cwd, "/corptie/runtime");
  assert.equal(calls[0].options.env.HOME, "/provider/home");
  runtime.stop();
  assert.deepEqual(calls.at(-1), { type: "kill", signal: "SIGTERM" });
});

test("explicit managed ports win while production and Development stay isolated by default", () => {
  assert.equal(resolveOpenClackyManagedPort("production", undefined), 47071);
  assert.equal(resolveOpenClackyManagedPort("development", undefined), 47072);
  assert.equal(resolveOpenClackyManagedPort("production", "47199"), 47199);
  assert.equal(resolveOpenClackyCommand("/custom/openclacky", "/unused"), "/custom/openclacky");
});
