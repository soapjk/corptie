import { CodexProviderRuntime } from "./codexProviderRuntime.mjs";
import { createReadinessRuntimeEpoch } from "../readinessRuntimeEpoch.mjs";

const threadMethods = new Set([
  "executeCommand", "bindThreadToolContext", "confirmThreadToolPlan", "restoreThreadToolPlanConfirmation",
  "archiveThread", "deleteThread", "execResumeThread", "ensureThreadResumed", "clearThreadGoal",
  "interruptTurn", "probeTurnExecution", "inspectEmptyThreadForRouteCommit", "liveItemsForThread",
  "attachManagedImagesToLiveItem", "readThreadForLegacyHistoryRepair", "respondToApproval",
  "respondToUserInput", "resumeThread", "setThreadName", "stabilizeRecoveryThread", "startTurn",
  "tokenUsageForThread", "updateThreadSettings", "unarchiveThread"
]);
const attachmentMethods = new Set(["resumeThread", "ensureThreadResumed", "inspectEmptyThreadForRouteCommit", "stabilizeRecoveryThread"]);

// Multiplexing stays entirely behind the existing Codex adapter port. Persist
// the provider-thread environment before publishing a newly created Session.
export function createCodexEnvironmentRuntime({ registry, environment, prepare, instructions,
  createRuntime = (options) => new CodexProviderRuntime(options), maxEnvironments = 4,
  canRelease = () => true, resolveSourceThread = () => null, ...options }) {
  const runtimes = new Map();
  const activity = new Map();
  const prepared = new Map();
  const readinessEpoch = createReadinessRuntimeEpoch(threadId => {
    const runtime = runtimes.get(registry.forThread(threadId).profileId);
    return { object: runtime?.client?.transport?.process,
      state: runtime?.client?.transport?.initialized === true ? "ready" : "not_ready" };
  });
  let replacingExecutable = false;
  const recyclable = (id, runtime) => typeof runtime.client === "object" && runtime.client !== null
    && canRelease(activity.get(id)?.profile)
    && !activity.get(id)?.turns.size && !runtime.client.freshThreadIds?.size
    && !runtime.client.transport?.pending?.size
    && !runtime.client.serverRequestsByThread?.size
    && !runtime.client.threadResumePromises?.size
    && !runtime.client.recoveryStabilizationThreads?.size;
  const release = (id) => {
    const runtime = runtimes.get(id);
    clearTimeout(activity.get(id)?.timer);
    activity.delete(id);
    runtimes.delete(id);
    prepared.delete(id);
    return runtime?.close().catch(() => {});
  };
  const assertProfileCapacity = (profile) => {
    if (runtimes.has(profile.profileId) || runtimes.size < maxEnvironments) return;
    const idle = [...runtimes.entries()].find(([id, runtime]) => recyclable(id, runtime));
    if (idle) { void release(idle[0]); return; }
    throw Object.assign(new Error("已打开多个正在使用的 Codex 环境，请结束任务后再切换。已有会话不会被终止。"), { code: "PROVIDER_ENVIRONMENT_LIMIT" });
  };
  const scheduleIdleRelease = (id) => {
    const entry = activity.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      const runtime = runtimes.get(id);
      if (runtime && recyclable(id, runtime)) void release(id);
      else scheduleIdleRelease(id);
    }, 5 * 60_000);
    entry.timer.unref?.();
  };
  const runtimeFor = (profile) => {
    if (replacingExecutable) throw Object.assign(new Error("Provider 程序正在切换，请稍后重试。"), { code: "PROVIDER_BUSY" });
    let runtime = runtimes.get(profile.profileId);
    if (!runtime) {
      assertProfileCapacity(profile);
      activity.set(profile.profileId, { turns: new Set(), profile });
      runtime = createRuntime({ ...options, env: () => environment(profile),
        onNotification: (message) => {
          const turns = activity.get(profile.profileId)?.turns;
          const turnId = message.params?.turn?.id;
          if (message.method === "turn/started" && turnId) turns?.add(turnId);
          if (message.method === "turn/completed" && turnId) turns?.delete(turnId);
          options.onNotification?.(message, profile);
        } });
      runtimes.set(profile.profileId, runtime);
    }
    scheduleIdleRelease(profile.profileId);
    return runtime;
  };
  const prepareProfile = async (profile) => {
    if (!prepared.has(profile.profileId)) {
      const pending = Promise.resolve().then(() => prepare(profile));
      prepared.set(profile.profileId, pending);
      pending.catch(() => prepared.delete(profile.profileId));
    }
    return prepared.get(profile.profileId);
  };
  const attach = async (profile, input = {}) => {
    await prepareProfile(profile);
    if (profile.mode !== "native" || input.baseInstructions !== undefined) return input;
    return { ...input, developerInstructions: [await instructions(profile), input.developerInstructions].filter(Boolean).join("\n\n") };
  };
  const target = {
    readinessRuntimeEpoch: readinessEpoch,
    async inspectThreadResume(threadId, input = {}) {
      const profile = registry.forThread(threadId);
      const runtime = runtimes.get(profile.profileId);
      if (!runtime || !prepared.has(profile.profileId)) {
        return { ready: false, reasonCode: "PROVIDER_RESUME_OUTCOME_UNKNOWN" };
      }
      await prepared.get(profile.profileId);
      const options = profile.mode === "native" && input.baseInstructions === undefined
        ? { ...input, developerInstructions: [await instructions(profile), input.developerInstructions].filter(Boolean).join("\n\n") }
        : input;
      const epoch = readinessEpoch(threadId);
      const proof = await runtime.inspectThreadResume(threadId, options);
      if (runtime !== runtimes.get(profile.profileId) || epoch !== readinessEpoch(threadId)) {
        return { ready: false, reasonCode: "PROVIDER_RESUME_OUTCOME_UNKNOWN" };
      }
      return { ...proof, runtimeEpoch: epoch };
    },
    async withExecutableTransition(operation) {
      target.assertExecutableChangeAllowed();
      replacingExecutable = true;
      try { return await operation(); }
      finally { replacingExecutable = false; }
    },
    runningPrograms() {
      return [...runtimes.entries()].flatMap(([profileId, runtime]) => {
        const transport = runtime.client?.transport;
        return transport?.process && transport.runningCommand ? [{ profileId,
          path: transport.runningCommand, pid: transport.process.pid,
          initialized: transport.initialized }] : [];
      });
    },
    assertExecutableChangeAllowed() {
      if (replacingExecutable || [...runtimes.entries()].some(([id, runtime]) => !recyclable(id, runtime))) {
        throw new Error("此 Provider 正在执行、审批或恢复，请结束后再更改程序。");
      }
    },
    get notifications() { return runtimeFor(registry.current).notifications; },
    runtimeFor,
    assertProfileCapacity,
    canRefreshAuthentication(profile) {
      const runtime = runtimes.get(profile.profileId);
      return !runtime || recyclable(profile.profileId, runtime);
    },
    async refreshAuthentication(profile) {
      const runtime = runtimes.get(profile.profileId);
      if (runtime && recyclable(profile.profileId, runtime)) await release(profile.profileId);
    },
    async initialize() {
      const profile = registry.current;
      await prepareProfile(profile);
      return runtimeFor(profile).initialize();
    },
    async startThread(input = {}) {
      const sourceThreadId = input.sourceThreadId ?? resolveSourceThread(input);
      const profile = sourceThreadId ? registry.forThread(sourceThreadId) : registry.current;
      const runtime = runtimeFor(profile);
      const result = await runtime.startThread(await attach(profile, input));
      try { await registry.register(profile, { threadId: result.thread.id }); }
      catch (error) { await runtime.archiveThread(result.thread.id).catch(() => {}); throw error; }
      return result;
    },
    async forkThread(threadId, input = {}) {
      const profile = registry.forThread(threadId);
      const runtime = runtimeFor(profile);
      const result = await runtime.forkThread(threadId, await attach(profile, input));
      try { await registry.register(profile, { threadId: result.thread.id }); }
      catch (error) { await runtime.archiveThread(result.thread.id).catch(() => {}); throw error; }
      return result;
    },
    async runEphemeralPrompt(input = {}) {
      const profile = registry.current;
      await prepareProfile(profile);
      return runtimeFor(profile).runEphemeralPrompt(input.executionPolicy === "no-tools" ? input : await attach(profile, input));
    },
    async readAccountRateLimits(threadId) {
      return runtimeFor(threadId ? registry.forThread(threadId) : registry.current).readAccountRateLimits();
    },
    async close() {
      for (const entry of activity.values()) clearTimeout(entry.timer);
      activity.clear();
      await Promise.all([...runtimes.values()].map((runtime) => runtime.close())); runtimes.clear(); prepared.clear();
    }
  };
  const delegates = new Map();
  return new Proxy(target, { get(object, property) {
    if (property in object) return object[property];
    if (!threadMethods.has(property)) return undefined;
    if (delegates.has(property)) return delegates.get(property);
    const delegate = (threadId, ...args) => {
      const profile = registry.forThread(threadId);
      const runtime = runtimeFor(profile);
      if (attachmentMethods.has(property)) {
        return attach(profile, args[0]).then((input) => runtime[property](threadId, input, ...args.slice(1)));
      }
      return runtime[property](threadId, ...args);
    };
    delegates.set(property, delegate);
    return delegate;
  } });
}
