// Skill 维护中心（provider-neutral）：全局共享的 Skill 映射表 + 物化安装。
//
// 职责边界：
// - 维护一个全局「Skill 注册表」（store.skills），每一项指向具体 Skill 位置：
//   local 源 → source 存本地绝对目录；git 源 → source 存 GitHub 仓库 URL，cache_path 存克隆缓存目录。
// - 「物化安装」：把某个 Skill 的内容复制/链接到各 Provider 的共享 skills 目录，
//   使 Agent 运行时能按需发现并加载。这里是 provider-neutral 的通用实现，
//   通过传入的 skillsDirs（providerId → 绝对 skills 根目录）决定落到哪里，
//   不 import 任何具体 Provider 适配器、也不按 provider 名分支业务逻辑。
//
// 全局共享语义：Skill 内容只有一份（local 目录 或 git 缓存目录），
// 各 Provider 的 skills 目录只是它的「物化挂载点」。Agent 通过 agent_skills 关联表
// 声明自己启用哪些 Skill（元数据），物化仍发生在全局目录，不按 Agent 隔离。

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const execFileAsync = promisify(execFile);

// 递归定位 SKILL.md 时的最大搜索深度（防止误匹配太深层的无关 SKILL.md）。
const MAX_SKILL_SEARCH_DEPTH = 5;

export class SkillRegistryService {
  constructor({ store, skillsDirs = {}, cacheRoot, exec = execFileAsync } = {}) {
    if (!store) throw new TypeError("SkillRegistryService requires a store.");
    // skillsDirs: { [providerId]: 绝对 skills 根目录 }，例如
    //   { codex: "~/.corptie/.../runtimes/codex/skills",
    //     claude: "~/.corptie/.../runtimes/claude/corptie-plugin/skills" }
    this.store = store;
    this.skillsDirs = skillsDirs;
    // git 源克隆缓存的根目录（全局共享，跨 Provider）。
    this.cacheRoot = resolve(cacheRoot ?? join(process.env.CORPTIE_HOME ?? join(homedirFallback(), ".corptie"), "skill-cache"));
    this.exec = exec;
  }

  // 列出所有已登记 Skill。
  list() {
    return this.store.listRegistrySkills();
  }

  get(skillId) {
    return this.store.getRegistrySkill(skillId);
  }

  // 登记一个 Skill（local 目录 或 git URL），并完成物化安装。
  // 返回登记后的 skill 记录。
  async register({ name, description = "", sourceType, source }) {
    const type = sourceType === "git" ? "git" : "local";
    const rawSource = String(source ?? "").trim();
    if (!rawSource) throw skillError("INVALID_INPUT", "source is required.");
    const resolvedName = String(name ?? "").trim() || defaultSkillName(type, rawSource);

    let cachePath = null;
    if (type === "git") {
      // git 源：先克隆到全局缓存目录，再登记；后续物化从缓存复制。
      cachePath = await this.#cloneGitSource(rawSource);
    } else {
      // local 源：校验目录存在且（递归）含 SKILL.md（标准 Skill 形态）。
      const localPath = resolve(rawSource);
      const marker = await this.#locateSkillMarker(localPath);
      if (!marker) {
        throw skillError("INVALID_SKILL", `所选目录（含子目录）不含 SKILL.md（或 skill.md）：${localPath}`);
      }
    }

    const skill = this.store.createRegistrySkill({
      name: resolvedName,
      description,
      sourceType: type,
      source: rawSource,
      cachePath
    });

    // 物化到各 Provider 的共享 skills 目录。
    await this.materialize(skill);

    return skill;
  }

  // 物化安装：把 skill 内容落到每个 Provider 的 skills 目录（skill_id 命名子目录）。
  async materialize(skill) {
    // 以 SKILL.md 所在目录为 skill 根（而非登记时的 source 本身），
    // 这样即使 SKILL.md 藏在子目录里，物化后也会被放到 <skillId>/ 顶层，
    // 满足运行时对 skills/<id>/SKILL.md 的扫描约定。
    const { rootDir } = await this.#resolveSkillRoot(skill);
    const results = [];
    for (const [providerId, skillsRoot] of Object.entries(this.skillsDirs)) {
      const targetDir = join(skillsRoot, skill.skillId);
      await mkdir(targetDir, { recursive: true, mode: 0o700 });
      await this.#mirrorDirectory(rootDir, targetDir);
      results.push({ providerId, installedAt: targetDir });
    }
    return results;
  }

  // 卸载：从所有 Provider 的 skills 目录移除该 Skill 的物化。
  async unmaterialize(skill) {
    for (const skillsRoot of Object.values(this.skillsDirs)) {
      const targetDir = join(skillsRoot, skill.skillId);
      await rm(targetDir, { recursive: true, force: true });
    }
  }

  // 删除登记：卸载物化 + 移除缓存（仅 git 源自己的缓存）+ 删除记录。
  async remove(skillId) {
    const skill = this.store.getRegistrySkill(skillId);
    if (!skill) throw skillError("NOT_FOUND", `Skill not found: ${skillId}`);
    await this.unmaterialize(skill);
    if (skill.sourceType === "git" && skill.cachePath) {
      await rm(skill.cachePath, { recursive: true, force: true });
    }
    this.store.deleteRegistrySkill(skillId);
    return true;
  }

