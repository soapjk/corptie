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
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const execFileAsync = promisify(execFile);

// 项目级 Skill 发现必须覆盖任意深度的源码子目录。明确排除依赖、版本库和构建缓存，
// 避免把第三方包里的 SKILL.md 当成用户项目的可安装 Skill，也避免无意义的大目录遍历。
const SKILL_DISCOVERY_IGNORED_DIRECTORIES = new Set([
  ".git", ".hg", ".svn", ".build", ".cache", ".corptie", ".dart_tool", ".gradle",
  ".next", ".nuxt", ".pytest_cache", ".swiftpm", ".turbo", ".venv",
  "DerivedData", "__pycache__", "build", "coverage", "dist", "node_modules",
  "target", "vendor"
]);
// MCP 描述符只在一个已识别 Package 的有限范围内搜索，避免把相邻 Package 的配置误绑定。
const MAX_MCP_DESCRIPTOR_SEARCH_DEPTH = 5;
const MAX_PACKAGE_PARENT_DEPTH = 6;
const MCP_DESCRIPTOR_NAMES = Object.freeze([".mcp.json", "mcp.json", "mcp.config.json"]);
const PLUGIN_MANIFEST_PATHS = Object.freeze([join(".codex-plugin", "plugin.json")]);
const SKILL_ROOT_TOKENS = Object.freeze([
  "${SKILL_ROOT}",
  "${SKILL_DIR}",
  "${PLUGIN_ROOT}",
  "${CLAUDE_PLUGIN_ROOT}"
]);
const CANDIDATE_INTERNAL = Symbol("skill-package-candidate");
const LEGACY_REPAIR_STATE_KEY = "skill_registry.legacy_repair.v1";
const LEGACY_REPAIR_VERSION = 1;
const DETERMINISTIC_LEGACY_REPAIR_ERRORS = new Set([
  "AMBIGUOUS_SKILL_SOURCE",
  "INVALID_SKILL",
  "INVALID_SKILL_SUBPATH",
  "MCP_CONFIG_INCOMPLETE",
  "MCP_CONFIG_INVALID",
  "MCP_RESOURCE_MISSING",
  "MCP_RESOURCE_OUTSIDE_SKILL",
  "MCP_TOOL_SCHEMA_INVALID",
  "MCP_TOOLS_EMPTY",
  "PACKAGE_MANIFEST_INVALID",
  "PACKAGE_RESOURCE_OUTSIDE_ROOT",
  "PACKAGE_ROOT_OUTSIDE_SOURCE",
  "SKILL_DISCOVERY_INVALID",
  "SKILL_ENTRY_MISSING"
]);

export class SkillRegistryService {
  constructor({
    store,
    skillsDirs = {},
    cacheRoot,
    exec = execFileAsync,
    removePath = rm,
    discoveryAssistant = null,
    verifyMcp = true,
    mcpVerificationTimeoutMs = 10_000
  } = {}) {
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
    // 可选的 Provider 中立后台 Agent。它只提出结构化候选计划，所有路径、清单和资源
    // 仍由本服务重新验证；标准插件和普通 Skill 不调用 Agent。
    this.discoveryAssistant = discoveryAssistant;
    this.verifyMcp = verifyMcp !== false;
    this.mcpVerificationTimeoutMs = mcpVerificationTimeoutMs;
  }

  setDiscoveryAssistant(assistant) {
    this.discoveryAssistant = typeof assistant === "function" ? assistant : null;
  }

  // 列出所有已登记 Skill。
  list() {
    return this.store.listRegistrySkills();
  }

  get(skillId) {
    return this.store.getRegistrySkill(skillId);
  }

  runtimeEvents(filters = {}) {
    return typeof this.store.listSkillRuntimeEvents === "function"
      ? this.store.listSkillRuntimeEvents(filters)
      : [];
  }

  async discover({ sourceType, source, assist = true }) {
    const type = sourceType === "git" ? "git" : "local";
    const rawSource = String(source ?? "").trim();
    if (!rawSource) throw skillError("INVALID_INPUT", "source is required.");
    let cachePath = null;
    try {
      const rootDir = type === "git"
        ? (cachePath = await this.#cloneGitSource(rawSource))
        : resolve(rawSource);
      // 项目扫描阶段只做确定性发现：一棵项目树可能包含大量普通 Skill，不能为每个
      // 候选串行启动后台 Agent。用户选定具体候选并登记时，register() 才按 assist
      // 设置对该一个候选执行 Agent 辅助识别与权威校验。
      const { candidates, diagnostics } = await this.#discoverCandidateResults(rootDir, { assist: false });
      if (candidates.length === 0) {
        if (diagnostics.length > 0) throw diagnostics[0].error;
        throw skillError("INVALID_SKILL", `所选来源不含 SKILL.md（或 skill.md）：${rawSource}`);
      }
      return {
        sourceType: type,
        source: rawSource,
        candidates,
        assistanceDeferred: assist !== false && candidates.some((candidate) => candidate.composition?.kind === "plain"),
        diagnostics: diagnostics.map(({ error: _error, ...diagnostic }) => diagnostic)
      };
    } finally {
      if (cachePath) await rm(cachePath, { recursive: true, force: true });
    }
  }

  // 登记一个 Skill。启动上下文只使用 manifest 索引；完整正文由 loadForAgent() 按需读取。
  async register({ name, description = "", sourceType, source, sourceSubpath = "", assist = true }) {
    const type = sourceType === "git" ? "git" : "local";
    const rawSource = String(source ?? "").trim();
    if (!rawSource) throw skillError("INVALID_INPUT", "source is required.");

    let cachePath = null;
    try {
      const sourceRoot = type === "git"
        ? (cachePath = await this.#cloneGitSource(rawSource))
        : resolve(rawSource);
      const candidate = await this.#selectCandidate(sourceRoot, sourceSubpath, { assist });
      const coordinates = this.#registrationCoordinates(type, rawSource, sourceRoot, candidate);
      const resolvedName = String(name ?? "").trim() || candidate.manifestName;
      const resolvedDescription = String(description ?? "").trim() || candidate.manifestDescription;

      const skill = this.store.createRegistrySkill({
        name: resolvedName,
        description: resolvedDescription,
        sourceType: type,
        source: coordinates.source,
        sourceSubpath: coordinates.sourceSubpath,
        packageSubpath: coordinates.packageSubpath,
        mcpDescriptorSubpath: coordinates.mcpDescriptorSubpath,
        packageDiscoveryMethod: coordinates.packageDiscoveryMethod,
        cachePath,
        manifestName: candidate.manifestName,
        manifestDescription: candidate.manifestDescription,
        contentHash: candidate.contentHash
      });

      try {
        await this.materialize(skill);
      } catch (error) {
        this.#recordRuntimeEvent({
          stage: "registration",
          status: "failed",
          skillId: skill.skillId,
          errorCode: error?.code ?? "SKILL_MATERIALIZATION_FAILED",
          reason: error?.message ?? String(error),
          details: { sourceType: type }
        });
        this.store.deleteRegistrySkill(skill.skillId);
        throw error;
      }

      this.#recordRuntimeEvent({
        stage: "registration",
        status: "success",
        skillId: skill.skillId,
        reason: "Skill package registered and materialized.",
        serverNames: candidate.composition.mcp?.serverNames ?? [],
        toolCount: candidate.composition.mcp?.toolCount ?? null,
        details: {
          packageDiscoveryMethod: coordinates.packageDiscoveryMethod,
          compound: Boolean(candidate.composition.mcp)
        }
      });

