import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceURL = new URL("../src/server.mjs", import.meta.url);

test("authoritative Session projection is callback-owned and never snapshot-read-owned", async () => {
  const source = await readFile(sourceURL, "utf8");

  assert.equal(source.includes("reconcileActiveSessionProviderProjections"), false);
  assert.equal(source.includes("startActiveSessionReconciliation"), false);
  assert.match(source, /function controlPlaneSnapshot\(\)[\s\S]*visibleStoredSessionProjections/);
  assert.match(
    source,
    /function controlPlaneSnapshot\(\)[\s\S]*decorateSessionForClient\(session\)/,
    "State Sync must publish the same Provider-backed Session readiness as GET /sessions"
  );
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

test("Codex binding readiness preserves a live empty thread until its first Turn", async () => {
  // Execution preparation is now Provider-neutral orchestration that calls the
  // Codex protocol through the lifecycle adapter; the readiness contract is
  // guarded on both files.
  const source = await readFile(sourceURL, "utf8");
  const begin = source.indexOf("function prepareCodexProviderExecution");
  const end = source.indexOf("async function probeCodexProviderBinding", begin);
  const body = source.slice(begin, end);
  assert.match(body, /providerSessionLifecycle\.prepareExecution/);

  const lifecycleSource = await readFile(
    new URL("../src/application/providerSessionLifecycle.mjs", import.meta.url),
    "utf8"
  );
  assert.match(lifecycleSource, /adapter\.ensureResumed\(threadId/);
  assert.doesNotMatch(lifecycleSource, /bindingReadinessProbe[\s\S]*resumeThread/);

  const probeBegin = source.indexOf("async function probeCodexProviderBinding");
  const probeEnd = source.indexOf("function resolvePreparedWorkspaceRoute", probeBegin);
  const probeBody = source.slice(probeBegin, probeEnd);
  assert.match(probeBody, /codexRuntime\.ensureThreadResumed\(reference\.providerSessionId/);
  assert.doesNotMatch(probeBody, /toolHostService|collaborationThreadOptionsForSession|prepareCodexProviderExecution/,
    "an existence probe must not be blocked by Tool catalog refresh");
});

test("Worker initial prompts drain only after the authoritative ready receipt commit", async () => {
  const source = await readFile(sourceURL, "utf8");
  const serviceBegin = source.indexOf("const providerWorkSessionPort = new ProviderWorkSessionPort");
  const serviceEnd = source.indexOf("projectWorktreeIntegrationService", serviceBegin);
  const serviceBody = source.slice(serviceBegin, serviceEnd);

  assert.match(serviceBody, /deferInitialPromptUntilBound:\s*true/);
  assert.match(serviceBody, /deferToolHostFinalization:\s*true/);
  const finalizeIndex = serviceBody.indexOf("workspaceBinding: providerWorkspaceBindingService");
  const activateIndex = serviceBody.indexOf("activateSession:");
  assert.ok(finalizeIndex >= 0 && activateIndex > finalizeIndex);
  assert.match(serviceBody.slice(activateIndex), /sessionApplicationService\.resumeSession\(session\.id,[\s\S]*purpose:\s*"session-create-finalization"/);
  assert.match(serviceBody.slice(activateIndex), /sendUnifiedSessionMessage\(session\.id, taskExecutionPrompt\(task\)/);
});

test("Worker startup composition consumes only the authoritative assignee Agent identity", async () => {
  const source = await readFile(sourceURL, "utf8");
  const serviceBegin = source.indexOf("const providerWorkSessionPort = new ProviderWorkSessionPort");
  const serviceEnd = source.indexOf("projectWorktreeIntegrationService", serviceBegin);
  const serviceBody = source.slice(serviceBegin, serviceEnd);

  assert.match(serviceBody, /store\.getAgent\(assigneeAgentId\)/);
  assert.doesNotMatch(serviceBody, /requestedAgentId|operation\.agentId/);
});

test("every Worker Session production entry routes through the authoritative startup coordinator", async () => {
  const source = await readFile(sourceURL, "utf8");
  assert.equal(source.match(/createProviderWorkSession\(/g)?.length, 2,
    "only ProviderWorkSessionPort and the Provider-facing constructor may create a Worker Session");
  assert.doesNotMatch(source, /launchAndBindTaskSession|launchTaskSession/);
  assert.match(source, /workSessionStartApplicationService\.start\(/);
  assert.match(source, /async function startPreparedWorkSession[\s\S]*workSessionStartApplicationService\.start/);
});

test("a replaced Worker Session cannot overwrite its Task lifecycle", async () => {
  const source = await readFile(sourceURL, "utf8");
  const settleBegin = source.indexOf("function settleEntityTaskFromSession");
  const settleEnd = source.indexOf("function scheduleTaskMemoryExtraction", settleBegin);
  const settleBody = source.slice(settleBegin, settleEnd);
  assert.match(settleBody, /task\.current_session_id !== session\.id/);
  assert.ok(settleBody.indexOf("current_session_id") < settleBody.indexOf("taskExecutionPatch"));
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

test("Claude turn settlement completes a waiting Provider switch through exactly one route", async () => {
  const source = await readFile(sourceURL, "utf8");
  const handlerBegin = source.indexOf("async function handleClaudeTurnSettled(event)");
  const handlerEnd = source.indexOf("function restartCodexProviderSession", handlerBegin);
  const handlerBody = source.slice(handlerBegin, handlerEnd);

  assert.notEqual(handlerBegin, -1);
  assert.notEqual(handlerEnd, -1);
  assert.equal(
    handlerBody.match(/continuePendingWorkspaceTransition\(logical, event\.turnId\)/g)?.length,
    1
  );
  assert.equal(
    handlerBody.match(/continuePendingProviderSwitch\(logical\)/g)?.length,
    1
  );
  assert.doesNotMatch(handlerBody, /claudeWorkspaceTransitionManager\.continueWorkspaceTransition/);

  const workspaceBegin = source.indexOf("function continuePendingWorkspaceTransition");
  const workspaceEnd = source.indexOf("function continuePendingProviderSwitch", workspaceBegin);
  const workspaceBody = source.slice(workspaceBegin, workspaceEnd);
  assert.match(workspaceBody, /transition\.transitionKind === "provider"\) return null/);

  const providerBegin = workspaceEnd;
  const providerEnd = source.indexOf("function enqueueWorkspaceContinuationSafely", providerBegin);
  const providerBody = source.slice(providerBegin, providerEnd);
  assert.match(providerBody, /transition\.transitionKind !== "provider"\) return null/);
  assert.equal(
    providerBody.match(/sessionProviderSwitchCoordinator\.completeProviderSwitch/g)?.length,
    1
  );
});

test("startup recovery validates or safely recreates only an empty journaled Codex replacement", async () => {
  const source = await readFile(sourceURL, "utf8");
  const recoveryBegin = source.indexOf("sessionRecoveryCoordinator = new SessionRecoveryCoordinator");
  const recoveryEnd = source.indexOf("projectWorktreeIntegrationService", recoveryBegin);
  const recoveryBody = source.slice(recoveryBegin, recoveryEnd);

  assert.notEqual(recoveryBegin, -1);
  assert.notEqual(recoveryEnd, -1);
  assert.match(recoveryBody, /resumeReplacement:\s*async/);
  assert.match(recoveryBody, /codexRuntime\.inspectEmptyThreadForRouteCommit/);
  assert.match(recoveryBody, /PROVIDER_EMPTY_THREAD_UNRECOVERABLE/);
  assert.match(recoveryBody, /error\?\.safeToRecreate !== true/);
  assert.match(recoveryBody, /sessionRecoveryCoordinator\.providerPort\.createReplacement/);
});

test("startup recovery runs after readiness and waits for isolated Provider runtime preparation", async () => {
  const source = await readFile(sourceURL, "utf8");
  const listenIndex = source.indexOf('server.listen(port, "127.0.0.1"');
  const maintenanceIndex = source.indexOf("async function runProviderStartupMaintenance", listenIndex);
  const recoveryCall = source.indexOf(
    'runContainedStartupOperation("session-recovery", resumeSessionRecoveryAttemptsAtStartup)',
    maintenanceIndex
  );
  const toolPreflightCall = source.indexOf("toolBootstrapBindingPreflight.run()", maintenanceIndex);

  assert.notEqual(listenIndex, -1);
  assert.ok(maintenanceIndex > listenIndex, "Provider maintenance must not block the listener");
  assert.notEqual(recoveryCall, -1);
  assert.notEqual(toolPreflightCall, -1);
  for (const prerequisite of [
    "await ensureCorptieOpenClackyRuntime",
    "openClackyManager.start()",
    "await ensureCorptieCodexRuntime",
    "await ensureCorptieClaudeRuntime"
  ]) {
    const prerequisiteIndex = source.indexOf(prerequisite, maintenanceIndex);
    assert.notEqual(prerequisiteIndex, -1, `missing startup prerequisite: ${prerequisite}`);
    assert.ok(
      prerequisiteIndex < recoveryCall,
      `${prerequisite} must complete before persisted Session recovery resumes`
    );
    assert.ok(
      prerequisiteIndex < toolPreflightCall,
      `${prerequisite} must complete before Tool bootstrap preflight recovery starts`
    );
  }
  assert.match(
    source.slice(maintenanceIndex, recoveryCall),
    /const \[corptieCodexRuntime\] = await Promise\.all\([\s\S]*?\);[\s\S]*?const operations = \[/
  );

  const helperBegin = source.indexOf("async function resumeSessionRecoveryAttemptsAtStartup");
  const helperEnd = source.indexOf("\nawait store.resolveDataPath()", helperBegin);
  const helperBody = source.slice(helperBegin, helperEnd);
  assert.match(helperBody, /await sessionRecoveryCoordinator\.recover/);
  assert.match(helperBody, /Math\.min\(2, attempts\.length\)/);
  assert.doesNotMatch(helperBody, /\.recover\([\s\S]*?\)\.catch/);
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
