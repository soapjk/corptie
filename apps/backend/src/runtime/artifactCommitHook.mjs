import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const HEADER = "# Corptie managed Artifact commit gate v1";

// Keep existing hooks by chaining pre-commit and linking the other hooks into
// a repository-local managed directory; never edit a shared/global hooks path.
export async function ensureArtifactCommitHook(cwd, { dbPath, nodePath = process.execPath } = {}) {
  if (!dbPath) throw new Error("Artifact commit hook requires the evidence database path.");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const git = async (...args) => (await run("git", ["-C", cwd, ...args], { env, encoding: "utf8", timeout: 10000 })).stdout.trim();
  const common = resolve(cwd, await git("rev-parse", "--git-common-dir"));
  const managed = join(common, "corptie-artifact-hooks");
  const previous = resolve(cwd, await git("rev-parse", "--git-path", "hooks"));
  await mkdir(managed, { recursive: true, mode: 0o700 });
  await ensureLocalCorptieIgnore(common);
  if (previous !== managed) {
    const names = await readdir(previous).catch(error => { if (error.code === "ENOENT") return []; throw error; });
    for (const name of names) {
      if (["pre-commit", "pre-merge-commit", "pre-applypatch"].includes(name) || name.endsWith(".sample")) continue;
      await symlink(join(previous, name), join(managed, name)).catch(error => { if (error.code !== "EEXIST") throw error; });
    }
  }
  const cli = fileURLToPath(new URL("./artifactCommitHookCli.mjs", import.meta.url));
  const installed = [];
  for (const name of ["pre-commit", "pre-merge-commit", "pre-applypatch"]) {
    const hook = join(managed, name);
    let original = previous !== managed ? join(previous, name) : null;
    if (!original) {
      const existing = await readFile(hook, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
      if (existing && !existing.includes(HEADER)) throw new Error(`Managed Artifact hook was replaced: ${name}`);
      original = existing.match(/^# original-hook: (.+)$/m)?.[1];
      if (original) original = JSON.parse(original);
    }
    const content = ["#!/bin/sh", HEADER, `# original-hook: ${JSON.stringify(original ?? "")}`,
      original ? `if [ -x ${quote(original)} ]; then ${quote(original)} "$@" || exit $?; fi` : "",
      `exec ${quote(nodePath)} ${quote(cli)} ${quote(resolve(dbPath))}`, ""].filter(Boolean).join("\n");
    const temporary = `${hook}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, content, { mode: 0o700 });
    await chmod(temporary, 0o700);
    await rename(temporary, hook);
    installed.push({ name, hookPath: hook, chainedHook: original });
  }
  await git("config", "--local", "core.hooksPath", managed);
  return { hooks: installed, dbPath: resolve(dbPath) };
}

async function ensureLocalCorptieIgnore(commonGitDirectory) {
  const path = join(commonGitDirectory, "info", "exclude");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const current = await readFile(path, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
  if (current.split(/\r?\n/u).some(line => line.trim().toLowerCase() === "/.corptie/")) return;
  const separator = current && !current.endsWith("\n") ? "\n" : "";
  await writeFile(path, `${current}${separator}/.corptie/\n`, "utf8");
}