      return { ...this.store.getRegistrySkill(skill.skillId), composition: candidate.composition };
    } catch (error) {
      error.stage ??= "registration";
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
      const candidate = await this.#selectCandidate(
        sourceRoot,
        input.sourceSubpath ?? existing.sourceSubpath ?? "",
        { assist: input.assist !== false }
      );
      const coordinates = this.#registrationCoordinates(type, source, sourceRoot, candidate);
      const next = {
        ...existing,
        name: String(input.name ?? existing.name).trim() || candidate.manifestName,
        description: String(input.description ?? existing.description).trim() || candidate.manifestDescription,
        sourceType: type,
        source: coordinates.source,
        sourceSubpath: coordinates.sourceSubpath,
        packageSubpath: coordinates.packageSubpath,
        mcpDescriptorSubpath: coordinates.mcpDescriptorSubpath,
        packageDiscoveryMethod: coordinates.packageDiscoveryMethod,
        cachePath,
        manifestName: candidate.manifestName,
        manifestDescription: candidate.manifestDescription,
        contentHash: candidate.contentHash
      };
      await this.materialize(next);
      const updated = this.store.updateRegistrySkill(skillId, next);
      this.#recordRuntimeEvent({
        stage: "registration",
        status: "success",
        skillId,
        reason: "Skill package registration updated and materialized.",
        serverNames: candidate.composition.mcp?.serverNames ?? [],
        toolCount: candidate.composition.mcp?.toolCount ?? null,
        details: { packageDiscoveryMethod: coordinates.packageDiscoveryMethod, update: true }
      });
      if (existing.sourceType === "git" && existing.cachePath && existing.cachePath !== cachePath) {
        await rm(existing.cachePath, { recursive: true, force: true });
      }
      return { ...updated, composition: candidate.composition };
    } catch (error) {
      error.stage ??= "registration";
      this.#recordRuntimeEvent({
        stage: "registration",
        status: "failed",
        skillId,
        errorCode: error?.code ?? "SKILL_UPDATE_FAILED",
        reason: error?.message ?? String(error),
        details: { update: true }
      });
      if (createdCache && cachePath) await rm(cachePath, { recursive: true, force: true });
      throw error;
    }
  }

  // 旧版本只保存来源根目录，并递归取第一个 SKILL.md。若登记名称能唯一匹配
  // manifest name，则可无歧义地补齐精确子路径；无法唯一判断的记录保持不变。
  async repairLegacyRegistrations() {
    const repaired = [];
    const skipped = [];
    const skills = this.store.listRegistrySkills();
    const repairState = legacyRepairState(this.store);
    const currentSkillIds = new Set(skills.map((skill) => skill.skillId));
    let repairStateChanged = false;
    for (const skillId of Object.keys(repairState.failures)) {
      if (!currentSkillIds.has(skillId)) {
        delete repairState.failures[skillId];
        repairStateChanged = true;
      }
    }

    const persistRepairState = () => {
      if (!repairStateChanged || typeof this.store.setRuntimeState !== "function") return;
      this.store.setRuntimeState(LEGACY_REPAIR_STATE_KEY, repairState);
      repairStateChanged = false;
    };

    for (const skill of skills) {
      const fingerprint = legacyRepairFingerprint(skill);
      const previousFailure = repairState.failures[skill.skillId];
      if (skill.sourceSubpath && skill.manifestName && skill.contentHash && skill.packageDiscoveryMethod) {
        if (previousFailure) {
          delete repairState.failures[skill.skillId];
          repairStateChanged = true;
        }
        continue;
      }
      if (previousFailure?.fingerprint === fingerprint) {
        skipped.push({
          skillId: skill.skillId,
          reason: "unchanged_failure",
          errorCode: previousFailure.errorCode
        });
        continue;
      }
      try {
        const sourceRoot = await this.#sourceDir(skill);
        const candidates = await this.#discoverCandidates(sourceRoot);
        const expected = String(skill.name ?? "").trim().toLowerCase();
        const matches = candidates.filter((candidate) => candidate.manifestName.toLowerCase() === expected);
        const selected = matches.length === 1 ? matches[0] : (candidates.length === 1 ? candidates[0] : null);
        if (!selected) {
          repairState.failures[skill.skillId] = legacyRepairFailure(
            fingerprint,
            "AMBIGUOUS_SKILL_SOURCE"
          );
          repairStateChanged = true;
          persistRepairState();
          skipped.push({
            skillId: skill.skillId,
            reason: "ambiguous",
            errorCode: "AMBIGUOUS_SKILL_SOURCE",
            candidates
          });
          continue;
        }
        const updated = await this.update(skill.skillId, { sourceSubpath: selected.relativePath });
        if (previousFailure) {
          delete repairState.failures[skill.skillId];
          repairStateChanged = true;
        }
        repaired.push(updated);
      } catch (error) {
        const errorCode = error.code ?? "repair_failed";
        if (DETERMINISTIC_LEGACY_REPAIR_ERRORS.has(errorCode)) {
          repairState.failures[skill.skillId] = legacyRepairFailure(fingerprint, errorCode);
          repairStateChanged = true;
          persistRepairState();
        } else if (previousFailure) {
          delete repairState.failures[skill.skillId];
          repairStateChanged = true;
        }
        skipped.push({ skillId: skill.skillId, reason: errorCode, errorCode });
      }
    }
    persistRepairState();
    return { repaired, skipped };
  }

  // 物化安装：把 skill 内容落到每个 Provider 的 skills 目录（skill_id 命名子目录）。
  async materialize(skill) {
    try {
      const installation = await this.#resolveInstallation(skill);
      await this.#inspectPackage(installation.packageRoot, installation);
      const results = [];
      for (const [providerId, skillsRoot] of Object.entries(this.skillsDirs)) {
        const targetDir = join(skillsRoot, skill.skillId);
        const composition = await this.#mirrorPackage(installation.packageRoot, installation.skillRoot, targetDir, {
          descriptorRelativePath: installation.descriptorPath
            ? normalizeSubpath(relative(installation.packageRoot, installation.descriptorPath))
            : null,
          manifestRelativePath: installation.manifestPath
            ? normalizeSubpath(relative(installation.packageRoot, installation.manifestPath))
            : null,
          discoveryMethod: installation.discoveryMethod,
          assistance: installation.assistance
        });
        results.push({ providerId, installedAt: targetDir, composition });
        this.#recordRuntimeEvent({
          stage: "materialization",
          status: "success",
          skillId: skill.skillId,
          providerId,
          reason: "Skill package materialized for Provider runtime.",
          serverNames: composition.mcp?.serverNames ?? [],
          toolCount: composition.mcp?.toolCount ?? null,
          details: { compound: Boolean(composition.mcp) }
        });
      }
      return results;
    } catch (error) {
      error.stage ??= "materialization";
      this.#recordRuntimeEvent({
        stage: "materialization",
        status: "failed",
        skillId: skill.skillId,
        errorCode: error?.code ?? "SKILL_MATERIALIZATION_FAILED",
        reason: error?.message ?? String(error)
      });
      throw error;
    }
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
    const configuredPackages = new Set();
    for (const skill of assigned) {
      try {
      const installation = await this.#resolveInstallation(skill);
      const sourceComposition = await this.#inspectPackage(installation.packageRoot, installation);
      if (!sourceComposition.mcp) continue;
      const packageKey = [
        skill.sourceType,
        skill.source,
        skill.cachePath ?? "",
        skill.packageSubpath ?? "",
        skill.mcpDescriptorSubpath ?? ""
      ].join("\u0000");
      if (configuredPackages.has(packageKey)) continue;
      if (!skillsRoot) {
        throw skillError(
          "MCP_PROVIDER_UNSUPPORTED",
          `Provider ${providerId} 未配置复合 Skill 运行时目录，无法加载 Skill ${skill.name} 的 MCP 依赖。`
        );
      }
      const installedRoot = join(skillsRoot, skill.skillId);
      const installedDescriptor = installation.descriptorPath
        ? join(installedRoot, normalizeSubpath(relative(installation.packageRoot, installation.descriptorPath)))
        : null;
      const installed = await this.#inspectPackage(installedRoot, {
        skillRoot: installedRoot,
        descriptorPath: installedDescriptor,
        resolveServers: true
      });
      for (const [serverName, server] of Object.entries(installed.mcp?.servers ?? {})) {
        if (Object.prototype.hasOwnProperty.call(result, serverName)) {
          throw skillError(
            "MCP_SERVER_NAME_CONFLICT",
            `Agent ${agentId} 分配的 Skill 存在重复 MCP server 名称：${serverName}`
          );
        }
        result[serverName] = server;
      }
      configuredPackages.add(packageKey);
      this.#recordRuntimeEvent({
        stage: "mcp-loading",
        status: "success",
        skillId: skill.skillId,
        agentId,
        providerId,
        reason: "Assigned Skill MCP dependency resolved for the authenticated Tool Host gateway.",
        serverNames: Object.keys(installed.mcp?.servers ?? {})
      });
      } catch (error) {
        error.stage ??= "mcp-loading";
        this.#recordRuntimeEvent({
          stage: "mcp-loading",
          status: error?.code === "SKILL_NOT_ASSIGNED" ? "denied" : "failed",
          skillId: skill.skillId,
          agentId,
          providerId,
          errorCode: error?.code ?? "MCP_LOADING_FAILED",
          reason: error?.message ?? String(error)
        });
        throw error;
      }
    }
    return result;
  }

  mcpAssignmentRevisionForAgent(agentId) {
    if (!agentId || !this.store.getAgent(agentId)) return "none";
    const assigned = this.store.listRegistrySkillsForAgent(agentId).map((skill) => ({
      skillId: skill.skillId,
      contentHash: skill.contentHash ?? "",
      updatedAt: skill.updatedAt ?? "",
      packageSubpath: skill.packageSubpath ?? "",
      mcpDescriptorSubpath: skill.mcpDescriptorSubpath ?? ""
    })).sort((left, right) => left.skillId.localeCompare(right.skillId));
    return assigned.length === 0
      ? "none"
      : createHash("sha256").update(JSON.stringify(assigned)).digest("hex");
  }

  #recordRuntimeEvent(input) {
    if (typeof this.store.recordSkillRuntimeEvent !== "function") return null;
    const event = this.store.recordSkillRuntimeEvent(input);
    const suffix = input.errorCode ? ` code=${input.errorCode}` : "";
    const skill = input.skillId ? ` skill=${input.skillId}` : "";
    const agent = input.agentId ? ` agent=${input.agentId}` : "";
    console[input.status === "failed" ? "error" : input.status === "denied" ? "warn" : "log"](
      `[skills] stage=${input.stage} status=${input.status}${suffix}${skill}${agent} reason=${input.reason ?? ""}`
    );
    return event;
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
    this.#recordRuntimeEvent({
      stage: "skill-discovery",
      status: candidates.length > 0 ? "success" : "denied",
      skillId: candidates[0]?.skillId ?? null,
      agentId,
      reason: candidates.length > 0
        ? `Found ${candidates.length} assigned Skill candidate(s).`
        : "No assigned Skill matched the authenticated Agent request.",
      details: { candidateCount: candidates.length }
    });
    return { found: candidates.length > 0, candidates };
  }

  async loadForAgent(agentId, skillId) {
    if (!agentId || !this.store.getAgent(agentId)) throw skillError("AGENT_NOT_FOUND", `Agent not found: ${agentId}`);
    const allowed = this.store.listRegistrySkillIdsForAgent(agentId);
    if (!allowed.includes(skillId)) {
      this.#recordRuntimeEvent({
        stage: "skill-load",
        status: "denied",
        skillId: this.store.getRegistrySkill(skillId) ? skillId : null,
        agentId,
        errorCode: "SKILL_NOT_ASSIGNED",
        reason: `Skill is not assigned to Agent ${agentId}: ${skillId}`
      });
      throw skillError("SKILL_NOT_ASSIGNED", `Skill is not assigned to Agent ${agentId}: ${skillId}`);
    }
    const skill = this.store.getRegistrySkill(skillId);
    if (!skill) throw skillError("NOT_FOUND", `Skill not found: ${skillId}`);
    const { markerPath } = await this.#resolveSkillRoot(skill);
    if (!markerPath) throw skillError("INVALID_SKILL", `Skill marker is missing: ${skill.name}`);
    const content = await readFile(markerPath, "utf8");
    const contentHash = hashContent(content);
    this.#recordRuntimeEvent({
      stage: "skill-load",
      status: "success",
      skillId,
      agentId,
      reason: "Assigned Skill instructions loaded for authenticated Agent."
    });
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
    const installation = await this.#resolveInstallation(skill);
    return { rootDir: installation.skillRoot, markerPath: installation.markerPath };
  }

  async #resolveInstallation(skill) {
    const sourceRoot = await realpath(await this.#sourceDir(skill));
    const skillRoot = await this.#resolveSubpath(sourceRoot, skill.sourceSubpath ?? "");
    const markerPath = await this.#markerAtRoot(skillRoot);
    if (!markerPath) throw skillError("INVALID_SKILL", `Skill 根目录缺少 SKILL.md：${skillRoot}`);

    let packageRoot = skill.packageSubpath
      ? await this.#resolveSubpath(sourceRoot, skill.packageSubpath)
      : sourceRoot;
    let definition = await this.#packageDefinition(packageRoot, skillRoot);
    if (skill.mcpDescriptorSubpath) {
      definition = {
        ...definition,
        descriptorPath: await resolvePackagePath(
          packageRoot,
          skill.mcpDescriptorSubpath,
          "stored MCP descriptor",
          { missingCode: "MCP_DESCRIPTOR_MISSING" }
        ),
        discoveryMethod: skill.packageDiscoveryMethod || definition.discoveryMethod
      };
    }
    // 兼容旧记录：历史 source 指向仓库根、sourceSubpath 指向嵌套 Skill，且没有包级字段。
    if (!skill.packageSubpath && packageRoot !== skillRoot && !definition.manifestPath && !definition.descriptorPath) {
      packageRoot = skillRoot;
      definition = await this.#packageDefinition(packageRoot, skillRoot);
    }
    return { sourceRoot, packageRoot, skillRoot, markerPath, ...definition };
  }

  #registrationCoordinates(type, rawSource, sourceRoot, candidate) {
    const internal = candidate[CANDIDATE_INTERNAL];
    if (!internal) throw skillError("SKILL_DISCOVERY_INVALID", "Skill 发现结果缺少经过验证的 Package 信息。");
    const resolvedSourceRoot = internal.sourceRoot ?? sourceRoot;
    const packageRel = relative(resolvedSourceRoot, internal.packageRoot);
    const packageOutsideSource = packageRel === ".." || packageRel.startsWith(`..${sep}`) || isAbsolute(packageRel);
    if (packageOutsideSource) {
      if (type === "git") {
        throw skillError("PACKAGE_ROOT_OUTSIDE_SOURCE", "Git Skill 的 Package 根目录不能超出克隆来源。");
      }
      return {
        source: internal.packageRoot,
        packageSubpath: "",
        sourceSubpath: normalizeSubpath(relative(internal.packageRoot, internal.skillRoot)),
        mcpDescriptorSubpath: internal.descriptorPath
          ? normalizeSubpath(relative(internal.packageRoot, internal.descriptorPath))
          : "",
        packageDiscoveryMethod: internal.discoveryMethod ?? "plain"
      };
    }
    return {
      source: rawSource,
      packageSubpath: normalizeSubpath(packageRel),
      sourceSubpath: normalizeSubpath(relative(resolvedSourceRoot, internal.skillRoot)),
      mcpDescriptorSubpath: internal.descriptorPath
        ? normalizeSubpath(relative(internal.packageRoot, internal.descriptorPath))
        : "",
      packageDiscoveryMethod: internal.discoveryMethod ?? "plain"
    };
  }

  async #selectCandidate(sourceRoot, requestedSubpath = "", options = {}) {
    const normalizedSubpath = normalizeSubpath(requestedSubpath);
    if (normalizedSubpath) {
      const selectedRoot = await this.#resolveSubpath(sourceRoot, normalizedSubpath);
      const markerPath = await this.#markerAtRoot(selectedRoot);
      if (!markerPath) throw skillError("INVALID_SKILL_SUBPATH", `所选子目录根部不含 SKILL.md：${normalizedSubpath}`);
      return this.#candidateFromMarker(sourceRoot, markerPath, options);
    }
    const candidates = await this.#discoverCandidates(sourceRoot, options);
    if (candidates.length === 0) throw skillError("INVALID_SKILL", `来源不含 SKILL.md：${sourceRoot}`);
    if (candidates.length > 1) {
      const error = skillError("AMBIGUOUS_SKILL_SOURCE", "该来源包含多个 Skill，请选择一个具体 Skill。");
      error.candidates = candidates;
      throw error;
    }
    return candidates[0];
  }

  async #discoverCandidates(sourceRoot, options = {}) {
    const { candidates, diagnostics } = await this.#discoverCandidateResults(sourceRoot, options);
    if (candidates.length === 0 && diagnostics.length > 0) throw diagnostics[0].error;
    return candidates;
  }

  async #discoverCandidateResults(sourceRoot, options = {}) {
    if (!(await isDirectory(sourceRoot))) throw skillError("SOURCE_MISSING", `Skill 来源目录不存在：${sourceRoot}`);
    const markers = await this.#locateSkillMarkers(sourceRoot);
    const candidates = [];
    const diagnostics = [];
    for (const markerPath of markers) {
      try {
        candidates.push(await this.#candidateFromMarker(sourceRoot, markerPath, options));
      } catch (error) {
        diagnostics.push({
          relativePath: normalizeSubpath(relative(sourceRoot, dirname(markerPath))),
          code: error?.code ?? "SKILL_DISCOVERY_FAILED",
          stage: error?.stage ?? "composition",
          message: error?.message ?? String(error),
          error
        });
      }
    }
    candidates.sort((a, b) => candidateDiscoveryRank(a) - candidateDiscoveryRank(b)
      || a.relativePath.localeCompare(b.relativePath));
    return { candidates, diagnostics };
  }

  async #candidateFromMarker(sourceRoot, markerPath, options = {}) {
    const content = await readFile(markerPath, "utf8");
    const manifest = parseSkillManifest(content, basename(dirname(markerPath)));
    const [resolvedSourceRoot, resolvedSkillRoot] = await Promise.all([
      realpath(sourceRoot),
      realpath(dirname(markerPath))
    ]);
    const packageDefinition = await this.#findPackageForSkill(resolvedSourceRoot, resolvedSkillRoot, {
      assist: options.assist !== false
    });
    const composition = await this.#inspectPackage(packageDefinition.packageRoot, {
      skillRoot: resolvedSkillRoot,
      ...packageDefinition
    });
    const candidate = {
      relativePath: normalizeSubpath(relative(resolvedSourceRoot, resolvedSkillRoot)),
      packageRelativePath: safeRelativeDisplay(resolvedSourceRoot, packageDefinition.packageRoot),
      manifestName: manifest.name,
      manifestDescription: manifest.description,
      contentHash: hashContent(content),
      composition
    };
    Object.defineProperty(candidate, CANDIDATE_INTERNAL, {
      value: { sourceRoot: resolvedSourceRoot, skillRoot: resolvedSkillRoot, ...packageDefinition },
      enumerable: false
    });
    return candidate;
  }

  async #findPackageForSkill(sourceRoot, skillRoot, options = {}) {
    let current = skillRoot;
    for (let depth = 0; depth <= MAX_PACKAGE_PARENT_DEPTH; depth += 1) {
      for (const relativeManifest of PLUGIN_MANIFEST_PATHS) {
        const manifestPath = join(current, relativeManifest);
        if (await isFile(manifestPath)) {
          const definition = await this.#packageDefinition(current, skillRoot, { manifestPath });
          return { packageRoot: current, ...definition };
        }
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }

    const sameRoot = await this.#packageDefinition(skillRoot, skillRoot);
    if (sameRoot.descriptorPath) return { packageRoot: skillRoot, ...sameRoot };

    // 项目发现阶段明确禁用 Agent 辅助，因此也不需要搜索项目内的外部 MCP 描述符。
    // 否则每个普通 Skill 候选都会把整个项目再遍历一次，扫描耗时会随候选数量成倍增长。
    if (!options.assist || !this.discoveryAssistant) {
      return { packageRoot: skillRoot, ...sameRoot };
    }

    const hints = await this.#locateMcpDescriptors(sourceRoot);
    const externalHints = hints.filter((item) => dirname(item) !== skillRoot);
    if (externalHints.length > 0) {
      const proposed = await this.discoveryAssistant({
        sourceRoot,
        skillRoot,
        markerPath: await this.#markerAtRoot(skillRoot),
        mcpDescriptorHints: externalHints.map((item) => safeRelativeDisplay(sourceRoot, item))
      });
      return this.#validateAssistedPackage(sourceRoot, skillRoot, proposed);
    }
    return { packageRoot: skillRoot, ...sameRoot };
  }

  async #packageDefinition(packageRoot, skillRoot, options = {}) {
    if (!(await isDirectory(packageRoot))) {
      throw skillError("SOURCE_MISSING", `Skill Package 根目录不存在：${packageRoot}`);
    }
    const explicitManifest = options.manifestPath ?? null;
    const manifestPath = explicitManifest
      ?? (await firstExistingFile(PLUGIN_MANIFEST_PATHS.map((item) => join(packageRoot, item))));
    if (manifestPath) {
      const plugin = await readPluginManifest(manifestPath);
      const declaredSkillRoots = normalizeManifestPaths(plugin.skills, "skills", manifestPath);
      if (declaredSkillRoots.length === 0) {
        throw skillError("PACKAGE_MANIFEST_INVALID", `插件清单 ${manifestPath} 必须声明 skills 路径。`);
      }
      const ownsSkill = await anyPathContains(packageRoot, declaredSkillRoots, skillRoot);
      if (!ownsSkill && !options.allowMissingManifestSkill) {
        throw skillError("SKILL_ENTRY_MISSING", `插件清单 ${manifestPath} 未声明 Skill：${skillRoot}`);
      }
      let descriptorPath = null;
      if (plugin.mcpServers != null) {
        if (typeof plugin.mcpServers !== "string" || !plugin.mcpServers.trim()) {
          throw skillError("PACKAGE_MANIFEST_INVALID", `插件清单 ${manifestPath} 的 mcpServers 必须是描述文件路径。`);
        }
        descriptorPath = await resolvePackagePath(packageRoot, plugin.mcpServers, "mcpServers", {
          missingCode: "MCP_DESCRIPTOR_MISSING"
        });
      }
      return { manifestPath, descriptorPath, discoveryMethod: "plugin-manifest" };
    }

    const descriptorPaths = [];
    for (const name of MCP_DESCRIPTOR_NAMES) {
      const candidate = join(packageRoot, name);
      if (await isFile(candidate)) descriptorPaths.push(candidate);
    }
    if (descriptorPaths.length > 1) {
      throw skillError(
        "MCP_CONFIG_AMBIGUOUS",
        `Skill Package 根目录包含多个 MCP 描述文件：${descriptorPaths.map((item) => basename(item)).join(", ")}`
      );
    }
    return {
      manifestPath: null,
      descriptorPath: descriptorPaths[0] ?? null,
      discoveryMethod: descriptorPaths.length > 0 ? "skill-root" : "plain"
    };
  }

  async #validateAssistedPackage(sourceRoot, skillRoot, proposed) {
    if (!isRecord(proposed)) {
      throw skillError("SKILL_ASSISTANCE_INVALID", "后台 Agent 未返回结构化 Skill Package 安装计划。");
    }
    const packageRoot = await resolvePackagePath(sourceRoot, proposed.packageRoot ?? ".", "packageRoot", {
      directory: true,
      missingCode: "PACKAGE_ROOT_INVALID"
    });
    const skillRel = relative(packageRoot, skillRoot);
    if (skillRel === ".." || skillRel.startsWith(`..${sep}`) || isAbsolute(skillRel)) {
      throw skillError("SKILL_ASSISTANCE_INVALID", "后台 Agent 建议的 Package 根目录不包含所选 Skill。");
    }
    const descriptorText = typeof proposed.mcpDescriptor === "string" ? proposed.mcpDescriptor.trim() : "";
    if (!descriptorText) {
      throw skillError("SKILL_ASSISTANCE_INVALID", "后台 Agent 安装计划缺少 mcpDescriptor。 ");
    }
    const descriptorPath = await resolvePackagePath(packageRoot, descriptorText, "mcpDescriptor", {
      missingCode: "MCP_DESCRIPTOR_MISSING"
    });
    // 在接受计划前完整解析一次，Agent 不能绕过确定性 MCP 校验。
    await this.#inspectPackage(packageRoot, { skillRoot, descriptorPath });
    return {
      packageRoot,
      manifestPath: null,
      descriptorPath,
      discoveryMethod: "agent-assisted",
      assistance: {
        confidence: normalizeConfidence(proposed.confidence),
        evidence: normalizeEvidence(proposed.evidence)
      }
    };
  }

  async #inspectPackage(rootDir, options = {}) {
    if (!(await isDirectory(rootDir))) {
      throw skillError("SOURCE_MISSING", `Skill Package 来源目录不存在：${rootDir}`);
    }
    const skillRoot = options.skillRoot ?? rootDir;
    const markerPath = await this.#markerAtRoot(skillRoot);
    if (!markerPath) throw skillError("INVALID_SKILL", `Skill 根目录缺少 SKILL.md：${skillRoot}`);
    const entries = await readdir(rootDir, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() || entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
    const descriptorPath = options.descriptorPath ?? null;
    const packageMetadata = {
      discoveryMethod: options.discoveryMethod ?? "plain",
      manifest: options.manifestPath ? normalizeSubpath(relative(rootDir, options.manifestPath)) : null,
      skillPath: normalizeSubpath(relative(rootDir, skillRoot)),
      ...(options.assistance ? { assistance: options.assistance } : {})
    };
    if (!descriptorPath) {
      return { kind: "plain", files, package: packageMetadata, mcp: null };
    }
    await validatePackageResource(rootDir, descriptorPath, "MCP descriptor");
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
      package: packageMetadata,
      mcp: {
        descriptor: normalizeSubpath(relative(rootDir, descriptorPath)),
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

  // 定位第一个 SKILL.md（大小写不敏感，递归搜索全部源码子目录）。
  async #locateSkillMarker(dir) {
    return (await this.#locateSkillMarkers(dir))[0] ?? null;
  }

  async #locateSkillMarkers(dir) {
    if (!(await isDirectory(dir))) return [];
    const marker = await this.#markerAtRoot(dir);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    // 目录本身是一个 Skill，不代表它的子目录不含其他独立 Skill。项目级扫描必须继续。
    const found = marker ? [marker] : [];
    for (const sub of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!sub.isDirectory() || SKILL_DISCOVERY_IGNORED_DIRECTORIES.has(sub.name)) continue;
      found.push(...await this.#locateSkillMarkers(join(dir, sub.name)));
    }
    return found;
  }

  async #locateMcpDescriptors(dir, depth = 0) {
    if (!(await isDirectory(dir)) || depth > MAX_MCP_DESCRIPTOR_SEARCH_DEPTH) return [];
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const found = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const item = join(dir, entry.name);
      if (entry.isFile() && MCP_DESCRIPTOR_NAMES.includes(entry.name)) found.push(item);
      if (entry.isDirectory() && !SKILL_DISCOVERY_IGNORED_DIRECTORIES.has(entry.name)) {
        found.push(...await this.#locateMcpDescriptors(item, depth + 1));
      }
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

  // 原子物化整个 Package，并把所选 Skill 的内容提升到目标根，使 Provider 仍能按
  // <skillsRoot>/<skillId>/SKILL.md 加载，同时保留 ${PLUGIN_ROOT} 所需的包级资源。
  async #mirrorPackage(packageRoot, skillRoot, targetDir, options = {}) {
    const parent = dirname(targetDir);
    const temporary = join(parent, `.${basename(targetDir)}.tmp-${randomUUID()}`);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await rm(temporary, { recursive: true, force: true });
    try {
      await cp(packageRoot, temporary, { recursive: true });
      if (packageRoot !== skillRoot) {
        const skillEntries = await readdir(skillRoot, { withFileTypes: true });
        for (const entry of skillEntries) {
          await cp(join(skillRoot, entry.name), join(temporary, entry.name), {
            recursive: true,
            force: true
          });
        }
      }
      if (!(await this.#markerAtRoot(temporary))) {
        throw skillError("INVALID_SKILL", "物化后的 Skill 根目录缺少 SKILL.md。");
      }
      const composition = await this.#inspectPackage(temporary, {
        skillRoot: temporary,
        descriptorPath: options.descriptorRelativePath ? join(temporary, options.descriptorRelativePath) : null,
        manifestPath: options.manifestRelativePath ? join(temporary, options.manifestRelativePath) : null,
        discoveryMethod: options.discoveryMethod,
        assistance: options.assistance,
        resolveServers: true
      });
      if (this.verifyMcp && composition.mcp) {
        const verification = await this.#verifyMcpServers(composition.mcp.servers);
        composition.mcp.toolCount = verification.toolCount;
      }
      await rm(targetDir, { recursive: true, force: true });
      await rename(temporary, targetDir);
      return stripResolvedServers(composition);
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
  }

  async #verifyMcpServers(servers = {}) {
    let toolCount = 0;
    for (const [serverName, server] of Object.entries(servers)) {
      if (server.type !== "stdio") continue;
      const client = new Client({ name: "corptie-skill-installer", version: "1.0.0" });
      const transport = new StdioClientTransport({
        command: server.command,
        args: server.args ?? [],
        cwd: server.cwd,
        env: { ...process.env, ...(server.env ?? {}) },
        stderr: "pipe"
      });
      try {
        await withTimeout(
          client.connect(transport),
          this.mcpVerificationTimeoutMs,
          `MCP server ${serverName} initialize 超时。`
        );
        let listed;
        try {
          listed = await withTimeout(
            client.listTools(),
            this.mcpVerificationTimeoutMs,
            `MCP server ${serverName} tools/list 超时。`
          );
        } catch (error) {
          if (Number(error?.code) === -32601) {
            throw skillError("MCP_TOOLS_EMPTY", `MCP server ${serverName} 未实现 tools/list，无法为 Skill 提供工具。`);
          }
          throw error;
        }
        if (!Array.isArray(listed?.tools) || listed.tools.length === 0) {
          throw skillError("MCP_TOOLS_EMPTY", `MCP server ${serverName} 未暴露任何工具。`);
        }
        validateProviderToolSchemas(serverName, listed.tools);
        toolCount += listed.tools.length;
      } catch (error) {
        if (new Set(["MCP_TOOLS_EMPTY", "MCP_TOOL_SCHEMA_INVALID", "MCP_TOOL_SCHEMA_UNSUPPORTED"]).has(error?.code)) {
          throw error;
        }
        const schemaSummary = summarizeToolSchemaError(error);
        if (schemaSummary) {
          throw skillError(
            "MCP_TOOL_SCHEMA_INVALID",
            `MCP server ${serverName} 的 tools/list 响应不符合 MCP 工具 Schema：${schemaSummary}`
          );
        }
        throw skillError(
          "MCP_SERVER_START_FAILED",
          `MCP server ${serverName} 安装验证失败：${error?.message ?? String(error)}`
        );
      } finally {
        await client.close().catch(() => {});
      }
    }
    return { serverNames: Object.keys(servers), toolCount };
  }
}

