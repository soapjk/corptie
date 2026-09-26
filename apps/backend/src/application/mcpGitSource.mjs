import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export async function withMcpGitCheckout(source, operation) {
  const validated = await validateSource(source);
  const temporary = await mkdtemp(join(tmpdir(), "corptie-mcp-git-"));
  const checkout = join(temporary, "source");
  const config = [
    "-c", "core.hooksPath=/dev/null",
    "-c", "http.followRedirects=false",
    "-c", "protocol.allow=never",
    "-c", `protocol.${validated.local ? "file" : "https"}.allow=always`
  ];
  const options = {
    encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 120_000,
    env: {
      ...Object.fromEntries(["PATH", "TMPDIR", "LANG"].filter((key) => process.env[key])
        .map((key) => [key, process.env[key]])),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_LFS_SKIP_SMUDGE: "1"
    }
  };
  try {
    await run("git", [...config, "clone", "--depth", "1", "--no-recurse-submodules", "--",
      validated.source, checkout], options);
    const { stdout } = await run("git", [...config, "-C", checkout, "rev-parse", "HEAD"], options);
    const revision = stdout.trim();
    if (!/^[a-f0-9]{40,64}$/.test(revision)) throw gitError("MCP_GIT_REVISION_INVALID", "Git package revision is invalid.");
    return await operation({ checkout, revision, source: validated.source });
  } catch (error) {
    if (error?.code?.startsWith?.("MCP_")) throw error;
    throw gitError("MCP_GIT_SOURCE_UNAVAILABLE", "Git MCP package could not be cloned or inspected.");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function validateSource(source) {
  if (typeof source !== "string" || !source.trim()) {
    throw gitError("MCP_GIT_SOURCE_INVALID", "Git MCP package source is required.");
  }
  if (isAbsolute(source)) {
    try {
      const path = await realpath(source);
      if ((await stat(path)).isDirectory()) return { source: path, local: true };
    } catch { /* invalid local source */ }
    throw gitError("MCP_GIT_SOURCE_INVALID", "Local Git source directory is unavailable.");
  }
  let url;
  try { url = new URL(source); } catch { /* invalid remote source */ }
  if (!url || url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw gitError("MCP_GIT_SOURCE_INVALID", "Git MCP package requires an HTTPS repository URL without embedded credentials.");
  }
  return { source: url.href, local: false };
}

function gitError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = code === "MCP_GIT_SOURCE_UNAVAILABLE" ? 422 : 400;
  return error;
}
