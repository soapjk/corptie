import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";

async function withStore(run) {
  const directory = await mkdtemp(join(os.tmpdir(), "corptie-feishu-test-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  try {
    await store.initialize();
    await run(store, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function createBot(store, profile) {
  return store.createFeishuBot({
    id: randomUUID(),
    name: profile,
    profile,
    enabled: false
  });
}

function createBinding(store, bot, suffix) {
  const codeHash = createHash("sha256").update(`code-${suffix}`).digest("hex");
  store.replaceFeishuPairingCode({
    id: randomUUID(),
    botId: bot.id,
    codeHash,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  });
  return store.consumeFeishuPairingCode(codeHash, {
    id: randomUUID(),
    botId: bot.id,
    openId: `ou_${suffix}`,
    chatId: `oc_${suffix}`
  });
}

test("pairing codes are single-use and persist the trusted chat", async () => {
  await withStore(async (store) => {
    const bot = createBot(store, "pairing-test");
    const binding = createBinding(store, bot, "owner");
    assert.equal(binding.openId, "ou_owner");
    assert.equal(binding.chatId, "oc_owner");

    const codeHash = createHash("sha256").update("code-owner").digest("hex");
    assert.equal(store.consumeFeishuPairingCode(codeHash, {
      id: randomUUID(),
      botId: bot.id,
      openId: "ou_other"
    }), null);
  });
});

test("a session can only be assigned to one bot", async () => {
  await withStore(async (store) => {
    const firstBot = createBot(store, "first-bot");
    const secondBot = createBot(store, "second-bot");
    const firstBinding = createBinding(store, firstBot, "first");
    const secondBinding = createBinding(store, secondBot, "second");

    store.assignFeishuSession({
      id: randomUUID(),
      botId: firstBot.id,
      bindingId: firstBinding.id,
      sessionId: "pty:shared",
      assignedAt: new Date().toISOString()
    });

    assert.throws(() => store.assignFeishuSession({
      id: randomUUID(),
      botId: secondBot.id,
      bindingId: secondBinding.id,
      sessionId: "pty:shared",
      assignedAt: new Date().toISOString()
    }), (error) => error.code === "FEISHU_SESSION_OCCUPIED");
  });
});

test("switching a bot releases its previous session", async () => {
  await withStore(async (store) => {
    const bot = createBot(store, "switching-bot");
    const binding = createBinding(store, bot, "switching");
    store.assignFeishuSession({
      id: randomUUID(),
      botId: bot.id,
      bindingId: binding.id,
      sessionId: "pty:first",
      assignedAt: new Date().toISOString()
    });
    store.assignFeishuSession({
      id: randomUUID(),
      botId: bot.id,
      bindingId: binding.id,
      sessionId: "pty:second",
      assignedAt: new Date().toISOString()
    });

    assert.equal(store.getFeishuAssignmentForSession("pty:first"), null);
    assert.equal(store.getFeishuAssignmentForBot(bot.id).sessionId, "pty:second");
  });
});

test("session events use a durable per-session cursor", async () => {
  await withStore(async (store) => {
    const first = store.appendSessionEvent({
      eventId: randomUUID(),
      sessionId: "codex:thread",
      type: "SessionRunStarted",
      source: { type: "desktop" },
      payload: {},
      createdAt: new Date().toISOString()
    });
    const second = store.appendSessionEvent({
      eventId: randomUUID(),
      sessionId: "codex:thread",
      type: "SessionRunCompleted",
      source: { type: "agent" },
      payload: {},
      createdAt: new Date().toISOString()
    });

    assert.equal(first.sequence, 1);
    assert.equal(second.sequence, 2);
    assert.deepEqual(store.listSessionEvents("codex:thread", 1).map((event) => event.sequence), [2]);
  });
});

test("gateway trusted workspaces are normalized and persisted", async () => {
  await withStore(async (store) => {
    await store.updateSettings({
      gateway: { trustedWorkspaces: [" /tmp/project-a ", "/tmp/project-a", "/tmp/project-b"] }
    });
    assert.deepEqual(store.settings().gateway.trustedWorkspaces, ["/tmp/project-a", "/tmp/project-b"]);
  });
});

test("log directory is created, persisted, and exposed with concrete log paths", async () => {
  await withStore(async (store, directory) => {
    const logDir = join(directory, "external-logs");
    await store.updateSettings({ logDir });

    assert.equal(store.settings().logDir, logDir);
    assert.deepEqual(store.settings().logPaths, {
      stdout: join(logDir, "backend.out.log"),
      stderr: join(logDir, "backend.err.log")
    });
    assert.equal(JSON.parse(await readFile(join(directory, "config.json"), "utf8")).logDir, logDir);
  });
});
