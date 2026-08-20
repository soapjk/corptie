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
// 各 Provider 的 skills 目录只是它的「物化挂载点」。Agent 通过 agent_skill_links 关联表
// 声明自己启用哪些 Skill（元数据），物化仍发生在全局目录，不按 Agent 隔离。

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import {
  cp,
  mkdir,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  stat
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const execFileAsync = promisify(execFile);

// 递归定位 SKILL.md 时的最大搜索深度（防止误匹配太深层的无关 SKILL.md）。
const MAX_SKILL_SEARCH_DEPTH = 5;
const MCP_DESCRIPTOR_NAMES = Object.freeze([".mcp.json", "mcp.json", "mcp.config.json"]);
const SKILL_ROOT_TOKENS = Object.freeze(["${SKILL_ROOT}", "${SKILL_DIR}", "${CLAUDE_PLUGIN_ROOT}"]);

export class SkillRegistryService {
  constructor({ store, skillsDirs = {}, cacheRoot, exec = execFileAsync, removePath = rm } = {}) {
    if (!store) throw new TypeError("SkillRegistryService requires a store.");
    // skillsDirs: { [providerId]: 绝对 skills 根目录 }，例如
    //   { codex: "~/.corptie/.../runtimes/codex/skills",
    //     claude: "~/.corptie/.../runtimes/claude/corptie-plugin/skills" }
    this.store = store;
    this.skillsDirs = skillsDirs;
    // git 源克隆缓存的根目录（全局共享，跨 Provider）。
    this.cacheRoot = resolve(cacheRoot ?? join(process.env.CORPTIE_HOME ?? join(homedirFallback(), ".corptie"), "skill-cache"));
    this.exec = exec;
    this.removePath = removePath;
  }

  // 列出所有已登记 Skill。
  list() {
    return this.store.listRegistrySkills();
  }

  get(skillId) {
    return this.store.getRegistrySkill(skillId);
  }

  async discover({ sourceType, source }) {
    const type = sourceType === "git" ? "git" : "local";
    const rawSource = String(source ?? "").trim();
    if (!rawSource) throw skillError("INVALID_INPUT", "source is required.");
    let cachePath = null;
    try {
      const rootDir = type === "git"
        ? (cachePath = await this.#cloneGitSource(rawSource))
        : resolve(rawSource);
      const candidates = await this.#discoverCandidates(rootDir);
      if (candidates.length === 0) {
        throw skillError("INVALID_SKILL", `所选来源不含 SKILL.md（或 skill.md）：${rawSource}`);
      }
      return { sourceType: type, source: rawSource, candidates };
    } finally {
      if (cachePath) await rm(cachePath, { recursive: true, force: true });
    }
  }

  // 登记一个 Skill。启动上下文只使用 manifest 索引；完整正文由 loadForAgent() 按需读取。
  async register({ name, description = "", sourceType, source, sourceSubpath = "" }) {
    const type = sourceType === "git" ? "git" : "local";
    const rawSource = String(source ?? "").trim();
    if (!rawSource) throw skillError("INVALID_INPUT", "source is required.");

    let cachePath = null;
    try {
      const sourceRoot = type === "git"
        ? (cachePath = await this.#cloneGitSource(rawSource))
        : resolve(rawSource);
      const candidate = await this.#selectCandidate(sourceRoot, sourceSubpath);
      const resolvedName = String(name ?? "").trim() || candidate.manifestName;
      const resolvedDescription = String(description ?? "").trim() || candidate.manifestDescription;

      const skill = this.store.createRegistrySkill({
        name: resolvedName,
        description: resolvedDescription,
        sourceType: type,
        source: rawSource,
        sourceSubpath: candidate.relativePath,
        cachePath,
        manifestName: candidate.manifestName,
        manifestDescription: candidate.manifestDescription,
        contentHash: candidate.contentHash
      });

      try {
        await this.materialize(skill);
      } catch (error) {
        this.store.deleteRegistrySkill(skill.skillId);
        throw error;
      }

      return { ...this.store.getRegistrySkill(skill.skillId), composition: candidate.composition };
    } catch (error) {
      if (cachePath && !this.store.listRegistrySkills().some((skill) => skill.cachePath === cachePath)) {
        await rm(cachePath, { recursive: true, force: true });
      }
      throw error;
    }
  }

  // 保留 skillId 和 Agent 绑定，重新指向一个经过验证的具体 Skill。
  async update(skillId, input = {}) {
    const existing = this.store.getRegistrySkill(skillId);
    if (!existing) throw skillError("NOT_FOUND", `Skill not found: ${skillId}`);
    const type = input.sourceType === "git" ? "git" : (input.sourceType ?? existing.sourceType);
    const source = String(input.source ?? existing.source).trim();
    let cachePath = type === "git" && source === existing.source ? existing.cachePath : null;
    const createdCache = type === "git" && !cachePath;
    try {
      if (createdCache) cachePath = await this.#cloneGitSource(source);
      const sourceRoot = type === "git" ? cachePath : resolve(source);
      const candidate = await this.#selectCandidate(sourceRoot, input.sourceSubpath ?? existing.sourceSubpath ?? "");
      const next = {
        ...existing,
        name: String(input.name ?? existing.name).trim() || candidate.manifestName,
        description: String(input.description ?? existing.description).trim() || candidate.manifestDescription,
        sourceType: type,
        source,
        sourceSubpath: candidate.relativePath,
        cachePath,
        manifestName: candidate.manifestName,
        manifestDescription: candidate.manifestDescription,
        contentHash: candidate.contentHash
      };
      await this.materialize(next);
      const updated = this.store.updateRegistrySkill(skillId, next);
      if (existing.sourceType === "git" && existing.cachePath && existing.cachePath !== cachePath) {
        await rm(existing.cachePath, { recursive: true, force: true });
      }
      return { ...updated, composition: candidate.composition };
    } catch (error) {
      if (createdCache && cachePath) await rm(cachePath, { recursive: true, force: true });
      throw error;
    }
  }

  // 旧版本只保存来源根目录，并递归取第一个 SKILL.md。若登记名称能唯一匹配
  // manifest name，则可无歧义地补齐精确子路径；无法唯一判断的记录保持不变。
  async repairLegacyRegistrations() {
    const repaired = [];
    const skipped = [];
    for (const skill of this.store.listRegistrySkills()) {
      if (skill.sourceSubpath && skill.manifestName && skill.contentHash) continue;
      try {
        const sourceRoot = await this.#sourceDir(skill);
        const candidates = await this.#discoverCandidates(sourceRoot);
        const expected = String(skill.name ?? "").trim().toLowerCase();
        const matches = candidates.filter((candidate) => candidate.manifestName.toLowerCase() === expected);
        const selected = matches.length === 1 ? matches[0] : (candidates.length === 1 ? candidates[0] : null);
        if (!selected) {
          skipped.push({ skillId: skill.skillId, reason: "ambiguous", candidates });
          continue;
        }
        const updated = await this.update(skill.skillId, { sourceSubpath: selected.relativePath });
        repaired.push(updated);
      } catch (error) {
        skipped.push({ skillId: skill.skillId, reason: error.code ?? "repair_failed" });
      }
    }
    return { repaired, skipped };
  }

  // 物化安装：把 skill 内容落到每个 Provider 的 skills 目录（skill_id 命名子目录）。
  async materialize(skill) {
    // 以 SKILL.md 所在目录为 skill 根（而非登记时的 source 本身），
    // 这样即使 SKILL.md 藏在子目录里，物化后也会被放到 <skillId>/ 顶层，
    // 满足运行时对 skills/<id>/SKILL.md 的扫描约定。
    const { rootDir } = await this.#resolveSkillRoot(skill);
    await this.#inspectPackage(rootDir);
    const results = [];
    for (const [providerId, skillsRoot] of Object.entries(this.skillsDirs)) {
      const targetDir = join(skillsRoot, skill.skillId);
      await this.#mirrorDirectory(rootDir, targetDir);
      const composition = await this.#inspectPackage(targetDir);
      results.push({ providerId, installedAt: targetDir, composition });
    }
    return results;
  }

  // 返回某个 Agent 在指定 Provider 运行时中需要启用的 MCP server 配置。
  // 配置从已物化目录读取并解析，因此 command/args/cwd 指向安装结果，而不是易失的来源目录。
  async mcpServersForAgent(agentId, providerId) {
    if (!agentId || !this.store.getAgent(agentId)) {
      throw skillError("AGENT_NOT_FOUND", `Agent not found: ${agentId}`);
    }
    const assigned = this.store.listRegistrySkillsForAgent(agentId);
    if (assigned.length === 0) return {};
    const skillsRoot = this.skillsDirs[providerId];
    const result = {};
    for (const skill of assigned) {
      const sourceComposition = await this.#inspectPackage((await this.#resolveSkillRoot(skill)).rootDir);
      if (!sourceComposition.mcp) continue;
      if (!skillsRoot) {
        throw skillError(
          "MCP_PROVIDER_UNSUPPORTED",
          `Provider ${providerId} 未配置复合 Skill 运行时目录，无法加载 Skill ${skill.name} 的 MCP 依赖。`
        );
      }
      const installedRoot = join(skillsRoot, skill.skillId);
      const installed = await this.#inspectPackage(installedRoot, { resolveServers: true });
      for (const [serverName, server] of Object.entries(installed.mcp?.servers ?? {})) {
        if (Object.prototype.hasOwnProperty.call(result, serverName)) {
          throw skillError(
            "MCP_SERVER_NAME_CONFLICT",
            `Agent ${agentId} 分配的 Skill 存在重复 MCP server 名称：${serverName}`
          );
        }
        result[serverName] = server;
      }
    }
    return result;
  }

  // 卸载：从所有 Provider 的 skills 目录移除该 Skill 的物化。
  async unmaterialize(skill) {
    for (const skillsRoot of Object.values(this.skillsDirs)) {
      const targetDir = join(skillsRoot, skill.skillId);
      await this.#removeManagedPath(targetDir, skillsRoot, "runtime materialization");
    }
  }

  deletionImpact(skillId) {
    const id = validateSkillId(skillId);
    const impact = this.store.registrySkillDeletionImpact(id);
    if (!impact) throw skillError("NOT_FOUND", `Skill not found: ${id}`);
    return impact;
  }

  // 删除登记采用可审计的本地 saga：活跃 Session 会阻止删除；先清理所有
  // provider-neutral 物化和 Git 缓存，全部成功后才事务性删除登记与 Agent 关联。
  // 文件部分失败时登记仍存在，并尝试重新物化，operation 可用于审计和重试。
  async remove(skillId) {
    const id = validateSkillId(skillId);
    const skill = this.store.getRegistrySkill(id);
    if (!skill) throw skillError("NOT_FOUND", `Skill not found: ${id}`);
    const impact = this.deletionImpact(id);
    if (!impact.canDelete) {
      const error = skillError(
        "SKILL_HAS_ACTIVE_SESSIONS",
        `Skill ${skill.name} 正被 ${impact.activeSessionCount} 个活跃 Session 使用；请先结束或中断这些 Session。`
      );
      error.impact = impact;
      throw error;
    }

    const cleanup = [
      ...Object.entries(this.skillsDirs).map(([providerId, skillsRoot]) => ({
        kind: "runtime",
        providerId,
        path: join(skillsRoot, id),
        root: resolve(skillsRoot),
        status: "pending"
      })),
      ...(skill.sourceType === "git" && skill.cachePath ? [{
        kind: "gitCache",
        providerId: null,
        path: resolve(skill.cachePath),
        root: this.cacheRoot,
        status: "pending"
      }] : [])
    ];
    let operation = this.store.createSkillDeletionOperation({ skill, impact, cleanup });
    const results = cleanup.map((target) => ({ ...target }));

    try {
      for (const target of results) {
        await this.#removeManagedPath(target.path, target.root, target.kind);
        target.status = "succeeded";
      }
    } catch (error) {
      const target = results.find((item) => item.status === "pending");
      if (target) {
        target.status = "failed";
        target.error = error?.message ?? String(error);
      }
      const recovery = await this.#recoverMaterialization(skill, results);
      operation = this.store.updateSkillDeletionOperation(operation.operationId, {
        status: "cleanup_failed",
        cleanup: results,
        recovery,
        errorCode: error?.code ?? "SKILL_CLEANUP_FAILED",
        errorMessage: error?.message ?? "Skill runtime cleanup failed."
      });
      const wrapped = skillError("SKILL_CLEANUP_FAILED", `Skill 清理失败；登记与 Agent 分配已保留，可重试删除。${error?.message ? ` ${error.message}` : ""}`);
      wrapped.operation = operation;
      wrapped.impact = impact;
      throw wrapped;
    }

    try {
      if (!this.store.deleteRegistrySkill(id)) {
        throw skillError("NOT_FOUND", `Skill not found: ${id}`);
      }
    } catch (error) {
      const recovery = await this.#recoverMaterialization(skill, results);
      operation = this.store.updateSkillDeletionOperation(operation.operationId, {
        status: "database_failed",
        cleanup: results,
        recovery,
        errorCode: error?.code ?? "SKILL_DATABASE_DELETE_FAILED",
        errorMessage: error?.message ?? "Skill database deletion failed."
      });
      if (error?.code === "SKILL_HAS_ACTIVE_SESSIONS") {
        const wrapped = skillError(
          "SKILL_HAS_ACTIVE_SESSIONS",
          "删除提交前检测到新的活跃 Session；已取消数据库删除并尝试恢复运行时物化。请先结束或中断该 Session 后重试。"
        );
        wrapped.operation = operation;
        wrapped.impact = error.impact ?? this.deletionImpact(id);
        throw wrapped;
      }
      const wrapped = skillError("SKILL_DATABASE_DELETE_FAILED", "Skill 文件已清理，但数据库级联删除失败；已尝试恢复运行时物化，可按操作记录重试。");
      wrapped.operation = operation;
      wrapped.impact = impact;
      throw wrapped;
    }

    operation = this.store.updateSkillDeletionOperation(operation.operationId, {
      status: "completed",
      cleanup: results,
      recovery: []
    });
    return { ok: true, operation, impact };
  }

  async #removeManagedPath(path, root, label) {
    const managedRoot = resolve(root);
    const target = resolve(path);
    if (target === managedRoot || !isPathWithin(target, managedRoot)) {
      throw skillError("UNSAFE_SKILL_CLEANUP_PATH", `拒绝清理不在托管根目录内的 ${label} 路径：${target}`);
    }
    await this.removePath(target, { recursive: true, force: true });
  }

  async #recoverMaterialization(skill, cleanup) {
    if (!cleanup.some((target) => target.kind === "runtime" && target.status === "succeeded")) return [];
    try {
      const restored = await this.materialize(skill);
      return restored.map((item) => ({
        kind: "runtime",
        providerId: item.providerId,
        path: item.installedAt,
        status: "restored"
      }));
    } catch (error) {
      return [{
        kind: "runtime",
        status: "recovery_failed",
        error: error?.message ?? String(error)
      }];
    }
  }

  // 重新物化某个 Skill（例如缓存被清空后）。
  async rematerialize(skillId) {
    const skill = this.store.getRegistrySkill(skillId);
    if (!skill) throw skillError("NOT_FOUND", `Skill not found: ${skillId}`);
    await this.materialize(skill);
    return skill;
  }

  // 启动时仅返回轻量索引；完整 Skill 由会话工具按需加载。
  async skillsForAgent(agentId) {
    if (!agentId) return [];
    return this.store.listRegistrySkillsForAgent(agentId).map((skill) => ({
      skillId: skill.skillId,
      name: skill.manifestName || skill.name,
      displayName: skill.name,
      description: skill.manifestDescription || skill.description || "",
      contentHash: skill.contentHash || ""
    }));
  }

  async searchForAgent(agentId, intent = "") {
    if (!agentId || !this.store.getAgent(agentId)) throw skillError("AGENT_NOT_FOUND", `Agent not found: ${agentId}`);
    const terms = tokenize(intent);
    const candidates = (await this.skillsForAgent(agentId))
      .map((skill) => ({ ...skill, score: skillSearchScore(skill, terms) }))
      .filter((skill) => terms.length === 0 || skill.score > 0)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    return { found: candidates.length > 0, candidates };
  }

  async loadForAgent(agentId, skillId) {
    if (!agentId || !this.store.getAgent(agentId)) throw skillError("AGENT_NOT_FOUND", `Agent not found: ${agentId}`);
    const allowed = this.store.listRegistrySkillIdsForAgent(agentId);
    if (!allowed.includes(skillId)) {
      throw skillError("SKILL_NOT_ASSIGNED", `Skill is not assigned to Agent ${agentId}: ${skillId}`);
    }
    const skill = this.store.getRegistrySkill(skillId);
    if (!skill) throw skillError("NOT_FOUND", `Skill not found: ${skillId}`);
    const { markerPath } = await this.#resolveSkillRoot(skill);
    if (!markerPath) throw skillError("INVALID_SKILL", `Skill marker is missing: ${skill.name}`);
    const content = await readFile(markerPath, "utf8");
    const contentHash = hashContent(content);
    return {
      skillId,
      name: skill.manifestName || skill.name,
      description: skill.manifestDescription || skill.description || "",
      content,
      contentHash,
      changedSinceRegistration: Boolean(skill.contentHash && skill.contentHash !== contentHash)
    };
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
    const selectedRoot = await this.#resolveSubpath(sourceRoot, skill.sourceSubpath ?? "");
    const markerPath = await this.#markerAtRoot(selectedRoot);
    if (!markerPath) throw skillError("INVALID_SKILL", `Skill 根目录缺少 SKILL.md：${selectedRoot}`);
    return { rootDir: selectedRoot, markerPath };
  }

  async #selectCandidate(sourceRoot, requestedSubpath = "") {
    const normalizedSubpath = normalizeSubpath(requestedSubpath);
    if (normalizedSubpath) {
      const selectedRoot = await this.#resolveSubpath(sourceRoot, normalizedSubpath);
      const markerPath = await this.#markerAtRoot(selectedRoot);
      if (!markerPath) throw skillError("INVALID_SKILL_SUBPATH", `所选子目录根部不含 SKILL.md：${normalizedSubpath}`);
      return this.#candidateFromMarker(sourceRoot, markerPath);
    }
    const candidates = await this.#discoverCandidates(sourceRoot);
    if (candidates.length === 0) throw skillError("INVALID_SKILL", `来源不含 SKILL.md：${sourceRoot}`);
    if (candidates.length > 1) {
      const error = skillError("AMBIGUOUS_SKILL_SOURCE", "该来源包含多个 Skill，请选择一个具体 Skill。");
      error.candidates = candidates;
      throw error;
    }
    return candidates[0];
  }

  async #discoverCandidates(sourceRoot) {
    if (!(await isDirectory(sourceRoot))) throw skillError("SOURCE_MISSING", `Skill 来源目录不存在：${sourceRoot}`);
    const markers = await this.#locateSkillMarkers(sourceRoot);
    return Promise.all(markers.map((markerPath) => this.#candidateFromMarker(sourceRoot, markerPath)));
  }

  async #candidateFromMarker(sourceRoot, markerPath) {
    const content = await readFile(markerPath, "utf8");
    const manifest = parseSkillManifest(content, basename(dirname(markerPath)));
    const [resolvedSourceRoot, resolvedSkillRoot] = await Promise.all([
      realpath(sourceRoot),
      realpath(dirname(markerPath))
    ]);
    const composition = await this.#inspectPackage(resolvedSkillRoot);
    return {
      relativePath: normalizeSubpath(relative(resolvedSourceRoot, resolvedSkillRoot)),
      manifestName: manifest.name,
      manifestDescription: manifest.description,
      contentHash: hashContent(content),
      composition
    };
  }

  async #inspectPackage(rootDir, options = {}) {
    if (!(await isDirectory(rootDir))) {
      throw skillError("SOURCE_MISSING", `Skill 来源目录不存在：${rootDir}`);
    }
    const markerPath = await this.#markerAtRoot(rootDir);
    if (!markerPath) throw skillError("INVALID_SKILL", `Skill 根目录缺少 SKILL.md：${rootDir}`);
    const descriptorPaths = [];
    for (const name of MCP_DESCRIPTOR_NAMES) {
      const candidate = join(rootDir, name);
      if (await isFile(candidate)) descriptorPaths.push(candidate);
    }
    if (descriptorPaths.length > 1) {
      throw skillError(
        "MCP_CONFIG_AMBIGUOUS",
        `Skill 根目录包含多个 MCP 描述文件：${descriptorPaths.map((item) => basename(item)).join(", ")}`
      );
    }
    const entries = await readdir(rootDir, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() || entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
    if (descriptorPaths.length === 0) {
      return { kind: "plain", files, mcp: null };
    }
    const descriptorPath = descriptorPaths[0];
    const descriptor = await readJsonDescriptor(descriptorPath);
    const declared = descriptor.mcpServers ?? descriptor.mcp_servers;
    if (!isRecord(declared) || Object.keys(declared).length === 0) {
      throw skillError(
        "MCP_CONFIG_INCOMPLETE",
        `MCP 描述 ${basename(descriptorPath)} 必须包含非空的 mcpServers（或 mcp_servers）。`
      );
    }
    if (descriptor.resources != null && !Array.isArray(descriptor.resources)) {
      throw skillError("MCP_CONFIG_INCOMPLETE", `MCP 描述 ${basename(descriptorPath)} 的 resources 必须是路径数组。`);
    }
    const resources = new Set();
    for (const resource of descriptor.resources ?? []) {
      if (typeof resource !== "string" || !resource.trim()) {
        throw skillError("MCP_CONFIG_INCOMPLETE", `MCP 描述 ${basename(descriptorPath)} 包含无效 resource 路径。`);
      }
      resources.add(await validatePackageResource(rootDir, resource, "resources"));
    }
    const servers = {};
    for (const [serverName, rawServer] of Object.entries(declared)) {
      const name = String(serverName ?? "").trim();
      if (!name || !isRecord(rawServer)) {
        throw skillError("MCP_CONFIG_INCOMPLETE", `MCP 描述 ${basename(descriptorPath)} 包含无效 server：${serverName}`);
      }
      servers[name] = await normalizeMcpServer(rootDir, name, rawServer, resources, options.resolveServers === true);
    }
    return {
      kind: "mcp",
      files,
      mcp: {
        descriptor: basename(descriptorPath),
        serverNames: Object.keys(servers),
        resources: [...resources].sort((a, b) => a.localeCompare(b)),
        ...(options.resolveServers ? { servers } : {})
      }
    };
  }

  async #resolveSubpath(sourceRoot, subpath) {
    const normalized = normalizeSubpath(subpath);
    const selected = resolve(sourceRoot, normalized || ".");
    let resolvedRoot;
    let resolvedSelected;
    try {
      [resolvedRoot, resolvedSelected] = await Promise.all([realpath(sourceRoot), realpath(selected)]);
    } catch {
      throw skillError("INVALID_SKILL_SUBPATH", `Skill 子目录不存在：${normalized || "."}`);
    }
    const rel = relative(resolvedRoot, resolvedSelected);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw skillError("INVALID_SKILL_SUBPATH", "Skill 子目录不能超出来源根目录。");
    }
    return resolvedSelected;
  }

  async #markerAtRoot(dir) {
    if (!(await isDirectory(dir))) return null;
    for (const name of ["SKILL.md", "skill.md", "SKILL.MD"]) {
      if (await isFile(join(dir, name))) return join(dir, name);
    }
    return null;
  }

  // 定位 SKILL.md（大小写不敏感，递归搜索子目录，优先最浅命中）。
  // 返回 SKILL.md 绝对路径，找不到返回 null。
  async #locateSkillMarker(dir, depth = 0) {
    return (await this.#locateSkillMarkers(dir, depth))[0] ?? null;
  }

  async #locateSkillMarkers(dir, depth = 0) {
    if (!(await isDirectory(dir))) return [];
    const marker = await this.#markerAtRoot(dir);
    if (marker) return [marker];
    if (depth >= MAX_SKILL_SEARCH_DEPTH) return [];
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const found = [];
    for (const sub of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!sub.isDirectory()) continue;
      found.push(...await this.#locateSkillMarkers(join(dir, sub.name), depth + 1));
    }
    return found;
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
    const parent = dirname(targetDir);
    const temporary = join(parent, `.${basename(targetDir)}.tmp-${randomUUID()}`);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await rm(temporary, { recursive: true, force: true });
    await cp(srcDir, temporary, { recursive: true });
    if (!(await this.#markerAtRoot(temporary))) {
      await rm(temporary, { recursive: true, force: true });
      throw skillError("INVALID_SKILL", "物化后的 Skill 根目录缺少 SKILL.md。");
    }
    await rm(targetDir, { recursive: true, force: true });
    await rename(temporary, targetDir);
  }
}

