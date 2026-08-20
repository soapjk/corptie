import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("remote Feishu reconciliation stays outside the backend readiness path", async () => {
  const source = await readFile(new URL("../src/server.mjs", import.meta.url), "utf8");
  const listenIndex = source.indexOf('server.listen(port, "127.0.0.1"');
  const initializeIndex = source.indexOf("feishuGateway.initialize()", listenIndex);

  assert.notEqual(listenIndex, -1, "production server must declare its loopback listener");
  assert.notEqual(initializeIndex, -1, "Feishu gateway must still initialize after startup");
  assert.equal(
    source.slice(0, listenIndex).includes("await feishuGateway.initialize()"),
    false,
    "remote Feishu initialization must never block server.listen"
  );
  assert.ok(initializeIndex > listenIndex, "Feishu initialization must be scheduled after the listener opens");
});
