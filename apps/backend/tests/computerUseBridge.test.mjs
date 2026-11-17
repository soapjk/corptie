import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { computerUseBridgePreset, prepareComputerUseBridge, COMPUTER_USE_BRIDGE_PROFILE } from "../src/application/computerUseBridge.mjs";
import { connectDesktopMcp, DesktopStdioTransport, readDesktopProcesses } from "../src/mcp/desktopMcpClient.mjs";
import { SkillMcpGateway } from "../src/application/skillMcpGateway.mjs";
import { isComputerUseMcpConfig } from "../src/application/computerUseGatewayPolicy.mjs";
import { BROWSER_CONTEXT_META } from "../src/application/browserAccessHost.mjs";

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

test("a builder that enables an unrequested browser service is rejected before the MCP starts", async t => {
  const root = await mkdtemp(join(tmpdir(), "bridge-surfaces-")); t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(prepareComputerUseBridge({ cwd: root }, {
    runtime: { status: "dependencies_available", paths: { nodeModuleDirs: "/signed/modules" } },
    buildEnvironment: () => ({ CUA_REPL_ENABLED_SURFACES: "browser,computer", NODE_REPL_TRUSTED_SERVICES: '{"browser":"other"}' })
  }), { code: "COMPUTER_USE_SURFACE_UNSUPPORTED" });
});

test("a compatible browser surface is explicitly enabled with the official services", async t => {
  const root = await mkdtemp(join(tmpdir(), "bridge-browser-")); t.after(() => rm(root, { recursive: true, force: true }));
  const result = await prepareComputerUseBridge({ cwd: root }, {
    runtime: { status: "dependencies_available", paths: { nodeModuleDirs: "/signed/modules", nodeReplPath: "/signed/node_repl" } },
    discoverBrowser: async () => ({ configured: true }),
    buildEnvironment: ({ env }) => ({ ...env, NODE_REPL_TRUSTED_SERVICES: JSON.stringify({ sky: "@oai/sky/service", browser: "@oai/browser-desktop/service" }) })
  });
  const native = JSON.parse(await readFile(join(result.cwd, "native-runtime.json"), "utf8"));
  assert.equal(native.mcpServers.cua_repl.env.CUA_REPL_ENABLED_SURFACES, "browser,computer");
  // The MCP host supplies its own signed browser access parameters at startup.
  assert.equal(native.mcpServers.cua_repl.env.BROWSER_USE_ACCESS_EXECUTOR_ID, undefined);
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
  const first = JSON.parse(result.content[0].text);
  assert.deepEqual(first.meta, { [BROWSER_CONTEXT_META]: {
    logicalSessionId: "logical:one", providerBindingId: "binding:one", turnId: "turn:one"
  } });
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

test("process enumeration retries transient failures and rejects empty or persistently failed snapshots", async () => {
  const complete = "    1     0 Thu Nov 12 18:50:47 2026 /sbin/launchd\n  500     1 Thu Nov 12 18:50:48 2026 /private/test\n";
  let attempts = 0;
  const delays = [];
  const table = await readDesktopProcesses({ run: async () => {
    if (++attempts < 3) throw Object.assign(Error("ps failed"), { code: 1 });
    return { stdout: complete };
  }, delay: async ms => delays.push(ms) });
  assert.equal(table.get(500).ppid, 1);
  assert.equal(table.get(500).identity, "Thu Nov 12 18:50:48 2026:/private/test");
  assert.equal(attempts, 3); assert.deepEqual(delays, [50, 100]);
  for (const output of ["", "partial invalid output", complete.replace(/^.*\n/, "")]) {
    let count = 0;
    await assert.rejects(readDesktopProcesses({ run: async () => { count++; return { stdout: output }; }, delay: async () => {} }),
      { code: "COMPUTER_USE_PROCESS_SNAPSHOT_FAILED" });
    assert.equal(count, 3);
  }
});

test("failed transport cleanup retains process ownership and resumes verification after the MCP exits", async t => {
  const root = await mkdtemp(join(tmpdir(), "bridge-cleanup-retry-"));
  let transport, fail = false, snapshot = 0, generation = 0, stateRoot;
  const client = await connectDesktopMcp({ cwd: root, command: process.execPath,
    args: [fileURLToPath(new URL("./fixtures/desktopBridgeMcp.mjs", import.meta.url))] }, async () => ({ action: "accept" }), {
    prepare: async c => {
      stateRoot = join(root, `instance-${++generation}`); await mkdir(stateRoot);
      return { ...c, stateRoot, env: { PATH: process.env.PATH } };
    }, fingerprint: async () => "stable",
    transportFactory: c => transport = new DesktopStdioTransport(c, { graceMs: 100,
      readProcesses: async () => {
        snapshot++;
        if (fail && snapshot >= 2) throw Object.assign(Error("ps transient failure"), { code: "COMPUTER_USE_PROCESS_SNAPSHOT_FAILED" });
        return readDesktopProcesses();
      } })
  });
  t.after(async () => { fail = false; await client.close(); await rm(root, { recursive: true, force: true }); });
  const first = JSON.parse((await client.callTool({ name: "js", arguments: { code: "inspect" } })).content[0].text);
  fail = true;
  await assert.rejects(client.close(), { code: "COMPUTER_USE_CLEANUP_FAILED" });
  assert.equal(transport.owned.has(first.pid), true);
  await stat(stateRoot); // Retain the private state until cleanup is verified.
  assert.equal(generation, 1);
  fail = false;
  await client.close();
  await assert.rejects(stat(stateRoot), { code: "ENOENT" });
  const next = JSON.parse((await client.callTool({ name: "js", arguments: { code: "inspect again" } })).content[0].text);
  assert.notEqual(first.pid, next.pid);
  assert.equal(generation, 2);
});

test("snapshot failure before shutdown cannot be cached forever or cause an unsafe restart", async t => {
  const root = await mkdtemp(join(tmpdir(), "bridge-snapshot-retry-"));
  let fail = true, transport;
  const config = { cwd: root, command: process.execPath,
    args: [fileURLToPath(new URL("./fixtures/desktopBridgeMcp.mjs", import.meta.url))], env: { PATH: process.env.PATH } };
  transport = new DesktopStdioTransport(config, { graceMs: 100, readProcesses: async () => {
    if (fail) throw Error("ps unavailable"); return readDesktopProcesses();
  } });
  transport.onmessage = () => {};
  t.after(async () => { fail = false; await transport.close(); await rm(root, { recursive: true, force: true }); });
  await transport.start();
  const pid = transport.process.pid;
  await assert.rejects(transport.close(), { code: "COMPUTER_USE_CLEANUP_FAILED" });
  assert.doesNotThrow(() => process.kill(pid, 0));
  assert.equal(transport.owned, undefined);
  fail = false;
  await transport.close();
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});
