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
  assert.equal(source.includes("readCodexProviderSession("), false);
  assert.equal(source.includes("listCodexProviderSessions("), false);
});

test("Codex notifications and commands cannot fall back to legacy lifecycle projection", async () => {
  const source = await readFile(sourceURL, "utf8");
  const notificationBegin = source.indexOf("function handleCodexAppServerNotification(message)");
  const notificationEnd = source.indexOf("function handleCommittedCodexProviderEvent", notificationBegin);
  const notificationBody = source.slice(notificationBegin, notificationEnd);
  assert.notEqual(notificationBegin, -1);
  assert.notEqual(notificationEnd, -1);
  assert.match(notificationBody, /providerEventIngestion\.ingest/);
  assert.doesNotMatch(notificationBody, /SessionTimelineProjection|CodexThreadProgressChanged|CodexThreadCompleted/);
  assert.doesNotMatch(notificationBody, /upsertManagedCodexSession|store\.renameSession/);

  const sendBegin = source.indexOf("async function sendCodexProviderMessage");
  const sendEnd = source.indexOf("function agentWorkTimelineItem", sendBegin);
  const sendBody = source.slice(sendBegin, sendEnd);
  assert.doesNotMatch(sendBody, /upsertManagedCodexSession|CodexThreadProgressChanged/);
  assert.doesNotMatch(sendBody, /readThread|findCodexRolloutBySessionId|readCodexRollout/);
});

test("initial prompts are persisted after Session and Binding creation before Provider dispatch", async () => {
  const source = await readFile(sourceURL, "utf8");
  const createBegin = source.indexOf("async function createSessionThroughApplication");
  const createEnd = source.indexOf("function prepareCodexProviderSessionInput", createBegin);
  const createBody = source.slice(createBegin, createEnd);
  const bindingIndex = createBody.indexOf("sessionApplicationService.createSession");
  const deliveryIndex = createBody.indexOf("sendUnifiedSessionMessage");
  assert.ok(bindingIndex >= 0 && deliveryIndex > bindingIndex);

  const providerCreateBegin = source.indexOf("async function createCodexProviderSession");
  const providerCreateEnd = source.indexOf("async function resumeCodexProviderSession", providerCreateBegin);
  assert.doesNotMatch(source.slice(providerCreateBegin, providerCreateEnd), /startTurn/);
});

test("Worker initial prompts drain only after the authoritative ready receipt commit", async () => {
  const source = await readFile(sourceURL, "utf8");
  const serviceBegin = source.indexOf("workSessionStartupCoordinator = new WorkSessionStartupCoordinator");
  const serviceEnd = source.indexOf("projectWorktreeIntegrationService", serviceBegin);
  const serviceBody = source.slice(serviceBegin, serviceEnd);

  assert.match(serviceBody, /deferInitialPromptUntilBound:\s*true/);
  assert.match(serviceBody, /deferToolHostFinalization:\s*true/);
  const finalizeIndex = serviceBody.indexOf("bindProviderWorkspace:");
  const activateIndex = serviceBody.indexOf("activateSession:");
  assert.ok(finalizeIndex >= 0 && activateIndex > finalizeIndex);
  assert.match(serviceBody.slice(activateIndex), /sessionApplicationService\.resumeSession\(session\.id,[\s\S]*purpose:\s*"session-create-finalization"/);
  assert.match(serviceBody.slice(activateIndex), /sendUnifiedSessionMessage\(session\.id, initialPrompt \|\| workItemExecutionPrompt\(workItem\)/);
});

test("Worker startup composition consumes the coordinator's requested Agent identity", async () => {
  const source = await readFile(sourceURL, "utf8");
  const serviceBegin = source.indexOf("workSessionStartupCoordinator = new WorkSessionStartupCoordinator");
  const serviceEnd = source.indexOf("projectWorktreeIntegrationService", serviceBegin);
  const serviceBody = source.slice(serviceBegin, serviceEnd);

  assert.match(serviceBody, /store\.getAgent\(operation\.requestedAgentId\)/);
  assert.doesNotMatch(serviceBody, /operation\.agentId/);
});

test("every Worker Session production entry routes through the authoritative startup coordinator", async () => {
  const source = await readFile(sourceURL, "utf8");
  assert.equal(source.match(/launchWorkItemSession\(/g)?.length, 2, "only the coordinator adapter and function definition may reference the low-level launcher");
  assert.match(source, /platform-operation/);
  assert.match(source, /integration-conflict-resolution/);
  assert.match(source, /integration-plan-resolution/);
  assert.match(source, /async function launchPreparedWorkItemSession[\s\S]*launchAndBindWorkItemSession/);
  assert.match(source, /async function launchAndBindWorkItemSession[\s\S]*workSessionStartupCoordinator\.start/);
});

test("a replaced Worker Session cannot overwrite its WorkItem lifecycle", async () => {
  const source = await readFile(sourceURL, "utf8");
  const settleBegin = source.indexOf("function settleEntityWorkItemFromSession");
  const settleEnd = source.indexOf("function scheduleWorkItemMemoryExtraction", settleBegin);
  const settleBody = source.slice(settleBegin, settleEnd);
  assert.match(settleBody, /workItem\.current_session_id !== session\.id/);
  assert.ok(settleBody.indexOf("current_session_id") < settleBody.indexOf("workItemExecutionPatch"));
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
