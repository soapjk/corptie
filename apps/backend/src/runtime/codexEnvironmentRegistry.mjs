import { createHash } from "node:crypto";
import { access, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import os from "node:os";

// Adapter-owned provider state. Thread IDs remain resources, not actors.
// Existing/unindexed threads always route to the legacy isolated Home.
export class CodexEnvironmentRegistry {
  constructor({ path, isolatedHome, nativeHome = process.env.CODEX_HOME || join(os.homedir(), ".codex") }) {
    Object.assign(this, { path, isolatedHome: resolve(isolatedHome), nativeHome: resolve(nativeHome) });
    if (this.nativeHome === this.isolatedHome) this.nativeHome = join(os.homedir(), ".codex");
    this.legacy = this.profile("isolated", this.isolatedHome);
    this.state = { version: 1, defaultProfileId: this.legacy.profileId,
      profiles: { [this.legacy.profileId]: this.legacy }, threads: {} };
    this.pending = Promise.resolve();
  }

  profile(mode, home) {
    return { profileId: `codex-home:${createHash("sha256").update(`${mode}:${home}`).digest("hex").slice(0, 24)}`,
      mode, home, revision: 1 };
  }

  async initialize() {
    try {
      const saved = JSON.parse(await readFile(this.path(), "utf8"));
      if (saved.version !== 1 || !saved.profiles?.[saved.defaultProfileId] || !saved.threads) {
        throw new Error("Codex 环境记录损坏，请恢复本地配置。");
      }
      this.state = saved;
      if (saved.nativeHome) this.nativeHome = saved.nativeHome;
      this.state.profiles[this.legacy.profileId] ??= this.legacy;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      // An unsaved selection always defaults to the existing native Home.
      // Historical thread bindings still resolve through the legacy profile.
      const native = this.profile("native", this.nativeHome);
      this.state.profiles[native.profileId] = native;
      this.state.defaultProfileId = native.profileId;
      await this.save();
    }
  }

  get current() { return this.state.profiles[this.state.defaultProfileId]; }

  selection(input) {
    if (!input) return this.current;
    if (!["native", "isolated"].includes(input.mode)) throw new Error("请选择有效的运行环境。");
    const home = input.mode === "isolated" ? this.isolatedHome : input.home?.trim() || this.nativeHome;
    if (!isAbsolute(home)) throw new Error("Codex Home 必须是绝对目录路径。");
    if (input.mode === "native" && resolve(home) === this.isolatedHome) throw new Error("请选择本机 Codex Home，而不是 Corptie 独立目录。");
    return this.profile(input.mode, resolve(home));
  }

  async validate(profile) {
    if (profile.mode === "isolated") return profile;
    try {
      if (!(await stat(profile.home)).isDirectory()) throw new Error();
      await access(profile.home, constants.R_OK | constants.W_OK);
      const home = await realpath(profile.home);
      if (home === await realpath(this.isolatedHome).catch(() => this.isolatedHome)) throw new Error();
      return this.profile("native", home);
    } catch {
      throw Object.assign(new Error("Codex Home 不存在或无法访问，请选择现有目录。"), { code: "PROVIDER_HOME_UNAVAILABLE" });
    }
  }

  async fingerprint(profile) {
    const info = await stat(join(profile.home, "config.toml")).catch(() => null);
    return `${profile.profileId}:${profile.revision}:${info?.mtimeMs ?? 0}:${info?.size ?? 0}`;
  }

  descriptor(profile = this.current) {
    return { ...profile, options: [
      { mode: "native", title: "使用现有 Codex 环境（推荐）", home: this.nativeHome },
      { mode: "isolated", title: "使用独立 Corptie 环境", home: this.isolatedHome }
    ], canImportAuthentication: profile.mode === "isolated" };
  }

  forThread(threadId) {
    const profileId = this.state.threads[threadId] ?? this.legacy.profileId;
    const profile = this.state.profiles[profileId];
    if (!profile) throw new Error("会话原有的 Codex 环境不可用，不能切换 Home 恢复。");
    return profile;
  }

  register(profile, { makeDefault = false, threadId } = {}) {
    const operation = this.pending.then(async () => {
      const previous = structuredClone(this.state);
      this.state.profiles[profile.profileId] = profile;
      if (makeDefault) this.state.defaultProfileId = profile.profileId;
      if (makeDefault && profile.mode === "native") this.state.nativeHome = profile.home;
      if (threadId) this.state.threads[threadId] = profile.profileId;
      try { await this.save(); }
      catch (error) { this.state = previous; throw error; }
      if (makeDefault && profile.mode === "native") this.nativeHome = profile.home;
      return profile;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }

  async save() {
    const path = this.path();
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.tmp-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(this.state)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  }
}
