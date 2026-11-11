import { mkdir, readFile, writeFile, rename, stat, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createHash } from "node:crypto";

const digest = value => createHash("sha256").update(value).digest("hex");
const failure = (code, message) => Object.assign(new Error(message), { code, dispatchState: "not_dispatched" });

// Shared settings lifecycle. Credential formats and supported sources belong to adapters.
export class ProviderRuntimeSettings {
  constructor({ path, adapters, isBusy = () => false, onChanged = async () => {} }) {
    Object.assign(this, { path, adapters, externalBusy: isBusy, onChanged });
    this.leases = new Map();
    this.sources = {};
    this.preparedConnections = new Map();
    this.pending = Promise.resolve();
  }

  async initialize() {
    try {
      const saved = JSON.parse(await readFile(this.path(), "utf8"));
      if (saved.version !== 1 || !saved.sources || typeof saved.sources !== "object" || Array.isArray(saved.sources)) {
        throw failure("PROVIDER_SOURCE_SETTINGS_INVALID", "凭证来源设置损坏，请恢复本地配置。");
      }
      this.sources = saved.sources;
    }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    for (const [id, adapter] of Object.entries(this.adapters)) {
      await mkdir(adapter.runtimeDirectory, { recursive: true, mode: 0o700 });
      if (this.sources[id] && adapter.target) {
        await this.markManagedSource(adapter, this.sources[id]);
        if (adapter.executionEnvironment) {
          const check = await this.inspect(id);
          if (check.value && this.sources[id].revision === digest(check.value.content)) this.prepareEnvironment(id, check.value);
        }
      }
    }
  }

  isBusy(id) {
    return (this.leases.get(id) ?? 0) > 0 || this.externalBusy(id);
  }

