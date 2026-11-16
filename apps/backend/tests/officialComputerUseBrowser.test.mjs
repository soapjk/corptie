import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createOfficialComputerUseServer } from "../src/mcp/officialComputerUseMcpServer.mjs";
import { BROWSER_CONTEXT_META } from "../src/application/browserAccessHost.mjs";
import { prepareOfficialBrokerAdapter } from "../src/application/officialComputerUseAdapter.mjs";
import { discoverBrowserSurface, computerUseSurfaces } from "../src/application/computerUseBrowserCapabilities.mjs";
import { challenge } from "./fixtures/browserAccessProtocol.mjs";

const context = { logicalSessionId: "logical:real", providerBindingId: "binding:real", turnId: "turn:real" };
const meta = { [BROWSER_CONTEXT_META]: context };
const overrides = { server_instructions: "Use the configured desktop and browser APIs", tools: {
  js: { description: "Official tools", field_descriptions: { code: "Code", title: "Title" } }, js_reset: { description: "Reset" }
} };

async function setup(t, allow = true) {
  const root = await mkdtemp(join(tmpdir(), "corptie-browser-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const nativePath = join(root, "native-runtime.json");
  await writeFile(nativePath, JSON.stringify({ mcpServers: { cua_repl: { env: {
    CUA_REPL_ENABLED_SURFACES: "browser,computer", NODE_REPL_TOOL_OVERRIDES: JSON.stringify(overrides)
  } } } }));
  await writeFile(join(root, "config.json"), JSON.stringify({ cuaReplConfigPath: nativePath }));
  let calls = 0, actions = 0, approvals = 0, closed = 0;
  const wrapper = await createOfficialComputerUseServer({ root, brokerFactory: async options => ({
    async call(tool, args, extra) {
      options.onNativeDispatch({ sessionId: "native-thread", turnId: "native-turn", tool });
      calls++;
      if (args.code === "desktop") return { content: [{ type: "text", text: "desktop-ok" }] };
      const env = JSON.parse(await readFile(nativePath, "utf8")).mcpServers.cua_repl.env;
      const response = await challenge(env);
      const grant = response.response.result && JSON.parse(response.response.result.payload).allowed;
      if (!grant) return { isError: true, content: [{ type: "text", text: "browser-denied" }] };
      if (args.code === "website") {
        const site = await extra.onElicitation({ mode: "form", message: "Allow example.test?",
          requestedSchema: { type: "object", properties: {} }, _meta: { connector_id: "browser-site" } });
        if (site.action !== "accept") return { isError: true, content: [{ type: "text", text: "website-denied" }] };
      }
      actions++;
      return { content: [{ type: "text", text: JSON.stringify({ corptieBrowserInventory: [{ id: "chrome-profile", name: "Chrome" }] }) }] };
    }, close: async () => { closed++; }
  }) });
  const client = new Client({ name: "test", version: "1" }, { capabilities: { elicitation: { form: {} } } });
  client.setRequestHandler(ElicitRequestSchema, async request => {
    approvals++;
    return { action: request.params._meta?.connector_id === "browser-site" ? "decline" : allow ? "accept" : "decline" };
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await wrapper.server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await wrapper.close(); });
  return { client, root, counts: () => ({ calls, actions, approvals, closed }) };
}

test("browser inventory is Session gated, signed, and separate from a directory/status read", async t => {
  const f = await setup(t);
  assert.equal((await f.client.listTools()).tools.length, 3);
  const initial = await f.client.callTool({ name: "computer_use_status" });
  assert.equal(initial.structuredContent.surfaces.browser.connected, null);
  assert.equal(f.counts().calls, 0);
  const result = await f.client.callTool({ name: "computer_use_status", arguments: { inspectBrowsers: true }, _meta: meta });
  assert.equal(result.structuredContent.surfaces.browser.connected, true);
  assert.equal(result.structuredContent.surfaces.browser.permissionStatus, "granted");
  await f.client.callTool({ name: "js", arguments: { code: "desktop" }, _meta: meta });
  assert.equal(f.counts().approvals, 1);
});

test("browser rejection performs no browser action and keeps native desktop usable", async t => {
  const f = await setup(t, false);
  const denied = await f.client.callTool({ name: "js", arguments: { code: "browser" }, _meta: meta });
  assert.equal(denied.isError, true);
  assert.equal(f.counts().actions, 0);
  const desktop = await f.client.callTool({ name: "js", arguments: { code: "desktop" }, _meta: meta });
  assert.equal(desktop.content[0].text, "desktop-ok");
});

test("website denial remains independent of the granted browser channel", async t => {
  const f = await setup(t);
  const denied = await f.client.callTool({ name: "js", arguments: { code: "website" }, _meta: meta });
  assert.equal(denied.isError, true);
  assert.equal(f.counts().actions, 0);
  assert.equal(f.counts().approvals, 2);
});

test("model-authored context in arguments cannot substitute trusted Session metadata", async t => {
  const f = await setup(t);
  const denied = await f.client.callTool({ name: "js", arguments: { code: "browser", _meta: meta } });
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /BROWSER_SESSION_REQUIRED/);
  assert.equal(f.counts().calls, 0);
});

test("a different Corptie Turn cannot reuse an already authorized native runtime", async t => {
  const f = await setup(t);
  await f.client.callTool({ name: "js", arguments: { code: "desktop" }, _meta: meta });
  const denied = await f.client.callTool({ name: "js", arguments: { code: "browser" }, _meta: {
    [BROWSER_CONTEXT_META]: { ...context, turnId: "turn:stale" }
  } });
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /BROWSER_SESSION_STALE/);
  assert.equal(f.counts().calls, 1);
});