async function readJsonDescriptor(descriptorPath) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(descriptorPath, "utf8"));
  } catch (error) {
    throw skillError(
      "MCP_CONFIG_INVALID",
      `无法解析 MCP 描述 ${basename(descriptorPath)}：${error?.message ?? String(error)}`
    );
  }
  if (!isRecord(parsed)) {
    throw skillError("MCP_CONFIG_INVALID", `MCP 描述 ${basename(descriptorPath)} 的根节点必须是 JSON 对象。`);
  }
  if (parsed.mcpServers != null && parsed.mcp_servers != null) {
    throw skillError(
      "MCP_CONFIG_AMBIGUOUS",
      `MCP 描述 ${basename(descriptorPath)} 不能同时声明 mcpServers 和 mcp_servers。`
    );
  }
  return parsed;
}

async function normalizeMcpServer(rootDir, serverName, input, resources, resolveServers) {
  const type = String(input.type ?? (input.url ? "http" : "stdio")).trim().toLowerCase();
  if (!new Set(["stdio", "http", "sse"]).has(type)) {
    throw skillError("MCP_CONFIG_INCOMPLETE", `MCP server ${serverName} 使用不支持的 type：${type || "(empty)"}`);
  }
  if (type !== "stdio") {
    if (typeof input.url !== "string" || !input.url.trim()) {
      throw skillError("MCP_CONFIG_INCOMPLETE", `MCP server ${serverName} 缺少 url。`);
    }
    return cloneJsonValue(input);
  }
  if (typeof input.command !== "string" || !input.command.trim()) {
    throw skillError("MCP_CONFIG_INCOMPLETE", `MCP server ${serverName} 缺少 command。`);
  }
  if (input.args != null && (!Array.isArray(input.args) || input.args.some((arg) => typeof arg !== "string"))) {
    throw skillError("MCP_CONFIG_INCOMPLETE", `MCP server ${serverName} 的 args 必须是字符串数组。`);
  }
  if (input.env != null && (!isRecord(input.env)
    || Object.values(input.env).some((value) => typeof value !== "string"))) {
    throw skillError("MCP_CONFIG_INCOMPLETE", `MCP server ${serverName} 的 env 必须是字符串键值对象。`);
  }
  if (input.cwd != null && (typeof input.cwd !== "string" || !input.cwd.trim())) {
    throw skillError("MCP_CONFIG_INCOMPLETE", `MCP server ${serverName} 的 cwd 必须是非空路径。`);
  }

  const output = cloneJsonValue(input);
  output.type = "stdio";
  output.command = await resolveMcpPathValue(rootDir, input.command, `${serverName}.command`, resources, {
    validateBarePath: false,
    resolveServers
  });
  output.args = [];
  for (let index = 0; index < (input.args ?? []).length; index += 1) {
    output.args.push(await resolveMcpPathValue(
      rootDir,
      input.args[index],
      `${serverName}.args[${index}]`,
      resources,
      { validateBarePath: looksLikeResourcePath(input.args[index]), resolveServers }
    ));
  }
  if (input.cwd) {
    output.cwd = await resolveMcpPathValue(rootDir, input.cwd, `${serverName}.cwd`, resources, {
      validateBarePath: true,
      resolveServers
    });
  } else if (resolveServers) {
    output.cwd = rootDir;
  }
  if (input.env) {
    output.env = Object.fromEntries(Object.entries(input.env).map(([key, value]) => [
      key,
      replaceSkillRootTokens(value, rootDir)
    ]));
  }
  return output;
}

