import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
async function git(cwd, args) {
  return (await execFile("git", ["-C", cwd, ...args], {
    encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 60_000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }
  })).stdout;
}
async function removeAllocatedForkWorktree(source, target, branchName) {
  await git(source, ["worktree", "remove", "--force", target]);
  await git(source, ["branch", "-D", branchName]);
}
function fail(code, message) { throw Object.assign(new Error(message), { code, statusCode: 409 }); }
function contained(root, path) {
  const value = relative(root, path);
  return value && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}
async function snapshot(source) {
  if ((await git(source, ["ls-files", "-u"])).trim()) fail("FORK_UNMERGED_FILES", "请先解决源工作区的合并冲突，再创建分支。");
  // Submodule worktrees need their own independent snapshots; don't silently omit them.
  if ((await git(source, ["ls-files", "--stage"])).split("\n").some(line => line.startsWith("160000 "))) {
    fail("FORK_SUBMODULE_UNSUPPORTED", "当前分叉暂不支持含 Git 子模块的工作区。");
  }
  const head = (await git(source, ["rev-parse", "HEAD"])).trim();
  const staged = await git(source, ["diff", "--cached", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "HEAD"]);
  const unstaged = await git(source, ["diff", "--binary", "--full-index", "--no-ext-diff", "--no-textconv"]);
  const names = (await git(source, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean).sort();
  const files = [];
  let bytes = Buffer.byteLength(staged) + Buffer.byteLength(unstaged);
  if (bytes > 128 * 1024 * 1024) fail("FORK_SNAPSHOT_TOO_LARGE", "未提交文件超过 128 MB，请先提交或排除大文件。");
  for (const name of names) {
    const path = resolve(source, name);
    if (!contained(source, path)) fail("FORK_PATH_INVALID", "源工作区包含无法复制的路径。");
    const info = await lstat(path);
    if (!info.isFile() && !info.isSymbolicLink()) fail("FORK_FILE_UNSUPPORTED", "源工作区包含特殊文件，无法创建分支。");
    bytes += info.size;
    if (bytes > 128 * 1024 * 1024) fail("FORK_SNAPSHOT_TOO_LARGE", "未提交文件超过 128 MB，请先提交或排除大文件。");
    files.push({ name, mode: info.mode, link: info.isSymbolicLink() ? await readlink(path) : null,
      data: info.isFile() ? await readFile(path) : null });
  }
  const hash = createHash("sha256").update(head).update(staged).update(unstaged);
  for (const file of files) hash.update(JSON.stringify([file.name, file.mode, file.link])).update(file.data ?? "");
  return { head, staged, unstaged, files, hash: hash.digest("hex") };
}

/** Copy the current Git state without stashing, committing, or changing the source index. */
export async function createForkWorktree({ sourcePath, targetPath, branchName }) {
  const source = await realpath(sourcePath), target = resolve(targetPath);
  if (target === source || contained(source, target)) fail("FORK_PATH_INVALID", "分支工作区不能位于源工作区内部。");
  try { await lstat(target); fail("FORK_PATH_OCCUPIED", "分支工作区路径已存在。"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const before = await snapshot(source);
  const temp = await mkdtemp(join(tmpdir(), "corptie-fork-"));
  let created = false;
  try {
    await mkdir(dirname(target), { recursive: true });
    await git(source, ["worktree", "add", "-b", branchName, target, before.head]);
    created = true;
    const canonicalTarget = await realpath(target);
    for (const [name, patch, index] of [["staged", before.staged, true], ["unstaged", before.unstaged, false]]) {
      if (!patch) continue;
      const path = join(temp, `${name}.patch`);
      await writeFile(path, patch);
      await git(target, ["apply", "--binary", "--whitespace=nowarn", ...(index ? ["--index"] : []), path]);
    }
    for (const file of before.files) {
      const path = resolve(target, file.name);
      let directory = canonicalTarget;
      for (const segment of relative(target, dirname(path)).split(sep).filter(Boolean)) {
        directory = join(directory, segment);
        try { await mkdir(directory); } catch (error) { if (error.code !== "EEXIST") throw error; }
        const info = await lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink()) fail("FORK_PATH_INVALID", "分支文件路径不能经过符号链接。");
      }
      // A tracked symlink must never turn an untracked-file copy into an external write.
      const parent = await realpath(dirname(path));
      if (parent !== canonicalTarget && !contained(canonicalTarget, parent)) fail("FORK_PATH_INVALID", "分支文件路径指向工作区之外。");
      if (file.link !== null) await symlink(file.link, path);
      else {
        await writeFile(path, file.data, { flag: "wx", mode: file.mode });
        await chmod(path, file.mode);
      }
    }
    if ((await snapshot(source)).hash !== before.hash) fail("FORK_SOURCE_CHANGED", "复制期间源工作区发生了变化，请稍后重试。");
    if ((await snapshot(target)).hash !== before.hash) fail("FORK_SNAPSHOT_MISMATCH", "分支文件校验未通过。");
    return { path: target, branchName, headOid: before.head, snapshotHash: before.hash,
      rollback: () => removeAllocatedForkWorktree(source, target, branchName) };
  } catch (error) {
    // Only the worktree and branch allocated by this invocation may be removed.
    if (created) {
      try { await removeAllocatedForkWorktree(source, target, branchName); }
      catch (cleanupError) { error.cleanupError = cleanupError.message; }
    }
    throw error;
  } finally { await rm(temp, { recursive: true, force: true }); }
}
