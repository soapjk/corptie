import { execFileSync } from "node:child_process";
import { accessSync, constants, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function isExecutableFile(candidate) {
  if (typeof candidate !== "string" || !candidate.trim()) return false;
  try {
    accessSync(candidate, constants.X_OK);
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function childDirectories(root, suffix = "") {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name, suffix))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

function loginShellCommand(command) {
  if (!/^[a-zA-Z0-9_-]+$/.test(command)) return "";
  const shell = process.env.SHELL || "/bin/zsh";
  try {
    return execFileSync(shell, ["-lic", `command -v ${command}`], {
      encoding: "utf8",
      timeout: 2500,
      stdio: ["ignore", "pipe", "ignore"]
    }).trim().split("\n").at(-1) || "";
  } catch {
    return "";
  }
}

export function externalCommandCandidates(command) {
  const home = os.homedir();
  const pathDirectories = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const nvmDirectories = childDirectories(path.join(home, ".nvm", "versions", "node"), "bin");
  const fnmDirectories = childDirectories(path.join(home, ".fnm", "node-versions"), path.join("installation", "bin"));
  const directories = [
    ...pathDirectories,
    path.dirname(process.execPath),
    ...nvmDirectories,
    ...fnmDirectories,
    path.join(home, ".volta", "bin"),
    path.join(home, ".asdf", "shims"),
    path.join(home, ".local", "share", "mise", "shims"),
    path.join(home, ".local", "bin"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".bun", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin"
  ];
  return [
    loginShellCommand(command),
    ...directories.map((directory) => path.join(directory, command))
  ];
}

export function resolveExternalCommand(command, options = {}) {
  const requested = typeof options.requested === "string" ? options.requested.trim() : "";
  const environmentCandidates = (options.environmentVariables || [])
    .map((name) => process.env[name])
    .filter(Boolean);
  return [requested && requested !== command ? requested : "", ...environmentCandidates,
    ...externalCommandCandidates(command), ...(options.extraCandidates || [])]
    .find(isExecutableFile) || command;
}

export function environmentForCommand(commandPath, baseEnvironment = process.env) {
  const directories = [];
  if (typeof commandPath === "string" && path.isAbsolute(commandPath)) {
    directories.push(path.dirname(commandPath));
  }
  directories.push(path.dirname(process.execPath));
  const existing = String(baseEnvironment.PATH || "").split(path.delimiter).filter(Boolean);
  return {
    ...baseEnvironment,
    PATH: Array.from(new Set([...directories, ...existing, "/usr/bin", "/bin", "/usr/sbin", "/sbin"]))
      .join(path.delimiter)
  };
}
