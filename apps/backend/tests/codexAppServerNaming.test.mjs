import assert from "node:assert/strict";
import test from "node:test";
import { CodexAppServerClient } from "../src/adapters/codexAppServer.mjs";

test("setThreadName uses the Codex app-server thread naming method", async () => {
  const calls = [];
  const client = new CodexAppServerClient();
  client.initialize = async () => {};
  client.request = async (method, params) => {
    calls.push({ method, params });
    return {};
  };

  await client.setThreadName("thread-a", "Custom session name");

  assert.deepEqual(calls, [{
    method: "thread/name/set",
    params: { threadId: "thread-a", name: "Custom session name" }
  }]);
});
