import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { FeishuEventConsumers } from "../src/feishu/feishuEventConsumers.mjs";

function fixture() {
  const bot = { id: "bot", profile: "profile", enabled: true };
  const updates = [];
  const children = [];
  const commands = [];
  const consumers = new FeishuEventConsumers({
    store: { getFeishuBot: () => bot, updateFeishuBot: (_id, patch) => updates.push(patch) },
    readCliPath: () => "/cli", readIdentityCliPath: () => "/identity",
    environment: (path) => ({ PATH: path }),
    handleLine: async () => {}, handleCardLine: async () => {},
    openLines: () => new EventEmitter(),
    spawnProcess: (path, args, options) => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = (signal) => { child.exitCode = 0; child.emit("exit", 0, signal); };
      children.push(child);
      commands.push({ path, args, options });
      return child;
    },
    execute: async (path, args) => { commands.push({ path, args }); return { stdout: "Bus: running" }; },
    wait: async () => {}
  });
  return { consumers, bot, children, updates, commands };
}

test("consumer owner starts both streams and confirms connection with current CLI path", async () => {
  const { consumers, bot, children, updates, commands } = fixture();
  consumers.startBot(bot);
  assert.equal(consumers.processes.get(bot.id), children[0]);
  assert.equal(consumers.cardProcesses.get(bot.id), children[1]);
  assert.equal(commands[0].args[4], "im.message.receive_v1");
  assert.equal(commands[1].args[4], "card.action.trigger");
  assert.deepEqual(commands[0].options.env, { PATH: "/identity" });
  await consumers.confirmBotConnection(bot.id, children[0]);
  assert.equal(updates.at(-1).connectionStatus, "connected");
});

test("card consumer failure is isolated and explicit stop clears both processes", async () => {
  const { consumers, bot, children, updates, commands } = fixture();
  consumers.startBot(bot);
  children[1].stderr.emit("data", JSON.stringify({ error: { message: "denied", hint: "enable permission" } }));
  children[1].emit("exit", 1, null);
  assert.equal(consumers.cardActionErrors.get(bot.id), "denied enable permission");
  assert.equal(consumers.processes.has(bot.id), true);
  assert.equal(updates.length, 1, "card-only failure must not mark message transport failed");
  await consumers.stopBot(bot.id, { stopDaemon: true });
  assert.equal(consumers.processes.size, 0);
  assert.equal(consumers.cardProcesses.size, 0);
  assert.equal(consumers.stoppingBots.size, 0);
  assert.deepEqual(commands.at(-1), { path: "/cli", args: ["--profile", "profile", "event", "stop", "--force"] });
  assert.equal(updates.length, 1, "intentional stop must not produce an unexpected-exit error");
});
