import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { ClaudeAgentManager } from "../src/adapters/claudeAgentManager.mjs";
import { recoverClaudeSessionIdentity } from "../src/adapters/claudeSessionIdentity.mjs";

test("Claude persists native identity at init and resumes exact identity after manager restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "claude-restart-"));
  const store = new CorptieStore({ dbPath: join(dir, "db.sqlite"), configPath: join(dir, "config.json") });
  try {
    await store.initialize();
    store.upsertSession({ id: "pty:one", title: "Recovery", sessionKind: "assistantChat", provider: "claude-sdk",
      status: "cancelled", external: { provider: "claude-sdk", sessionId: "one", cwd: dir } });
    const first = new ClaudeAgentManager({ store });
    first.start({ id: "one", cwd: dir });
    first.handleSdkMessage(first.get("one"), { type: "system", subtype: "init", session_id: "native-one" });
    assert.equal(store.getSession("pty:one").external.agentSessionId, "native-one");
    let options;
    const restarted = new ClaudeAgentManager({ store, query: request => {
      options = request.options;
      return { async *[Symbol.asyncIterator]() {} };
    } });
    await restarted.reconnect("one", { startQuery: false });
    assert.equal(restarted.get("one").currentTurnId, null);
    await restarted.probeBinding("one");
    assert.equal(options.resume, "native-one");
  } finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("legacy repair requires exact cwd and Session evidence and rejects ambiguity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "claude-identity-"));
  try {
    const cwd = await realpath(dir);
    const project = join(dir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
    await mkdir(project, { recursive: true });
    const input = { configDirectory: dir, cwd, logicalSessionId: "logical:one" };
    const row = { type: "user", cwd, sessionId: "native-one", message: {
      content: '<corptie_direct_user_message_evidence logical_session_id="logical:one" event_id="test">'
    } };
    await writeFile(join(project, "native-one.jsonl"), JSON.stringify(row));
    assert.equal(await recoverClaudeSessionIdentity(input), "native-one");
    assert.equal(await recoverClaudeSessionIdentity({ ...input, logicalSessionId: "logical:other" }), null);
    assert.equal(await recoverClaudeSessionIdentity({ ...input, configDirectory: null }), null);
    await writeFile(join(project, "native-two.jsonl"), JSON.stringify({ ...row, sessionId: "native-two" }));
    assert.equal(await recoverClaudeSessionIdentity(input), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("missing native identity with prior messages must not silently start fresh", async () => {
  const manager = new ClaudeAgentManager({ environment: () => ({}), store: {
    getSession: id => id === "pty:old" ? { id, external: { provider: "claude-sdk" } } : null,
    getItems: () => [{ type: "agentMessage", text: "history" }]
  }, query: () => assert.fail("must not launch a fresh query") });
  await assert.rejects(manager.reconnect("old"), { code: "PROVIDER_SESSION_UNAVAILABLE" });
});
