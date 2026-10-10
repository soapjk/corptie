import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const AUTH_LIMIT = 256 * 1024;
const SOURCE_ERROR = "无法读取已有的 Codex 登录状态，请检查登录凭据或允许钥匙串访问后重试。";

// Codex-specific storage compatibility belongs in the runtime adapter, not in
// provider-neutral setup/business logic. Matches Codex's DirectKeyringAuthStorage:
// service = Codex Auth; account = cli| + the canonical home's SHA-256 prefix.
export async function codexKeychainAccount(sourceHome) {
  const canonical = await realpath(sourceHome).catch(() => sourceHome);
  return `cli|${createHash("sha256").update(canonical).digest("hex").slice(0, 16)}`;
}

export async function readCodexAuthenticationSource(sourceAuthPath, options = {}) {
  const sourceHome = dirname(sourceAuthPath);
  const preference = await credentialStorePreference(join(sourceHome, "config.toml"));
  const file = async () => {
    try { return authentication(await readFile(sourceAuthPath, "utf8"), "copied"); }
    catch (error) {
      if (error.code === "ENOENT") return null;
      throw new Error(SOURCE_ERROR);
    }
  };
  const keychain = async () => {
    if ((options.platform ?? process.platform) !== "darwin") return null;
    const account = await codexKeychainAccount(sourceHome);
    const read = options.readKeychainCredential ?? readCodexKeychainCredential;
    const value = await read({ service: "Codex Auth", account });
    return value == null ? null : authentication(value, "keychain");
  };

  // Respect an explicit store selection: a leftover file/Keychain entry may
  // belong to a logged-out account. Codex's auto mode permits file fallback.
  // Unconfigured installations can discover either supported persisted store.
  const readers = preference === "keyring" ? [keychain]
    : preference === "auto" ? [keychain, file]
      : preference === "file" ? [file]
        : preference === "ephemeral" ? [] : [file, keychain];
  let failed = false;
  for (const read of readers) {
    try {
      const result = await read();
      if (result) return result;
    } catch { failed = true; }
  }
  if (failed) throw new Error(SOURCE_ERROR);
  return null;
}

async function credentialStorePreference(configPath) {
  let config;
  try { config = await readFile(configPath, "utf8"); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(SOURCE_ERROR);
  }
  // Only this top-level enum is read; native configuration is never copied or
  // modified. Table-scoped lookalikes must not change authentication selection.
  const topLevel = config.split(/^\s*\[/m, 1)[0];
  return topLevel.match(/^\s*cli_auth_credentials_store\s*=\s*["'](file|keyring|auto|ephemeral)["']\s*(?:#.*)?$/m)?.[1] ?? null;
}

function authentication(value, source) {
  if (typeof value !== "string" || Buffer.byteLength(value) > AUTH_LIMIT) throw new Error(SOURCE_ERROR);
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw new Error(SOURCE_ERROR); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(SOURCE_ERROR);
  const hasValue = value => typeof value === "string" && value.trim().length > 0;
  if (!hasValue(parsed.OPENAI_API_KEY) && !hasValue(parsed.personal_access_token)
      && !hasValue(parsed.tokens?.access_token) && !hasValue(parsed.tokens?.refresh_token)
      && !hasValue(parsed.agent_identity?.agent_private_key) && !hasValue(parsed.agent_identity)) return null;
  return { content: `${JSON.stringify(parsed)}\n`, source };
}

export async function readCodexKeychainCredential({ service, account }, execute = executeFile) {
  try {
    const { stdout } = await execute("/usr/bin/security", [
      "find-generic-password", "-s", service, "-a", account, "-w"
    ], { timeout: 10_000, maxBuffer: AUTH_LIMIT, encoding: "utf8" });
    return stdout;
  } catch (error) {
    if (error.code === 44) return null; // errSecItemNotFound
    // execFile errors can include the credential in captured stdout. Never
    // propagate their message, output or cause into HTTP responses or logs.
    throw new Error(SOURCE_ERROR);
  }
}
