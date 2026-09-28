import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceURL = new URL("../src/server.mjs", import.meta.url);

test("authoritative Session projection is callback-owned and never snapshot-read-owned", async () => {
  const source = await readFile(sourceURL, "utf8");

  assert.equal(source.includes("reconcileActiveSessionProviderProjections"), false);
  assert.equal(source.includes("startActiveSessionReconciliation"), false);
  const projection = await readFile(new URL("../src/application/controlPlaneProjection.mjs", import.meta.url), "utf8");
  assert.match(source, /createControlPlaneProjection\(\{\s*store, environmentName, decorateSessionForClient/);
  assert.match(projection, /function controlPlaneSnapshot\(\)[\s\S]*activeStoredSessionProjections\(store\)/);
  assert.doesNotMatch(projection, /persistProviderSessionProjection|reconcileActiveSessionProviderProjections/);
  assert.match(
    projection,
    /function controlPlaneSnapshot\(\)[\s\S]*decorateSessionForClient\(session\)/,
    "State Sync must publish the same Provider-backed Session readiness as GET /sessions"
  );
  const snapshotBegin = source.indexOf("async function getUnifiedSessionSnapshot");
  const snapshotEnd = source.indexOf("function requireSessionReference", snapshotBegin);
  const snapshotBody = source.slice(snapshotBegin, snapshotEnd);
  assert.notEqual(snapshotBegin, -1);
  assert.notEqual(snapshotEnd, -1);
  assert.match(snapshotBody, /getStoredSessionSnapshot/);
  assert.match(source, /createSessionTimelineReader\(\{ store, requireSessionReference, decorateSessionForClient \}\)/);
  const timelineReader = await readFile(new URL("../src/application/sessionTimelineReader.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(timelineReader, /sessionApplicationService|codexRuntime|claudeProviderRuntime|persistProviderSessionProjection/);
  assert.doesNotMatch(snapshotBody, /readSessionDetailWithStoredFallback/);
  assert.doesNotMatch(snapshotBody, /sessionApplicationService\.readSession/);
  assert.equal(source.includes("readCodexProviderSession("), false);
  assert.equal(source.includes("listCodexProviderSessions("), false);
});

test("Codex notifications and commands cannot fall back to legacy lifecycle projection", async () => {
  const source = await readFile(sourceURL, "utf8");
  const receiver = await readFile(new URL("../src/adapters/codexNotificationReceiver.mjs", import.meta.url), "utf8");
  assert.match(source, /createCodexNotificationReceiver\(/);
  const notificationBegin = receiver.indexOf("function handleCodexAppServerNotification(message)");
  const notificationEnd = receiver.indexOf("function handleCommittedCodexProviderEvent", notificationBegin);
  const notificationBody = receiver.slice(notificationBegin, notificationEnd);
  assert.notEqual(notificationBegin, -1);
  assert.notEqual(notificationEnd, -1);
  assert.match(notificationBody, /providerEventIngestion\.ingest/);
  assert.doesNotMatch(notificationBody, /SessionTimelineProjection|CodexThreadProgressChanged|CodexThreadCompleted/);
  assert.doesNotMatch(notificationBody, /upsertManagedCodexSession|store\.renameSession/);

  assert.match(source, /createCodexTurnDispatcher\(/);
  const sendBody = await readFile(new URL("../src/adapters/codexTurnDispatcher.mjs", import.meta.url), "utf8");
  assert.match(sendBody, /async function sendCodexProviderMessage/);
  assert.doesNotMatch(sendBody, /upsertManagedCodexSession|CodexThreadProgressChanged/);
  assert.doesNotMatch(sendBody, /readThread|findCodexRolloutBySessionId|readCodexRollout/);
});

test("initial prompts are persisted after Session and Binding creation before Provider dispatch", async () => {
  const source = await readFile(sourceURL, "utf8");
  const createBody = await readFile(new URL("../src/application/sessionCreationOperation.mjs", import.meta.url), "utf8");
  assert.match(source, /createSessionCreationOperation\(/);
  const bindingIndex = createBody.indexOf("sessionApplicationService.createSession");
  const deliveryIndex = createBody.indexOf("await sendUnifiedSessionMessage", bindingIndex);
  assert.ok(bindingIndex >= 0 && deliveryIndex > bindingIndex);

  const providerCreateBegin = source.indexOf("async function createCodexProviderSession");
  const providerCreateEnd = source.indexOf("function stabilizeCodexRecoverySession", providerCreateBegin);
  assert.ok(providerCreateBegin >= 0 && providerCreateEnd > providerCreateBegin);
  assert.doesNotMatch(source.slice(providerCreateBegin, providerCreateEnd), /startTurn/);
});

test("Codex binding readiness preserves a live empty thread until its first Turn", async () => {
  // Execution preparation is now Provider-neutral orchestration that calls the
  // Codex protocol through the lifecycle adapter; the readiness contract is
  // guarded on both files.
  const source = await readFile(sourceURL, "utf8");
  const begin = source.indexOf("function prepareCodexProviderExecution");
  const end = source.indexOf("function resolvePreparedWorkspaceRoute", begin);
  const body = source.slice(begin, end);
  assert.match(body, /providerSessionLifecycle\.prepareExecution/);

  const lifecycleSource = await readFile(
    new URL("../src/application/providerSessionLifecycle.mjs", import.meta.url),
    "utf8"
  );
  assert.match(lifecycleSource, /adapter\.ensureResumed\(threadId/);
  assert.doesNotMatch(lifecycleSource, /bindingReadinessProbe[\s\S]*resumeThread/);

  const commands = await readFile(new URL("../src/adapters/codexSessionCommands.mjs", import.meta.url), "utf8");
  assert.match(source, /createCodexSessionCommands\(/);
  const probeBegin = commands.indexOf("async function probeCodexProviderBinding");
  const probeEnd = commands.indexOf("async function deleteCodexProviderSession", probeBegin);
  assert.ok(probeBegin >= 0 && probeEnd > probeBegin);
  const probeBody = commands.slice(probeBegin, probeEnd);
  assert.match(probeBody, /codexRuntime\.ensureThreadResumed\(reference\.providerSessionId/);
  assert.doesNotMatch(probeBody, /toolHostService|collaborationThreadOptionsForSession|prepareCodexProviderExecution/,
    "an existence probe must not be blocked by Tool catalog refresh");
});

test("message dispatch reuses binding readiness and invalidates it after Provider failure", async () => {
  const root = await readFile(sourceURL, "utf8");
  assert.match(root, /createSessionMessageOperation\(/);
  const source = await readFile(new URL("../src/application/sessionMessageOperation.mjs", import.meta.url), "utf8");
  const begin = source.indexOf("async function sendUnifiedSessionMessage");
  const end = source.indexOf("function assertSessionRecoveryMessageBoundary", begin);
  const body = source.slice(begin, end);

  assert.match(body, /sessionBindingReadinessProbe\.verify\([\s\S]*reuseReady:\s*true/);
  assert.match(body, /catch \(error\) \{[\s\S]*sessionBindingReadinessProbe\.invalidateBinding\(reference\)/);
});

test("Worker initial prompts drain only after the authoritative ready receipt commit", async () => {
  const root = await readFile(sourceURL, "utf8");
  assert.match(root, /createWorkSessionStartupComposition\(/);
  const source = await readFile(new URL("../src/application/workSessionStartupComposition.mjs", import.meta.url), "utf8");
  const serviceBegin = source.indexOf("const providerWorkSessionPort = new ProviderWorkSessionPort");
  const serviceEnd = source.indexOf("const workSessionStartupCoordinator", serviceBegin);
  assert.ok(serviceBegin >= 0 && serviceEnd > serviceBegin);
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
  const source = await readFile(new URL("../src/application/workSessionStartupComposition.mjs", import.meta.url), "utf8");
  const serviceBegin = source.indexOf("const providerWorkSessionPort = new ProviderWorkSessionPort");
  const serviceEnd = source.indexOf("const workSessionStartupCoordinator", serviceBegin);
  assert.ok(serviceBegin >= 0 && serviceEnd > serviceBegin);
  const serviceBody = source.slice(serviceBegin, serviceEnd);

  assert.match(serviceBody, /store\.getAgent\(assigneeAgentId\)/);
  assert.doesNotMatch(serviceBody, /requestedAgentId|operation\.agentId/);
});

test("every Worker Session production entry routes through the authoritative startup coordinator", async () => {
  const source = await readFile(sourceURL, "utf8");
  const launchers = await readFile(new URL("../src/application/entitySessionLaunchers.mjs", import.meta.url), "utf8");
  const preparedLaunch = await readFile(new URL("../src/application/sessionLaunchPreparation.mjs", import.meta.url), "utf8");
  assert.equal(source.match(/createProviderWorkSession\(/g)?.length, 1,
    "root must expose only the deferred construction port");
  const composition = await readFile(new URL("../src/application/workSessionStartupComposition.mjs", import.meta.url), "utf8");
  assert.equal(composition.match(/createProviderWorkSession\(/g)?.length, 1,
    "only ProviderWorkSessionPort may invoke the Worker Session constructor");
  assert.equal(launchers.match(/async function createProviderWorkSession\(/g)?.length, 1);
  assert.match(source, /createEntitySessionLaunchers\(/);
  assert.doesNotMatch(source, /launchAndBindTaskSession|launchTaskSession/);
  assert.match(source, /workSessionStartApplicationService\.start\(/);
  assert.match(source, /async function startPreparedWorkSession[\s\S]*startPreparedWorkSessionWithAuthority/);
  assert.match(preparedLaunch, /export async function startPreparedWorkSession[\s\S]*workSessionStartApplicationService\.start/);
});

test("a replaced Worker Session cannot overwrite its Task lifecycle", async () => {
  const server = await readFile(sourceURL, "utf8");
  assert.match(server, /createTaskSessionProjection\(/);
  const source = await readFile(new URL("../src/application/taskSessionProjection.mjs", import.meta.url), "utf8");
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
  const openClackyReceiver = await readFile(new URL("../src/agent-provider/bootstrap/openClackyRuntimeManagerComposition.mjs", import.meta.url), "utf8");
  assert.match(openClackyReceiver, /provider=openclacky[\s\S]*markProviderBindingCursorDegraded/);
  const codexReceiver = await readFile(new URL("../src/adapters/codexNotificationReceiver.mjs", import.meta.url), "utf8");
  assert.match(source, /createCodexNotificationReceiver\(/);
  assert.match(codexReceiver, /provider=codex-app-server[\s\S]*markProviderBindingCursorDegraded/);
  const claudeReceiver = await readFile(new URL("../src/adapters/claudeNotificationReceiver.mjs", import.meta.url), "utf8");
  assert.match(source, /createClaudeNotificationReceiver\(/);
  assert.match(claudeReceiver, /provider=claude-sdk[\s\S]*markProviderBindingCursorDegraded/);
  assert.equal(source.includes("scheduleSessionProviderProjectionReconciliation"), false);
});

test("Claude turn settlement completes a waiting Provider switch through exactly one route", async () => {
  const source = await readFile(sourceURL, "utf8");
  const receiver = await readFile(new URL("../src/adapters/claudeNotificationReceiver.mjs", import.meta.url), "utf8");
  const handlerBegin = receiver.indexOf("async function handleClaudeTurnSettled(event)");
  const handlerEnd = receiver.indexOf("\n  return {", handlerBegin);
  const handlerBody = receiver.slice(handlerBegin, handlerEnd);

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

  const operations = await readFile(new URL("../src/application/postTurnWorkspaceOperations.mjs", import.meta.url), "utf8");
  assert.match(source, /createPostTurnWorkspaceOperations\(/);
  const workspaceBegin = operations.indexOf("function continuePendingWorkspaceTransition");
  const workspaceEnd = operations.indexOf("function continuePendingProviderSwitch", workspaceBegin);
  const workspaceBody = operations.slice(workspaceBegin, workspaceEnd);
  assert.match(workspaceBody, /transition\.transitionKind === "provider"\) return null/);

  const providerBegin = workspaceEnd;
  const providerEnd = operations.indexOf("function enqueueWorkspaceContinuationSafely", providerBegin);
  const providerBody = operations.slice(providerBegin, providerEnd);
  assert.match(providerBody, /transition\.transitionKind !== "provider"\) return null/);
  assert.equal(
    providerBody.match(/sessionProviderSwitchCoordinator\.completeProviderSwitch/g)?.length,
    1
  );
});

test("startup recovery validates or safely recreates only an empty journaled Codex replacement", async () => {
  const source = await readFile(sourceURL, "utf8");
  assert.match(source, /sessionRecoveryCoordinator = createSessionRecoveryComposition\(/);
  const recoveryBody = await readFile(
    new URL("../src/agent-provider/bootstrap/sessionRecoveryComposition.mjs", import.meta.url), "utf8"
  );
  assert.match(recoveryBody, /resumeReplacement:\s*async/);
  assert.match(recoveryBody, /codexRuntime\.inspectEmptyThreadForRouteCommit/);
  assert.match(recoveryBody, /PROVIDER_EMPTY_THREAD_UNRECOVERABLE/);
  assert.match(recoveryBody, /error\?\.safeToRecreate !== true/);
  assert.match(recoveryBody, /sessionRecoveryCoordinator\.providerPort\.createReplacement/);
});

test("startup recovery runs after readiness and waits for isolated Provider runtime preparation", async () => {
  const source = await readFile(sourceURL, "utf8");
  const listenIndex = source.indexOf('server.listen(port, "127.0.0.1"');
  const maintenanceScheduleIndex = source.indexOf("scheduleBackendStartupMaintenance({", listenIndex);
  const startup = await readFile(new URL("../src/application/backendStartupMaintenance.mjs", import.meta.url), "utf8");
  const maintenance = await readFile(new URL("../src/agent-provider/bootstrap/providerStartupMaintenance.mjs", import.meta.url), "utf8");
  const maintenanceIndex = maintenance.indexOf("async function runProviderStartupMaintenance");
  const recoveryCall = maintenance.indexOf(
    'runContainedStartupOperation("session-recovery", resumeSessionRecoveryAttemptsAtStartup)',
    maintenanceIndex
  );
  const toolPreflightCall = maintenance.indexOf("toolBootstrapBindingPreflight.run()", maintenanceIndex);

  assert.notEqual(listenIndex, -1);
  assert.ok(maintenanceScheduleIndex > listenIndex, "Provider maintenance must not block the listener");
  assert.match(startup, /trackStartupMaintenance\(runProviderStartupMaintenance/);
  assert.notEqual(maintenanceIndex, -1);
  assert.match(source, /const \{ runProviderStartupMaintenance \} = createProviderStartupMaintenance\(/);
  assert.notEqual(recoveryCall, -1);
  assert.notEqual(toolPreflightCall, -1);
  for (const prerequisite of [
    "await ensureCorptieOpenClackyRuntime",
    "openClackyManager.start()",
    "await ensureCorptieCodexRuntime",
    "await ensureCorptieClaudeRuntime"
  ]) {
    const prerequisiteIndex = maintenance.indexOf(prerequisite, maintenanceIndex);
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
    maintenance.slice(maintenanceIndex, recoveryCall),
    /const \[corptieCodexRuntime\] = await Promise\.all\([\s\S]*?\);[\s\S]*?const operations = \[/
  );

  assert.match(source, /createStartupRecoveryOperations\(/);
  const recovery = await readFile(new URL("../src/application/startupRecoveryOperations.mjs", import.meta.url), "utf8");
  const helperBegin = recovery.indexOf("async function resumeSessionRecoveryAttemptsAtStartup");
  const helperEnd = recovery.indexOf("async function recoverPendingWorkspaceTransitions", helperBegin);
  assert.notEqual(helperBegin, -1);
  assert.ok(helperEnd > helperBegin);
  const helperBody = recovery.slice(helperBegin, helperEnd);
  assert.match(helperBody, /await sessionRecoveryCoordinator\.recover/);
  assert.match(helperBody, /Math\.min\(2, attempts\.length\)/);
  assert.doesNotMatch(helperBody, /\.recover\([\s\S]*?\)\.catch/);
});

test("state publication is mutation-driven and subscriptions own no polling scheduler", async () => {
  const source = await readFile(sourceURL, "utf8");
  const readiness = await readFile(new URL("../src/application/backendStoreReadiness.mjs", import.meta.url), "utf8");
  const shutdown = await readFile(new URL("../src/application/backendShutdown.mjs", import.meta.url), "utf8");
  const publisher = await readFile(new URL("../src/application/stateSyncPublisher.mjs", import.meta.url), "utf8");
  assert.match(source, /createStateSyncPublisher\(/);
  assert.match(readiness, /store.setStateDirtyListener\(scheduleStateSyncPublish\)/);
  assert.match(shutdown, /stateSyncPublisher.cancelPendingPublish\(\)/);
  assert.match(publisher, /stateSyncPublishTimer = scheduleTimeout\([\s\S]*?\}, 20\)/);
  assert.doesNotMatch(publisher, /setInterval\(/);
  assert.equal(source.includes("stateSyncConsistencyTimer"), false);
  assert.doesNotMatch(source, /setInterval\(publishStateChangesIfNeeded/);
});

test("synthetic Session progress is opt-in and its scheduler is released", async () => {
  const source = await readFile(sourceURL, "utf8");
  const activation = await readFile(new URL("../src/application/startupSessionActivation.mjs", import.meta.url), "utf8");
  const shutdown = await readFile(new URL("../src/application/backendShutdown.mjs", import.meta.url), "utf8");
  assert.match(source, /enableMockSessions: process\.env\.CORPTIE_ENABLE_MOCK_SESSIONS === "1"/);
  assert.match(activation, /if \(!developmentPreview && enableMockSessions\)[\s\S]*seedSessions\(\)/);
  const activity = await readFile(new URL("../src/application/backendRuntimeActivity.mjs", import.meta.url), "utf8");
  assert.match(activation, /runtimeActivity\.startMockTimer\(\)/);
  assert.match(activity, /this\.mockTimer = setInterval\(this\.updateMockProgress, 2500\)/);
  assert.match(shutdown, /shutdown[\s\S]*runtimeActivity\.stopTimers\(\)/);
  assert.match(activity, /clearInterval\(this\.mockTimer\)/);
});
