import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

export function credentialStorageError(code = "MCP_CREDENTIAL_STORAGE_UNAVAILABLE") {
  return Object.assign(new Error("MCP credential storage requires attention."), { code, statusCode: 503 });
}
function validateAccount(account) {
  if (typeof account !== "string" || !/^mcp:[a-f0-9-]{36}:[1-9][0-9]*(?::[a-f0-9-]{36})?$/.test(account)) {
    throw credentialStorageError("MCP_CREDENTIAL_REF_INVALID");
  }
}
function validateValue(value) {
  if (!value || Array.isArray(value) || typeof value !== "object"
      || Object.keys(value).length !== 1 || !["headers", "env"].includes(Object.keys(value)[0])) {
    throw credentialStorageError("MCP_CREDENTIAL_STORAGE_CORRUPT");
  }
  const fields = value.headers ?? value.env;
  if (!fields || Array.isArray(fields) || typeof fields !== "object"
      || Object.entries(fields).some(([key, value]) => ["__proto__", "constructor", "prototype"].includes(key)
        || typeof value !== "string" || !key || /[\r\n\0]/.test(key + value))
      || Buffer.byteLength(JSON.stringify(value)) > 256 * 1024) {
    throw credentialStorageError("MCP_CREDENTIAL_STORAGE_CORRUPT");
  }
}

// The backend holds its Data Root process lock. Reads are memory-only; writes
// persist before publication and SQL commit. Never fall back to Keychain.
export function createMcpSecretStore({ dataRoot, environmentId = "production", ephemeral = false } = {}) {
  if (dataRoot != null && (typeof dataRoot !== "string" || !dataRoot)) throw new TypeError("MCP secret store requires a data root.");
  const directory = dataRoot ? join(resolve(dataRoot), "security") : null;
  const path = directory ? join(directory, "mcp-secrets.v1.json") : null;
  const limit = 8 * 1024 * 1024;
  let snapshot = { schemaVersion: 1, revision: 0, environmentId, legacySourceDataRoot: dataRoot ? resolve(dataRoot) : null, entries: {} };
  let loaded = false, initialization, unavailable, accepting = true, tail = Promise.resolve();
  async function checked(handle, isDirectory = false) {
    const info = await handle.stat();
    if (!(isDirectory ? info.isDirectory() : info.isFile()) || info.uid !== process.getuid()
        || !isDirectory && (info.nlink !== 1 || info.size > limit)) throw credentialStorageError();
    await handle.chmod(isDirectory ? 0o700 : 0o600);
  }
  async function read() {
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      await checked(handle);
      const bytes = await handle.readFile();
      if (bytes.length > limit) throw credentialStorageError("MCP_CREDENTIAL_STORAGE_FULL");
      const value = JSON.parse(bytes.toString("utf8"));
      if (value.schemaVersion !== 1 || value.environmentId !== environmentId || !Number.isSafeInteger(value.revision)
          || value.revision < 0 || !value.entries || Array.isArray(value.entries) || typeof value.entries !== "object") {
        throw credentialStorageError("MCP_CREDENTIAL_STORAGE_CORRUPT");
      }
      for (const [account, entry] of Object.entries(value.entries)) { validateAccount(account); validateValue(entry); }
      return value;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error.code?.startsWith("MCP_") ? error : credentialStorageError("MCP_CREDENTIAL_STORAGE_CORRUPT");
    } finally { await handle?.close(); }
  }
  async function initialize() {
    if (initialization) return initialization;
    initialization = (async () => {
      if (ephemeral) { loaded = true; return; }
      if (!directory) throw credentialStorageError();
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const dir = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await checked(dir, true); } finally { await dir.close(); }
      const existing = await read();
      snapshot = existing ?? snapshot;
      if (!existing) await persist(snapshot);
      loaded = true;
    })().catch(error => { unavailable = error.code?.startsWith("MCP_") ? error : credentialStorageError(); throw unavailable; });
    return initialization;
  }
  async function persist(next) {
    if (ephemeral) return;
    const bytes = Buffer.from(JSON.stringify(next));
    if (bytes.length > limit) throw credentialStorageError("MCP_CREDENTIAL_STORAGE_FULL");
    const temporary = join(directory, `.mcp-secrets-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
      await rename(temporary, path);
      const dir = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await dir.sync(); } finally { await dir.close(); }
    } catch {
      loaded = false; unavailable = credentialStorageError("MCP_CREDENTIAL_STORAGE_COMMIT_UNKNOWN");
      try { const current = await read(); if (current) { snapshot = current; loaded = true; unavailable = null; } } catch { /* keep closed */ }
      throw credentialStorageError("MCP_CREDENTIAL_STORAGE_COMMIT_UNKNOWN");
    } finally { bytes.fill(0); await handle?.close(); await unlink(temporary).catch(() => {}); }
  }
  function mutate(operation) {
    if (!accepting) return Promise.reject(credentialStorageError("MCP_CREDENTIAL_STORAGE_BUSY"));
    const job = tail.then(async () => {
      await initialize();
      if (!loaded || unavailable) throw unavailable ?? credentialStorageError();
      const next = structuredClone(snapshot);
      operation(next.entries);
      next.revision++;
      if (!Number.isSafeInteger(next.revision)) throw credentialStorageError();
      await persist(next); snapshot = next;
    });
    tail = job.catch(() => {});
    return job;
  }
  return Object.freeze({
    initialize,
    legacySourceDataRoot: () => snapshot.legacySourceDataRoot ?? dataRoot,
    get(account) {
      validateAccount(account);
      if (!loaded || unavailable) throw unavailable ?? credentialStorageError();
      return structuredClone(Object.hasOwn(snapshot.entries, account) ? snapshot.entries[account] : null);
    },
    put(account, value) {
      validateAccount(account); validateValue(value);
      const copy = structuredClone(value);
      return mutate(entries => {
        if (Object.hasOwn(entries, account) && JSON.stringify(entries[account]) !== JSON.stringify(copy)) {
          throw credentialStorageError("MCP_CREDENTIAL_STORAGE_CONFLICT");
        }
        entries[account] = copy;
      });
    },
    delete(account) { validateAccount(account); return mutate(entries => { delete entries[account]; }); },
    flush: () => tail,
    async pause() { accepting = false; await tail; },
    resume() { accepting = true; },
    revision: () => snapshot.revision,
    status: () => ({ state: unavailable ? "unavailable" : loaded ? "ready" : "initializing", code: unavailable?.code ?? null })
  });
}
