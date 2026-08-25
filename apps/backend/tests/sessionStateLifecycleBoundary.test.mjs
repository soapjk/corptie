import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceURL = new URL("../src/server.mjs", import.meta.url);

test("authoritative Session projection is callback-owned and never snapshot-read-owned", async () => {
  const source = await readFile(sourceURL, "utf8");

  assert.equal(source.includes("reconcileActiveSessionProviderProjections"), false);
  assert.equal(source.includes("startActiveSessionReconciliation"), false);
  assert.match(source, /function controlPlaneSnapshot\(\)[\s\S]*visibleStoredSessionProjections/);
  const snapshotBegin = source.indexOf("async function getUnifiedSessionSnapshot");
  const snapshotEnd = source.indexOf("async function getStoredSessionSnapshot", snapshotBegin);
  const snapshotBody = source.slice(snapshotBegin, snapshotEnd);
  assert.notEqual(snapshotBegin, -1);
  assert.notEqual(snapshotEnd, -1);
  assert.match(snapshotBody, /getStoredSessionSnapshot/);
  assert.doesNotMatch(snapshotBody, /readSessionDetailWithStoredFallback/);
  assert.doesNotMatch(snapshotBody, /sessionApplicationService\.readSession/);
});

test("every supported streaming Provider isolates lifecycle callback failures", async () => {
  const source = await readFile(sourceURL, "utf8");
  assert.match(source, /onNotification:\s*\(message\)[\s\S]*handleCodexAppServerNotificationSafely/);
  assert.match(source, /onTurnSettled:\s*handleClaudeTurnSettledSafely/);
  assert.match(source, /provider=openclacky[\s\S]*markProviderBindingCursorDegraded/);
  assert.match(source, /provider=codex-app-server[\s\S]*markProviderBindingCursorDegraded/);
  assert.match(source, /provider=claude-sdk[\s\S]*markProviderBindingCursorDegraded/);
  assert.equal(source.includes("scheduleSessionProviderProjectionReconciliation"), false);
});

test("state publication is mutation-driven and subscriptions own no polling scheduler", async () => {
  const source = await readFile(sourceURL, "utf8");
  assert.match(source, /stateSyncPublishTimer = setTimeout\([\s\S]*?\}, 20\)/);
  assert.equal(source.includes("stateSyncConsistencyTimer"), false);
  assert.doesNotMatch(source, /setInterval\(publishStateChangesIfNeeded/);
});

test("synthetic Session progress is opt-in and its scheduler is released", async () => {
  const source = await readFile(sourceURL, "utf8");
  assert.match(source, /if \(process\.env\.CORPTIE_ENABLE_MOCK_SESSIONS === "1"\)[\s\S]*seedSessions\(\)/);
  assert.match(source, /mockProgressTimer = setInterval\(updateMockProgress, 2500\)/);
  assert.match(source, /shutdown[\s\S]*clearInterval\(mockProgressTimer\)/);
});
