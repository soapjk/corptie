import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withMcpGitCheckout } from "../src/application/mcpGitSource.mjs";
import { McpRegistryService } from "../src/application/mcpRegistryService.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

test("Git MCP package is pinned to the discovered revision before installation", async () => {
  const root = await mkdtemp(join(tmpdir(), "corptie-mcp-git-test-"));
  const source = join(root, "source");
  const store = new CorptieStore({ dbPath: join(root, "db.sqlite"), configPath: join(root, "config.json") });
  try {
    await mkdir(source);
    git(["init", source]);
    await writeFile(join(source, "server.mjs"), "process.stdin.resume();\n");
    await writeFile(join(source, ".mcp.json"), JSON.stringify({ mcpServers: {
      ping: { command: "node", args: ["${PLUGIN_ROOT}/server.mjs"] }
    } }));
    git(["-C", source, "add", "."]);
    git(["-C", source, "-c", "user.name=Corptie Test", "-c", "user.email=test@example.invalid",
      "commit", "-m", "first"]);
    await store.initialize();
    const service = new McpRegistryService({ store, packageRoot: join(root, "managed") });
    const first = await service.discoverPackage({ sourceType: "git", source });
    assert.match(first.sourceRevision, /^[a-f0-9]{40}$/);
    assert.deepEqual(first.candidates.map((candidate) => candidate.serverName), ["ping"]);
    await writeFile(join(source, "changed.txt"), "second revision\n");
    git(["-C", source, "add", "."]);
    git(["-C", source, "-c", "user.name=Corptie Test", "-c", "user.email=test@example.invalid",
      "commit", "-m", "second"]);
    await assert.rejects(() => service.registerPackage({ sourceType: "git", source,
      serverName: "ping", expectedContentHash: first.contentHash,
      expectedSourceRevision: first.sourceRevision }), { code: "MCP_PACKAGE_CHANGED" });
    const current = await service.discoverPackage({ sourceType: "git", source });
    service.verify = async (config) => ({ ...config, toolCount: 1, toolNames: ["ping"] });
    const installed = await service.registerPackage({ sourceType: "git", source,
      serverName: "ping", expectedContentHash: current.contentHash,
      expectedSourceRevision: current.sourceRevision });
    assert.equal(installed.sourceKind, "git_package");
    assert.equal(installed.sourceRevision, current.sourceRevision);
    assert.equal(installed.packageHash, current.contentHash);
    assert.equal((await service.remove(installed.serverId)).cleanupPending, false);
  } finally {
    await store.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("Git MCP package rejects credentialed, non-HTTPS and shell-style sources", async () => {
  for (const source of ["git@github.com:org/repo.git", "http://example.test/repo.git",
    "https://token@example.test/repo.git", "https://example.test/repo.git?token=secret"]) {
    await assert.rejects(() => withMcpGitCheckout(source, async () => {}), { code: "MCP_GIT_SOURCE_INVALID" });
  }
});