async function resolveMcpPathValue(rootDir, value, field, resources, options = {}) {
  const raw = String(value).trim();
  const hasRootToken = SKILL_ROOT_TOKENS.some((token) => raw.includes(token));
  const explicitlyRelative = raw.startsWith("./") || raw.startsWith("../");
  if (raw.includes("${") && !hasRootToken) {
    throw skillError("MCP_CONFIG_INCOMPLETE", `MCP 配置字段 ${field} 包含不支持的路径占位符：${raw}`);
  }
  const shouldResolve = hasRootToken || explicitlyRelative || options.validateBarePath;
  if (!shouldResolve) return raw;
  const replaced = replaceSkillRootTokens(raw, rootDir);
  const absolutePath = isAbsolute(replaced) ? resolve(replaced) : resolve(rootDir, replaced);
  const relativePath = await validatePackageResource(rootDir, absolutePath, field);
  resources.add(relativePath);
  return options.resolveServers ? absolutePath : raw;
}

async function validatePackageResource(rootDir, value, field) {
  const replaced = replaceSkillRootTokens(String(value).trim(), rootDir);
  const candidate = isAbsolute(replaced) ? resolve(replaced) : resolve(rootDir, replaced);
  const rootRealPath = await realpath(rootDir);
  let resourceRealPath;
  try {
    resourceRealPath = await realpath(candidate);
  } catch {
    throw skillError("MCP_RESOURCE_MISSING", `MCP 配置字段 ${field} 引用的资源不存在：${value}`);
  }
  const rel = relative(rootRealPath, resourceRealPath);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw skillError("MCP_RESOURCE_OUTSIDE_SKILL", `MCP 配置字段 ${field} 引用的资源超出 Skill 根目录：${value}`);
  }
  return normalizeSubpath(rel) || ".";
}