function legacyRepairState(store) {
  const stored = typeof store.getRuntimeState === "function"
    ? store.getRuntimeState(LEGACY_REPAIR_STATE_KEY)
    : null;
  if (stored?.repairVersion !== LEGACY_REPAIR_VERSION || !stored.failures || typeof stored.failures !== "object") {
    return { repairVersion: LEGACY_REPAIR_VERSION, failures: {} };
  }
  return {
    repairVersion: LEGACY_REPAIR_VERSION,
    failures: { ...stored.failures }
  };
}

function legacyRepairFingerprint(skill) {
  return createHash("sha256").update(JSON.stringify({
    repairVersion: LEGACY_REPAIR_VERSION,
    sourceType: skill.sourceType ?? "local",
    source: skill.source ?? "",
    sourceSubpath: skill.sourceSubpath ?? "",
    packageSubpath: skill.packageSubpath ?? "",
    mcpDescriptorSubpath: skill.mcpDescriptorSubpath ?? "",
    packageDiscoveryMethod: skill.packageDiscoveryMethod ?? "",
    manifestName: skill.manifestName ?? "",
    contentHash: skill.contentHash ?? "",
    updatedAt: skill.updatedAt ?? ""
  })).digest("hex");
}

function legacyRepairFailure(fingerprint, errorCode) {
  return {
    fingerprint,
    errorCode,
    attemptedAt: new Date().toISOString()
  };
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

async function readPluginManifest(manifestPath) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw skillError(
      "PACKAGE_MANIFEST_INVALID",
      `无法解析插件清单 ${manifestPath}：${error?.message ?? String(error)}`
    );
  }
  if (!isRecord(parsed)) {
    throw skillError("PACKAGE_MANIFEST_INVALID", `插件清单 ${manifestPath} 的根节点必须是 JSON 对象。`);
  }
  return parsed;
}

