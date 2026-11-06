import { join } from "node:path";
import { stageNativeCodexThread } from "../../runtime/codexNativeThreadStorage.mjs";
import { CodexProviderRuntime } from "./codexProviderRuntime.mjs";
import { createReadinessRuntimeEpoch } from "../readinessRuntimeEpoch.mjs";

const threadMethods = new Set([
  "executeCommand", "bindThreadToolContext", "confirmThreadToolPlan", "restoreThreadToolPlanConfirmation",
  "archiveThread", "deleteThread", "execResumeThread", "ensureThreadResumed", "clearThreadGoal", "readLastThreadTurn",
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
  canRelease = () => true, assertProfileReady = async () => {}, accountAuthentication, resolveSourceThread = () => null, ...options }) {
  const runtimes = new Map();
  const activity = new Map();
  const prepared = new Map();
  const accountTransitions = new Map();
  const nativeMigrations = new Map();
  const executionAccount = () => accountAuthentication ? registry.current : null;
  const readinessEpoch = createReadinessRuntimeEpoch(threadId => {
    const profileId = registry.forThread(threadId).profileId;
    const runtime = runtimes.get(profileId);
    const accountId = executionAccount()?.profileId ?? null;
    const current = activity.get(profileId)?.accountId === accountId;
    return { object: current ? runtime?.client?.transport?.process : null,
      state: `${accountId ?? "legacy"}:${current && runtime?.client?.transport?.initialized === true ? "ready" : "not_ready"}` };
  });
  let replacingExecutable = false;
  const recyclable = (id, runtime) => typeof runtime.client === "object" && runtime.client !== null
    && canRelease(activity.get(id)?.profile)
    && !activity.get(id)?.inFlight
    && !activity.get(id)?.turns.size && !runtime.client.freshThreadIds?.size
    && !runtime.client.transport?.pending?.size
    && !runtime.client.serverRequestsByThread?.size
    && !runtime.client.threadResumePromises?.size
    && !runtime.client.recoveryStabilizationThreads?.size;
  const release = (id) => {
    const runtime = runtimes.get(id);
    activity.delete(id);
    runtimes.delete(id);
    prepared.delete(id);
    return runtime?.close().catch(() => {});
  };
  const assertProfileCapacity = (profile) => {
    if (runtimes.has(profile.profileId) || runtimes.size < maxEnvironments) return;
    throw Object.assign(new Error("已达到打开 Codex 环境的数量上限。已有环境将保持运行，无法继续打开新环境。"), { code: "PROVIDER_ENVIRONMENT_LIMIT" });
  };
  const runtimeFor = (profile, account = executionAccount()) => {
    if (replacingExecutable) throw Object.assign(new Error("Provider 程序正在切换，请稍后重试。"), { code: "PROVIDER_BUSY" });
    let runtime = runtimes.get(profile.profileId);
    if (!runtime) {
      assertProfileCapacity(profile);
      const state = { turns: new Set(), profile, accountId: account?.profileId ?? null, inFlight: 0 };
      activity.set(profile.profileId, state);
      runtime = createRuntime({ ...options, env: () => environment(profile),
        ...(account ? { accountAuthentication: refresh => accountAuthentication(account, refresh, profile) } : {}),
        onNotification: (message) => {
          const turns = state.turns;
          const turnId = message.params?.turn?.id;
          if (message.method === "turn/started" && turnId) turns?.add(turnId);
          if (message.method === "turn/completed" && turnId) turns?.delete(turnId);
          options.onNotification?.(message, profile);
        } });
      runtimes.set(profile.profileId, runtime);
    }
    // Keep shared Provider processes warm for the backend lifetime. Idleness
    // and capacity pressure must not terminate existing Sessions' runtimes.
    return runtime;
  };
  const switchError = (code, message) => Object.assign(new Error(message), {
    code, dispatchState: "not_dispatched"
  });
  const acquireExecutionRuntime = async (profile) => {
    if (!accountAuthentication) {
      await assertProfileReady(profile);
      return { runtime: runtimeFor(profile), release: () => {} };
    }
    const id = profile.profileId;
    const account = executionAccount();
    const pending = accountTransitions.get(id) ?? Promise.resolve();
    const operation = pending.catch(() => {}).then(async () => {
      await assertProfileReady(account);
      if (executionAccount().profileId !== account.profileId) {
        throw switchError("CODEX_ACCOUNT_SWITCH_SUPERSEDED", "当前账号已再次变更，请重新准备会话。");
      }
      const previous = runtimes.get(id);
      if (previous && activity.get(id)?.accountId !== account.profileId) {
        if (!recyclable(id, previous)) {
          throw switchError("CODEX_ACCOUNT_SWITCH_BUSY", "此 Codex 环境仍有任务、审批或未保存的线程，请等待后重试。");
        }
        const child = previous.client?.transport?.process;
        const exited = typeof child?.once === "function" && child.exitCode == null && child.signalCode == null
          ? new Promise(resolve => child.once("exit", resolve)) : null;
        await release(id);
        if (exited) {
          const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
          timer.unref?.();
          try { await exited; } finally { clearTimeout(timer); }
        }
      }
      if (executionAccount().profileId !== account.profileId) {
        throw switchError("CODEX_ACCOUNT_SWITCH_SUPERSEDED", "当前账号已再次变更，请重新准备会话。");
      }
      const runtime = runtimeFor(profile, account);
      const state = activity.get(id);
      state.inFlight++;
      return { runtime, release: () => { state.inFlight--; }, accountId: account.profileId };
    });
    accountTransitions.set(id, operation);
    try { return await operation; }
    finally { if (accountTransitions.get(id) === operation) accountTransitions.delete(id); }
  };
  const withExecutionRuntime = async (profile, operation) => {
    const lease = await acquireExecutionRuntime(profile);
    try { return await operation(lease.runtime); }
    finally { lease.release(); }
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
  const attachExistingThread = async (method, threadId, input, rest) => {
    const source = registry.forThread(threadId);
    const account = executionAccount();
    if (source.mode !== "native" || !account || account.mode === "native") {
      return withExecutionRuntime(source, async runtime => {
        try { return await runtime[method](threadId, await attach(source, input), ...rest); }
        catch (error) {
          if (account && account.profileId !== source.profileId && error?.code === "PROVIDER_SESSION_UNAVAILABLE") {
            throw switchError("CODEX_ACCOUNT_RESUME_FAILED", "当前账号无法恢复原 Codex 线程。请重试，原线程和历史仍保留。");
          }
          throw error;
        }
      });
    }
    if (nativeMigrations.has(threadId)) {
      await nativeMigrations.get(threadId);
      return attachExistingThread(method, threadId, input, rest);
    }
    const operation = (async () => {
      if (!canRelease(source)) throw switchError("CODEX_ACCOUNT_SWITCH_BUSY", "请等待此 Codex 环境的当前请求结束后重试。");
      const nativeRuntime = runtimeFor(source, null);
      if (!recyclable(source.profileId, nativeRuntime)) throw switchError("CODEX_ACCOUNT_SWITCH_BUSY", "原生 Codex 环境仍在使用，请稍后重试。");
      const { thread } = await nativeRuntime.readThreadStoragePath(threadId);
      if (thread?.id !== threadId) throw switchError("CODEX_NATIVE_THREAD_STORAGE_UNAVAILABLE", "无法核对原生 Codex 线程 ID。");
      const profile = registry.profile("isolated", join(registry.isolatedHome, "native-thread-storage", source.profileId.replace(":", "-")));
      await prepareProfile(profile);
      await stageNativeCodexThread({ sourceHome: source.home, targetHome: profile.home, threadId, rolloutPath: thread.path });
      const result = await withExecutionRuntime(profile, async runtime => runtime[method](threadId, await attach(source, input), ...rest));
      if (result?.thread?.id !== threadId || executionAccount()?.profileId !== account.profileId) {
        throw switchError("CODEX_ACCOUNT_SWITCH_SUPERSEDED", "原线程恢复未通过验证，请重试。");
      }
      await registry.register(profile, { threadId });
      if (recyclable(source.profileId, nativeRuntime)) await release(source.profileId);
      return result;
    })();
    nativeMigrations.set(threadId, operation);
    try { return await operation; }
    finally { if (nativeMigrations.get(threadId) === operation) nativeMigrations.delete(threadId); }
  };
  const target = {
    accountSwitchReadiness(threadId) {
      const account = executionAccount();
      if (!account || !threadId) return null;
      const profile = registry.forThread(threadId);
      const runtime = runtimes.get(profile.profileId);
      const current = activity.get(profile.profileId);
      if (current?.accountId === account.profileId && runtime?.client?.threadResumeFingerprints?.has(threadId)) return null;
      if (current?.turns.size || !canRelease(profile)) return null;
      return { state: "not_ready", reasonCode: "CODEX_ACCOUNT_RESUME_REQUIRED",
        message: "正在为当前 Codex 账号准备原会话。", retryable: true };
    },
    readinessRuntimeEpoch: readinessEpoch,
    async inspectThreadResume(threadId, input = {}) {
      const profile = registry.forThread(threadId);
      const runtime = runtimes.get(profile.profileId);
      if (!runtime || activity.get(profile.profileId)?.accountId !== (executionAccount()?.profileId ?? null)) {
        return { ready: false, canRetryVerification: true,
          runtimeEpoch: readinessEpoch(threadId), reasonCode: "PROVIDER_RESUME_OUTCOME_UNKNOWN" };
      }
      if (!prepared.has(profile.profileId)) {
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
    canUpdateExecutionAccount(profile) {
      return [...runtimes].every(([id, runtime]) =>
        activity.get(id)?.accountId !== profile.profileId || recyclable(id, runtime));
    },
    async recycleExecutionAccount(profile) {
      const matches = [...runtimes].filter(([id]) => activity.get(id)?.accountId === profile.profileId);
      if (matches.some(([id, runtime]) => !recyclable(id, runtime))) {
        throw switchError("CODEX_ACCOUNT_SWITCH_BUSY", "此账号仍有请求正在执行，请等待后重试。");
      }
      await Promise.all(matches.map(([id]) => release(id)));
    },
    async initialize() {
      const profile = registry.current;
      await prepareProfile(profile);
      return runtimeFor(profile).initialize();
    },
    async startThread(input = {}) {
      const sourceThreadId = input.sourceThreadId ?? resolveSourceThread(input);
      const profile = sourceThreadId ? registry.forThread(sourceThreadId) : registry.current;
      return withExecutionRuntime(profile, async runtime => {
        const result = await runtime.startThread(await attach(profile, input));
        try { await registry.register(profile, { threadId: result.thread.id }); }
        catch (error) { await runtime.archiveThread(result.thread.id).catch(() => {}); throw error; }
        return result;
      });
    },
    async forkThread(threadId, input = {}) {
      const profile = registry.forThread(threadId);
      return withExecutionRuntime(profile, async runtime => {
        const result = await runtime.forkThread(threadId, await attach(profile, input));
        try { await registry.register(profile, { threadId: result.thread.id }); }
        catch (error) { await runtime.archiveThread(result.thread.id).catch(() => {}); throw error; }
        return result;
      });
    },
    async runEphemeralPrompt(input = {}) {
      const profile = registry.current;
      return withExecutionRuntime(profile, async runtime => {
        await prepareProfile(profile);
        return runtime.runEphemeralPrompt(input.executionPolicy === "no-tools" ? input : await attach(profile, input));
      });
    },
    async readAccountRateLimits(threadId) {
      const profile = accountAuthentication ? registry.current : threadId ? registry.forThread(threadId) : registry.current;
      return withExecutionRuntime(profile, runtime => runtime.readAccountRateLimits());
    },
    async close() {
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
      if (attachmentMethods.has(property)) {
        return attachExistingThread(property, threadId, args[0], args.slice(1));
      }
      if (property === "startTurn" || (accountAuthentication && property === "executeCommand")) {
        return withExecutionRuntime(profile, runtime => {
          if (accountAuthentication && !runtime.client?.threadResumeFingerprints?.has(threadId)) {
            throw switchError("CODEX_ACCOUNT_SWITCH_PREPARATION_REQUIRED", "请重新准备此会话后再发送消息。");
          }
          return runtime[property](threadId, ...args);
        });
      }
      return runtimeFor(profile)[property](threadId, ...args);
    };
    delegates.set(property, delegate);
    return delegate;
  } });
}