  acquire(id) {
    this.leases.set(id, (this.leases.get(id) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.leases.set(id, Math.max(0, this.leases.get(id) - 1));
    };
  }

  serialize(operation) {
    const task = this.pending.then(operation);
    this.pending = task.catch(() => {});
    return task;
  }

  adapter(id) {
    const adapter = this.adapters[id];
    if (!adapter) throw failure("PROVIDER_SETTINGS_UNSUPPORTED", "此执行引擎不支持运行配置设置。");
    return adapter;
  }

  async inspect(id, source = this.sources[id]) {
    const adapter = this.adapter(id);
    if (!adapter.read) return { state: "unsupported", message: adapter.unsupportedReason };
    if (!source) {
      const legacy = adapter.target && (await stat(adapter.target).catch(() => null))?.isFile();
      return legacy ? { state: "legacy", message: "沿用旧运行环境中的凭证，尚未指定官方来源；请选择后续同步的来源。" }
        : { state: "unselected", message: "请选择官方工具已有的登录凭证来源。" };
    }
    try {
      const value = await adapter.read(source);
      if (!value) return { state: "missing", message: "未找到登录凭证，请先在官方 CLI 或 App 中登录。" };
      return { state: "found", message: "已找到凭证；有效性需通过连接检测确认。", value };
    } catch {
      return { state: "unavailable", message: "无法读取所选凭证，请检查路径、权限及文件格式。不会改用其他来源。" };
    }
  }

  async describe(id) {
    const adapter = this.adapter(id), source = this.sources[id];
    const check = await this.inspect(id);
    const changed = check.value && ((source?.identity && check.value.identity && source.identity !== check.value.identity)
      || (!source?.identity && source?.revision && source.revision !== digest(check.value.content)));
    return { runtimeDirectory: adapter.runtimeDirectory, credentialTarget: adapter.target ?? null,
      formatDescription: adapter.formatDescription ?? null,
      reuseMethod: adapter.read ? "synchronize" : "unsupported", sourceKinds: adapter.sourceKinds ?? [],
      candidates: await Promise.all((adapter.candidates ?? []).map(async candidate => {
        const local = await this.inspect(id, candidate);
        return { ...candidate, state: local.state };
      })),
      source: source ? { kind: source.kind, path: source.path } : null,
      state: changed ? "account_changed" : check.state,
      message: changed ? "来源中的账号或凭证内容已变更，请点击“保存设置”确认。" : check.message,
      sourceChanged: Boolean(check.value && source?.revision !== digest(check.value.content)),
      ...(adapter.describeConnection ? { connection: adapter.describeConnection(check.value) } : {}) };
  }

  async validateSource(id, input) {
    const adapter = this.adapter(id);
    if (!adapter.sourceKinds?.includes(input.kind)) throw failure("PROVIDER_SOURCE_UNSUPPORTED", "此执行引擎不支持所选凭证来源类型。");
    if (typeof input.path !== "string" || !isAbsolute(input.path) || /[\0\r\n]/.test(input.path)) {
      throw failure("PROVIDER_SOURCE_INVALID", "请选择凭证来源的绝对路径。");
    }
    const source = { kind: input.kind, path: resolve(input.path) };
    const canonicalSource = await realpath(source.path).catch(() => source.path);
    const canonicalRuntime = await realpath(adapter.runtimeDirectory).catch(() => resolve(adapter.runtimeDirectory));
    const managedConnection = source.kind === "connection" && adapter.managedConnectionPath
      && source.path === resolve(adapter.managedConnectionPath);
    if (!managedConnection && (canonicalSource === canonicalRuntime || canonicalSource.startsWith(`${canonicalRuntime}/`))) {
      throw failure("PROVIDER_SOURCE_INVALID", "凭证来源必须是官方工具的登录环境，不能是 Corptie 的目标目录。");
    }
    if (this.isBusy(id)) throw failure("PROVIDER_BUSY", "此引擎有正在执行的请求，请结束后再更改凭证来源。");
    const check = await this.inspect(id, source);
    if (!check.value) throw failure("PROVIDER_SOURCE_UNAVAILABLE", check.message);
    return { adapter, source, check };
  }

  prepareEnvironment(id, value) {
    const adapter = this.adapter(id);
    if (!adapter.executionEnvironment) return;
    this.preparedConnections.set(id, {
      env: adapter.executionEnvironment(value),
      metadata: adapter.describeConnection?.(value)?.current ?? null
    });
  }

  executionEnvironment(id, environment) {
    return { ...environment, ...(this.preparedConnections.get(id)?.env ?? {}) };
  }

  connectionMetadata(id) {
    return this.preparedConnections.get(id)?.metadata ?? null;
  }

  async markManagedSource(adapter, source) {
    if (!adapter.target) return;
    const marker = join(dirname(adapter.target), ".corptie-source-managed");
    if (!source) return unlink(marker).catch(error => { if (error.code !== "ENOENT") throw error; });
    await writeFile(marker,
      adapter.sourceManagesConnection?.(source) ? "connection" : "", { mode: 0o600 });
  }

  validateConnection(id, input) {
    const adapter = this.adapter(id);
    if (!adapter.validateConnection || !adapter.stageConnection) throw failure("PROVIDER_CONNECTION_UNSUPPORTED", "此执行引擎不支持手动模型来源。");
    if (this.isBusy(id)) throw failure("PROVIDER_BUSY", "此引擎正在执行，请结束后再修改模型来源。");
    const normalized = adapter.validateConnection(input);
    if (normalized.credential == null) {
      const current = this.connectionMetadata(id);
      if (this.sources[id]?.kind !== "connection" || !current?.credentialConfigured || current.authType !== normalized.authType) {
        throw failure("PROVIDER_CONNECTION_INVALID", "请填写此模型来源的密钥。");
      }
    }
    return normalized;
  }

  saveConnection(id, input) {
    return this.serialize(async () => {
      const normalized = this.validateConnection(id, input);
      const adapter = this.adapter(id);
      const previous = this.sources;
      const staged = await adapter.stageConnection(normalized, previous[id]);
      try {
        await staged.write();
        return await this.commitSource(id, await this.validateSource(id, staged.source));
      } catch (error) {
        await staged.restore();
        if (this.sources !== previous) {
          this.sources = previous;
          await this.persist();
          await this.markManagedSource(adapter, previous[id]);
          this.preparedConnections.delete(id);
          if (previous[id]) {
            const restored = await this.inspect(id);
            if (restored.value) this.prepareEnvironment(id, restored.value);
          }
        }
        throw error;
      }
    });
  }

  saveSource(id, input) {
    return this.serialize(async () => this.commitSource(id, await this.validateSource(id, input)));
  }

  async commitSource(id, { adapter, source, check }) {
    const previous = this.sources;
    this.sources = { ...previous, [id]: { ...source, identity: check.value.identity ?? null,
      revision: digest(check.value.content) } };
    try { await this.persist(); }
    catch (error) { this.sources = previous; throw error; }
    try { await adapter.onSourceApplied?.(); }
    catch (error) { this.sources = previous; await this.persist(); throw error; }
    await this.markManagedSource(adapter, source);
    this.preparedConnections.delete(id);
    this.prepareEnvironment(id, check.value);
    await this.onChanged(id);
    return this.describe(id);
  }

  async prepareExecution(id, args) {
    const adapter = this.adapter(id);
    if (this.sources[id]) await adapter.assertExecutionScope?.(args[0]);
    else if (adapter.usesLegacyEnvironment?.(args[0])) return;
    await this.sync(id);
  }

  sync(id) {
    return this.serialize(async () => {
      const adapter = this.adapter(id), source = this.sources[id];
      // Older installs retain their adopted local credentials until a source is explicitly selected.
      if (!adapter.read) return;
      if (!source) {
        if (adapter.usesLegacyEnvironment?.()) return;
        if ((await stat(adapter.target).catch(() => null))?.isFile()) return;
        throw failure("PROVIDER_SOURCE_REQUIRED", "请在执行引擎设置中选择官方登录凭证来源并保存设置。");
      }
      const check = await this.inspect(id, source);
      if (!check.value) throw failure("PROVIDER_SOURCE_UNAVAILABLE", check.message);
      if ((source.identity && check.value.identity && source.identity !== check.value.identity)
        || (!source.identity && source.revision !== digest(check.value.content))) {
        await this.onChanged(id);
        throw failure("PROVIDER_ACCOUNT_CHANGED", "账号或无法识别账号的凭证内容已变更，请在执行引擎设置中确认来源并保存设置。");
      }
      this.prepareEnvironment(id, check.value);
      const sourceContent = check.value.content;
      const target = adapter.targetForSource?.(source) ?? adapter.target;
      const previous = await readFile(target, "utf8").catch(error => {
        if (error.code === "ENOENT") return null;
        throw failure("PROVIDER_CREDENTIAL_UNAVAILABLE", "无法访问独立运行目录中的凭证。");
      });
      const content = adapter.targetContent?.(source, sourceContent, previous) ?? sourceContent;
      const revision = digest(sourceContent);
      // Preserve tokens refreshed by the Provider while the official source is unchanged.
      if (previous !== null && source.revision === revision && source.syncedRevision === revision) return;
      if (this.isBusy(id)) throw failure("PROVIDER_BUSY", "凭证来源已更新，请等待当前请求结束后重试。");
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const temporary = `${target}.source-${process.pid}`;
      await writeFile(temporary, content, { mode: 0o600 });
      await rename(temporary, target);
      this.sources[id] = { ...source, revision, syncedRevision: revision };
      await this.persist();
      await adapter.afterSync?.(source);
      await this.onChanged(id);
    });
  }

  async persist() {
    const path = this.path();
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, sources: this.sources }), { mode: 0o600 });
    await rename(temporary, path);
  }
}

// Structural validation only; no authentication or model request is performed here.
export function jsonCredentialReader({ fileName, validate, identity = () => null }) {
  return async source => {
    const path = source.kind === "directory" ? join(source.path, fileName) : source.path;
    const info = await stat(path).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (!info) return null;
    if (!info.isFile() || info.size > 256 * 1024) throw new Error("Unsupported credential file");
    const data = JSON.parse(await readFile(path, "utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data) || !validate(data)) return null;
    const account = identity(data);
    return { content: `${JSON.stringify(data)}\n`, identity: account ? digest(account) : null };
  };
}
