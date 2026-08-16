import { mkdir, stat } from "node:fs/promises";
import os from "node:os";
import { join, resolve } from "node:path";

// Agent 工作目录约定（03 / 15 Phase 5「角色化执行主体」的持久化地基）。
//
// 目录是「元数据」：路径落库（agents.work_dir），目录内容（记忆 / Skill / 制度化文件）
// 作为普通文件落在该目录里，由各 Provider runtime 直接读取，绝不把文件内容塞进数据库。
//
// 约定（相对 corptieHome）：
//   - Assistant（平台预置单例）：runtimes/assistant/workspace —— 该助手下所有会话共用此目录。
//   - 独立贡献者：runtimes/contributors/<agentId> —— 存放该 Agent 的记忆 / Skill 等持久化文件，
//     但不作为会话的直接工作目录（会话绑定 WorkItem，用 WorkItem 的 workspace 目录）。
//
// production 下 runtimes 根无 "development/" 前缀，与 corptieCodexRuntime 的布局保持一致。

export function resolveAgentRuntimesRoot(options = {}) {
  const home = resolve(options.homeDir ?? os.homedir());
  const corptieHome = resolve(options.corptieHome ?? process.env.CORPTIE_HOME ?? join(home, ".corptie"));
  const environmentName = options.environmentName === "development" ? "development" : "production";
  const runtimesRoot = environmentName === "development"
    ? join(corptieHome, "development", "runtimes")
    : join(corptieHome, "runtimes");
  return { home, corptieHome, environmentName, runtimesRoot };
}

// 解析 Agent 的默认工作目录（不创建）。
export function resolveAgentWorkDir(agent, options = {}) {
  const { runtimesRoot } = resolveAgentRuntimesRoot(options);
  if (agent?.role === "assistant") {
    return join(runtimesRoot, "assistant", "workspace");
  }
  const agentId = String(agent?.agentId ?? "").trim();
  if (!agentId) {
    throw new Error("Agent id is required to resolve a contributor work directory.");
  }
  return join(runtimesRoot, "contributors", agentId);
}

// 确保 Agent 工作目录存在（幂等），返回规范化后的绝对路径。
// 若目录路径已存在且不是目录（是文件/符号链接指向文件），抛错避免破坏用户数据。
export async function ensureAgentWorkDir(agent, options = {}) {
  const target = resolveAgentWorkDir(agent, options);
  await assertDirectory(target);
  return target;
}

// 解析传入的显式工作目录（用户可在高级选项覆盖）：空则回退到 Agent 默认目录。
export async function resolveOrEnsureAgentWorkDir(agent, explicitPath, options = {}) {
  const requested = typeof explicitPath === "string" ? explicitPath.trim() : "";
  const target = requested ? resolve(requested) : resolveAgentWorkDir(agent, options);
  await assertDirectory(target);
  return target;
}

async function assertDirectory(path) {
  const info = await stat(path).catch(() => null);
  if (!info) {
    await mkdir(path, { recursive: true });
    return;
  }
  if (!info.isDirectory()) {
    const error = new Error(`Agent work directory is not a directory: ${path}`);
    error.code = "INVALID_WORK_DIR";
    throw error;
  }
}
