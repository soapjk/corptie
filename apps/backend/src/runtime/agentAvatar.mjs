import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import os from "node:os";
import { extname, join, resolve } from "node:path";

// Agent 头像落盘约定（头像只属于 Agent，会话统一继承其头像）。
//
// 头像文件统一复制到 Corptie 数据目录下的 avatars/<agentId>.<ext>：
//   - development: ~/.corptie/development/avatars/
//   - production:  ~/.corptie/avatars/
// 路径作为元数据落库（agents.avatar_path），前端直接读该文件渲染。
// 与 session 头像不同：会话不再单独持有头像，所有入口都走 Agent 头像。

const AVATAR_EXTENSIONS = [".gif", ".png", ".jpeg", ".jpg", ".heic", ".tiff", ".webp"];

export function resolveAgentAvatarsRoot(options = {}) {
  const home = resolve(options.homeDir ?? os.homedir());
  const corptieHome = resolve(options.corptieHome ?? process.env.CORPTIE_HOME ?? join(home, ".corptie"));
  const environmentName = options.environmentName === "development" ? "development" : "production";
  const avatarsRoot = environmentName === "development"
    ? join(corptieHome, "development", "avatars")
    : join(corptieHome, "avatars");
  return { home, corptieHome, environmentName, avatarsRoot };
}

// 将一个已存在的头像源文件复制到托管目录，返回规范化后的目标绝对路径。
// 会先清理该 Agent 名下旧的托管头像文件，避免残留。
export async function saveAgentAvatar(agentId, sourcePath, options = {}) {
  const { avatarsRoot } = resolveAgentAvatarsRoot(options);
  const source = resolve(String(sourcePath ?? ""));
  if (!source) {
    throw new Error("Avatar source path is required.");
  }
  const ext = (extname(source) || ".png").toLowerCase();
  const safeExt = AVATAR_EXTENSIONS.includes(ext) ? ext : ".png";
  const targetDir = join(avatarsRoot, "agents", String(agentId));
  await mkdir(targetDir, { recursive: true, mode: 0o700 });
  await clearAgentAvatarFiles(agentId, options);
  const target = join(targetDir, `avatar${safeExt}`);
  await copyFile(source, target);
  return target;
}

// 删除某个 Agent 的所有托管头像文件，返回是否确曾存在。
export async function clearAgentAvatar(agentId, options = {}) {
  const existed = await clearAgentAvatarFiles(agentId, options);
  return existed;
}

async function clearAgentAvatarFiles(agentId, options = {}) {
  const { avatarsRoot } = resolveAgentAvatarsRoot(options);
  const targetDir = join(avatarsRoot, "agents", String(agentId));
  const entries = await readdir(targetDir).catch(() => []);
  for (const entry of entries) {
    await rm(join(targetDir, entry), { force: true });
  }
  return entries.length > 0;
}
