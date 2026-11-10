import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, rm, realpath, lstat } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { CodexAppServerClient } from "./codexAppServer.mjs";

const fail = (code, message) => Object.assign(new Error(message), { code, statusCode: 409, dispatchState: "not_dispatched" });
const hash = value => createHash("sha256").update(value).digest("hex");
const now = () => new Date().toISOString();
const maskEmail = value => {
  if (typeof value !== "string" || !value.includes("@")) return null;
  const [name, domain] = value.split("@");
  return `${name.slice(0, 1)}***@${domain}`;
};

export function inspectCodexCredential(content) {
  if (typeof content !== "string" || Buffer.byteLength(content) > 256 * 1024) throw fail("CODEX_CREDENTIAL_INVALID", "凭证文件格式不受支持。");
  let value;
  try { value = JSON.parse(content); } catch { throw fail("CODEX_CREDENTIAL_INVALID", "无法解析所选凭证文件。"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail("CODEX_CREDENTIAL_INVALID", "凭证文件格式不受支持。");
  const text = value => typeof value === "string" && value.trim().length > 0;
  const token = value.tokens;
  let claims = {};
  try { claims = JSON.parse(Buffer.from(token?.id_token?.split(".")[1], "base64url").toString()); } catch { }
  const account = token?.account_id ?? claims["https://api.openai.com/auth"]?.chatgpt_account_id;
  if (text(token?.access_token) || text(token?.refresh_token)) {
    return { identity: text(account) ? hash(`chatgpt:${account}`) : null,
      kind: "chatgpt", label: maskEmail(claims.email) ?? "ChatGPT 账号", content: `${JSON.stringify(value)}\n` };
  }
  const key = value.OPENAI_API_KEY ?? value.personal_access_token;
  if (text(key)) return { identity: hash(`key:${key}`), kind: "apiKey", label: "API 凭证", content: `${JSON.stringify(value)}\n` };
  throw fail("CODEX_CREDENTIAL_INVALID", "未找到支持的 Codex 登录凭证。");
}

export function trustedCodexLoginURL(address) {
  try {
    const url = new URL(address);
    return url.protocol === "https:" && !url.username && !url.password
      && (url.hostname === "chatgpt.com" || url.hostname === "auth.openai.com" || url.hostname.endsWith(".openai.com"));
  } catch { return false; }
}

// Codex-only account resources. Execution and authorization still belong to Sessions.
// Credentials live exclusively in their profile's Home and never in the list projection.
export class CodexAccountManager {
  constructor({ path, registry, readSource, sourceKinds, candidates = [], prepare, environment, command,
    isBusy = () => false, bindingCount = () => 0, recycle = async () => {}, onSelected = async () => {},
    createClient = options => new CodexAppServerClient(options), loginTimeoutMs = 5 * 60_000 }) {
    Object.assign(this, { path, registry, readSource, sourceKinds, candidates, prepare, environment, command,
      isBusy, bindingCount, recycle, onSelected, createClient, loginTimeoutMs });
    this.accountRoot = join(dirname(registry.isolatedHome), "codex-accounts");
    this.state = { version: 1, accounts: {} };
    this.pending = Promise.resolve();
    this.logins = new Map();
    this.refreshes = new Map();
  }

  serial(operation) {
    const task = this.pending.then(operation);
    this.pending = task.catch(() => {});
    return task;
  }

  async initialize() {
    try {
      const saved = JSON.parse(await readFile(this.path(), "utf8"));
      if (saved.version !== 1 || !saved.accounts || Array.isArray(saved.accounts) || typeof saved.accounts !== "object") throw new Error();
      this.state = saved;
    } catch (error) {
      if (error.code !== "ENOENT") throw fail("CODEX_ACCOUNTS_INVALID", "账号列表损坏，已停止自动迁移，请恢复本地配置。");
    }
    let changed = false;
    for (const profile of Object.values(this.registry.state.profiles)) {
      if (this.state.accounts[profile.profileId]) continue;
      const credential = await this.credential(profile).catch(() => null);
      if (!credential && !this.bindingCount(profile)) continue;
      this.state.accounts[profile.profileId] = { id: profile.profileId, profileId: profile.profileId,
        name: profile.mode === "native" ? "原有原生环境" : "原有账号", legacy: true, owned: false,
        identity: credential?.identity ?? null, kind: credential?.kind ?? "legacy", createdAt: now() };
      changed = true;
    }
    // A server restart never restarts a login or rewrites an existing account's credentials.
    for (const record of Object.values(this.state.accounts)) {
      if (record.state === "signing_in") { record.state = record.updateFor ? "interrupted_update" : "needs_auth"; changed = true; }
    }
    if (changed) await this.persist();
  }

  async persist() {
    const path = this.path();
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(this.state), { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  }

  record(id) {
    const record = this.state.accounts[id];
    if (!record || record.deletedAt || record.removedFromListAt || !this.registry.state.profiles[record.profileId]) throw fail("CODEX_ACCOUNT_NOT_FOUND", "所选账号不存在，请重新选择。");
    return record;
  }

  profile(record) { return this.registry.state.profiles[record.profileId]; }

  async credential(profile) {
    const path = join(profile.home, "auth.json");
    const info = await lstat(path).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (!info) return null;
    if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024) throw fail("CODEX_CREDENTIAL_INVALID", "账号凭证文件不可用，请重新授权。");
    return inspectCodexCredential(await readFile(path, "utf8"));
  }

  async status(record) {
    const profile = this.profile(record);
    if (record.state === "signing_in" || record.state === "interrupted_update") return { state: record.state, label: null };
    try {
      const credential = await this.credential(profile);
      if (!credential) return { state: profile.mode === "native" ? "external" : "needs_auth", label: null };
      if (record.identity && credential.identity !== record.identity) return { state: "identity_changed", label: credential.label };
      return { state: "ready", label: credential.label };
    } catch { return { state: "needs_auth", label: null }; }
  }

  async list() {
    const current = this.registry.current.profileId;
    const accounts = [];
    for (const record of Object.values(this.state.accounts)) {
      if (record.deletedAt || record.removedFromListAt || record.state === "signing_in") continue;
      const profile = this.profile(record);
      if (!profile) continue;
      const count = this.bindingCount(profile), busy = this.isBusy(profile);
      const status = await this.status(record);
      const signingIn = [...this.logins.values()].some(login => login.state === "pending" && login.record.updateFor === record.id);
      const removesListingOnly = record.legacy && profile.mode === "native";
      const deletionReason = current === profile.profileId ? "请先选择其他当前使用账号并保存设置。"
        : removesListingOnly ? null : signingIn ? "请先完成或取消登录。"
          : record.legacy ? "原有环境保留，不自动删除其凭证或数据。"
            : count ? "仍有会话绑定此账号，不能删除。" : busy ? "账号正在使用，请等待请求结束。" : null;
      accounts.push({ id: record.id, name: record.name, accountLabel: status.label ?? "未验证账号",
        state: status.state, kind: record.kind, runtimeDirectory: profile.home,
        credentialPath: join(profile.home, "auth.json"), importedFrom: record.importedFrom ?? null,
        origin: record.legacy ? (profile.mode === "native" ? "native" : "legacy") : record.importedFrom ? "imported" : "login",
        isDefault: current === profile.profileId, isLegacy: Boolean(record.legacy), sessionCount: count,
        canSelect: status.state === "ready" && profile.mode === "isolated",
        canDelete: !deletionReason, removesListingOnly, deletionReason, canReauthorize: profile.mode === "isolated" && !busy,
        createdAt: record.createdAt });
    }
    const active = [...this.logins.values()].find(login => login.state === "pending");
    return { capabilities: { login: true, import: true, rename: true, update: true, delete: true },
      selectedAccountId: accounts.find(account => account.isDefault)?.id ?? null,
      accounts, sourceKinds: this.sourceKinds, candidates: this.candidates,
      activeLogin: active ? { id: active.id, state: "pending", authUrl: active.authUrl } : null };
  }

  name(value) {
    if (typeof value !== "string" || !value.trim() || value.trim().length > 80 || /[\r\n\0]/.test(value)) throw fail("CODEX_ACCOUNT_NAME_INVALID", "请输入不超过 80 个字符的账号名称。");
    return value.trim();
  }

  async allocate(name, extra = {}) {
    const accountName = this.name(name);
    await mkdir(this.accountRoot, { recursive: true, mode: 0o700 });
    const base = await realpath(this.accountRoot);
    if (base !== join(await realpath(dirname(this.accountRoot)), basename(this.accountRoot))) throw fail("CODEX_ACCOUNT_PATH_UNSAFE", "账号运行目录不能是符号链接。");
    const home = join(base, randomUUID());
    await mkdir(home, { mode: 0o700 });
    const profile = this.registry.profile("isolated", home);
    await this.registry.register(profile);
    const record = { id: profile.profileId, profileId: profile.profileId, name: accountName, owned: true,
      createdAt: now(), ...extra };
    this.state.accounts[record.id] = record;
    await this.persist();
    return record;
  }

  async validateSelection(id) {
    const record = this.record(id), profile = this.profile(record);
    if (profile.mode !== "isolated") throw fail("CODEX_ACCOUNT_IMPORT_REQUIRED", "请先将原生环境的凭证导入独立账号，再用于新会话。");
    if ((await this.status(record)).state !== "ready") throw fail("CODEX_ACCOUNT_NOT_READY", "所选账号尚未完成授权，或凭证与账号不匹配。");
    return record;
  }

  select(id) {
    return this.serial(async () => {
      const record = await this.validateSelection(id);
      await this.registry.register(this.profile(record), { makeDefault: true });
      await this.onSelected(this.profile(record));
    });
  }

  assertNoPendingLogin() {
    if ([...this.logins.values()].some(login => login.state === "pending")) {
      throw fail("CODEX_LOGIN_PENDING", "请先完成或取消正在进行的登录。");
    }
  }

  async executionAuthentication(profile, refresh, storageProfile) {
    await this.assertProfileReady(profile);
    if (!refresh && profile.mode === "native" && storageProfile?.profileId === profile.profileId) return null;
    const readAuth = async () => {
      const credential = await this.credential(profile);
      if (!credential) throw fail("CODEX_ACCOUNT_NOT_READY", "当前 Codex 账号缺少可用凭证。");
      const value = JSON.parse(credential.content);
      if (value.tokens?.access_token && value.tokens?.account_id) {
        return { type: "chatgptAuthTokens", accessToken: value.tokens.access_token,
          chatgptAccountId: value.tokens.account_id, chatgptPlanType: null };
      }
      if (!refresh && (value.OPENAI_API_KEY || value.personal_access_token) && storageProfile?.profileId === profile.profileId) return null;
      throw fail("CODEX_ACCOUNT_NOT_READY", "当前 Codex 凭证格式不支持独立执行。");
    };
    const previous = await readAuth();
    if (!refresh) return previous;
    if (previous.type !== "chatgptAuthTokens" || (refresh.previousAccountId && refresh.previousAccountId !== previous.chatgptAccountId)) {
      throw fail("CODEX_ACCOUNT_MISMATCH", "刷新请求与当前账号不匹配。");
    }
    const id = profile.profileId;
    if (!this.refreshes.has(id)) {
      const operation = this.serial(async () => {
        const current = await readAuth();
        if (current.accessToken !== previous.accessToken) return current;
        const client = this.createClient({ command: this.command(), env: this.environment(profile) });
        try {
          await client.initialize();
          await client.request("account/read", { refreshToken: true });
          await this.assertProfileReady(profile);
          const refreshed = await readAuth();
          if (refreshed.type !== previous.type || refreshed.chatgptAccountId !== previous.chatgptAccountId) {
            throw fail("CODEX_ACCOUNT_MISMATCH", "刷新后的凭证与当前账号不匹配。");
          }
          return refreshed;
        } finally { await client.close(); }
      }).finally(() => this.refreshes.delete(id));
      this.refreshes.set(id, operation);
    }
    return this.refreshes.get(id);
  }

  async assertProfileReady(profile = this.registry.current) {
    const record = this.state.accounts[profile.profileId];
    if (!record || record.deletedAt) throw fail("CODEX_ACCOUNT_REQUIRED", "请先指定账号：在账号列表中选择一个账号，或点击“添加账号”使用本机已有登录。");
    const status = await this.status(record);
    if (status.state !== "ready" && !(record.legacy && profile.mode === "native" && status.state === "external")) {
      throw fail("CODEX_ACCOUNT_NOT_READY", "此会话绑定的账号凭证不可用，请在账号列表中更新该账号的凭证；不会自动切换其他账号。");
    }
  }

  async replaceCredential(record, credential) {
    const profile = this.profile(record);
    if (profile.mode !== "isolated" || this.isBusy(profile)) throw fail("CODEX_ACCOUNT_BUSY", "账号正在使用或属于原生环境，不能替换凭证。");
    const target = join(profile.home, "auth.json");
    const original = await readFile(target).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    const newAccount = record.owned && !record.identity && !original && !this.bindingCount(profile);
    if (!newAccount && (!record.identity || record.identity !== credential.identity)) {
      throw fail("CODEX_ACCOUNT_MISMATCH", "凭证属于不同账号或无法确认身份，请添加为新账号；原账号未被覆盖。");
    }
    await this.recycle(profile);
    if (original) {
      const backup = join(profile.home, ".account-credential-backups");
      await mkdir(backup, { recursive: true, mode: 0o700 });
      await writeFile(join(backup, `${randomUUID()}.json`), original, { mode: 0o600, flag: "wx" });
    }
    await this.writeCredential(profile, credential.content);
    record.kind = credential.kind;
    record.identity = credential.identity;
    record.state = "ready";
    record.updatedAt = now();
    await this.persist();
  }

  async writeCredential(profile, content) {
    const target = join(profile.home, "auth.json"), temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
    await rename(temporary, target);
  }

  async importCredential(input) {
    if (!input.source || !this.sourceKinds.includes(input.source.kind) || typeof input.source.path !== "string"
      || !input.source.path.startsWith("/") || /[\0\r\n]/.test(input.source.path)) throw fail("CODEX_ACCOUNT_SOURCE_INVALID", "请选择支持的凭证来源和绝对路径。");
    let source;
    try { source = await this.readSource(input.source); } catch { throw fail("CODEX_ACCOUNT_SOURCE_UNAVAILABLE", "无法读取所选凭证，请检查路径、格式及系统钥匙串授权。"); }
    if (!source) throw fail("CODEX_ACCOUNT_SOURCE_UNAVAILABLE", "未找到已有凭证，请先登录官方工具或选择其他来源。");
    const credential = inspectCodexCredential(source.content);
    if (input.accountId) {
      const record = this.record(input.accountId);
      await this.replaceCredential(record, credential);
      return record;
    }
    const existing = Object.values(this.state.accounts).find(record => !record.deletedAt && this.profile(record)?.mode === "isolated" && credential.identity && record.identity === credential.identity);
    // Selecting a locally discovered login is idempotent: if that identity is
    // already registered, reuse it instead of rejecting the selection.
    if (existing) return existing;
    const record = await this.allocate(input.name ?? credential.label, { identity: credential.identity, kind: credential.kind,
      importedFrom: input.source.path });
    await this.prepare(this.profile(record));
    await this.writeCredential(this.profile(record), credential.content);
    return record;
  }

  async startLogin(input) {
    if ([...this.logins.values()].some(login => login.state === "pending")) throw fail("CODEX_LOGIN_PENDING", "请先完成或取消正在进行的登录。");
    const target = input.accountId ? this.record(input.accountId) : null;
    if (target && (this.profile(target).mode !== "isolated" || this.isBusy(this.profile(target)))) throw fail("CODEX_ACCOUNT_BUSY", "请等待该账号的当前请求结束后再重新授权。");
    const record = await this.allocate(target?.name ?? input.name ?? "Codex 账号", { state: "signing_in", updateFor: target?.id ?? null });
    const profile = this.profile(record);
    const login = { id: randomUUID(), record, state: "pending", providerLoginId: null, started: false };
    this.logins.set(login.id, login);
    try {
      await this.prepare(profile);
      login.client = this.createClient({ command: this.command(), env: this.environment(profile), initializationTimeoutMs: 5000,
        onNotification: message => {
          if (message.method !== "account/login/completed") return;
          if (login.providerLoginId && login.providerLoginId !== message.params?.loginId) return;
          login.outcome = Boolean(message.params?.success);
          if (login.started) void this.serial(() => this.finishLogin(login)).catch(() => {});
        } });
      await login.client.initialize();
      const result = await login.client.request("account/login/start", { type: "chatgpt" });
      if (!result.loginId || !trustedCodexLoginURL(result.authUrl)) throw new Error();
      login.providerLoginId = result.loginId;
      login.authUrl = result.authUrl;
      login.started = true;
      login.timer = setTimeout(() => { void this.serial(() => this.cancelLogin(login)).catch(() => {}); }, this.loginTimeoutMs);
      login.timer.unref?.();
      return { id: login.id, state: "pending", authUrl: login.authUrl };
    } catch {
      await login.client?.close().catch(() => {});
      login.state = "failed";
      await this.discardLoginCredential(record);
      await this.persist();
      throw fail("CODEX_LOGIN_FAILED", "无法启动官方登录，请检查 Codex 程序和网络后重试；原有账号未被修改。");
    }
  }

  async finishLogin(login) {
    if (login.state !== "pending" || login.outcome === undefined) return;
    if (!login.outcome) return this.cancelLogin(login);
    clearTimeout(login.timer);
    await login.client.close();
    try {
      const credential = await this.credential(this.profile(login.record));
      if (!credential) throw new Error();
      const target = login.record.updateFor ? this.record(login.record.updateFor) : null;
      if (target) {
        await this.replaceCredential(target, credential);
        await this.discardLoginCredential(login.record);
        login.accountId = target.id;
      } else {
        const duplicate = Object.values(this.state.accounts).find(record => record.id !== login.record.id && !record.deletedAt
          && this.profile(record)?.mode === "isolated" && credential.identity && record.identity === credential.identity);
        if (duplicate) throw fail("CODEX_ACCOUNT_EXISTS", "此账号已存在，请使用原账号的重新授权操作。");
        if (login.record.name === "Codex 账号") login.record.name = credential.label;
        Object.assign(login.record, { identity: credential.identity, kind: credential.kind, state: "ready" });
        login.accountId = login.record.id;
      }
      login.state = "completed";
      await this.persist();
    } catch (error) {
      login.state = "failed";
      login.message = error.statusCode === 409 ? error.message : "登录凭证未能安全保存，请重试；原有账号未被覆盖。";
      await this.discardLoginCredential(login.record);
      await this.persist();
    }
    delete login.authUrl;
  }

  async discardLoginCredential(record) {
    const profile = this.profile(record);
    await rm(join(profile.home, "auth.json"), { force: true });
    record.deletedAt = now();
  }

  async cancelLogin(login) {
    if (login.state !== "pending") return;
    clearTimeout(login.timer);
    await login.client?.request("account/login/cancel", { loginId: login.providerLoginId }).catch(() => {});
    await login.client?.close().catch(() => {});
    login.state = "cancelled";
    await this.discardLoginCredential(login.record);
    delete login.authUrl;
    await this.persist();
  }

  async remove(id) {
    const record = this.record(id), profile = this.profile(record);
    const row = (await this.list()).accounts.find(account => account.id === id);
    if (!row.canDelete) throw fail("CODEX_ACCOUNT_IN_USE", row.deletionReason);
    if (row.removesListingOnly) {
      // Native bindings still resolve through this record. Only hide the settings entry.
      record.removedFromListAt = now();
      try { await this.persist(); }
      catch (error) { delete record.removedFromListAt; throw error; }
      return;
    }
    const canonical = await realpath(profile.home);
    if (!record.owned || canonical !== profile.home || !canonical.startsWith(`${await realpath(this.accountRoot)}${sep}`)) {
      throw fail("CODEX_ACCOUNT_PATH_UNSAFE", "账号目录不属于 Corptie 管理，不能删除。");
    }
    await this.recycle(profile);
    await rm(join(canonical, "auth.json"), { force: true });
    await rm(join(canonical, ".account-credential-backups"), { recursive: true, force: true });
    record.deletedAt = now();
    await this.persist();
  }

  operation(input) {
    return this.serial(async () => {
      let flow = null;
      let discovered;
      let accountId = null;
      switch (input.action) {
        case "discover": {
          const inspected = await Promise.all(this.candidates.filter(source => source.kind !== "keychain").map(async source => {
            try {
              const result = await this.readSource(source);
              if (!result) return null;
              const credential = inspectCodexCredential(result.content);
              return { ...source, label: credential.label };
            } catch { return null; }
          }));
          discovered = inspected.filter(Boolean);
          break;
        }
        case "import": accountId = (await this.importCredential(input)).id; break;
        case "login": flow = await this.startLogin(input); break;
        case "rename": this.record(input.accountId).name = this.name(input.name); await this.persist(); break;
        case "delete": await this.remove(input.accountId); break;
        case "loginStatus": {
          const login = this.logins.get(input.loginId);
          if (!login) throw fail("CODEX_LOGIN_NOT_FOUND", "登录请求已结束或应用已重启，请重新登录。");
          await this.finishLogin(login);
          accountId = login.accountId ?? null;
          flow = { id: login.id, state: login.state, accountId: login.accountId ?? null, message: login.message ?? null };
          break;
        }
        case "cancelLogin": {
          const login = this.logins.get(input.loginId);
          if (login) await this.cancelLogin(login);
          break;
        }
        default: throw fail("CODEX_ACCOUNT_ACTION_INVALID", "账号操作无效。");
      }
      return { accounts: await this.list(), flow, discovered, accountId };
    });
  }

  async close() { await Promise.all([...this.logins.values()].map(login => this.cancelLogin(login))); }
}
