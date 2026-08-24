import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceURL = new URL("../src/server.mjs", import.meta.url);

test("authoritative Session reconciliation is backend-owned, not SSE-client-owned", async () => {
  const source = await readFile(sourceURL, "utf8");
  const begin = source.indexOf("async function reconcileActiveSessionProviderProjections()");
  const end = source.indexOf("function updateStateSyncConsistencyTimer()", begin);
  const body = source.slice(begin, end);

  assert.notEqual(begin, -1);
  assert.notEqual(end, -1);
  assert.equal(body.includes("stateSyncClients.size === 0"), false);
  assert.match(source, /server\.listen[\s\S]*startActiveSessionReconciliation\(\)/);
});

test("every supported streaming Provider isolates lifecycle callback failures", async () => {
  const source = await readFile(sourceURL, "utf8");
  assert.match(source, /onNotification:\s*\(message\)[\s\S]*handleCodexAppServerNotificationSafely/);
  assert.match(source, /onTurnSettled:\s*handleClaudeTurnSettledSafely/);
  assert.match(source, /provider=openclacky[\s\S]*provider-notification-error/);
});

test("state publication coalesces event bursts and uses a low-frequency safety pass", async () => {
  const source = await readFile(sourceURL, "utf8");
  assert.match(source, /stateSyncPublishTimer = setTimeout\([\s\S]*?\}, 20\)/);
  assert.match(source, /stateSyncConsistencyTimer = setInterval\(publishStateChangesIfNeeded, 2_000\)/);
});
