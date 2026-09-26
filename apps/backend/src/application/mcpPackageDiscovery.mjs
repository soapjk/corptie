import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const DESCRIPTORS = [".mcp.json", "mcp.json", "mcp.config.json"];
const MANIFEST = join(".codex-plugin", "plugin.json");
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_PACKAGE_BYTES = 100 * 1024 * 1024;
const MAX_PACKAGE_FILES = 10_000;

export async function discoverLocalMcpPackage(source) {
  if (typeof source !== "string" || !isAbsolute(source)) {
    throw packageError("MCP_PACKAGE_SOURCE_INVALID", "MCP package source must be an absolute directory.");
  }
  let root;
  try {
    root = await realpath(source);
    if (!(await stat(root)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw packageError("MCP_PACKAGE_SOURCE_INVALID", "MCP package source directory is unavailable.");
  }
  let descriptorPath;
  if (await exists(join(root, MANIFEST))) {
    const manifest = await readJson(root, MANIFEST, "MCP_PACKAGE_MANIFEST_INVALID");
    if (typeof manifest.mcpServers !== "string" || !manifest.mcpServers.trim()) {
      throw packageError("MCP_PACKAGE_MANIFEST_INVALID", "Plugin manifest must declare an MCP descriptor path.");
    }
    descriptorPath = manifest.mcpServers.trim();
  } else {
    const found = [];
    for (const name of DESCRIPTORS) if (await exists(join(root, name))) found.push(name);
    if (found.length !== 1) {
      throw packageError(found.length ? "MCP_PACKAGE_DESCRIPTOR_AMBIGUOUS" : "MCP_PACKAGE_DESCRIPTOR_MISSING",
        "MCP package must contain exactly one root descriptor or a plugin manifest.");
    }
    descriptorPath = found[0];
  }
  const descriptor = await readJson(root, descriptorPath, "MCP_PACKAGE_DESCRIPTOR_INVALID");
  if (descriptor.mcpServers != null && descriptor.mcp_servers != null) {
    throw packageError("MCP_PACKAGE_DESCRIPTOR_AMBIGUOUS", "MCP descriptor declares both server fields.");
  }
  const servers = descriptor.mcpServers ?? descriptor.mcp_servers;
  if (!record(servers) || Object.keys(servers).length === 0) {
    throw packageError("MCP_PACKAGE_DESCRIPTOR_INVALID", "MCP descriptor must declare at least one Server.");
  }
  if (Object.keys(servers).length > 100) {
    throw packageError("MCP_PACKAGE_TOO_LARGE", "MCP descriptor declares too many Servers.");
  }
  const candidates = Object.entries(servers).map(([serverName, config]) => {
    if (!serverName.trim() || serverName.length > 120 || !record(config)) {
      throw packageError("MCP_PACKAGE_DESCRIPTOR_INVALID", "MCP descriptor contains an invalid Server.");
    }
    const transport = String(config.type ?? (config.url ? "http" : "stdio")).toLowerCase();
    if (!["http", "sse", "stdio"].includes(transport)) {
      throw packageError("MCP_PACKAGE_DESCRIPTOR_INVALID", "MCP descriptor contains an unsupported transport.");
    }
    if (transport === "stdio") {
      if (config.headers != null) {
        throw packageError("MCP_PACKAGE_DESCRIPTOR_INVALID", "Stdio MCP package cannot declare HTTP headers.");
      }
      if (typeof config.command !== "string" || !config.command.trim()
        || (config.args != null && (!Array.isArray(config.args) || config.args.length > 32
          || config.args.some((value) => typeof value !== "string" || value.includes("\0"))))) {
        throw packageError("MCP_PACKAGE_DESCRIPTOR_INVALID", "MCP package stdio Server command or arguments are invalid.");
      }
    } else {
      if (config.env != null) {
        throw packageError("MCP_PACKAGE_DESCRIPTOR_INVALID", "Remote MCP package cannot declare environment variables.");
      }
      let url;
      try { url = new URL(config.url); } catch { /* handled below */ }
      const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url?.hostname);
      if (!url || (url.protocol !== "https:" && !(loopback && url.protocol === "http:"))
        || url.username || url.password || url.search || url.hash) {
        throw packageError("MCP_PACKAGE_DESCRIPTOR_INVALID", "MCP package remote Server URL is invalid.");
      }
    }
    const credentials = transport === "stdio" ? config.env : config.headers;
    if (credentials != null && (!record(credentials) || Object.keys(credentials).length > 16
      || Object.entries(credentials).some(([key, value]) => transport === "stdio"
        ? !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" || value.includes("\0")
        : !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || typeof value !== "string"
          || /[\r\n]/.test(value)))) {
      throw packageError("MCP_PACKAGE_DESCRIPTOR_INVALID", "MCP package credential declarations are invalid.");
    }
    if (Object.values(credentials ?? {}).some((value) => value !== ""
      && !/^(?:Bearer |Basic )?\$\{(?:env:)?[A-Za-z_][A-Za-z0-9_]*\}$/.test(value))) {
      throw packageError("MCP_PACKAGE_LITERAL_CREDENTIAL", "MCP package credentials must be empty or placeholders, not literal values.");
    }
    const credentialNames = Object.keys(credentials ?? {});
    return {
      serverName, transport, requiresConfiguration: credentialNames.length > 0,
      credentialNames,
      command: transport === "stdio" && typeof config.command === "string" ? config.command : null,
      args: transport === "stdio" && Array.isArray(config.args)
        ? config.args : [],
      url: transport === "stdio" ? null : (typeof config.url === "string" ? config.url : null)
    };
  });
  return { sourceRoot: root, descriptorPath, candidates, servers };
}

export async function copyLocalMcpPackage(sourceRoot, destination) {
  const root = (await discoverLocalMcpPackage(sourceRoot)).sourceRoot;
  if (inside(root, await canonicalDestination(destination))) {
    throw packageError("MCP_PACKAGE_DESTINATION_INVALID", "Managed installation cannot be inside its source package.");
  }
  let bytes = 0;
  let files = 0;
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  try {
    await cp(root, destination, {
      recursive: true,
      force: false,
      filter: async (source) => {
        const rel = relative(root, source);
        if (rel === ".git" || rel.startsWith(`.git${sep}`)) return false;
        const info = await lstat(source);
        if (!info.isDirectory() && !info.isFile()) {
          throw packageError("MCP_PACKAGE_RESOURCE_INVALID", "MCP package contains a link or special file.");
        }
        if (info.isFile()) {
          files += 1;
          bytes += info.size;
          if (files > MAX_PACKAGE_FILES || bytes > MAX_PACKAGE_BYTES) {
            throw packageError("MCP_PACKAGE_TOO_LARGE", "MCP package exceeds the installation size limit.");
          }
        }
        return true;
      }
    });
    const copied = await discoverLocalMcpPackage(destination);
    const contentHash = await hashLocalMcpPackage(destination);
    return { ...copied, contentHash };
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

async function canonicalDestination(destination) {
  let parent = dirname(resolve(destination));
  const missing = [basename(destination)];
  while (true) {
    try { return resolve(await realpath(parent), ...missing); } catch {
      const next = dirname(parent);
      if (next === parent) throw packageError("MCP_PACKAGE_DESTINATION_INVALID", "Managed installation parent is unavailable.");
      missing.unshift(basename(parent));
      parent = next;
    }
  }
}

export async function hashLocalMcpPackage(root) {
  const hash = createHash("sha256");
  let bytes = 0;
  let files = 0;
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (directory === root && entry.name === ".git") continue;
      const path = join(directory, entry.name);
      const rel = relative(root, path).replaceAll("\\", "/");
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const info = await stat(path);
        files += 1;
        bytes += info.size;
        if (files > MAX_PACKAGE_FILES || bytes > MAX_PACKAGE_BYTES) {
          throw packageError("MCP_PACKAGE_TOO_LARGE", "MCP package exceeds the installation size limit.");
        }
        hash.update(rel).update("\0").update(await readFile(path)).update("\0");
      } else throw packageError("MCP_PACKAGE_RESOURCE_INVALID", "MCP package contains a link or special file.");
    }
  }
  await visit(root);
  return hash.digest("hex");
}

