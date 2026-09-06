import { access, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute } from "node:path";

// Provider-independent setup state. Only adapter reply tests can mark a binary
// available; enabling a row never substitutes for a successful test.
export class FirstRunSetupService {
  constructor({ path, providers, hasWorks, firstWorkSession = () => null, findAssistantSession, createAssistantSession, onDefaultChanged = () => {} }) {
    Object.assign(this, { path, providers, hasWorks, firstWorkSession, findAssistantSession, createAssistantSession, onDefaultChanged });
    this.state = { providers: {}, completed: false };
    this.pending = Promise.resolve();
    this.checks = new Map();
  }

  async initialize() {
    try { this.state = JSON.parse(await readFile(this.path(), "utf8")); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.state = { providers: {}, completed: this.hasWorks() };
    }
  }

  command(id, fallback) {
    const saved = this.state.providers?.[id];
    return saved?.configuredPath || (saved?.confirmed ? saved.path : null) || fallback();
  }

  async row(provider) {
    const saved = this.state.providers?.[provider.id];
    const check = this.checks.get(provider.id);
    const path = check?.path ?? saved?.path ?? provider.discover();
    const fingerprint = await executableFingerprint(path);
    const available = Boolean(fingerprint && saved?.probe?.state === "available" && saved.probe.fingerprint === fingerprint);
    const checkState = check ? "checking" : (!fingerprint ? "missing" : (available ? "available"
      : (saved?.probe?.fingerprint === fingerprint ? saved.probe.state : "unknown")));
    return { id: provider.id, name: provider.name, path: fingerprint || saved || check ? path : "",
      executable: Boolean(fingerprint), enabled: !check && available && saved.enabled === true,
      checkState, message: checkState === "failed" ? saved.probe.message : null };
  }

  async status() {
    return { providers: await Promise.all(this.providers.map((p) => this.row(p))),
      completed: this.state.completed === true, hasWorks: this.hasWorks(),
      defaultProviderId: this.state.defaultProviderId ?? null,
      assistantSessionId: this.findAssistantSession()?.id ?? null,
      workSessionId: this.firstWorkSession()?.id ?? null };
  }

  serialize(operation) {
    const task = this.pending.then(operation);
    this.pending = task.catch(() => {});
    return task;
  }

  provider(id) {
    const provider = this.providers.find((p) => p.id === id);
    if (!provider) throw new Error("请选择支持的 Provider。");
    return provider;
  }

  check(input) {
    const provider = this.provider(input.providerId);
    const path = typeof input.path === "string" ? input.path.trim() : "";
    const running = this.checks.get(provider.id);
    if (running?.path === path) return running.promise;
    running?.controller.abort();
    const check = { path, controller: new AbortController() };
    this.checks.set(provider.id, check);
    check.promise = this.runCheck(provider, check).finally(() => {
      if (this.checks.get(provider.id) === check) this.checks.delete(provider.id);
    });
    return check.promise;
  }

  async runCheck(provider, check) {
    const previous = this.state.providers?.[provider.id];
    const configuredPath = previous?.configuredPath ?? (previous?.confirmed ? previous.path : null);
    const userDisabled = previous?.path === check.path && previous?.userDisabled === true;
    const fingerprint = await executableFingerprint(check.path);
    let message = null;
    let available = false;
    await this.serialize(async () => {
      if (this.checks.get(provider.id) !== check) return;
      await this.saveRow(provider.id, { path: check.path, enabled: false, userDisabled, configuredPath });
    });
    try {
      if (!fingerprint) throw new Error("请选择可执行文件。");
      const result = await provider.probe(check.path, { signal: check.controller.signal });
      if (result?.ok !== true) throw new Error("未收到有效回复，请重试。");
      if (await executableFingerprint(check.path) !== fingerprint) throw new Error("程序已变更，请重新检测。");
      available = true;
    } catch (error) { message = error.message; }
    return this.serialize(async () => {
      // A slow response from a replaced path must never enable the new path.
      if (this.checks.get(provider.id) !== check) return this.row(provider);
      try {
        if (available && !userDisabled) await provider.configure(check.path);
      } catch (error) { available = false; message = error.message; }
      this.checks.delete(provider.id);
      await this.saveRow(provider.id, { path: check.path, enabled: available && !userDisabled, userDisabled,
        configuredPath: available && !userDisabled ? check.path : configuredPath,
        probe: { state: available ? "available" : "failed", fingerprint, message, checkedAt: new Date().toISOString() } });
      return this.row(provider);
    });
  }

  setEnabled(input) {
    return this.serialize(async () => {
      const provider = this.provider(input.providerId);
      const row = await this.row(provider);
      if (typeof input.enabled !== "boolean") throw new Error("启用状态无效。");
      if (input.path !== row.path || row.checkState === "checking") throw new Error("路径已变更，请等待检测完成。");
      if (input.enabled && row.checkState !== "available") throw new Error("请先完成回复检测。");
      if (input.enabled) await provider.configure(row.path);
      await this.saveRow(provider.id, { ...this.state.providers[provider.id], enabled: input.enabled, userDisabled: !input.enabled,
        configuredPath: input.enabled ? row.path : this.state.providers[provider.id]?.configuredPath });
      return this.row(provider);
    });
  }

  async saveRow(id, row) {
    const providers = { ...this.state.providers, [id]: row };
    const enabled = this.providers.filter((p) => providers[p.id]?.enabled && providers[p.id]?.probe?.state === "available");
    const defaultProviderId = enabled.find((p) => p.id === this.state.defaultProviderId)?.id ?? enabled[0]?.id ?? null;
    await this.save({ ...this.state, providers, defaultProviderId });
    this.onDefaultChanged(defaultProviderId);
  }

  prepareAssistant() {
    return this.serialize(async () => {
      const status = await this.status();
      const selected = status.providers.find((p) => p.id === status.defaultProviderId && p.enabled)
        ?? status.providers.find((p) => p.enabled);
      if (!selected) throw new Error("请先启用至少一个可用 Provider。");
      if (selected.id !== this.state.defaultProviderId) {
        await this.save({ ...this.state, defaultProviderId: selected.id });
        this.onDefaultChanged(selected.id);
      }
      const existing = this.findAssistantSession();
      if (existing) return { sessionId: existing.id };
      await this.provider(selected.id).prepare?.();
      const session = await this.createAssistantSession(selected.id);
      return { sessionId: session.id };
    });
  }

  complete() {
    return this.serialize(async () => {
      const status = await this.status();
      if (!status.providers.some((p) => p.enabled) || !status.hasWorks || !status.assistantSessionId) {
        throw new Error("请先启用 Provider、准备 Corptie Chat，并创建第一个 Work。");
      }
      await this.save({ ...this.state, completed: true });
      return this.status();
    });
  }

  async save(state) {
    const path = this.path();
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.tmp`;
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
    await rename(temporary, path);
    this.state = state;
  }
}

async function executableFingerprint(path) {
  if (typeof path !== "string" || !isAbsolute(path)) return null;
  try {
    await access(path, constants.X_OK);
    const info = await stat(path);
    return info.isFile() ? JSON.stringify([await realpath(path), info.ino, info.size, info.mtimeMs]) : null;
  } catch { return null; }
}