test("the pinned broker adapter loads without editing upstream and retains signature checks", async t => {
  const root = await mkdtemp(join(tmpdir(), "browser-adapter-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packagePath = createRequire(import.meta.url).resolve("codex-computer-use-mcp/package.json");
  const entry = await prepareOfficialBrokerAdapter(packagePath, root);
  const module = await import(pathToFileURL(entry).href);
  assert.equal(typeof module.createOfficialCuaReplSession, "function");
  const source = await readFile(entry, "utf8");
  assert.match(source, /onNativeDispatch/);
  assert.match(source, /verifyOfficialDirectBroker/);
  assert.match(source, /modelTurnsStarted/);
  const identities = [];
  const broker = await module.createOfficialCuaReplSession({
    skipSignatureVerification: true, appServerCommand: process.execPath,
    appServerArgs: [fileURLToPath(new URL("./fixtures/directBrowserBrokerHost.mjs", import.meta.url))],
    onNativeDispatch: value => identities.push(value)
  });
  try {
    const result = await broker.call("js", { code: "fixture" });
    const actual = JSON.parse(result.content[0].text)._meta["x-codex-turn-metadata"];
    assert.equal(identities[0].sessionId, actual.session_id);
    assert.equal(identities[0].sessionId, "fixture-native-thread");
    assert.equal(identities[0].turnId, actual.turn_id);
    assert.equal(result.modelTurnsStarted, 0);
  } finally { await broker.close(); }
});

test("a pinned adapter with an incompatible dispatch shape is rejected without patching upstream", async t => {
  const root = await mkdtemp(join(tmpdir(), "browser-adapter-incompatible-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "dist"));
  const packagePath = join(root, "package.json");
  await writeFile(packagePath, JSON.stringify({ name: "codex-computer-use-mcp", version: "0.7.1" }));
  await writeFile(join(root, "dist/direct-broker.js"), "export const changed = true;");
  await assert.rejects(prepareOfficialBrokerAdapter(packagePath, root), { code: "BROWSER_BROKER_INCOMPATIBLE" });
  assert.equal(await readFile(join(root, "dist/direct-broker.js"), "utf8"), "export const changed = true;");
});

test("missing or incompatible browser components leave desktop capabilities independent", async t => {
  const root = await mkdtemp(join(tmpdir(), "browser-components-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal((await discoverBrowserSurface(root)).reasonCode, "BROWSER_COMPONENT_MISSING");
  const dir = join(root, "@oai/browser-desktop");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "@oai/browser-desktop", exports: { "./service": "./service.mjs" } }));
  await writeFile(join(dir, "service.mjs"), "unknown protocol");
  const browser = await discoverBrowserSurface(root);
  assert.equal(browser.reasonCode, "BROWSER_PROTOCOL_INCOMPATIBLE");
  assert.equal(computerUseSurfaces("official", browser).computer.configured, true);
  assert.equal(computerUseSurfaces("independent").browser.supported, false);
});
