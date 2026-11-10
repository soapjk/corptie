import { logError } from "../utils/errorDiagnostics.mjs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { executableFingerprint } from "./providerExecutableDiscovery.mjs";

// Provider-independent setup state. Only adapter reply tests can mark a binary
// available; enabling a row never substitutes for a successful test.
export class FirstRunSetupService {
  constructor({ path, providers, hasWorks, hasProviderUsage = () => false, runtimeSettings = null, firstWorkSession = () => null, findAssistantSession, createAssistantSession, ensureAssistantGreeting = async () => {}, onDefaultChanged = () => {} }) {
    Object.assign(this, { path, providers, hasWorks, hasProviderUsage, runtimeSettings, firstWorkSession, findAssistantSession, createAssistantSession, ensureAssistantGreeting, onDefaultChanged });
    this.state = { providers: {}, completed: false };
    this.pending = Promise.resolve();
    this.settingsPending = Promise.resolve();
    this.checks = new Map();
  }

  async initialize() {
    try { this.state = JSON.parse(await readFile(this.path(), "utf8")); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.state = { providers: {}, completed: false };
    }
    // Existing installations must never re-enter onboarding on restart, even
    // if an older build left an incomplete first-run marker behind.
    if (!this.state.completed && this.hasWorks()) await this.save({ ...this.state, completed: true });
    // Older installations already execute sessions without an onboarding row.
    // Carry that existing use forward as intent, without fabricating reply proof.
    if (this.state.completed) {
      const providers = { ...this.state.providers };
      let changed = false;
      for (const provider of this.providers) {
        const saved = providers[provider.id];
        if (typeof saved?.enabled === "boolean" || saved?.userDisabled === true
          || !this.hasProviderUsage(provider.id)) continue;
        providers[provider.id] = { ...saved, enabled: true };
        changed = true;
      }
      if (changed) await this.save({ ...this.state, providers });
    }
    await Promise.all(this.providers.filter(p => p.programDiscovery).map(p =>
      p.programDiscovery.scan({ additionalPaths: [this.state.providers[p.id]?.configuredPath,
        this.state.providers[p.id]?.path].filter(Boolean) })));
  }

  command(id, fallback) {
    const saved = this.state.providers?.[id];
    const discovery = this.providers.find(p => p.id === id)?.programDiscovery;
    return discovery?.controlledPath() || (discovery && saved?.selectionMode !== "manual"
      ? discovery.describe().recommendedPath : null) || saved?.configuredPath || (saved?.confirmed ? saved.path : null)
      || discovery?.describe().recommendedPath || fallback();
  }

