import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyLocalMcpPackage, discoverLocalMcpPackage } from "../src/application/mcpPackageDiscovery.mjs";

test("pure MCP plugin package is discovered without SKILL.md", async () => {
  const root = await mkdtemp(join(tmpdir(), "corptie-mcp-package-"));
  try {
    await mkdir(join(root, ".codex-plugin"));
    await writeFile(join(root, ".codex-plugin", "plugin.json"), JSON.stringify({ mcpServers: "mcp.json" }));
    await writeFile(join(root, "mcp.json"), JSON.stringify({ mcpServers: {
      calendar: { type: "stdio", command: "node", args: ["server.mjs"] },
      remote: { type: "http", url: "https://example.test/mcp" }
    } }));
    const result = await discoverLocalMcpPackage(root);
    assert.equal(result.descriptorPath, "mcp.json");
    assert.deepEqual(result.candidates, [
      { serverName: "calendar", transport: "stdio", requiresConfiguration: false,
        credentialNames: [], command: "node", args: ["server.mjs"], url: null },
      { serverName: "remote", transport: "http", requiresConfiguration: false,
        credentialNames: [], command: null, args: [], url: "https://example.test/mcp" }
    ]);
    assert.equal(result.servers.calendar.command, "node");
    await assert.rejects(() => copyLocalMcpPackage(root, join(root, "managed")),
      { code: "MCP_PACKAGE_DESTINATION_INVALID" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP package discovery rejects descriptor traversal and symlink files", async () => {
  const root = await mkdtemp(join(tmpdir(), "corptie-mcp-package-"));
  try {
    await mkdir(join(root, ".codex-plugin"));
    await writeFile(join(root, ".codex-plugin", "plugin.json"), JSON.stringify({ mcpServers: "../outside.json" }));
    await assert.rejects(() => discoverLocalMcpPackage(root), { code: "MCP_PACKAGE_PATH_OUTSIDE" });
    await writeFile(join(root, ".codex-plugin", "plugin.json"), JSON.stringify({ mcpServers: "mcp.json" }));
    await writeFile(join(root, "actual.json"), JSON.stringify({ mcpServers: { remote: { url: "https://example.test/mcp" } } }));
    await symlink("actual.json", join(root, "mcp.json"));
    await assert.rejects(() => discoverLocalMcpPackage(root), { code: "MCP_PACKAGE_FILE_INVALID" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP package discovery exposes credential names without returning their values", async () => {
  const root = await mkdtemp(join(tmpdir(), "corptie-mcp-package-"));
  try {
    await writeFile(join(root, ".mcp.json"), JSON.stringify({ mcpServers: {
      secured: { command: "node", args: ["server.mjs"], env: { API_KEY: "${API_KEY}" } }
    } }));
    const result = await discoverLocalMcpPackage(root);
    assert.deepEqual(result.candidates[0].credentialNames, ["API_KEY"]);
    assert.equal(result.candidates[0].requiresConfiguration, true);
    assert.doesNotMatch(JSON.stringify(result.candidates), /\$\{API_KEY\}/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP package discovery refuses literal credentials before copying package files", async () => {
  const root = await mkdtemp(join(tmpdir(), "corptie-mcp-package-"));
  try {
    await writeFile(join(root, ".mcp.json"), JSON.stringify({ mcpServers: {
      secured: { command: "node", env: { API_KEY: "literal-secret" } }
    } }));
    await assert.rejects(() => discoverLocalMcpPackage(root), { code: "MCP_PACKAGE_LITERAL_CREDENTIAL" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
