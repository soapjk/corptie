import { execFile } from "node:child_process";
import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { createGitWorkspaceSnapshot } from "../utils/gitWorktreeInventory.mjs";

const execFileAsync = promisify(execFile);

export class GitRepositoryRegistrationError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "GitRepositoryRegistrationError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export async function registerGitRepository({
  dirPath,
  initializeIfNeeded = false,
  store,
  createSnapshot = createGitWorkspaceSnapshot,
  run = execFileAsync,
  inspectPath = stat
}) {
  let directory;
  try {
    directory = await inspectPath(dirPath);
  } catch {
    throw new GitRepositoryRegistrationError("INVALID_DIRECTORY", "所选文件夹不存在或无法访问。");
  }
  if (!directory.isDirectory()) {
    throw new GitRepositoryRegistrationError("INVALID_DIRECTORY", "所选路径不是文件夹。");
  }

  let snapshot;
  try {
    snapshot = await createSnapshot(dirPath);
  } catch {
    if (!initializeIfNeeded) {
      throw new GitRepositoryRegistrationError("NOT_A_GIT_REPOSITORY", "所选文件夹不是 Git 仓库。");
    }
    try {
      await run("git", ["-C", dirPath, "init"], {
        encoding: "utf8",
        maxBuffer: 1024 * 1024
      });
      await writeFile(join(dirPath, "README.md"), "", { flag: "wx" }).catch((error) => {
        if (error?.code !== "EEXIST") throw error;
      });
      await run("git", ["-C", dirPath, "add", "--", "README.md"], {
        encoding: "utf8",
        maxBuffer: 1024 * 1024
      });
      await run("git", [
        "-C", dirPath,
        "-c", "user.name=Corptie",
        "-c", "user.email=corptie@localhost",
        "commit", "-m", "Initial commit"
      ], {
        encoding: "utf8",
        maxBuffer: 1024 * 1024
      });
      snapshot = await createSnapshot(dirPath);
    } catch (error) {
      const detail = String(error?.stderr ?? error?.message ?? "未知错误").trim();
      throw new GitRepositoryRegistrationError(
        "GIT_INITIALIZATION_FAILED",
        `无法在所选文件夹初始化 Git 仓库：${detail || "Git 命令执行失败。"}`,
        500
      );
    }
  }

  store.upsertGitWorkspaceSnapshot(snapshot);
  return store.listGitRepositories().find((repository) => repository.id === snapshot.repository.id);
}