  async row(provider) {
    const saved = this.state.providers?.[provider.id];
    const check = this.checks.get(provider.id);
    const program = provider.programDiscovery?.describe(saved);
    const path = check?.path ?? (["controlled", "auto"].includes(program?.mode) && program.recommendedPath ? program.recommendedPath :
      saved?.configuredPath ?? saved?.path ?? program?.recommendedPath ?? provider.discover());
    const fingerprint = await executableFingerprint(path);
    const environment = provider.environmentDescriptor?.();
    const environmentFingerprint = environment ? await provider.environmentFingerprint(environment) : null;
    const environmentMatches = !environment || saved?.probe?.environmentFingerprint === environmentFingerprint;
    const accounts = await provider.accounts?.list();
    const runtime = !accounts && this.runtimeSettings ? await this.runtimeSettings.describe(provider.id) : null;
    const sourceUnchanged = !runtime || (!runtime.sourceChanged && !["account_changed", "unavailable", "missing"].includes(runtime.state));
    const available = Boolean(sourceUnchanged && fingerprint && environmentMatches && saved?.probe?.state === "available" && saved.probe.fingerprint === fingerprint);
    const checkState = check ? "checking" : (!fingerprint ? "missing" : (available ? "available"
      : (sourceUnchanged && environmentMatches && saved?.probe?.fingerprint === fingerprint ? saved.probe.state : "unknown")));
    return { id: provider.id, name: provider.name, path: fingerprint || saved || check ? path : "",
      executable: Boolean(fingerprint), enabled: saved?.enabled === true && saved?.userDisabled !== true,
      checkState, message: checkState === "failed" ? saved.probe.message : null,
      ...(runtime ? { runtime } : {}),
      ...(accounts ? { accounts } : {}),
      lastCheckedAt: saved?.probe?.checkedAt ?? null,
      ...(environment ? { environment } : {}),
      ...(program ? { program: { ...program, running: provider.runningPrograms?.() ?? [] } } : {}),
      ...(saved?.probe?.code ? { errorCode: saved.probe.code } : {}) };
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
    let path = typeof input.path === "string" ? input.path.trim() : "";
    const selectionMode = input.selectionMode ?? "manual";
    if (!["auto", "manual", "legacyPinned", "controlled"].includes(selectionMode)) throw new Error("程序选择模式无效。");
    if (provider.programDiscovery) {
      const controlled = provider.programDiscovery.controlledPath();
      if (controlled && path !== controlled) throw new Error("程序路径由运行环境指定，不能在此覆盖。");
      if (selectionMode === "auto") {
        const recommended = provider.programDiscovery.describe().recommendedPath;
        if (!recommended || (path && path !== recommended)) throw new Error("推荐程序已变更，请重新扫描后检测。");
        path = recommended;
      }
    }
    const model = typeof input.model === "string" ? input.model.trim() : "";
    if (model.length > 200 || /[\r\n\0]/.test(model)) throw new Error("检测模型无效。");
    let environment;
    try { environment = provider.resolveEnvironment?.(input.environment); }
    catch (error) { return Promise.reject(error); }
    const running = this.checks.get(provider.id);
    if (running?.committing) throw new Error("正在应用程序配置，请稍后重试。");
    if (running?.path === path && running?.environment?.profileId === environment?.profileId
      && running?.model === model && running?.selectionMode === selectionMode
      && running?.checkId === input.checkId) return running.promise;
    running?.controller.abort();
    const check = { path, environment, model, selectionMode, checkId: input.checkId, controller: new AbortController() };
    this.checks.set(provider.id, check);
    check.promise = this.runCheck(provider, check).finally(() => {
      if (this.checks.get(provider.id) === check) this.checks.delete(provider.id);
    });
    return check.promise;
  }

