import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const nativePath = join(dirname(fileURLToPath(import.meta.url)), "../../native/corptie_native.node");

// The database stores only a Keychain account reference and credential field
// names. Values never enter SQLite, management responses, or command arguments.
export function createMcpSecretStore({ dataRoot, native } = {}) {
  if (typeof dataRoot !== "string" || !dataRoot) throw new TypeError("MCP secret store requires a data root.");
  const service = `com.corptie.mcp.${createHash("sha256").update(resolve(dataRoot)).digest("hex").slice(0, 32)}`;
  let bridge = native;
  function keychain() {
    if (!bridge) {
      try { bridge = require(nativePath); } catch { throw secretError("MCP_KEYCHAIN_UNAVAILABLE"); }
    }
    if (!["mcpKeychainPut", "mcpKeychainGet", "mcpKeychainDelete"].every((name) => typeof bridge[name] === "function")) {
      throw secretError("MCP_KEYCHAIN_UNAVAILABLE");
    }
    return bridge;
  }
  function operation(callback) {
    try { return callback(keychain()); } catch (error) {
      if (error?.code === "MCP_KEYCHAIN_UNAVAILABLE") throw error;
      throw secretError("MCP_KEYCHAIN_UNAVAILABLE");
    }
  }
  return Object.freeze({
    put(account, value) {
      validateAccount(account);
      const bytes = Buffer.from(JSON.stringify(value), "utf8");
      try { operation((nativeBridge) => nativeBridge.mcpKeychainPut(service, account, bytes)); }
      finally { bytes.fill(0); }
    },
    get(account) {
      validateAccount(account);
      const bytes = operation((nativeBridge) => nativeBridge.mcpKeychainGet(service, account));
      if (!bytes) return null;
      try { return JSON.parse(Buffer.from(bytes).toString("utf8")); }
      catch { throw secretError("MCP_KEYCHAIN_CORRUPT"); }
      finally { if (typeof bytes.fill === "function") bytes.fill(0); }
    },
    delete(account) {
      validateAccount(account);
      operation((nativeBridge) => nativeBridge.mcpKeychainDelete(service, account));
    }
  });
}

function validateAccount(account) {
  if (typeof account !== "string" || !/^mcp:[a-f0-9-]{36}:[1-9][0-9]*(?::[a-f0-9-]{36})?$/.test(account)) {
    throw secretError("MCP_CREDENTIAL_REF_INVALID");
  }
}

function secretError(code) {
  const error = new Error(code === "MCP_KEYCHAIN_CORRUPT" ? "MCP credential data is invalid." : "MCP credential storage is unavailable.");
  error.code = code;
  error.statusCode = 503;
  return error;
}
