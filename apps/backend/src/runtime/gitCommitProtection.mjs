import { execFile } from "node:child_process";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const WARNING_CONFIG_KEY = "corptie.privateFilesWarning";
const MANAGED_HEADER = "# Corptie local Agent configuration";

export class GitCommitProtection {
  constructor(options = {}) {
    this.execFile = options.execFile ?? execFileAsync;
    this.configPath = options.configPath;
    this.rules = options.rules ?? null;
  }

  async inspect(workingDirectory) {
    const root = (await this.gitOutput(workingDirectory, ["rev-parse", "--show-toplevel"])).trim();
    const statusRaw = await this.gitOutput(root, [
      "status", "--porcelain=v1", "-z", "--untracked-files=all"
    ]);
    const changedPaths = parseStatusPaths(statusRaw);
    const rules = await this.loadRules();
    const protectedPaths = [];
    const matchedRules = [];
    for (const rule of rules) {
      const matches = changedPaths.filter((path) => pathMatchesRule(path, rule));
      if (matches.length === 0) continue;
      if (rule.onlyWhenSymlink === true && !await isSymbolicLink(join(root, rule.path))) continue;
      matchedRules.push(rule);
      protectedPaths.push(...matches);
    }
    const warningEnabled = await this.warningEnabled(root);
    return {
      repositoryRoot: root,
      protectedPaths: [...new Set(protectedPaths)].sort(),
      suggestedIgnorePatterns: matchedRules.map(ignorePatternForRule),
      warningEnabled,
      requiresDecision: warningEnabled && protectedPaths.length > 0
    };
  }

  async resolve(workingDirectory, input = {}) {
    const inspection = await this.inspect(workingDirectory);
    const decision = String(input.decision ?? "");
    if (inspection.requiresDecision && decision !== "ignore" && decision !== "include") {
      const error = new Error("Choose whether to add local Agent files to .gitignore or include them in this commit.");
      error.code = "GIT_COMMIT_PROTECTION_REQUIRED";
      error.protection = inspection;
      throw error;
    }
    if (decision === "ignore" && inspection.protectedPaths.length > 0) {
      await appendGitignore(inspection.repositoryRoot, inspection.suggestedIgnorePatterns);
    }
    if (input.neverRemind === true) {
      await this.runGit(inspection.repositoryRoot, ["config", "--local", WARNING_CONFIG_KEY, "false"]);
    }
    return {
      ...inspection,
      decision: decision || null,
      gitignoreUpdated: decision === "ignore" && inspection.protectedPaths.length > 0
    };
  }

  async warningEnabled(root) {
    const value = await this.optionalGitOutput(root, ["config", "--local", "--bool", "--get", WARNING_CONFIG_KEY]);
    return value?.trim() !== "false";
  }

  async loadRules() {
    if (this.rules) return this.rules;
    if (!this.configPath) throw new Error("Git commit protection configuration is missing.");
    const configuration = JSON.parse(await readFile(this.configPath, "utf8"));
    if (!Array.isArray(configuration.rules)) throw new Error("Git commit protection rules are invalid.");
    this.rules = configuration.rules.filter(validRule);
    return this.rules;
  }

  async gitOutput(cwd, arguments_) {
    const result = await this.runGit(cwd, arguments_);
    return result.stdout;
  }

  async optionalGitOutput(cwd, arguments_) {
    try {
      return await this.gitOutput(cwd, arguments_);
    } catch {
      return null;
    }
  }

  async runGit(cwd, arguments_) {
    return this.execFile("git", ["-C", cwd, ...arguments_], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024
    });
  }
}

export function parseStatusPaths(statusRaw) {
  const fields = String(statusRaw ?? "").split("\0");
  const paths = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field) continue;
    const code = field.slice(0, 2);
    const path = field.slice(3);
    if (path) paths.push(path);
    if (code.includes("R") || code.includes("C")) {
      const original = fields[index + 1];
      if (original) paths.push(original);
      index += 1;
    }
  }
  return [...new Set(paths)].sort();
}

function validRule(rule) {
  return rule && typeof rule.path === "string" && rule.path.trim()
    && (rule.kind === "file" || rule.kind === "directory");
}

function pathMatchesRule(path, rule) {
  return path === rule.path || (rule.kind === "directory" && path.startsWith(`${rule.path}/`));
}

function ignorePatternForRule(rule) {
  return `/${rule.path}${rule.kind === "directory" ? "/" : ""}`;
}

async function appendGitignore(root, patterns) {
  if (patterns.length === 0) return;
  const path = join(root, ".gitignore");
  let current = "";
  try {
    current = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const existing = new Set(current.split(/\r?\n/).map((line) => line.trim()));
  const additions = [...new Set(patterns)].filter((pattern) => !existing.has(pattern));
  if (additions.length === 0) return;
  const separator = current && !current.endsWith("\n") ? "\n" : "";
  const header = existing.has(MANAGED_HEADER) ? "" : `${MANAGED_HEADER}\n`;
  await writeFile(path, `${current}${separator}${header}${additions.join("\n")}\n`, "utf8");
}

async function isSymbolicLink(path) {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
