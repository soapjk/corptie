import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { environmentForCommand, resolveExternalCommand } from "../utils/externalCommand.mjs";

export const execFileAsync = promisify(execFile);

export function formatFeishuFailureForLog(error, secretValues = []) {
  let message = error instanceof Error ? error.message : String(error ?? "Unknown error");
  for (const secret of secretValues) {
    if (typeof secret === "string" && secret.length > 0) {
      message = message.split(secret).join("[REDACTED]");
    }
  }
  message = message
    .replace(/((?:app[-_ ]?)?secret\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return message.slice(0, 2000) || "Unknown error";
}

export async function fetchBotIdentity(commandPath, profile, options = {}) {
  const directory = await mkdtemp(join(os.tmpdir(), "corptie-feishu-identity-"));
  const outputName = "bot-info.json";
  const outputPath = join(directory, outputName);
  const execute = options.execFile ?? execFileAsync;
  try {
    await execute(commandPath, [
      "--profile", profile,
      "api", "GET", "/open-apis/bot/v3/info",
      "--as", "bot",
      "--output", `./${outputName}`
    ], {
      cwd: directory,
      maxBuffer: 4 * 1024 * 1024,
      env: options.env
    });
    const result = JSON.parse(await readFile(outputPath, "utf8"));
    if (result.code && result.code !== 0) {
      throw new Error(result.msg || `Feishu API error ${result.code}`);
    }
    return result.bot ?? result.data?.bot ?? null;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function resolveLarkCli() {
  const resolved = resolveExternalCommand("lark-cli", {
    environmentVariables: ["CORPTIE_LARK_CLI"]
  });
  return resolved === "lark-cli" ? null : resolved;
}

export async function resolveIdentityLarkCli(primaryPath) {
  return primaryPath;
}

export function runWithInput(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: larkCliEnvironment(command) });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(stderr.trim() || stdout.trim() || `lark-cli exited (${signal || code || "unknown"}).`));
    });
    child.stdin.end(input);
  });
}

export function larkCliEnvironment(commandPath) {
  const env = { ...environmentForCommand(commandPath), LARK_CLI_NO_PROXY: "1" };
  for (const key of [
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
    "http_proxy", "https_proxy", "all_proxy", "no_proxy"
  ]) {
    delete env[key];
  }
  return env;
}
