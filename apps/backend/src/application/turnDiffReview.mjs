import { execFile, spawn } from "node:child_process";
import { copyFile, mkdtemp, stat, mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import { isExecutable, pathExists } from "../utils/localPathAccess.mjs";

const execFileAsync = promisify(execFile);

export function safeTurnFileChanges(items, cwd) {
  const changes = (items ?? [])
    .filter((item) => item.type === "fileChange")
    .flatMap((item) => item.fileChanges ?? [])
    .map((change) => ({
      path: normalizeRelativeDiffPath(change.path, cwd),
      kind: typeof change.kind === "string" ? change.kind : (change.kind?.type ?? "update"),
      diff: typeof change.diff === "string" ? change.diff : ""
    }));
  if (changes.length === 0) {
    throw new Error("This turn has no recorded file changes.");
  }
  return changes;
}

function normalizeRelativeDiffPath(value, cwd) {
  const rawPath = normalize(String(value ?? "").replaceAll("\\", "/"));
  const cwdRoot = resolve(cwd);
  if (isAbsolute(rawPath) && !rawPath.startsWith(`${cwdRoot}${sep}`)) {
    throw new Error(`Unsafe changed file path: ${value}`);
  }
  const path = isAbsolute(rawPath) ? normalize(rawPath.slice(cwdRoot.length + 1)) : rawPath;
  const absolutePath = resolve(cwdRoot, path);
  if (!path || path === "." || absolutePath === cwdRoot || !absolutePath.startsWith(`${cwdRoot}${sep}`)) {
    throw new Error(`Unsafe changed file path: ${value}`);
  }
  return path;
}

export function turnDiffFor(items, changes) {
  const persistedDiff = [...(items ?? [])].reverse().find((item) => {
    return typeof item?.turnDiff === "string" && item.turnDiff.trim();
  })?.turnDiff;
  return persistedDiff || changes.map(unifiedDiffForChange).filter(Boolean).join("\n");
}

function unifiedDiffForChange(change) {
  const diff = change.diff ?? "";
  if (!diff) {
    return "";
  }
  if (diff.startsWith("diff --git ") || diff.startsWith("--- ")) {
    return diff;
  }
  const quotedPath = change.path;
  if (change.kind === "add" && !diff.startsWith("@@")) {
    const lines = diff.endsWith("\n") ? diff.slice(0, -1).split("\n") : diff.split("\n");
    const body = lines.map((line) => `+${line}`).join("\n");
    return [
      `diff --git a/${quotedPath} b/${quotedPath}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${quotedPath}`,
      `@@ -0,0 +1,${lines.length} @@`,
      body,
      ""
    ].join("\n");
  }
  if (change.kind === "delete" && !diff.startsWith("@@")) {
    const lines = diff.endsWith("\n") ? diff.slice(0, -1).split("\n") : diff.split("\n");
    const body = lines.map((line) => `-${line}`).join("\n");
    return [
      `diff --git a/${quotedPath} b/${quotedPath}`,
      "deleted file mode 100644",
      `--- a/${quotedPath}`,
      "+++ /dev/null",
      `@@ -1,${lines.length} +0,0 @@`,
      body,
      ""
    ].join("\n");
  }
  return [
    `diff --git a/${quotedPath} b/${quotedPath}`,
    `--- a/${quotedPath}`,
    `+++ b/${quotedPath}`,
    diff,
    ""
  ].join("\n");
}

export async function writeTurnPatch(threadId, turnId, diff) {
  if (!diff.trim()) {
    throw new Error("The recorded file changes do not include a usable diff.");
  }
  const root = await mkdtemp(join(os.tmpdir(), "corptie-diff-"));
  const patchPath = join(root, `${threadId}-${turnId}.diff`.replaceAll("/", "_"));
  await writeFile(patchPath, diff, "utf8");
  return { root, patchPath };
}

export async function prepareExternalDiff(cwd, threadId, turnId, changes, diff) {
  const { root, patchPath } = await writeTurnPatch(threadId, turnId, diff);
  const beforeDir = join(root, "Before");
  const afterDir = join(root, "After");
  await Promise.all([mkdir(beforeDir), mkdir(afterDir)]);

  for (const change of changes) {
    const source = resolve(cwd, change.path);
    if (!source.startsWith(`${resolve(cwd)}${sep}`)) {
      throw new Error(`Changed file is outside the task directory: ${change.path}`);
    }
    try {
      if (!(await stat(source)).isFile()) {
        continue;
      }
      for (const targetRoot of [beforeDir, afterDir]) {
        const target = join(targetRoot, change.path);
        await mkdir(dirname(target), { recursive: true });
        await copyFile(source, target);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }

  try {
    await execFileAsync("git", ["apply", "--reverse", "--check", "--directory=Before", patchPath], { cwd: root });
    await execFileAsync("git", ["apply", "--reverse", "--directory=Before", patchPath], { cwd: root });
  } catch (reverseError) {
    try {
      await execFileAsync("git", ["apply", "--check", "--directory=After", patchPath], { cwd: root });
      await execFileAsync("git", ["apply", "--directory=After", patchPath], { cwd: root });
    } catch {
      throw new Error(`Could not reconstruct this turn for review: ${reverseError.stderr || reverseError.message}`);
    }
  }
  return { root, patchPath, beforeDir, afterDir };
}

export function createDiffToolLauncher({
  executableExists = isExecutable,
  applicationExists = pathExists,
  launch = launchDetached,
  ensurePlaceholder = ensureDiffPlaceholder
} = {}) {
  return async function launchDiffTool(configuredTool, review, changes) {
    let tool = configuredTool || "automatic";
    if (tool === "automatic") {
      tool = executableExists("/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code") ? "vscode" : "filemerge";
    }

    if (tool === "vscode") {
      const executable = "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code";
      if (!executableExists(executable)) {
        throw new Error("Visual Studio Code is not installed in /Applications.");
      }
      for (const change of changes) {
        const before = join(review.beforeDir, change.path);
        const after = join(review.afterDir, change.path);
        await ensurePlaceholder(before);
        await ensurePlaceholder(after);
        launch(executable, ["--reuse-window", "--diff", before, after]);
      }
      return tool;
    }

    if (tool === "git-difftool") {
      launch("git", ["difftool", "--no-index", "--dir-diff", "--no-prompt", review.beforeDir, review.afterDir]);
      return tool;
    }

    const appTools = {
      filemerge: { command: "/usr/bin/opendiff", args: [review.beforeDir, review.afterDir] },
      kaleidoscope: { appPath: "/Applications/Kaleidoscope.app", command: "/usr/bin/open", args: ["-a", "Kaleidoscope", "--args", review.beforeDir, review.afterDir] },
      "beyond-compare": { appPath: "/Applications/Beyond Compare.app", command: "/usr/bin/open", args: ["-a", "Beyond Compare", "--args", review.beforeDir, review.afterDir] },
      "sublime-merge": { appPath: "/Applications/Sublime Merge.app", command: "/usr/bin/open", args: ["-a", "Sublime Merge", "--args", "mergetool", review.beforeDir, review.afterDir] }
    };
    const selected = appTools[tool];
    if (!selected) {
      throw new Error(`Unsupported code diff tool: ${tool}`);
    }
    if (selected.appPath && !applicationExists(selected.appPath)) {
      throw new Error(`${selected.appPath.split("/").at(-1)} is not installed in /Applications.`);
    }
    launch(selected.command, selected.args);
    return tool;
  };
}

export const launchDiffTool = createDiffToolLauncher();

async function ensureDiffPlaceholder(path) {
  try {
    await stat(path);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "", "utf8");
  }
}

function launchDetached(command, args) {
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", (error) => {
    console.error("[code-diff] failed to launch", command, error);
  });
  child.unref();
}
