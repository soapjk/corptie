import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServerClient } from "./codexAppServer.mjs";
import { importCorptieCodexAuthentication } from "../runtime/corptieCodexRuntime.mjs";
import { PROVIDER_PROBE_PROMPT } from "../agent-provider/providers/providerReplyProbe.mjs";

export function createCodexEnvironmentSetup({ registry, environment, prepare, runtimeOptions,
  canImport = () => true, createClient = (options) => new CodexAppServerClient(options),
  prepareSelection = () => {},
  afterAuthentication = async () => {},
  onEnvironmentChanged = () => {},
  importAuthentication = importCorptieCodexAuthentication }) {
  const logins = new Map();
  const resolveEnvironment = (input) => registry.selection(input);
  const environmentDescriptor = (profile) => registry.descriptor(profile);
  const environmentFingerprint = (profile) => registry.fingerprint(profile);
  async function configureEnvironment(profile) {
    await prepareSelection(profile);
    await registry.register(profile, { makeDefault: true });
    onEnvironmentChanged(profile);
  }

  async function probe(path, { signal, environment: selected, model = "" } = {}) {
    const profile = await registry.validate(selected ?? registry.current);
    await prepare(profile);
    const fingerprint = await registry.fingerprint(profile);
    const client = createClient({ command: path, env: environment(profile, path), initializationTimeoutMs: 5000 });
    const abort = () => { void client.close(); };
    const cwd = await mkdtemp(join(tmpdir(), "corptie-codex-check-"));
    try {
      signal?.throwIfAborted();
      signal?.addEventListener("abort", abort, { once: true });
      await client.initialize();
      const account = await client.request("account/read", { refreshToken: false });
      if (account?.requiresOpenaiAuth === true && !account.account) {
        throw Object.assign(new Error("此 Codex 环境尚未登录，请登录后重新检测。"), { code: "PROVIDER_LOGIN_REQUIRED" });
      }
      const reply = await client.runEphemeralPrompt({ prompt: PROVIDER_PROBE_PROMPT, cwd,
        executionPolicy: "no-tools", permissionProfile: "read-only", model: model || undefined,
        rejectModelReroute: true, timeoutMs: 30_000, signal });
      if (reply.text?.trim() !== "CORPTIE_OK") throw Object.assign(new Error("未收到有效回复，请重新检测。"), { code: "PROVIDER_REPLY_INVALID" });
      signal?.throwIfAborted();
      if (fingerprint !== await registry.fingerprint(profile)) {
        throw Object.assign(new Error("Codex 配置在检测期间已变更，请重新检测。"), { code: "PROVIDER_CONFIGURATION_CHANGED" });
      }
      return { ok: true, environment: profile, environmentFingerprint: fingerprint, effectiveModel: reply.model ?? (model || null) };
    } catch (error) {
      // RPC/provider text can contain sensitive configuration. Expose only our
      // known actionable errors, never a raw transport/model diagnostic.
      if (["PROVIDER_LOGIN_REQUIRED", "PROVIDER_REPLY_INVALID", "PROVIDER_CONFIGURATION_CHANGED"].includes(error.code)) throw error;
      const info = error.providerErrorInfo;
      const variant = (typeof info === "string" ? info : info?.type ?? Object.keys(info ?? {})[0] ?? "").toLowerCase();
      const status = info?.httpStatusCode ?? info?.httpConnectionFailed?.httpStatusCode;
      if (variant === "unauthorized" || status === 401) {
        throw Object.assign(new Error("Codex 认证已失效，请在所选环境中重新登录。"), { code: "PROVIDER_LOGIN_REQUIRED" });
      }
      if (variant === "usagelimitexceeded" || status === 429) {
        throw Object.assign(new Error("Codex 额度或请求频率受限，请稍后重试。"), { code: "PROVIDER_USAGE_LIMIT" });
      }
      if (variant === "badrequest" || [400, 403, 404].includes(status)) {
        throw Object.assign(new Error("服务端拒绝了检测请求，请检查模型权限和配置，或检测较新的程序。"), { code: "PROVIDER_REQUEST_REJECTED" });
      }
      if (["responsestreamconnectionfailed", "responsestreamdisconnected", "responsetoomanyfailedattempts"].includes(variant) || status >= 500) {
        throw Object.assign(new Error("Codex 网络或服务异常，请稍后重试。"), { code: "PROVIDER_NETWORK_FAILED" });
      }
      if (error.rpcCode === -32601 || ["BACKGROUND_NO_TOOLS_RUNTIME_UNVERIFIED", "CAPABILITY_UNSUPPORTED", "METHOD_NOT_FOUND"].includes(error.code)) {
        throw Object.assign(new Error("此 Codex 程序不支持安全回复检测，请选择较新的兼容版本。"), { code: "PROVIDER_PROTOCOL_UNSUPPORTED" });
      }
      if (error.code === "BACKGROUND_TIMEOUT") throw Object.assign(new Error("检测超时，请重试。"), { code: "PROVIDER_CHECK_TIMEOUT" });
      if (error.code === "BACKGROUND_MODEL_REROUTED") throw Object.assign(new Error("检测模型被服务端切换，不能确认原模型可用。"), { code: "PROVIDER_MODEL_REROUTED" });
      if (signal?.aborted) throw new Error("检测已取消。");
      throw Object.assign(new Error("Codex 连接或回复检测失败，请检查程序版本、网络和所选环境的配置。"), { code: "PROVIDER_CONNECTION_FAILED" });
    } finally {
      signal?.removeEventListener("abort", abort);
      await client.close();
      await rm(cwd, { recursive: true, force: true });
    }
  }

  async function authentication(input) {
    const profile = await registry.validate(resolveEnvironment(input.environment));
    if (input.action === "import") {
      if (profile.mode !== "isolated" || input.confirmed !== true) throw new Error("仅可在独立环境中确认导入本机登录。");
      if (!canImport(profile)) throw new Error("此环境有正在执行的任务，请结束后再导入登录。");
      await prepare(profile);
      const imported = await importAuthentication({ ...runtimeOptions, codexHome: profile.home,
        sourceAuthPath: join(registry.nativeHome, "auth.json") });
      if (!imported) throw new Error("未找到可导入的本机登录，或独立环境已保存认证。请重新登录或重新检测。");
      await afterAuthentication(profile);
      return { state: "imported" };
    }
    if (input.action === "status" || input.action === "cancel") {
      const login = logins.get(input.loginId);
      if (!login || login.profileId !== profile.profileId) throw new Error("登录请求已失效，请重新登录。");
      if (input.action === "cancel") {
        await login.client.request("account/login/cancel", { loginId: input.loginId }).catch(() => {});
        await finishLogin(input.loginId);
        return { state: "cancelled" };
      }
      if (login.state !== "pending") {
        const state = login.state;
        await finishLogin(input.loginId);
        if (state === "completed") await afterAuthentication(profile);
        return { state };
      }
      return { state: "pending" };
    }
    if (input.action !== "login") throw new Error("认证操作无效。");
    if (!canImport(profile)) throw new Error("此环境有正在执行或尚未持久化的会话，请结束后再登录。");
    if (logins.size >= 2) throw new Error("已有登录正在进行，请先完成或取消。");
    await prepare(profile);
    let loginId;
    const client = createClient({ command: input.path, env: environment(profile),
      onNotification: (message) => {
        if (message.method === "account/login/completed" && message.params?.loginId === loginId) {
          const login = logins.get(loginId);
          if (login) login.state = message.params.success ? "completed" : "failed";
        }
      } });
    try {
      await client.initialize();
      const result = await client.request("account/login/start", { type: "chatgpt" });
      loginId = result.loginId;
      if (!loginId || !result.authUrl) throw new Error();
      const timer = setTimeout(() => { void finishLogin(loginId); }, 5 * 60_000);
      timer.unref?.();
      logins.set(loginId, { client, timer, profileId: profile.profileId, state: "pending" });
      return { state: "pending", loginId, authUrl: result.authUrl };
    } catch {
      await client.close();
      throw new Error("无法启动 Codex 登录，请检查程序版本，或在 Codex 中登录后重新检测。");
    }
  }
  async function finishLogin(id) {
    const login = logins.get(id);
    if (!login) return;
    logins.delete(id);
    clearTimeout(login.timer);
    await login.client.close();
  }
  return { resolveEnvironment, environmentDescriptor, environmentFingerprint, configureEnvironment, probe, authentication,
    assertNoPendingLogin() { if (logins.size) throw new Error("请先完成或取消正在进行的登录，再更改程序。"); } };
}
