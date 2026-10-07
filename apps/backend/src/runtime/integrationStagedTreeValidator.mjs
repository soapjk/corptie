import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readFile, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const FORBIDDEN_INTERNAL_PATHS = new Set(["corptie-artifact-hooks", "info/exclude"]);

// Stage into an isolated candidate index, validate the complete tree, then
// atomically promote that index. The user's real index remains untouched when
// validation rejects a path.
export async function stageValidatedIntegrationTree({ cwd, execFile }) {
  const repositoryRoot = (await git(execFile, cwd, ["rev-parse", "--show-toplevel"])).trim();
  const rawIndexPath = (await git(execFile, cwd, ["rev-parse", "--git-path", "index"])).trim();
  const indexPath = isAbsolute(rawIndexPath) ? rawIndexPath : resolve(cwd, rawIndexPath);
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), "corptie-integration-index-"));
  const candidateIndex = resolve(temporaryRoot, "index");
  const originalFingerprint = await fileFingerprint(indexPath);
  const environment = { ...process.env, GIT_INDEX_FILE: candidateIndex };
  try {
    if (originalFingerprint) await copyFile(indexPath, candidateIndex);
    else if (await gitSucceeds(execFile, cwd, ["rev-parse", "--verify", "HEAD"])) {
      await git(execFile, cwd, ["read-tree", "HEAD"], environment);
    } else {
      await git(execFile, cwd, ["read-tree", "--empty"], environment);
    }
    await git(execFile, cwd, ["add", "--all"], environment);
    const entries = parseStagedEntries(await git(execFile, cwd, ["ls-files", "--stage", "-z"], environment));
    const declaredSubmodules = await declaredSubmodulePaths(execFile, cwd, environment);
    const violations = [];
    for (const entry of entries) {
      if (FORBIDDEN_INTERNAL_PATHS.has(entry.path) || entry.path === ".corptie" || entry.path.startsWith(".corptie/")) {
        violations.push({ code: "CORPTIE_INTERNAL_PATH_STAGED", path: entry.path, mode: entry.mode });
      }
      if (entry.mode === "160000" && !declaredSubmodules.has(entry.path)) {
        violations.push({ code: "UNDECLARED_GITLINK", path: entry.path, mode: entry.mode });
      }
      if (entry.mode === "120000") {
        const target = await git(execFile, cwd, ["cat-file", "blob", entry.oid], environment);
        const resolvedTarget = resolve(repositoryRoot, dirname(entry.path), target.trim());
        if (isAbsolute(target.trim()) || !contains(repositoryRoot, resolvedTarget)) {
          violations.push({ code: "SYMLINK_ESCAPES_REPOSITORY", path: entry.path, target: target.trim() });
        }
      }
    }
    if (violations.length > 0) {
      const error = new Error(`Integration staged-tree validation rejected ${violations.length} unsafe path(s).`);
      error.code = "INTEGRATION_STAGED_TREE_REJECTED";
      error.statusCode = 409;
      error.recoverable = true;
      error.violations = violations;
      throw error;
    }
    if ((await fileFingerprint(indexPath)) !== originalFingerprint) {
      const error = new Error("The Git index changed while the integration candidate was being validated.");
      error.code = "INTEGRATION_INDEX_CHANGED";
      error.statusCode = 409;
      error.recoverable = true;
      throw error;
    }
    const replacement = resolve(dirname(indexPath), `index.corptie-${process.pid}-${randomUUID()}.tmp`);
    await copyFile(candidateIndex, replacement);
    await rename(replacement, indexPath);
    return { staged: true, entryCount: entries.length, validated: true };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function declaredSubmodulePaths(execFile, cwd, environment) {
  const content = await git(execFile, cwd, ["show", ":.gitmodules"], environment).catch(() => "");
  return new Set([...content.matchAll(/^\s*path\s*=\s*(.+?)\s*$/gmu)].map(match => match[1]));
}

function parseStagedEntries(output) {
  return String(output).split("\0").filter(Boolean).map(record => {
    const match = record.match(/^(\d{6}) ([0-9a-f]+) (\d)\t([\s\S]+)$/u);
    if (!match) return null;
    return { mode: match[1], oid: match[2], stage: Number(match[3]), path: match[4] };
  }).filter(Boolean);
}

async function git(execFile, cwd, arguments_, environment = process.env) {
  const result = await execFile("git", ["-C", cwd, ...arguments_], {
    encoding: "utf8", maxBuffer: 16 * 1024 * 1024, env: environment
  });
  return result.stdout;
}

async function gitSucceeds(execFile, cwd, arguments_) {
  try { await git(execFile, cwd, arguments_); return true; } catch { return false; }
}

async function fileFingerprint(path) {
  try {
    const info = await stat(path);
    const bytes = await readFile(path);
    return `${info.size}:${createHash("sha256").update(bytes).digest("hex")}`;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function contains(parent, candidate) {
  const relation = relative(resolve(parent), resolve(candidate));
  return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation));
}