function normalizeManifestPaths(value, field, manifestPath) {
  const values = typeof value === "string" ? [value] : (Array.isArray(value) ? value : []);
  if (values.some((item) => typeof item !== "string" || !item.trim())) {
    throw skillError("PACKAGE_MANIFEST_INVALID", `插件清单 ${manifestPath} 的 ${field} 必须是路径或路径数组。`);
  }
  return values.map((item) => item.trim());
}

async function anyPathContains(packageRoot, declaredPaths, targetPath) {
  const targetRealPath = await realpath(targetPath);
  for (const declaredPath of declaredPaths) {
    const declaredRoot = await resolvePackagePath(packageRoot, declaredPath, "skills", {
      directory: true,
      missingCode: "SKILL_ENTRY_MISSING"
    });
    const rel = relative(declaredRoot, targetRealPath);
    if (rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) return true;
  }
  return false;
}

async function resolvePackagePath(packageRoot, value, field, options = {}) {
  const raw = String(value ?? "").trim();
  if (!raw) throw skillError(options.missingCode ?? "PACKAGE_RESOURCE_MISSING", `Package 字段 ${field} 缺少路径。`);
  const replaced = replaceSkillRootTokens(raw, packageRoot);
  const candidate = isAbsolute(replaced) ? resolve(replaced) : resolve(packageRoot, replaced);
  const lexicalRel = relative(resolve(packageRoot), candidate);
  if (lexicalRel === ".." || lexicalRel.startsWith(`..${sep}`) || isAbsolute(lexicalRel)) {
    throw skillError("PACKAGE_RESOURCE_OUTSIDE_ROOT", `Package 字段 ${field} 超出 Package 根目录：${raw}`);
  }
  let rootRealPath;
  let candidateRealPath;
  try {
    [rootRealPath, candidateRealPath] = await Promise.all([realpath(packageRoot), realpath(candidate)]);
  } catch {
    throw skillError(options.missingCode ?? "PACKAGE_RESOURCE_MISSING", `Package 字段 ${field} 引用不存在：${raw}`);
  }
  const rel = relative(rootRealPath, candidateRealPath);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw skillError("PACKAGE_RESOURCE_OUTSIDE_ROOT", `Package 字段 ${field} 超出 Package 根目录：${raw}`);
  }
  const info = await stat(candidateRealPath);
  if (options.directory ? !info.isDirectory() : !info.isFile()) {
    throw skillError(options.missingCode ?? "PACKAGE_RESOURCE_INVALID", `Package 字段 ${field} 类型不正确：${raw}`);
  }
  return candidateRealPath;
}