  async runCheck(provider, check) {
    const previous = this.state.providers?.[provider.id];
    const configuredPath = previous?.configuredPath ?? (previous?.confirmed ? previous.path : null);
    const userDisabled = previous?.userDisabled === true && (provider.programDiscovery || previous?.path === check.path);
    const fingerprint = await executableFingerprint(check.path);
    let message = null, code = null;
    let environmentFingerprint = null;
    let environment = check.environment;
    let available = false;
    let effectiveModel = null;
    const preserveWorking = Boolean(provider.programDiscovery && previous?.probe?.state === "available");
    await this.serialize(async () => {
      if (this.checks.get(provider.id) !== check) return;
      if (!environment && !preserveWorking) await this.saveRow(provider.id, { path: check.path, enabled: previous?.enabled === true, userDisabled, configuredPath });
    });
    try {
      if (!fingerprint) throw new Error("请选择可执行文件。");
      if (!provider.accounts) await this.runtimeSettings?.sync(provider.id);
      const release = this.runtimeSettings?.acquire(provider.id);
      let result;
      try { result = await provider.probe(check.path, { signal: check.controller.signal, environment, model: check.model }); }
      finally { release?.(); }
      if (result?.ok !== true) throw new Error("未收到有效回复，请重试。");
      effectiveModel = result.effectiveModel ?? null;
      if (await executableFingerprint(check.path) !== fingerprint) throw new Error("程序已变更，请重新检测。");
      environment = result.environment ?? environment;
      if (environment) {
        environmentFingerprint = await provider.environmentFingerprint(environment);
        if (result.environmentFingerprint && result.environmentFingerprint !== environmentFingerprint) {
          throw new Error("运行环境配置已变更，请重新检测。");
        }
      }
      available = true;
    } catch (error) { logError("provider-setup.probe", error, { providerId: provider.id, stage: "probe" }); message = error.message; code = error.code ?? null; }
    return this.serialize(async () => {
      // A slow response from a replaced path must never enable the new path.
      if (this.checks.get(provider.id) !== check) return this.row(provider);
      const commit = async () => {
        // Do not supersede a partially committed program/Home selection.
        check.committing = true;
        try {
          if (available && (!userDisabled || provider.programDiscovery)) await provider.configure(check.path, { fingerprint, model: check.model });
          if (available && environment) await provider.configureEnvironment(environment);
        } catch (error) { logError("provider-setup.configure", error, { providerId: provider.id, stage: "configure" }); available = false; message = error.message; code = error.code ?? "PROVIDER_BUSY"; }
        this.checks.delete(provider.id);
        // A failed candidate never replaces the working default environment.
        if ((environment || preserveWorking) && !available) return { ...(await this.row(provider)), path: check.path,
          executable: Boolean(fingerprint), checkState: "failed", message, errorCode: code,
          ...(environment ? { environment: provider.environmentDescriptor(environment) } : {}) };
        await this.saveRow(provider.id, { path: check.path, enabled: !userDisabled && (available || previous?.enabled === true), userDisabled,
          configuredPath: available && (!userDisabled || provider.programDiscovery) ? check.path : configuredPath,
          ...(provider.programDiscovery ? { selectionMode: provider.programDiscovery.controlledPath() ? "controlled" : check.selectionMode } : {}),
          probe: { state: available ? "available" : "failed", fingerprint, environmentFingerprint, model: check.model, effectiveModel, message, code, checkedAt: new Date().toISOString() } });
        return this.row(provider);
      };
      if (available && provider.withProgramTransition) {
        try { return await provider.withProgramTransition(check.path, { fingerprint }, commit); }
        catch (error) {
          logError("provider-setup.transition", error, { providerId: provider.id, stage: "program-transition" });
          this.checks.delete(provider.id);
          return { ...(await this.row(provider)), path: check.path,
            checkState: "failed", message: error.message, errorCode: error.code ?? "PROVIDER_BUSY" };
        }
      }
      return commit();
    });
  }

  async scanPrograms(input) {
    const provider = this.provider(input.providerId);
    if (!provider.programDiscovery) throw new Error("此 Provider 不支持多版本程序发现。");
    const saved = this.state.providers[provider.id];
    // Arbitrary files are probed only by the explicit check action; scans
    // enumerate adapter-owned locations and already adopted paths.
    await provider.programDiscovery.scan({ additionalPaths: [saved?.configuredPath, saved?.path].filter(Boolean) });
    return this.row(provider);
  }

  cancelCheck(input) {
    const provider = this.provider(input.providerId);
    const check = this.checks.get(provider.id);
    if (check && !check.committing && input.checkId && check.checkId === input.checkId) {
      check.controller.abort();
      this.checks.delete(provider.id);
    }
    return this.row(provider);
  }

  async validateRuntimeProgram(id, path) {
    const saved = this.state.providers[id];
    if (!saved?.selectionMode || !saved?.configuredPath || saved.configuredPath !== path) return;
    if (await executableFingerprint(path) !== (saved.programFingerprint ?? saved.probe?.fingerprint)) {
      throw Object.assign(new Error("已采用的程序已变更，请重新检测后再运行。"), { code: "PROVIDER_PROGRAM_CHANGED" });
    }
  }

  invalidateConnectionTest(id) {
    return this.serialize(async () => {
      const saved = this.state.providers[id];
      if (!saved?.probe || saved.probe.state !== "available") return;
      // Keep the selected Provider and explicit enable/disable intent. An
      // account notification invalidates proof, not the user's configuration.
      await this.save({ ...this.state, providers: { ...this.state.providers,
        [id]: { ...saved, probe: { ...saved.probe, state: "unknown", code: "PROVIDER_ACCOUNT_CHANGED" } } } });
    });
  }