async function readJson(root, path, code) {
  const file = await containedFile(root, path);
  let content;
  try { content = await readFile(file, "utf8"); } catch {
    throw packageError(code, "MCP package JSON file cannot be read.");
  }
  let value;
  try { value = JSON.parse(content); } catch {
    throw packageError(code, "MCP package JSON file is invalid.");
  }
  if (!record(value)) throw packageError(code, "MCP package JSON root must be an object.");
  return value;
}

async function containedFile(root, path) {
  const target = resolve(root, path);
  if (!inside(root, target)) throw packageError("MCP_PACKAGE_PATH_OUTSIDE", "MCP package path escapes its root.");
  let info;
  try { info = await lstat(target); } catch {
    throw packageError("MCP_PACKAGE_FILE_MISSING", "MCP package file is missing.");
  }
  if (!info.isFile() || info.size > MAX_JSON_BYTES) {
    throw packageError("MCP_PACKAGE_FILE_INVALID", "MCP package file must be a regular JSON file under 1 MiB.");
  }
  const actual = await realpath(target);
  if (!inside(root, actual)) throw packageError("MCP_PACKAGE_PATH_OUTSIDE", "MCP package path escapes its root.");
  return actual;
}

function inside(root, target) {
  const path = relative(root, target);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function exists(path) {
  try { await lstat(path); return true; } catch { return false; }
}

function packageError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 400;
  return error;
}
