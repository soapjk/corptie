import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { executableFingerprint } from "./providerExecutableDiscovery.mjs";

// Provider-independent setup state. Only adapter reply tests can mark a binary
// available; enabling a row never substitutes for a successful test.
export class FirstRunSetupService {
  constructor({ path, providers, hasWorks, firstWorkSession = () => null, findAssistantSession, createAssistantSession, ensureAssistantGreeting = async () => {}, onDefaultChanged = () => {} }) {
    Object.assign(this, { path, providers, hasWorks, firstWorkSession, findAssistantSession, createAssistantSession, ensureAssistantGreeting, onDefaultChanged });
    this.state = { providers: {}, completed: false };
    this.pending = Promise.resolve();
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
    const available = Boolean(fingerprint && environmentMatches && saved?.probe?.state === "available" && saved.probe.fingerprint === fingerprint);
    const checkState = check ? "checking" : (!fingerprint ? "missing" : (available ? "available"
      : (environmentMatches && saved?.probe?.fingerprint === fingerprint ? saved.probe.state : "unknown")));
    return { id: provider.id, name: provider.name, path: fingerprint || saved || check ? path : "",
      executable: Boolean(fingerprint), enabled: !check && available && saved.enabled === true,
      checkState, message: checkState === "failed" ? saved.probe.message : null,
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
      if (!environment && !preserveWorking) await this.saveRow(provider.id, { path: check.path, enabled: false, userDisabled, configuredPath });
    });
    try {
      if (!fingerprint) throw new Error("请选择可执行文件。");
      const result = await provider.probe(check.path, { signal: check.controller.signal, environment, model: check.model });
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
    } catch (error) { message = error.message; code = error.code ?? null; }
    return this.serialize(async () => {
      // A slow response from a replaced path must never enable the new path.
      if (this.checks.get(provider.id) !== check) return this.row(provider);
      const commit = async () => {
        // Do not supersede a partially committed program/Home selection.
        check.committing = true;
        try {
          if (available && (!userDisabled || provider.programDiscovery)) await provider.configure(check.path, { fingerprint, model: check.model });
          if (available && environment) await provider.configureEnvironment(environment);
        } catch (error) { available = false; message = error.message; code = error.code ?? "PROVIDER_BUSY"; }
        this.checks.delete(provider.id);
        // A failed candidate never replaces the working default environment.
        if ((environment || preserveWorking) && !available) return { ...(await this.row(provider)), path: check.path,
          executable: Boolean(fingerprint), enabled: false, checkState: "failed", message, errorCode: code,
          ...(environment ? { environment: provider.environmentDescriptor(environment) } : {}) };
        await this.saveRow(provider.id, { path: check.path, enabled: available && !userDisabled, userDisabled,
          configuredPath: available && (!userDisabled || provider.programDiscovery) ? check.path : configuredPath,
          ...(provider.programDiscovery ? { selectionMode: provider.programDiscovery.controlledPath() ? "controlled" : check.selectionMode } : {}),
          probe: { state: available ? "available" : "failed", fingerprint, environmentFingerprint, model: check.model, effectiveModel, message, code, checkedAt: new Date().toISOString() } });
        return this.row(provider);
      };
      if (available && provider.withProgramTransition) {
        try { return await provider.withProgramTransition(check.path, { fingerprint }, commit); }
        catch (error) {
          this.checks.delete(provider.id);
          return { ...(await this.row(provider)), path: check.path, enabled: false,
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
    if (saved.probe?.state !== "available" || await executableFingerprint(path) !== saved.probe.fingerprint) {
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

  setEnabled(input) {
    return this.serialize(async () => {
      const provider = this.provider(input.providerId);
      const row = await this.row(provider);
      if (typeof input.enabled !== "boolean") throw new Error("启用状态无效。");
      if (input.path !== row.path || row.checkState === "checking") throw new Error("路径已变更，请等待检测完成。");
      if (input.enabled && row.checkState !== "available") throw new Error("请先完成回复检测。");
      if (input.enabled) await provider.configure(row.path, this.state.providers[provider.id]?.probe);
      await this.saveRow(provider.id, { ...this.state.providers[provider.id], enabled: input.enabled, userDisabled: !input.enabled,
        configuredPath: input.enabled ? row.path : this.state.providers[provider.id]?.configuredPath });
      return this.row(provider);
    });
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
    const enabled = this.providers.filter((p) => providers[p.id]?.enabled && providers[p.id]?.probe?.state === "available");
    const defaultProviderId = enabled.find((p) => p.id === this.state.defaultProviderId)?.id ?? enabled[0]?.id ?? null;
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
    const selected = status.providers.find((p) => p.id === status.defaultProviderId && p.enabled)
      ?? status.providers.find((p) => p.enabled);
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
      if (!status.providers.some((p) => p.enabled)) {
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