  saveSettings(input) {
    const operation = this.settingsPending.then(async () => {
      if (!Array.isArray(input.providers) || input.providers.length > this.providers.length) throw new Error("执行引擎设置无效。");
      const seen = new Set(), changes = [];
      // Validate the entire submitted form locally before applying any configuration.
      for (const value of input.providers) {
        const provider = this.provider(value.providerId);
        if (seen.has(provider.id) || typeof value.enabled !== "boolean") throw new Error("执行引擎设置无效。");
        seen.add(provider.id);
        const before = await this.row(provider);
        const path = typeof value.path === "string" ? value.path.trim() : "";
        const programChanged = path !== (before.program?.adoptedPath || before.path);
        if ((value.enabled || programChanged) && (!isAbsolute(path) || !await executableFingerprint(path))) throw new Error(`${provider.name}：请选择可执行的程序。`);
        const controlled = provider.programDiscovery?.controlledPath();
        if (programChanged && controlled && controlled !== path) throw new Error("程序路径由运行环境指定，不能覆盖。");
        const accountChanged = value.accountId != null && value.accountId !== before.accounts?.selectedAccountId;
        if (accountChanged) {
          if (!provider.accounts) throw new Error("此执行引擎不支持账号管理。");
          if (this.checks.has(provider.id)) throw new Error("请等待连接检测结束后再切换账号。");
          await provider.accounts.validateSelection(value.accountId);
        }
        const oldSource = before.runtime?.source ?? null;
        const source = value.source ?? null;
        const sourceChanged = JSON.stringify(source && { kind: source.kind, path: source.path })
          !== JSON.stringify(oldSource && { kind: oldSource.kind, path: oldSource.path });
        const applySource = sourceChanged || value.confirmSource === true;
        if (applySource) {
          if (provider.accounts) throw new Error("此执行引擎使用账号列表：请在账号列表中指定账号，无需导入凭证来源。");
          if (!this.runtimeSettings || !source || !isAbsolute(source.path ?? "")) throw new Error(`${provider.name}：请选择有效的凭证来源路径。`);
          await this.runtimeSettings.validateSource(provider.id, source);
        }
        if ((programChanged || applySource) && (this.checks.has(provider.id) || this.runtimeSettings?.isBusy(provider.id))) {
          throw new Error(`${provider.name} 正在执行，请结束当前请求后再保存程序或凭证来源。`);
        }
        changes.push({ provider, value, before, path, programChanged, source, applySource, accountChanged });
      }
      for (const change of changes) {
        const { provider, value, before, path, programChanged, source, applySource, accountChanged } = change;
        if (applySource) await this.saveCredentialSource({ providerId: provider.id, ...source });
        if (programChanged) await this.setProgram({ providerId: provider.id, path });
        if (accountChanged) await provider.accounts.select(value.accountId);
        if (value.enabled !== before.enabled) await this.setEnabled({ providerId: provider.id, path, enabled: value.enabled });
      }
      return this.status();
    });
    this.settingsPending = operation.catch(() => {});
    return operation;
  }

  setProgram(input) {
    return this.serialize(async () => {
      const provider = this.provider(input.providerId);
      const path = typeof input.path === "string" ? input.path.trim() : "";
      const fingerprint = await executableFingerprint(path);
      if (!fingerprint) throw new Error("请选择可执行的程序。");
      const controlled = provider.programDiscovery?.controlledPath();
      if (controlled && path !== controlled) throw new Error("程序路径由运行环境指定，不能覆盖。");
      if (this.checks.has(provider.id) || this.runtimeSettings?.isBusy(provider.id)) throw new Error("请等待此引擎的当前请求结束。");
      await provider.configure(path, { fingerprint });
      const saved = this.state.providers[provider.id] ?? {};
      await this.saveRow(provider.id, { ...saved, path, configuredPath: path, programFingerprint: fingerprint,
        selectionMode: controlled ? "controlled" : "manual", probe: { ...saved.probe, state: "unknown" } });
      return this.row(provider);
    });
  }