function replaceSkillRootTokens(value, rootDir) {
  return SKILL_ROOT_TOKENS.reduce((result, token) => result.replaceAll(token, rootDir), String(value));
}

function looksLikeResourcePath(value) {
  const text = String(value ?? "").trim();
  if (!text || text.startsWith("-")) return false;
  if (SKILL_ROOT_TOKENS.some((token) => text.includes(token))) return true;
  if (text.startsWith("./") || text.startsWith("../")) return true;
  return /[\\/]|\.(?:c?m?js|ts|py|rb|sh|jar|json|ya?ml|toml)$/i.test(text);
}

function cloneJsonValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function skillError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.name = "SkillRegistryError";
  return error;
}

function validateSkillId(value) {
  const id = String(value ?? "").trim();
  if (!id || id.length > 200 || /[\0\r\n]/.test(id)) {
    throw skillError("INVALID_INPUT", "skillId must be a non-empty identifier of at most 200 characters.");
  }
  return id;
}

function isPathWithin(path, root) {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function normalizeSubpath(value) {
  const normalized = String(value ?? "").trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  if (!normalized || normalized === ".") return "";
  if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw skillError("INVALID_SKILL_SUBPATH", "Skill 子目录必须是来源目录内的相对路径。");
  }
  return normalized;
}

function parseSkillManifest(content, fallbackName) {
  const frontmatter = String(content).match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? "";
  const field = (name) => {
    const match = frontmatter.match(new RegExp(`^${name}:\\s*(.+?)\\s*$`, "mi"));
    return match ? match[1].trim().replace(/^(["'])(.*)\1$/, "$2") : "";
  };
  return {
    name: field("name") || fallbackName || "skill",
    description: field("description")
  };
}

function hashContent(content) {
  return createHash("sha256").update(String(content)).digest("hex");
}

function tokenize(text) {
  return String(text ?? "").toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(Boolean);
}

function skillSearchScore(skill, terms) {
  if (terms.length === 0) return 1;
  const name = String(skill.name ?? "").toLowerCase();
  const displayName = String(skill.displayName ?? "").toLowerCase();
  const description = String(skill.description ?? "").toLowerCase();
  return terms.reduce((score, term) => score
    + (name === term ? 5 : name.includes(term) || term.includes(name) ? 3 : 0)
    + (displayName.includes(term) || term.includes(displayName) ? 2 : 0)
    + (description.includes(term) ? 1 : 0), 0);
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
