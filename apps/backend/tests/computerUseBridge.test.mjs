import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { computerUseBridgePreset, prepareComputerUseBridge, COMPUTER_USE_BRIDGE_PROFILE } from "../src/application/computerUseBridge.mjs";
import { connectDesktopMcp, DesktopStdioTransport } from "../src/mcp/desktopMcpClient.mjs";
import { SkillMcpGateway } from "../src/application/skillMcpGateway.mjs";
import { isComputerUseMcpConfig } from "../src/application/computerUseGatewayPolicy.mjs";

test("bridge remains unavailable when the official component or optional package is absent", async () => {
  const r = await computerUseBridgePreset({ discover: async () => ({ status: "missing_app" }) });
  assert.equal(r.config, null);
  const p = await computerUseBridgePreset({ discover: async () => ({ status: "dependencies_available" }), packageFile: () => { throw new Error("missing"); } });
  assert.equal(p.runtime.status, "missing_bridge");
  assert.equal(p.config, null);
});

test("a private runtime uses the installed environment builder and enables only computer", async t => {
  const root = await mkdtemp(join(tmpdir(), "bridge-profile-")); t.after(() => rm(root, { recursive: true, force: true }));
  const paths = { nodeModuleDirs: "/signed/modules", nodePath: "/signed/node", nodeReplPath: "/signed/node_repl", serviceAppPath: "/signed/service.app" };
  let input;
  const c = await prepareComputerUseBridge({ cwd: root }, {
    runtime: { status: "dependencies_available", paths },
    buildEnvironment: options => { input = options; return { ...options.env, NODE_REPL_TRUSTED_SERVICES: '{"sky":"@oai/sky/service"}' }; }
  });
  const profile = JSON.parse(await readFile(join(c.cwd, "native-runtime.json"), "utf8"));
  assert.equal(input.env.CUA_REPL_ENABLED_SURFACES, "computer");
  assert.equal(profile.mcpServers.cua_repl.command, paths.nodeReplPath);
  assert.equal(c.env.CODEX_COMPUTER_USE_HOME, c.cwd);
  assert.equal(Object.hasOwn(c.env, "OPENAI_API_KEY"), false);
  assert.equal(isComputerUseMcpConfig({ type: "stdio", runtimeProfile: COMPUTER_USE_BRIDGE_PROFILE }), true);
  assert.equal(isComputerUseMcpConfig({ type: "http", runtimeProfile: COMPUTER_USE_BRIDGE_PROFILE }), false);
});

test("a builder that enables browsers is rejected before the MCP starts", async t => {
  const root = await mkdtemp(join(tmpdir(), "bridge-surfaces-")); t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(prepareComputerUseBridge({ cwd: root }, {
    runtime: { status: "dependencies_available", paths: { nodeModuleDirs: "/signed/modules" } },
    buildEnvironment: () => ({ CUA_REPL_ENABLED_SURFACES: "browser,computer", NODE_REPL_TRUSTED_SERVICES: '{"browser":"other"}' })
  }), { code: "COMPUTER_USE_SURFACE_UNSUPPORTED" });
});