  setEnabled(input) {
    return this.serialize(async () => {
      const provider = this.provider(input.providerId);
      const row = await this.row(provider);
      if (typeof input.enabled !== "boolean") throw new Error("启用状态无效。");
      if (input.path !== row.path || row.checkState === "checking") throw new Error("路径已变更，请等待检测完成。");
      if (input.enabled && !row.executable) throw new Error("请选择可执行的程序。");
      if (input.enabled) await provider.configure(row.path, this.state.providers[provider.id]?.probe);
      await this.saveRow(provider.id, { ...this.state.providers[provider.id], enabled: input.enabled, userDisabled: !input.enabled,
        configuredPath: input.enabled ? row.path : this.state.providers[provider.id]?.configuredPath,
        programFingerprint: input.enabled ? await executableFingerprint(row.path) : this.state.providers[provider.id]?.programFingerprint });
      return this.row(provider);
    });
  }

  isEnabled(id) {
    const saved = this.state.providers[id];
    return saved?.enabled === true && saved?.userDisabled !== true;
  }

  assertExecutionAllowed(id) {
    if (!this.isEnabled(id)) throw Object.assign(new Error("此执行引擎已关闭，请在设置中启用后重试。"),
      { code: "PROVIDER_DISABLED", dispatchState: "not_dispatched", statusCode: 409 });
  }

  async saveCredentialSource(input) {
    if (this.provider(input.providerId).accounts) throw new Error("此执行引擎使用账号列表：请在账号列表中指定账号，无需导入凭证来源。");
    if (!this.runtimeSettings) throw new Error("此环境不支持凭证来源设置。");
    await this.runtimeSettings.saveSource(input.providerId, input);
    return this.row(this.provider(input.providerId));
  }

  async accountOperation(id, input) {
    const accounts = this.provider(id).accounts;
    if (!accounts) throw new Error("此执行引擎不支持账号管理。");
    return input == null ? accounts.list() : accounts.operation(input);
  }

  async authentication(input) {
    const provider = this.provider(input.providerId);
    if (!provider.authentication) throw new Error("此 Provider 不支持该认证操作。");
    const path = typeof input.path === "string" ? input.path.trim() : "";
    if (!await executableFingerprint(path)) throw new Error("请选择可执行文件。");
    return provider.authentication({ ...input, path });
  }

  async saveRow(id, row) {
    const providers = { ...this.state.providers, [id]: row };
    // Explicit defaults remain selected when disabled; execution reports the blocker instead of switching accounts/providers.
    const defaultProviderId = this.state.defaultProviderId ?? this.providers.find(p => providers[p.id]?.enabled)?.id ?? null;
    await this.save({ ...this.state, providers, defaultProviderId });
    this.onDefaultChanged(defaultProviderId);
  }

  prepareAssistant() {
    return this.serialize(() => this.prepareAssistantWithinOperation());
  }

  // Caller owns the serialization lock. Completion and the legacy preparation
  // route share this operation without nesting queue promises.
  async prepareAssistantWithinOperation(language) {
    const status = await this.status();
    const selected = status.providers.find((p) => p.id === status.defaultProviderId && p.enabled && p.executable)
      ?? status.providers.find((p) => p.enabled && p.executable);
    if (!selected) throw new Error("请先启用至少一个可用 Provider。");
    if (selected.id !== this.state.defaultProviderId) {
      await this.save({ ...this.state, defaultProviderId: selected.id });
      this.onDefaultChanged(selected.id);
    }
    let session = this.findAssistantSession();
    if (!session) {
      await this.provider(selected.id).prepare?.();
      session = await this.createAssistantSession(selected.id);
    }
    if (!this.state.completed) await this.ensureAssistantGreeting(session.id, language);
    return { sessionId: session.id };
  }

  complete(input = {}) {
    return this.serialize(async () => {
      // Replaying a completed request must not recreate a deleted assistant.
      if (this.state.completed) return this.status();
      await this.prepareAssistantWithinOperation(typeof input.language === "string" ? input.language : undefined);
      // Revalidate after initialization: the binary or enabled choice may have
      // changed while the Provider was preparing its Session.
      const status = await this.status();
      if (!status.providers.some((p) => p.enabled && p.executable)) {
        throw new Error("请先启用至少一个可用 Provider。");
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