async function firstExistingFile(paths) {
  for (const path of paths) {
    if (await isFile(path)) return path;
  }
  return null;
}

function safeRelativeDisplay(rootDir, item) {
  const value = relative(rootDir, item).replaceAll("\\", "/");
  return value || ".";
}

function normalizeConfidence(value) {
  const confidence = Number(value);
  if (!Number.isFinite(confidence)) return null;
  return Math.max(0, Math.min(1, confidence));
}

function normalizeEvidence(value) {
  return (Array.isArray(value) ? value : [])
    .filter((item) => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 20);
}

function summarizeToolSchemaError(error) {
  const message = String(error?.message ?? "").trim();
  if (!message.includes("inputSchema")) return null;
  try {
    const issues = JSON.parse(message);
    if (!Array.isArray(issues)) return message.slice(0, 500);
    return issues.slice(0, 5).map((issue) => {
      const path = Array.isArray(issue?.path) ? issue.path.join(".") : "inputSchema";
      return `${path}: ${issue?.message ?? "invalid schema"}`;
    }).join("; ");
  } catch {
    return message.slice(0, 500);
  }
}

function validateProviderToolSchemas(serverName, tools) {
  for (const tool of tools) {
    const toolName = typeof tool?.name === "string" && tool.name.trim() ? tool.name.trim() : "(unnamed)";
    validateProviderJsonSchema(serverName, toolName, "inputSchema", tool?.inputSchema, { required: true });
    if (tool?.outputSchema != null) {
      validateProviderJsonSchema(serverName, toolName, "outputSchema", tool.outputSchema, { required: false });
    }
  }
}