  // 重新物化某个 Skill（例如缓存被清空后）。
  async rematerialize(skillId) {
    const skill = this.store.getRegistrySkill(skillId);
    if (!skill) throw skillError("NOT_FOUND", `Skill not found: ${skillId}`);
    await this.materialize(skill);
    return skill;
  }

  // 解析某 Agent 启用的 Skill 列表（provider-neutral，供 AgentContextService 注入）。
  // 返回 [{ name, description, content }]，content 为 SKILL.md 正文（截断到合理长度）。
  async skillsForAgent(agentId) {
    if (!agentId) return [];
    const skills = this.store.listRegistrySkillsForAgent(agentId);
    const result = [];
    for (const skill of skills) {
      const content = await this.#readSkillSummary(skill);
      result.push({
        name: skill.name,
        description: skill.description ?? "",
        content
      });
    }
    return result;
  }

  // 读取 Skill 的 SKILL.md 正文摘要（用于上下文注入，不做完整内容注入，避免撑爆 prompt）。
  async #readSkillSummary(skill, maxLength = 2000) {
    try {
      const { markerPath } = await this.#resolveSkillRoot(skill);
      if (!markerPath) return "";
      const text = await readFile(markerPath, "utf8");
      const trimmed = text.trim();
      return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}…` : trimmed;
    } catch {
      return "";
    }
  }

  // 解析 Skill 的实际内容目录。
  // - local：source 即目录本身。
  // - git：cache_path（克隆缓存）。克隆时会把仓库根直接作为缓存目录。
  async #sourceDir(skill) {
    if (skill.sourceType === "git") {
      const dir = skill.cachePath ?? skill.source;
      if (await isDirectory(dir)) return dir;
      throw skillError("CACHE_MISSING", `Skill 缓存缺失，请重新安装：${skill.name}`);
    }
    const dir = resolve(skill.source);
    if (await isDirectory(dir)) return dir;
    throw skillError("SOURCE_MISSING", `Skill 本地目录不存在：${dir}`);
  }

  // 解析 Skill 的「根目录 + SKILL.md 路径」。
  // 根目录 = 含 SKILL.md 的那一层（用于物化复制源）；markerPath = SKILL.md 绝对路径。
  // 支持 SKILL.md 藏在子目录里（递归搜索），优先取「最浅」命中。
  async #resolveSkillRoot(skill) {
    const sourceRoot = await this.#sourceDir(skill);
    const markerPath = await this.#locateSkillMarker(sourceRoot);
    if (!markerPath) return { rootDir: sourceRoot, markerPath: null };
    return { rootDir: dirname(markerPath), markerPath };
  }

  // 定位 SKILL.md（大小写不敏感，递归搜索子目录，优先最浅命中）。
  // 返回 SKILL.md 绝对路径，找不到返回 null。
  async #locateSkillMarker(dir, depth = 0) {
    if (!(await isDirectory(dir))) return null;
    for (const name of ["SKILL.md", "skill.md", "SKILL.MD"]) {
      if (await isFile(join(dir, name))) return join(dir, name);
    }
    // 递归搜索子目录（限制深度，避免误匹配太深层的无关 SKILL.md）。
    if (depth >= MAX_SKILL_SEARCH_DEPTH) return null;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const sub of entries) {
      if (!sub.isDirectory()) continue;
      const found = await this.#locateSkillMarker(join(dir, sub.name), depth + 1);
      if (found) return found;
    }
    return null;
  }

  async #cloneGitSource(url) {
    await mkdir(this.cacheRoot, { recursive: true, mode: 0o700 });
    const dir = join(this.cacheRoot, `skill-${randomUUID()}`);
    // 浅克隆（--depth 1）到缓存目录。
    await this.exec("git", ["clone", "--depth", "1", url, dir], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: 120_000
    });
    // 校验克隆产物是有效 Skill。
    const marker = await this.#locateSkillMarker(dir);
    if (!marker) {
      await rm(dir, { recursive: true, force: true });
      throw skillError("INVALID_SKILL", `仓库不含 SKILL.md（或 skill.md）：${url}`);
    }
    return dir;
  }

  // 把 srcDir 的内容镜像到 targetDir（先清空 targetDir，再整体复制）。
  async #mirrorDirectory(srcDir, targetDir) {
    await rm(targetDir, { recursive: true, force: true });
    await mkdir(targetDir, { recursive: true, mode: 0o700 });
    await cp(srcDir, targetDir, { recursive: true });
  }
}

function skillError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.name = "SkillRegistryError";
  return error;
}

function defaultSkillName(type, source) {
  if (type === "git") {
    const cleaned = source.replace(/\/+$/, "").replace(/\.git$/, "");
    return basename(cleaned) || "skill";
  }
  return basename(source) || "skill";
}

function homedirFallback() {
  try {
    // 轻量 home 解析，避免引入 os 的额外依赖（os 已在 server 用，这里保守处理）。
    return process.env.HOME ?? "/tmp";
  } catch {
    return "/tmp";
  }
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
