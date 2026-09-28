import { spawn, execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

export class FeishuEventConsumers {
  constructor({
    store, readCliPath, readIdentityCliPath, environment, handleLine, handleCardLine,
    spawnProcess = spawn, openLines = createInterface, execute = promisify(execFile),
    wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
  }) {
    Object.assign(this, { store, readCliPath, readIdentityCliPath, environment, handleLine, handleCardLine });
    this.spawn = spawnProcess;
    this.createInterface = openLines;
    this.execFileAsync = execute;
    this.delay = wait;
    this.processes = new Map();
    this.cardProcesses = new Map();
    this.stoppingBots = new Set();
    this.cardActionErrors = new Map();
  }

  get cliPath() { return this.readCliPath(); }
  get identityCliPath() { return this.readIdentityCliPath(); }

  startBot(bot) {
    this.stoppingBots.delete(bot.id);
    this.cardActionErrors.delete(bot.id);
    this.store.updateFeishuBot(bot.id, { connectionStatus: "connecting", lastError: null });
    const messageChild = this.spawnEventConsumer(
      bot,
      "im.message.receive_v1",
      this.processes,
      "message",
      (line) => this.handleLine(bot.id, line)
    );
    this.spawnEventConsumer(
      bot,
      "card.action.trigger",
      this.cardProcesses,
      "card action",
      (line) => this.handleCardLine(bot.id, line)
    );
    messageChild.once("spawn", () => {
      this.confirmBotConnection(bot.id, messageChild).catch((error) => {
        console.log(`[feishu] bot=${bot.id} connection confirmation failed: ${error.message}`);
      });
    });
  }

  spawnEventConsumer(bot, eventKey, processMap, label, handleLine) {
    const child = this.spawn(this.cliPath, [
      "--profile", bot.profile,
      "event", "consume", eventKey,
      "--as", "bot",
      "--quiet",
      "--timeout", "8760h"
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      env: this.environment(this.identityCliPath)
    });
    processMap.set(bot.id, child);
    this.createInterface({ input: child.stdout }).on("line", (line) => {
      handleLine(line).catch((error) => {
        console.error(`[feishu] bot=${bot.id} ${label} event failed: ${error.message}`);
      });
    });
    child.stderr.on("data", (chunk) => {
      const message = String(chunk).trim();
      if (message) {
        console.log(`[feishu] bot=${bot.id} ${label}: ${message}`);
        if (label === "card action") {
          this.cardActionErrors.set(bot.id, parseCliError(message));
        }
      }
    });
    child.once("error", (error) => {
      if (processMap.get(bot.id) === child) processMap.delete(bot.id);
      this.store.updateFeishuBot(bot.id, { connectionStatus: "error", lastError: error.message });
    });
    child.once("exit", (code, signal) => {
      if (processMap.get(bot.id) === child) processMap.delete(bot.id);
      const current = this.store.getFeishuBot(bot.id);
      if (!current || this.stoppingBots.has(bot.id) || !current.enabled) return;
      if (label === "card action") {
        if (!this.cardActionErrors.has(bot.id)) {
          this.cardActionErrors.set(bot.id, `Card action consumer exited (${signal || code || "unknown"}).`);
        }
        return;
      }
      this.store.updateFeishuBot(bot.id, {
        connectionStatus: "error",
        lastError: `lark-cli ${label} consumer exited (${signal || code || "unknown"}). It will only restart after the bot is explicitly toggled or the backend restarts.`
      });
    });
    return child;
  }

  async confirmBotConnection(botId, child) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await this.delay(500);
      if (this.processes.get(botId) !== child || child.exitCode != null) {
        return;
      }
      const bot = this.store.getFeishuBot(botId);
      if (!bot) return;
      try {
        const { stdout } = await this.execFileAsync(this.cliPath, ["--profile", bot.profile, "event", "status"], {
          timeout: 3000,
          maxBuffer: 1024 * 1024,
          env: this.environment(this.cliPath)
        });
        if (/Bus:\s+running/i.test(stdout)) {
          this.store.updateFeishuBot(botId, { connectionStatus: "connected", lastError: null });
          return;
        }
      } catch {}
    }
    if (this.processes.get(botId) === child) {
      this.store.updateFeishuBot(botId, {
        connectionStatus: "error",
        lastError: "The Feishu event consumer started, but the event bus did not become ready."
      });
      child.kill("SIGTERM");
    }
  }

  async stopBot(botId, options = {}) {
    this.stoppingBots.add(botId);
    const children = [this.processes.get(botId), this.cardProcesses.get(botId)].filter(Boolean);
    this.processes.delete(botId);
    this.cardProcesses.delete(botId);
    await Promise.all(children.map(async (child) => {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await Promise.race([exited, this.delay(1500)]);
    }));
    if (options.stopDaemon && this.cliPath) {
      const bot = this.store.getFeishuBot(botId);
      if (bot?.profile) {
        await this.execFileAsync(this.cliPath, ["--profile", bot.profile, "event", "stop", "--force"], {
          timeout: 5000,
          maxBuffer: 1024 * 1024,
          env: this.environment(this.cliPath)
        }).catch((error) => {
          console.log(`[feishu] bot=${botId} event daemon stop skipped: ${error.message}`);
        });
      }
    }
    this.stoppingBots.delete(botId);
  }
}

function parseCliError(message) {
  try {
    const parsed = JSON.parse(message);
    const detail = parsed.error?.message ?? parsed.message;
    const hint = parsed.error?.hint ?? parsed.hint;
    return [detail, hint].filter(Boolean).join(" ") || message;
  } catch {
    return message;
  }
}