function validateProviderJsonSchema(serverName, toolName, field, schema, options = {}) {
  if (!isRecord(schema)) {
    throw skillError(
      "MCP_TOOL_SCHEMA_INVALID",
      `MCP server ${serverName} 的工具 ${toolName}.${field} 必须是 JSON 对象。`
    );
  }
  if (schema.type !== "object") {
    throw skillError(
      "MCP_TOOL_SCHEMA_INVALID",
      `MCP server ${serverName} 的工具 ${toolName}.${field} 根 type 必须是 object。`
    );
  }
  if (schema.properties != null && !isRecord(schema.properties)) {
    throw skillError(
      "MCP_TOOL_SCHEMA_INVALID",
      `MCP server ${serverName} 的工具 ${toolName}.${field}.properties 必须是 JSON 对象。`
    );
  }
  if (schema.required != null && (!Array.isArray(schema.required)
    || schema.required.some((value) => typeof value !== "string" || !value.trim()))) {
    throw skillError(
      "MCP_TOOL_SCHEMA_INVALID",
      `MCP server ${serverName} 的工具 ${toolName}.${field}.required 必须是非空字段名数组。`
    );
  }
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const unknownRequired = (schema.required ?? []).filter((name) => !Object.prototype.hasOwnProperty.call(properties, name));
  if (unknownRequired.length > 0) {
    throw skillError(
      "MCP_TOOL_SCHEMA_INVALID",
      `MCP server ${serverName} 的工具 ${toolName}.${field}.required 引用了未声明字段：${unknownRequired.join(", ")}`
    );
  }
  const unsupported = findUnsupportedSchemaKeyword(schema);
  if (unsupported) {
    throw skillError(
      "MCP_TOOL_SCHEMA_UNSUPPORTED",
      `MCP server ${serverName} 的工具 ${toolName}.${field}${unsupported.path} 使用 Provider 不兼容的 ${unsupported.keyword}。`
    );
  }
  if (options.required && Object.prototype.hasOwnProperty.call(schema, "required") && !Array.isArray(schema.required)) {
    throw skillError("MCP_TOOL_SCHEMA_INVALID", `MCP server ${serverName} 的工具 ${toolName}.${field}.required 无效。`);
  }
}

function findUnsupportedSchemaKeyword(value, path = "") {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findUnsupportedSchemaKeyword(value[index], `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  for (const keyword of ["$ref", "$defs", "oneOf", "anyOf", "allOf"]) {
    if (Object.prototype.hasOwnProperty.call(value, keyword)) return { keyword, path };
  }
  if (Array.isArray(value.type)) return { keyword: "联合 type 数组", path };
  for (const [key, nested] of Object.entries(value)) {
    const found = findUnsupportedSchemaKeyword(nested, `${path}.${key}`);
    if (found) return found;
  }
  return null;
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

function stripResolvedServers(composition) {
  if (!composition?.mcp?.servers) return composition;
  const cloned = cloneJsonValue(composition);
  delete cloned.mcp.servers;
  return cloned;
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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

function candidateDiscoveryRank(candidate) {
  if (candidate?.composition?.kind === "mcp") return 0;
  return 1;
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