test("standard MCP bridge preserves approvals/images and reopens only desktop state at Turn end", async t => {
  const root = await mkdtemp(join(tmpdir(), "bridge-protocol-")); t.after(() => rm(root, { recursive: true, force: true }));
  const config = { type: "stdio", command: process.execPath,
    args: [fileURLToPath(new URL("./fixtures/desktopBridgeMcp.mjs", import.meta.url))], cwd: root,
    runtimeProfile: COMPUTER_USE_BRIDGE_PROFILE };
  let generation = 0, ordinaryCloses = 0, allow = false, approvals = 0;
  const prepare = async c => {
    const stateRoot = join(root, String(++generation)); await mkdir(stateRoot);
    return { ...c, stateRoot, env: { PATH: process.env.PATH } };
  };
  const gateway = new SkillMcpGateway({ resolveServers: async () => ({ desktop: config, ordinary: { command: "/ordinary" } }),
    computerUseSupport: () => true,
    onElicitation: async () => { approvals++; return { action: allow ? "accept" : "decline", content: {} }; },
    connectServer: async (name, c) => name === "desktop"
      ? connectDesktopMcp(c, (client, r, extra) => gateway.elicit(client, r, extra), { prepare, fingerprint: async () => "one" })
      : { listTools: async () => ({ tools: [{ name: "other", inputSchema: { type: "object" } }] }), close: async () => { ordinaryCloses++; } }
  });
  t.after(() => gateway.close());
  const input = { actorId: "resource:role", providerId: "provider:any", tool: "js", arguments: { code: "read" },
    metadata: { logicalSessionId: "logical:one", providerBindingId: "binding:one", turnId: "turn:one" } };
  const denied = await gateway.execute(input);
  assert.equal(denied.isError, true); assert.equal(denied.content[0].text, "declined-before-action");
  allow = true;
  const result = await gateway.execute({ ...input, metadata: { ...input.metadata,
    requestMetadata: { "x-codex-turn-metadata": { thread_id: "origin" } } } });
  assert.equal(result.content[1].type, "image");
  const first = JSON.parse(result.content[0].text); assert.equal(first.meta, null);
  assert.match((await gateway.definitions(input)).find(x => x.name === "js").description, /computer-only cua/);
  await gateway.endTurn("logical:one", "turn:one");
  assert.equal(ordinaryCloses, 0);
  const next = await gateway.execute({ ...input, metadata: { ...input.metadata, turnId: "turn:two" } });
  assert.notEqual(JSON.parse(next.content[0].text).pid, first.pid);
  assert.equal(generation, 2); assert.equal(approvals, 3);
});

test("runtime fingerprint changes close the old process and never replay a tool call", async t => {
  const root = await mkdtemp(join(tmpdir(), "bridge-update-")); t.after(() => rm(root, { recursive: true, force: true }));
  let identity = "old", approvals = 0;
  const config = { type: "stdio", command: process.execPath,
    args: [fileURLToPath(new URL("./fixtures/desktopBridgeMcp.mjs", import.meta.url))], cwd: root };
  const client = await connectDesktopMcp(config, async () => { approvals++; return { action: "accept", content: {} }; }, {
    fingerprint: async () => identity,
    prepare: async c => { const stateRoot = await mkdtemp(join(root, "instance-")); return { ...c, stateRoot, env: { PATH: process.env.PATH } }; }
  });
  t.after(() => client.close());
  await client.callTool({ name: "js", arguments: { code: "read" } });
  identity = "new";
  await assert.rejects(client.callTool({ name: "js", arguments: { code: "must not run" } }), { code: "COMPUTER_USE_RUNTIME_CHANGED" });
  assert.equal(approvals, 1);
});

test("stopping while approval is pending aborts and reaps the private MCP process", async t => {
  const root = await mkdtemp(join(tmpdir(), "bridge-cancel-")); t.after(() => rm(root, { recursive: true, force: true }));
  let transport, entered;
  const approval = new Promise(resolve => { entered = resolve; });
  const config = { type: "stdio", command: process.execPath,
    args: [fileURLToPath(new URL("./fixtures/desktopBridgeMcp.mjs", import.meta.url))], cwd: root };
  const client = await connectDesktopMcp(config, async (_c, _r, extra) => {
    entered();
    if (!extra.signal.aborted) await new Promise(resolve => extra.signal.addEventListener("abort", resolve, { once: true }));
    return { action: "cancel" };
  }, {
    prepare: async c => { const stateRoot = await mkdtemp(join(root, "instance-")); return { ...c, stateRoot, env: { PATH: process.env.PATH } }; },
    transportFactory: c => transport = new DesktopStdioTransport(c, { graceMs: 50 }), fingerprint: async () => "same"
  });
  const stop = new AbortController();
  const pending = client.callTool({ name: "js", arguments: { code: "read" } }, undefined, { signal: stop.signal });
  const rejected = assert.rejects(pending);
  await approval;
  stop.abort(); await rejected;
  await client.close();
  assert.ok(transport.process.exitCode !== null || transport.process.signalCode !== null);
  assert.throws(() => process.kill(transport.process.pid, 0), { code: "ESRCH" });
});
