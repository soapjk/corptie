import { createHash, randomInt, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { environmentForCommand, resolveExternalCommand } from "../utils/externalCommand.mjs";
import { isClearCommand } from "../commands/unifiedCommands.mjs";

const execFileAsync = promisify(execFile);
const pairingCodePattern = /^\d{6}$/;
const sessionCardPageSize = 5;
const workspaceCardPageSize = 5;

export class FeishuGatewayManager {
  constructor(options) {
    this.store = options.store;
    this.listSessions = options.listSessions;
    this.listWorkspaces = options.listWorkspaces ?? (() => []);
    this.createSession = options.createSession;
    this.getSnapshot = options.getSnapshot;
    this.getUsage = options.getUsage;
    this.sendMessage = options.sendMessage;
    this.interruptSession = options.interruptSession;
    this.respondToApproval = options.respondToApproval;
    this.cliPath = options.cliPath || process.env.CORPTIE_LARK_CLI || null;
    this.identityCliPath = null;
    this.processes = new Map();
    this.cardProcesses = new Map();
    this.stoppingBots = new Set();
    this.processedEventIds = new Set();
    this.botRuntime = new Map();
    this.cardActionErrors = new Map();
    this.syncTimers = new Map();
    this.syncRuns = new Map();
    this.syncInterval = null;
  }

  async initialize() {
    this.cliPath = this.cliPath || await resolveLarkCli();
    this.identityCliPath = await resolveIdentityLarkCli(this.cliPath);
    await this.reconcile();
    this.syncInterval = setInterval(() => {
      for (const assignment of this.store.listFeishuAssignments()) {
        if (this.store.getFeishuBot(assignment.botId)?.enabled) {
          this.syncBot(assignment.botId).catch((error) => {
            console.error(`[feishu] bot=${assignment.botId} periodic sync failed: ${error.message}`);
          });
        }
      }
    }, 2000);
    this.syncInterval.unref?.();
  }

  async close() {
    const botIds = new Set([...this.processes.keys(), ...this.cardProcesses.keys()]);
    await Promise.all(Array.from(botIds).map((botId) => this.stopBot(botId, { stopDaemon: true })));
    for (const timer of this.syncTimers.values()) {
      clearTimeout(timer);
    }
    this.syncTimers.clear();
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
  }

  status() {
    return {
      cliPath: this.cliPath,
      cliAvailable: Boolean(this.cliPath),
      runningBotIds: Array.from(this.processes.keys()),
      cardActionBotIds: Array.from(this.cardProcesses.keys())
    };
  }

  async listProfiles() {
    if (!this.cliPath) return [];
    const { stdout } = await execFileAsync(this.cliPath, ["profile", "list"], {
      maxBuffer: 1024 * 1024,
      env: larkCliEnvironment(this.cliPath)
    });
    const profiles = JSON.parse(stdout || "[]");
    return Array.isArray(profiles) ? profiles.map((profile) => ({
      name: profile.name,
      appId: profile.appId ?? null,
      brand: profile.brand ?? null,
      active: profile.active === true
    })).filter((profile) => profile.name) : [];
  }

  listBots() {
    const assignments = new Map(this.store.listFeishuAssignments().map((item) => [item.botId, item]));
    return this.store.listFeishuBots().map((bot) => ({
      ...bot,
      bindings: this.store.listFeishuBindings(bot.id),
      assignment: assignments.get(bot.id) ?? null,
      runtime: this.processes.has(bot.id) ? "running" : "stopped",
      cardActions: {
        status: this.cardProcesses.has(bot.id)
          ? "running"
          : this.cardActionErrors.has(bot.id) ? "setup_required" : "stopped",
        error: this.cardActionErrors.get(bot.id) ?? null
      }
    }));
  }

  async createBot(input = {}) {
    if (!this.cliPath) {
      throw new Error("lark-cli was not found. Install it before adding a Feishu bot.");
    }
    const existingProfile = optionalText(input.profile);
    if (existingProfile) {
      const profile = (await this.listProfiles()).find((item) => item.name === existingProfile);
      if (!profile) {
        throw new Error("The selected lark-cli profile was not found.");
      }
      const bot = this.store.createFeishuBot({
        id: randomUUID(),
        name: optionalText(input.name) || profile.name,
        profile: profile.name,
        appId: profile.appId,
        brand: profile.brand || "feishu",
        managedProfile: false,
        transportType: "lark-cli",
        enabled: false
      });
      await this.reconcileBot(bot);
      return this.getBot(bot.id);
    }
    const appId = requiredText(input.appId, "Feishu App ID is required.");
    const appSecret = requiredText(input.appSecret, "Feishu App Secret is required.");
    const brand = input.brand === "lark" ? "lark" : "feishu";
    if (this.store.listFeishuBots().some((bot) => bot.appId === appId)) {
      throw new Error("A Gateway bot already uses this App ID.");
    }
    const id = randomUUID();
    const profile = `corptie-${id}`;
    await runWithInput(this.cliPath, [
      "profile", "add",
      "--name", profile,
      "--app-id", appId,
      "--brand", brand,
      "--app-secret-stdin"
    ], `${appSecret}\n`);
    let bot;
    try {
      bot = this.store.createFeishuBot({
        id,
        name: optionalText(input.name) || appId,
        profile,
        appId,
        brand,
        managedProfile: true,
        transportType: "lark-cli",
        enabled: false
      });
    } catch (error) {
      await execFileAsync(this.cliPath, ["profile", "remove", profile], { env: larkCliEnvironment(this.cliPath) }).catch(() => {});
      throw error;
    }
    await this.reconcileBot(bot);
    return this.getBot(bot.id);
  }

  async updateBot(id, input = {}) {
    const bot = this.store.updateFeishuBot(id, input);
    if (!bot) {
      return null;
    }
    await this.reconcileBot(bot);
    return this.getBot(id);
  }

  async deleteBot(id) {
    const bot = this.store.getFeishuBot(id);
    if (!bot) {
      return false;
    }
    await this.stopBot(id, { stopDaemon: true });
    if (bot.managedProfile && this.cliPath) {
      await execFileAsync(this.cliPath, ["profile", "remove", bot.profile], {
        timeout: 5000,
        maxBuffer: 1024 * 1024,
        env: larkCliEnvironment(this.cliPath)
      }).catch((error) => {
        console.log(`[feishu] bot=${id} managed profile cleanup skipped: ${error.message}`);
      });
    }
    this.store.deleteFeishuBot(id);
    this.botRuntime.delete(id);
    return true;
  }

  getBot(id) {
    return this.listBots().find((bot) => bot.id === id) ?? null;
  }

  createPairingCode(botId, ttlMs = 10 * 60 * 1000) {
    if (!this.store.getFeishuBot(botId)) {
      return null;
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + Math.max(60_000, Math.min(60 * 60 * 1000, ttlMs))).toISOString();
    this.store.replaceFeishuPairingCode({
      id: randomUUID(),
      botId,
      codeHash: pairingHash(code),
      createdAt,
      expiresAt
    });
    return { code, expiresAt };
  }

  releaseSession(botId) {
    this.store.releaseFeishuSession(botId);
    this.botRuntime.delete(botId);
  }

  async assignSession(botId, bindingId, sessionId) {
    const sessions = await this.listSessions();
    if (!sessions.some((session) => session.id === sessionId)) {
      const error = new Error("Session not found.");
      error.code = "SESSION_NOT_FOUND";
      throw error;
    }
    const assignment = this.store.assignFeishuSession({
      id: randomUUID(),
      botId,
      bindingId,
      sessionId,
      assignedAt: new Date().toISOString(),
      lastEventSequence: this.store.lastSessionEventSequence(sessionId)
    });
    const snapshot = await this.getSnapshot(sessionId);
    this.botRuntime.set(botId, {
      lastStatus: snapshot.status,
      seenItems: new Set((snapshot.items ?? []).map((item) => item.id))
    });
    return assignment;
  }

  async reconcile() {
    for (const bot of this.store.listFeishuBots()) {
      await this.reconcileBot(bot);
    }
  }

  async reconcileBot(bot) {
    await this.refreshBotIdentity(bot.id);
    bot = this.store.getFeishuBot(bot.id) ?? bot;
    if (!bot.enabled) {
      await this.stopBot(bot.id, { stopDaemon: bot.connectionStatus !== "disabled" });
      this.store.updateFeishuBot(bot.id, { connectionStatus: "disabled", lastError: null });
      return;
    }
    if (!this.cliPath) {
      this.store.updateFeishuBot(bot.id, {
        connectionStatus: "error",
        lastError: "lark-cli was not found. Set CORPTIE_LARK_CLI or install the Feishu CLI."
      });
      return;
    }
    await this.stopBot(bot.id, { stopDaemon: true });
    this.startBot(bot);
  }

  async refreshBotIdentity(botId) {
    try {
      const bot = this.store.getFeishuBot(botId);
      if (!bot || !this.identityCliPath) return;
      const remote = await fetchBotIdentity(this.identityCliPath, bot.profile, {
        env: larkCliEnvironment(this.cliPath)
      });
      if (!remote) {
        throw new Error("Feishu returned no bot identity.");
      }
      this.store.updateFeishuBot(botId, {
        name: remote.app_name ?? bot.name,
        remoteName: remote.app_name ?? null,
        remoteAvatarURL: remote.avatar_url ?? null,
        remoteOpenId: remote.open_id ?? null,
        remoteActivateStatus: remote.activate_status ?? null
      });
    } catch (error) {
      console.log(`[feishu] bot=${botId} identity unavailable: ${error.message}`);
    }
  }

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
    const child = spawn(this.cliPath, [
      "--profile", bot.profile,
      "event", "consume", eventKey,
      "--as", "bot",
      "--quiet",
      "--timeout", "8760h"
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      env: larkCliEnvironment(this.identityCliPath)
    });
    processMap.set(bot.id, child);
    createInterface({ input: child.stdout }).on("line", (line) => {
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
      await delay(500);
      if (this.processes.get(botId) !== child || child.exitCode != null) {
        return;
      }
      const bot = this.store.getFeishuBot(botId);
      if (!bot) return;
      try {
        const { stdout } = await execFileAsync(this.cliPath, ["--profile", bot.profile, "event", "status"], {
          timeout: 3000,
          maxBuffer: 1024 * 1024,
          env: larkCliEnvironment(this.cliPath)
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
      await Promise.race([exited, delay(1500)]);
    }));
    if (options.stopDaemon && this.cliPath) {
      const bot = this.store.getFeishuBot(botId);
      if (bot?.profile) {
        await execFileAsync(this.cliPath, ["--profile", bot.profile, "event", "stop", "--force"], {
          timeout: 5000,
          maxBuffer: 1024 * 1024,
          env: larkCliEnvironment(this.cliPath)
        }).catch((error) => {
          console.log(`[feishu] bot=${botId} event daemon stop skipped: ${error.message}`);
        });
      }
    }
    this.stoppingBots.delete(botId);
  }

  async handleLine(botId, line) {
    let raw;
    try {
      raw = JSON.parse(line);
    } catch {
      return;
    }
    const event = normalizeInboundEvent(raw);
    if (!event || event.chatType !== "p2p" || event.messageType !== "text") {
      return;
    }
    if (event.eventId && (this.processedEventIds.has(event.eventId) || !this.store.claimFeishuInboundEvent(botId, event.eventId))) {
      return;
    }
    if (event.eventId) {
      this.processedEventIds.add(event.eventId);
      if (this.processedEventIds.size > 5000) {
        this.processedEventIds.delete(this.processedEventIds.values().next().value);
      }
    }

    const runtime = this.botRuntime.get(botId) ?? { lastStatus: null, seenItems: new Set() };
    runtime.chatId = event.chatId;
    this.botRuntime.set(botId, runtime);

    const binding = this.store.getFeishuBinding(botId, event.openId);
    if (!binding) {
      if (!pairingCodePattern.test(event.text)) {
        await this.sendText(botId, event.chatId, "此飞书用户尚未绑定 Corptie。请在电脑端设置中生成 6 位绑定码，然后将绑定码发送给我。");
        return;
      }
      const verified = this.store.consumeFeishuPairingCode(pairingHash(event.text), {
        id: randomUUID(),
        botId,
        openId: event.openId,
        chatId: event.chatId,
        tenantKey: event.tenantKey
      });
      if (!verified) {
        await this.sendText(botId, event.chatId, "绑定码无效或已经过期，请在电脑端重新生成。");
        return;
      }
      await this.sendText(botId, event.chatId, "绑定成功。请选择要连接的 Corptie 会话：");
      await this.sendSessionListCard(botId, event.chatId);
      return;
    }

    if (binding.chatId !== event.chatId) {
      this.store.updateFeishuBindingChat(binding.id, event.chatId);
    }

    try {
      await this.handleCommand(botId, binding, event);
    } catch (error) {
      await this.clearTyping(botId).catch(() => {});
      await this.sendText(botId, event.chatId, `操作失败：${error.message}`);
      throw error;
    }
  }

  async handleCardLine(botId, line) {
    let raw;
    try {
      raw = JSON.parse(line);
    } catch {
      return;
    }
    const event = normalizeCardActionEvent(raw);
    if (!event?.operatorId || !event.chatId) return;
    if (event.eventId && !this.store.claimFeishuInboundEvent(botId, `card:${event.eventId}`)) return;

    const binding = this.store.getFeishuBinding(botId, event.operatorId);
    if (!binding || (binding.chatId && binding.chatId !== event.chatId)) {
      console.log(`[feishu] bot=${botId} rejected card action from an untrusted operator or chat`);
      return;
    }
    if (binding.chatId !== event.chatId) {
      this.store.updateFeishuBindingChat(binding.id, event.chatId);
    }

    const action = event.actionValue?.corptie_action;
    let page = nonNegativeInteger(event.actionValue?.page);
    let notice = null;
    let card = null;
    if (action === "select_session") {
      const sessionId = optionalText(event.actionValue?.session_id);
      try {
        await this.assignSession(botId, binding.id, sessionId);
        const session = (await this.listSessions()).find((item) => item.id === sessionId);
        notice = { type: "success", text: `已连接「${session?.title ?? "所选会话"}」` };
      } catch (error) {
        notice = error.code === "FEISHU_SESSION_OCCUPIED"
          ? { type: "error", text: "这个会话刚刚被另一个机器人占用，请重新选择。" }
          : { type: "error", text: `连接失败：${error.message}` };
      }
    } else if (action === "detach_session") {
      this.releaseSession(botId);
      notice = { type: "success", text: "已释放当前会话。" };
    } else if (action === "sessions_page" || action === "refresh_sessions") {
      if (action === "refresh_sessions") page = 0;
    } else if (action === "start_create_session" || action === "workspaces_page" || action === "refresh_workspaces") {
      if (action !== "workspaces_page") page = 0;
      card = await this.buildWorkspaceCard(page);
    } else if (action === "select_workspace") {
      const workspace = await this.resolveWorkspace(event.actionValue?.workspace_id);
      card = buildAgentPickerCard({ workspace });
    } else if (action === "select_create_agent") {
      const workspace = await this.resolveWorkspace(event.actionValue?.workspace_id);
      const agent = normalizeGatewayAgent(event.actionValue?.agent);
      card = buildCreateConfirmationCard({
        workspace,
        agent,
        replacesCurrentSession: Boolean(this.store.getFeishuAssignmentForBot(botId))
      });
    } else if (action === "confirm_create_session") {
      const workspace = await this.resolveWorkspace(event.actionValue?.workspace_id);
      const agent = normalizeGatewayAgent(event.actionValue?.agent);
      if (!this.createSession) throw new Error("Gateway session creation is unavailable.");
      try {
        const session = await this.createSession({ cwd: workspace.path, agent });
        await this.assignSession(botId, binding.id, session.id);
        notice = { type: "success", text: `已创建并连接「${session.title}」` };
      } catch (error) {
        card = buildCreateConfirmationCard({
          workspace,
          agent,
          replacesCurrentSession: Boolean(this.store.getFeishuAssignmentForBot(botId)),
          notice: { type: "error", text: `创建失败：${error.message}` }
        });
      }
    } else if (action === "respond_approval") {
      const sessionId = optionalText(event.actionValue?.session_id);
      const assignment = this.store.getFeishuAssignmentForBot(botId);
      if (!assignment || assignment.sessionId !== sessionId) {
        card = buildApprovalResultCard("这个审批所属的会话已不再连接，未执行操作。", false);
      } else if (!this.respondToApproval) {
        card = buildApprovalResultCard("当前版本无法处理审批，请在电脑端操作。", false);
      } else {
        const role = optionalText(event.actionValue?.option_role).toLowerCase();
        const approved = !role.includes("deny") && !role.includes("cancel");
        try {
          await this.respondToApproval(sessionId, {
            approved,
            optionId: optionalText(event.actionValue?.option_id),
            optionIndex: nonNegativeInteger(event.actionValue?.option_index),
            choiceId: optionalText(event.actionValue?.choice_id),
            itemType: optionalText(event.actionValue?.item_type)
          }, feishuSource(botId, event));
          card = buildApprovalResultCard(approved ? "已允许，Codex 将继续执行。" : "已拒绝，Codex 将停止这项操作。", approved);
        } catch (error) {
          card = buildApprovalResultCard(`审批失败：${error.message}`, false);
        }
      }
    } else if (action === "create_back_workspaces") {
      card = await this.buildWorkspaceCard(0);
    } else if (action === "create_cancel" || action === "create_back_sessions") {
      card = await this.buildSessionListCard(botId, 0);
    } else {
      return;
    }

    card ??= await this.buildSessionListCard(botId, page, notice);
    if (event.token) {
      await this.updateCard(botId, event.token, card);
    } else {
      await this.sendCard(botId, event.chatId, card);
    }
  }

  async handleCommand(botId, binding, event) {
    const text = event.text.trim();
    if (["/new", "新建会话", "创建会话"].includes(text)) {
      await this.sendCard(botId, event.chatId, await this.buildWorkspaceCard(0));
      return;
    }
    if (["/sessions", "会话", "切换会话"].includes(text)) {
      await this.sendSessionListCard(botId, event.chatId);
      return;
    }
    if (text === "/current" || text === "/status" || text === "状态") {
      await this.sendText(botId, event.chatId, await this.currentSessionText(botId));
      return;
    }
    if (text.toLowerCase() === "/usage") {
      if (!this.getUsage) {
        await this.sendText(botId, event.chatId, "当前版本无法查询模型用量。请更新 Corptie 后重试。");
        return;
      }
      const assignment = this.store.getFeishuAssignmentForBot(botId);
      const usage = await this.getUsage(assignment?.sessionId ?? null);
      await this.sendText(botId, event.chatId, formatUsageText(usage));
      return;
    }
    if (text === "/detach") {
      this.releaseSession(botId);
      await this.sendSessionListCard(botId, event.chatId, 0, { type: "success", text: "已释放当前会话。" });
      return;
    }
    if (text === "/stop") {
      const assignment = this.store.getFeishuAssignmentForBot(botId);
      if (!assignment) {
        await this.sendText(botId, event.chatId, "当前没有连接会话。");
        return;
      }
      await this.interruptSession(assignment.sessionId, feishuSource(botId, event));
      await this.sendText(botId, event.chatId, "已发送停止请求。");
      return;
    }
    if (text === "/help") {
      await this.sendText(botId, event.chatId, "/new 创建会话\n/clear 清空上下文并开始新对话\n/sessions 查看和切换会话\n/current 查看当前会话\n/status 查看状态\n/usage 查看模型用量余额\n/detach 释放会话\n/stop 中断任务");
      return;
    }
    const useMatch = text.match(/^\/(?:use|switch)\s+(.+)$/i);
    if (useMatch) {
      const sessions = await this.listSessions();
      const requested = useMatch[1].trim();
      const index = Number(requested);
      const session = Number.isInteger(index) && index >= 1
        ? sessions[index - 1]
        : sessions.find((item) => item.id === requested);
      if (!session) {
        await this.sendText(botId, event.chatId, "没有找到这个会话。请发送 /sessions 刷新列表。");
        return;
      }
      try {
        await this.assignSession(botId, binding.id, session.id);
        await this.sendText(botId, event.chatId, `已连接：${session.title}\n状态：${displayStatus(session.status)}`);
      } catch (error) {
        if (error.code === "FEISHU_SESSION_OCCUPIED") {
          await this.sendText(botId, event.chatId, "这个会话已被另一个飞书机器人连接，请选择其他会话。");
          return;
        }
        throw error;
      }
      return;
    }

    const assignment = this.store.getFeishuAssignmentForBot(botId);
    if (!assignment) {
      await this.sendSessionListCard(botId, event.chatId, 0, { type: "info", text: "请先选择一个会话。" });
      return;
    }
    if (isClearCommand(text)) {
      const sendResult = await this.sendMessage(assignment.sessionId, text, feishuSource(botId, event));
      if (sendResult?.sessionId && sendResult.sessionId !== assignment.sessionId) {
        await this.assignSession(botId, binding.id, sendResult.sessionId);
      }
      await this.sendText(botId, event.chatId, "已清空上下文，可以开始新的对话。");
      return;
    }
    const runtime = this.botRuntime.get(botId) ?? { lastStatus: null, seenItems: new Set() };
    runtime.pendingFeishuInputs = [...(runtime.pendingFeishuInputs ?? []), text];
    this.botRuntime.set(botId, runtime);
    await this.showTyping(botId, event.messageId).catch((error) => {
      console.log(`[feishu] bot=${botId} typing reaction unavailable: ${error.message}`);
    });
    const sendResult = await this.sendMessage(assignment.sessionId, text, feishuSource(botId, event));
    if (sendResult?.queued) {
      await this.clearTyping(botId).catch(() => {});
      await this.sendText(botId, event.chatId, `已加入队列，前面还有 ${Math.max(0, sendResult.queuePosition - 1)} 条消息。`, {
        sessionStatus: "queued"
      });
    } else {
      await this.sendText(botId, event.chatId, "已发送，正在处理……");
    }
  }

  async sessionListText(botId) {
    const sessions = await this.listSessions();
    const current = this.store.getFeishuAssignmentForBot(botId);
    const assignments = new Map(this.store.listFeishuAssignments().map((item) => [item.sessionId, item]));
    if (sessions.length === 0) {
      return "这台电脑上暂时没有可用会话。";
    }
    const lines = sessions.map((session, index) => {
      const owner = assignments.get(session.id);
      const marker = current?.sessionId === session.id ? "●" : owner ? "×" : "○";
      const occupied = owner && owner.botId !== botId ? " · 已被其他机器人占用" : "";
      const cwd = session.external?.cwd ? ` · ${session.external.cwd}` : "";
      return `${index + 1}. ${marker} ${session.title} · ${displayStatus(session.status)}${cwd}${occupied}`;
    });
    return `会话列表：\n${lines.join("\n")}\n\n发送 /use 序号 切换，例如 /use 2`;
  }

  async buildSessionListCard(botId, page = 0, notice = null) {
    const sessions = await this.listSessions();
    const assignments = this.store.listFeishuAssignments();
    const maxPage = Math.max(0, Math.ceil(sessions.length / sessionCardPageSize) - 1);
    const safePage = Math.min(nonNegativeInteger(page), maxPage);
    return buildSessionListCard({
      botId,
      sessions,
      assignments,
      current: this.store.getFeishuAssignmentForBot(botId),
      page: safePage,
      pageSize: sessionCardPageSize,
      notice
    });
  }

  async sendSessionListCard(botId, chatId, page = 0, notice = null) {
    await this.sendCard(botId, chatId, await this.buildSessionListCard(botId, page, notice));
  }

  async trustedWorkspaces() {
    const workspaces = await this.listWorkspaces();
    return workspaces
      .filter((workspace) => optionalText(workspace?.path))
      .map((workspace) => ({
        id: workspaceIdForPath(workspace.path),
        path: workspace.path,
        name: optionalText(workspace.name) || workspace.path.split("/").filter(Boolean).at(-1) || workspace.path,
        updatedAt: workspace.updatedAt ?? null
      }));
  }

  async resolveWorkspace(workspaceId) {
    const requested = optionalText(workspaceId);
    const workspace = (await this.trustedWorkspaces()).find((item) => item.id === requested);
    if (!workspace) {
      const error = new Error("这个工作区已不在可信列表中，请刷新后重新选择。");
      error.code = "WORKSPACE_NOT_TRUSTED";
      throw error;
    }
    return workspace;
  }

  async buildWorkspaceCard(page = 0, notice = null) {
    const workspaces = await this.trustedWorkspaces();
    const maxPage = Math.max(0, Math.ceil(workspaces.length / workspaceCardPageSize) - 1);
    return buildWorkspacePickerCard({
      workspaces,
      page: Math.min(nonNegativeInteger(page), maxPage),
      pageSize: workspaceCardPageSize,
      notice
    });
  }

  async currentSessionText(botId) {
    const assignment = this.store.getFeishuAssignmentForBot(botId);
    if (!assignment) {
      return "当前没有连接会话。发送 /sessions 查看列表。";
    }
    const snapshot = await this.getSnapshot(assignment.sessionId);
    return `当前会话：${snapshot.title}\n状态：${displayStatus(snapshot.status)}${snapshot.activityStatus ? `\n进度：${snapshot.activityStatus}` : ""}`;
  }

  handleSessionEvent(event) {
    const assignment = this.store.getFeishuAssignmentForSession(event.sessionId);
    if (!assignment || !this.store.getFeishuBot(assignment.botId)?.enabled) {
      return;
    }
    this.store.updateFeishuAssignmentCursor(assignment.botId, event.sequence);
    clearTimeout(this.syncTimers.get(assignment.botId));
    const timer = setTimeout(() => {
      this.syncTimers.delete(assignment.botId);
      this.syncBot(assignment.botId).catch((error) => {
        console.error(`[feishu] bot=${assignment.botId} sync failed: ${error.message}`);
      });
    }, 500);
    timer.unref?.();
    this.syncTimers.set(assignment.botId, timer);
  }

  async syncBot(botId) {
    const activeRun = this.syncRuns.get(botId);
    if (activeRun) {
      activeRun.rerun = true;
      return activeRun.promise;
    }

    const run = { rerun: false, promise: null };
    run.promise = Promise.resolve().then(async () => {
      try {
        do {
          run.rerun = false;
          await this.syncBotOnce(botId);
        } while (run.rerun);
      } finally {
        if (this.syncRuns.get(botId) === run) {
          this.syncRuns.delete(botId);
        }
      }
    });
    this.syncRuns.set(botId, run);
    return run.promise;
  }

  async syncBotOnce(botId) {
    const assignment = this.store.getFeishuAssignmentForBot(botId);
    const binding = this.store.listFeishuBindings(botId)[0];
    if (!assignment || !binding) {
      return;
    }
    const snapshot = await this.getSnapshot(assignment.sessionId);
    const existingRuntime = this.botRuntime.get(botId);
    const runtime = existingRuntime ?? { lastStatus: null, seenItems: new Set() };
    const chatId = binding.chatId || runtime.chatId;
    if (!chatId) {
      return;
    }
    if (!existingRuntime) {
      runtime.lastStatus = snapshot.status;
      runtime.seenItems = new Set((snapshot.items ?? [])
        .filter((item) => !isPendingApprovalItem(item))
        .map((item) => item.id)
        .filter(Boolean));
      this.botRuntime.set(botId, runtime);
      await this.sendText(botId, chatId, `当前会话：${snapshot.title}\n状态：${displayStatus(snapshot.status)}`, {
        sessionTitle: snapshot.title,
        sessionStatus: snapshot.status
      });
    }
    if (snapshot.status !== runtime.lastStatus) {
      runtime.lastStatus = snapshot.status;
      if (!isProcessingStatus(snapshot.status)) {
        await this.clearTyping(botId).catch(() => {});
      }
    }
    const newAssistantItems = (snapshot.items ?? []).filter((item) => {
      const unseen = item.id && !runtime.seenItems.has(item.id);
      const locallyHiddenCollaboration = item.sourceType === "collaboration" && item.localVisibility === "status_only";
      return unseen && !locallyHiddenCollaboration && ["agentMessage", "assistantMessage"].includes(item.type) && item.text;
    });
    for (const item of newAssistantItems) {
      const sentCards = await this.sendText(botId, chatId, item.text, {
        sessionTitle: snapshot.title,
        sessionStatus: snapshot.status
      });
      runtime.lastAssistantCards = (sentCards ?? [])
        .map(({ text, result }) => ({
          itemId: item.id,
          messageId: result?.data?.message_id ?? result?.data?.message?.message_id ?? null,
          text,
          sessionTitle: snapshot.title,
          sessionStatus: snapshot.status
        }))
        .filter((card) => card.messageId);
    }
    if (runtime.lastAssistantCards?.some((card) => card.sessionStatus !== snapshot.status)) {
      for (const card of runtime.lastAssistantCards) {
        await this.updateSentMessageCard(
          botId,
          card.messageId,
          buildMessageCard(card.text, {
            sessionTitle: snapshot.title,
            sessionStatus: snapshot.status
          })
        );
      }
      runtime.lastAssistantCards = runtime.lastAssistantCards.map((card) => ({
        ...card,
        sessionTitle: snapshot.title,
        sessionStatus: snapshot.status
      }));
    }
    const newApprovalItems = (snapshot.items ?? []).filter((item) => {
      const unseen = item.id && !runtime.seenItems.has(item.id);
      return unseen && isPendingApprovalItem(item);
    });
    for (const item of newApprovalItems) {
      await this.sendCard(botId, chatId, buildApprovalCard({
        sessionId: assignment.sessionId,
        sessionTitle: snapshot.title,
        item
      }));
    }
    const newUserItems = (snapshot.items ?? []).filter((item) => {
      const unseen = item.id && !runtime.seenItems.has(item.id);
      return unseen && item.sourceType !== "collaboration" && item.type === "userMessage" && item.status !== "queued" && item.text;
    });
    for (const item of newUserItems) {
      const pendingIndex = (runtime.pendingFeishuInputs ?? []).findIndex((text) => text === item.text);
      if (pendingIndex >= 0) {
        runtime.pendingFeishuInputs.splice(pendingIndex, 1);
      } else {
        await this.sendText(botId, chatId, `电脑端：${item.text}`, {
          sessionTitle: snapshot.title,
          sessionStatus: snapshot.status
        });
      }
    }
    for (const item of snapshot.items ?? []) {
      if (item.id) runtime.seenItems.add(item.id);
    }
    this.botRuntime.set(botId, runtime);
  }

  async sendText(botId, chatId, text, options = {}) {
    let sessionTitle = optionalText(options.sessionTitle);
    let sessionStatus = optionalText(options.sessionStatus);
    if (!sessionTitle || !sessionStatus) {
      const context = await this.resolveSessionContext(botId);
      sessionTitle ||= context.title;
      sessionStatus ||= context.status;
    }
    const chunks = splitMessage(text, 3500);
    const sentCards = [];
    for (const chunk of chunks) {
      const result = await this.sendCard(botId, chatId, buildMessageCard(chunk, { sessionTitle, sessionStatus }));
      sentCards.push({ text: chunk, result });
    }
    return sentCards;
  }

  async resolveSessionContext(botId) {
    const assignment = this.store.getFeishuAssignmentForBot(botId);
    if (!assignment) return { title: "", status: "" };
    try {
      const snapshot = await this.getSnapshot(assignment.sessionId);
      return {
        title: optionalText(snapshot?.title),
        status: optionalText(snapshot?.status)
      };
    } catch {
      return { title: "", status: "" };
    }
  }

  async sendCard(botId, chatId, card) {
    const bot = this.store.getFeishuBot(botId);
    if (!bot || !this.cliPath) throw new Error("Feishu bot transport is unavailable.");
    const { stdout } = await execFileAsync(this.cliPath, [
      "--profile", bot.profile,
      "api", "POST", "/open-apis/im/v1/messages",
      "--as", "bot",
      "--params", JSON.stringify({ receive_id_type: "chat_id" }),
      "--data", JSON.stringify({
        receive_id: chatId,
        msg_type: "interactive",
        content: JSON.stringify(card)
      })
    ], { maxBuffer: 4 * 1024 * 1024, env: larkCliEnvironment(this.cliPath) });
    const result = JSON.parse(stdout || "{}");
    if (result.code && result.code !== 0) {
      throw new Error(result.msg || `Feishu API error ${result.code}`);
    }
    return result;
  }

  async updateCard(botId, token, card) {
    return this.callApi(botId, "POST", "/open-apis/interactive/v1/card/update", { token, card });
  }

  async updateSentMessageCard(botId, messageId, card) {
    return this.callApi(
      botId,
      "PATCH",
      `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
      { content: JSON.stringify(card) }
    );
  }

  async showTyping(botId, messageId) {
    if (!messageId) return;
    const result = await this.callApi(botId, "POST", `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions`, {
      reaction_type: { emoji_type: "Typing" }
    });
    const runtime = this.botRuntime.get(botId) ?? { lastStatus: null, seenItems: new Set() };
    runtime.typingMessageId = messageId;
    runtime.typingReactionId = result.data?.reaction_id ?? result.data?.reaction?.reaction_id ?? null;
    this.botRuntime.set(botId, runtime);
  }

  async clearTyping(botId) {
    const runtime = this.botRuntime.get(botId);
    if (!runtime?.typingMessageId || !runtime.typingReactionId) return;
    await this.callApi(
      botId,
      "DELETE",
      `/open-apis/im/v1/messages/${encodeURIComponent(runtime.typingMessageId)}/reactions/${encodeURIComponent(runtime.typingReactionId)}`
    );
    runtime.typingMessageId = null;
    runtime.typingReactionId = null;
  }

  async callApi(botId, method, path, data = null) {
    const bot = this.store.getFeishuBot(botId);
    if (!bot || !this.cliPath) throw new Error("Feishu bot transport is unavailable.");
    const args = ["--profile", bot.profile, "api", method, path, "--as", "bot"];
    if (data) args.push("--data", JSON.stringify(data));
    const { stdout } = await execFileAsync(this.cliPath, args, {
      maxBuffer: 4 * 1024 * 1024,
      env: larkCliEnvironment(this.cliPath)
    });
    const result = JSON.parse(stdout || "{}");
    if (result.code && result.code !== 0) {
      throw new Error(result.msg || `Feishu API error ${result.code}`);
    }
    return result;
  }
}

export async function fetchBotIdentity(commandPath, profile, options = {}) {
  const directory = await mkdtemp(join(os.tmpdir(), "corptie-feishu-identity-"));
  const outputName = "bot-info.json";
  const outputPath = join(directory, outputName);
  const execute = options.execFile ?? execFileAsync;
  try {
    await execute(commandPath, [
      "--profile", profile,
      "api", "GET", "/open-apis/bot/v3/info",
      "--as", "bot",
      "--output", `./${outputName}`
    ], {
      cwd: directory,
      maxBuffer: 4 * 1024 * 1024,
      env: options.env
    });
    const result = JSON.parse(await readFile(outputPath, "utf8"));
    if (result.code && result.code !== 0) {
      throw new Error(result.msg || `Feishu API error ${result.code}`);
    }
    return result.bot ?? result.data?.bot ?? null;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function normalizeInboundEvent(raw) {
  const value = raw.event ?? raw;
  const message = value.message ?? value;
  const sender = value.sender ?? {};
  const senderId = value.sender_id ?? sender.sender_id ?? {};
  const openId = typeof senderId === "string" ? senderId : senderId.open_id;
  const chatId = message.chat_id ?? value.chat_id;
  if (!openId || !chatId) {
    return null;
  }
  let content = message.content ?? value.content ?? "";
  try {
    content = JSON.parse(content)?.text ?? content;
  } catch {}
  return {
    eventId: raw.event_id ?? raw.header?.event_id ?? value.event_id ?? null,
    messageId: message.message_id ?? value.message_id ?? null,
    chatId,
    chatType: message.chat_type ?? value.chat_type ?? "",
    messageType: message.message_type ?? value.message_type ?? "",
    openId,
    tenantKey: raw.header?.tenant_key ?? value.tenant_key ?? null,
    text: String(content).trim()
  };
}

function normalizeCardActionEvent(raw) {
  const value = raw.event ?? raw;
  let actionValue = value.action_value ?? value.action?.value ?? {};
  if (typeof actionValue === "string") {
    try {
      actionValue = JSON.parse(actionValue);
    } catch {
      actionValue = {};
    }
  }
  const operator = value.operator ?? {};
  const operatorId = value.operator_id ?? operator.operator_id ?? operator.open_id ?? null;
  return {
    eventId: raw.event_id ?? raw.header?.event_id ?? value.event_id ?? value.token ?? null,
    operatorId: typeof operatorId === "string" ? operatorId : operatorId?.open_id,
    chatId: value.chat_id ?? value.context?.open_chat_id ?? null,
    token: value.token ?? null,
    actionValue: actionValue && typeof actionValue === "object" ? actionValue : {}
  };
}

export function buildSessionListCard({
  botId,
  sessions = [],
  assignments = [],
  current = null,
  page = 0,
  pageSize = sessionCardPageSize,
  notice = null
}) {
  const ownerBySession = new Map(assignments.map((item) => [item.sessionId, item]));
  const pageCount = Math.max(1, Math.ceil(sessions.length / pageSize));
  const safePage = Math.min(nonNegativeInteger(page), pageCount - 1);
  const visibleSessions = sessions.slice(safePage * pageSize, (safePage + 1) * pageSize);
  const elements = [];

  if (notice?.text) {
    const color = notice.type === "error" ? "red" : notice.type === "success" ? "green" : "blue";
    elements.push({
      tag: "markdown",
      content: `<font color='${color}'>${escapeCardMarkdown(notice.text)}</font>`
    });
  }

  if (visibleSessions.length === 0) {
    elements.push({
      tag: "markdown",
      content: "这台电脑上暂时没有可用会话。打开 Corptie 创建会话后，再点击下方刷新按钮。"
    });
  }

  for (const session of visibleSessions) {
    const owner = ownerBySession.get(session.id);
    const isCurrent = current?.sessionId === session.id;
    const isOccupied = Boolean(owner && owner.botId !== botId);
    const cwd = compactPath(session.external?.cwd);
    const state = isCurrent ? "已连接" : isOccupied ? "其他机器人已占用" : displayStatus(session.status);
    const buttonText = isCurrent ? "已连接" : isOccupied ? "不可用" : "连接";
    elements.push({
      tag: "column_set",
      flex_mode: "none",
      background_style: isCurrent ? "blue-50" : "grey-50",
      columns: [
        {
          tag: "column",
          width: "weighted",
          weight: 4,
          padding: "10px 8px 10px 12px",
          vertical_spacing: "4px",
          elements: [
            { tag: "markdown", content: `**${escapeCardMarkdown(session.title || "未命名会话")}**` },
            {
              tag: "markdown",
              content: `<font color='grey'>${escapeCardMarkdown([state, cwd].filter(Boolean).join(" · "))}</font>`,
              text_size: "notation"
            }
          ]
        },
        {
          tag: "column",
          width: "auto",
          padding: "10px 12px 10px 4px",
          vertical_align: "center",
          elements: [{
            tag: "button",
            text: { tag: "plain_text", content: buttonText },
            type: isCurrent ? "primary" : "primary_filled",
            disabled: isCurrent || isOccupied,
            ...((isCurrent || isOccupied) ? {
              disabled_tips: {
                tag: "plain_text",
                content: isOccupied ? "同一个会话只能连接一个飞书机器人" : "当前机器人已连接此会话"
              }
            } : {}),
            behaviors: [{
              type: "callback",
              value: {
                corptie_action: "select_session",
                session_id: session.id,
                page: safePage
              }
            }]
          }]
        }
      ]
    });
  }

  const navigation = [];
  if (safePage > 0) navigation.push(cardActionButton("上一页", "sessions_page", safePage - 1));
  navigation.push(cardActionButton("刷新", "refresh_sessions", safePage));
  if (safePage < pageCount - 1) navigation.push(cardActionButton("下一页", "sessions_page", safePage + 1, true));
  if (current) navigation.push(cardActionButton("释放会话", "detach_session", safePage));
  elements.push(cardButtonRow([cardActionButton("新建会话", "start_create_session", 0, true)]));
  elements.push({
    tag: "column_set",
    flex_mode: "none",
    columns: navigation.map((button) => ({
      tag: "column",
      width: "weighted",
      weight: 1,
      elements: [button]
    }))
  });

  return {
    schema: "2.0",
    config: {
      update_multi: true,
      width_mode: "default",
      summary: { content: "选择 Corptie 会话" }
    },
    header: {
      title: { tag: "plain_text", content: "Corptie 会话" },
      subtitle: {
        tag: "plain_text",
        content: sessions.length ? `选择后直接连接 · ${safePage + 1}/${pageCount}` : "等待本机会话"
      },
      template: current ? "turquoise" : "blue"
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 16px 12px",
      vertical_spacing: "10px",
      elements
    }
  };
}

export function buildWorkspacePickerCard({
  workspaces = [],
  page = 0,
  pageSize = workspaceCardPageSize,
  notice = null
}) {
  const pageCount = Math.max(1, Math.ceil(workspaces.length / pageSize));
  const safePage = Math.min(nonNegativeInteger(page), pageCount - 1);
  const visible = workspaces.slice(safePage * pageSize, (safePage + 1) * pageSize);
  const elements = [];
  if (notice?.text) elements.push(noticeMarkdown(notice));
  if (visible.length === 0) {
    elements.push({
      tag: "markdown",
      content: "还没有可信工作区。请先在电脑端创建一个会话；它使用过的项目目录会自动出现在这里。"
    });
  }
  for (const workspace of visible) {
    elements.push({
      tag: "column_set",
      flex_mode: "none",
      background_style: "grey-50",
      columns: [
        {
          tag: "column",
          width: "weighted",
          weight: 4,
          padding: "10px 8px 10px 12px",
          vertical_spacing: "4px",
          elements: [
            { tag: "markdown", content: `**${escapeCardMarkdown(workspace.name)}**` },
            { tag: "markdown", content: `<font color='grey'>${escapeCardMarkdown(compactPath(workspace.path))}</font>`, text_size: "notation" }
          ]
        },
        {
          tag: "column",
          width: "auto",
          padding: "10px 12px 10px 4px",
          vertical_align: "center",
          elements: [{
            tag: "button",
            text: { tag: "plain_text", content: "选择" },
            type: "primary_filled",
            behaviors: [{
              type: "callback",
              value: { corptie_action: "select_workspace", workspace_id: workspace.id, page: safePage }
            }]
          }]
        }
      ]
    });
  }
  const navigation = [];
  if (safePage > 0) navigation.push(cardActionButton("上一页", "workspaces_page", safePage - 1));
  navigation.push(cardActionButton("刷新", "refresh_workspaces", safePage));
  if (safePage < pageCount - 1) navigation.push(cardActionButton("下一页", "workspaces_page", safePage + 1, true));
  navigation.push(cardActionButton("返回会话", "create_back_sessions", 0));
  elements.push(cardButtonRow(navigation));
  return cardShell({
    title: "选择项目",
    subtitle: workspaces.length ? `可信工作区 · ${safePage + 1}/${pageCount}` : "需要先在电脑端使用项目",
    template: "blue",
    summary: "选择新会话的项目目录",
    elements
  });
}

export function buildAgentPickerCard({ workspace, notice = null }) {
  const elements = [];
  if (notice?.text) elements.push(noticeMarkdown(notice));
  elements.push({
    tag: "markdown",
    content: `项目：**${escapeCardMarkdown(workspace.name)}**\n<font color='grey'>${escapeCardMarkdown(compactPath(workspace.path))}</font>`
  });
  elements.push(cardButtonRow([
    gatewayActionButton("Codex", "select_create_agent", {
      workspace_id: workspace.id,
      agent: "codex"
    }, true),
    gatewayActionButton("Claude Code", "select_create_agent", {
      workspace_id: workspace.id,
      agent: "claude"
    })
  ]));
  elements.push(cardButtonRow([
    gatewayActionButton("返回项目", "create_back_workspaces"),
    gatewayActionButton("取消", "create_cancel")
  ]));
  return cardShell({
    title: "选择 Agent",
    subtitle: workspace.name,
    template: "indigo",
    summary: "选择新会话使用的 Agent",
    elements
  });
}

export function buildCreateConfirmationCard({ workspace, agent, replacesCurrentSession = false, notice = null }) {
  const label = agent === "claude" ? "Claude Code" : "Codex";
  const elements = [];
  if (notice?.text) elements.push(noticeMarkdown(notice));
  elements.push({
    tag: "markdown",
    content: [
      `**项目**：${escapeCardMarkdown(workspace.name)}`,
      `**Agent**：${label}`,
      `<font color='grey'>${escapeCardMarkdown(compactPath(workspace.path))}</font>`,
      replacesCurrentSession ? "\n<font color='orange'>创建后，机器人将从当前会话切换到新会话。</font>" : ""
    ].filter(Boolean).join("\n")
  });
  elements.push(cardButtonRow([
    gatewayActionButton("创建并连接", "confirm_create_session", {
      workspace_id: workspace.id,
      agent
    }, true),
    gatewayActionButton("返回", "select_workspace", { workspace_id: workspace.id }),
    gatewayActionButton("取消", "create_cancel")
  ]));
  return cardShell({
    title: "确认创建会话",
    subtitle: `${workspace.name} · ${label}`,
    template: "turquoise",
    summary: "确认创建并连接 Corptie 会话",
    elements
  });
}

function cardShell({ title, subtitle, template, summary, elements }) {
  return {
    schema: "2.0",
    config: { update_multi: true, width_mode: "default", summary: { content: summary } },
    header: {
      title: { tag: "plain_text", content: title },
      subtitle: { tag: "plain_text", content: subtitle },
      template
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 16px 12px",
      vertical_spacing: "10px",
      elements
    }
  };
}

function cardButtonRow(buttons) {
  return {
    tag: "column_set",
    flex_mode: "none",
    columns: buttons.map((button) => ({ tag: "column", width: "weighted", weight: 1, elements: [button] }))
  };
}

function gatewayActionButton(label, action, extra = {}, primary = false) {
  return {
    tag: "button",
    text: { tag: "plain_text", content: label },
    type: primary ? "primary_filled" : "default",
    width: "fill",
    behaviors: [{ type: "callback", value: { corptie_action: action, ...extra } }]
  };
}

function noticeMarkdown(notice) {
  const color = notice.type === "error" ? "red" : notice.type === "success" ? "green" : "blue";
  return { tag: "markdown", content: `<font color='${color}'>${escapeCardMarkdown(notice.text)}</font>` };
}

export function buildApprovalCard({ sessionId, sessionTitle = "", item }) {
  const options = Array.isArray(item?.options) ? item.options.slice(0, 5) : [];
  const body = optionalText(item?.text) || "Codex 请求执行一项需要授权的操作。";
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      width_mode: "default",
      summary: { content: "Codex 正在等待权限审批" }
    },
    header: {
      title: {
        tag: "plain_text",
        content: optionalText(sessionTitle) || "Corptie · 需要权限审批"
      },
      ...(optionalText(sessionTitle) ? {
        subtitle: { tag: "plain_text", content: "Corptie · 需要权限审批" }
      } : {}),
      template: "orange"
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 16px 12px",
      elements: [
        { tag: "markdown", content: body },
        cardButtonRow(options.map((option) => ({
          tag: "button",
          text: {
            tag: "plain_text",
            content: optionalText(option.label)
              || (String(option.role ?? "").toLowerCase().includes("deny") ? "拒绝" : "允许")
          },
          type: String(option.role ?? "").toLowerCase().includes("deny") ? "default" : "primary_filled",
          width: "fill",
          behaviors: [{
            type: "callback",
            value: {
              corptie_action: "respond_approval",
              session_id: sessionId,
              choice_id: item.id,
              item_type: item.type,
              option_id: option.id,
              option_index: option.index ?? 0,
              option_role: option.role ?? ""
            }
          }]
        })))
      ]
    }
  };
}

function buildApprovalResultCard(message, approved) {
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      width_mode: "default",
      summary: { content: message }
    },
    header: {
      title: { tag: "plain_text", content: approved ? "Corptie · 已允许" : "Corptie · 审批结果" },
      template: approved ? "green" : "grey"
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 16px 12px",
      elements: [{ tag: "markdown", content: message }]
    }
  };
}

export function formatUsageText(usage = {}) {
  if (usage.available === false) {
    return optionalText(usage.message) || "当前模型暂时没有可查询的用量余额。";
  }

  const buckets = Object.entries(usage.rateLimitsByLimitId ?? {})
    .filter(([, snapshot]) => snapshot && typeof snapshot === "object");
  if (buckets.length === 0 && usage.rateLimits) {
    buckets.push([usage.rateLimits.limitId || "codex", usage.rateLimits]);
  }
  if (buckets.length === 0) {
    return "Codex 暂未返回可用的额度信息。";
  }

  const lines = ["**模型用量余额**"];
  if (optionalText(usage.model)) {
    lines.push(`当前模型：${usage.model}`);
  }
  const planType = buckets.map(([, snapshot]) => snapshot.planType).find(Boolean);
  if (planType) {
    lines.push(`账户计划：${displayPlanType(planType)}`);
  }

  for (const [limitId, snapshot] of buckets) {
    const name = optionalText(snapshot.limitName) || displayLimitId(snapshot.limitId || limitId);
    lines.push("", `**${name}**`);
    const windows = [snapshot.primary, snapshot.secondary].filter(Boolean);
    for (const window of windows) {
      const used = clampPercentage(window.usedPercent);
      const remaining = clampPercentage(100 - used);
      const reset = formatResetTime(window.resetsAt);
      lines.push(`- ${formatWindowDuration(window.windowDurationMins)}：剩余 **${formatPercentage(remaining)}%**（已用 ${formatPercentage(used)}%）${reset ? ` · ${reset} 重置` : ""}`);
    }
    if (snapshot.credits?.unlimited) {
      lines.push("- Credits：无限");
    } else if (snapshot.credits?.balance != null) {
      lines.push(`- Credits 余额：${snapshot.credits.balance}`);
    }
    if (windows.length === 0 && !snapshot.credits?.unlimited && snapshot.credits?.balance == null) {
      lines.push("- 暂无可显示的额度窗口");
    }
  }
  return lines.join("\n");
}

function displayLimitId(value) {
  const text = optionalText(value);
  if (!text || text === "codex") return "Codex";
  return text.split("_").filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function displayPlanType(value) {
  return ({
    free: "Free",
    go: "Go",
    plus: "Plus",
    pro: "Pro",
    prolite: "Pro Lite",
    team: "Team",
    business: "Business",
    enterprise: "Enterprise",
    edu: "Education"
  })[value] ?? String(value);
}

function formatWindowDuration(value) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) return "额度窗口";
  if (minutes % 10080 === 0) return `${minutes / 10080} 周`;
  if (minutes % 1440 === 0) return `${minutes / 1440} 天`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时`;
  return `${minutes} 分钟`;
}

function formatResetTime(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(seconds * 1000));
}

function clampPercentage(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(100, Math.max(0, number)) : 0;
}

function formatPercentage(value) {
  return Number(value.toFixed(1)).toString();
}

export function buildMessageCard(text, { sessionTitle = "", sessionStatus = "" } = {}) {
  const content = String(text ?? "").trim() || " ";
  const tone = optionalText(sessionStatus)
    ? sessionStatusTone(sessionStatus)
    : messageTone(content);
  const title = optionalText(sessionTitle);
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      width_mode: "default",
      summary: { content: plainTextSummary(content) }
    },
    header: {
      title: { tag: "plain_text", content: title || tone.title },
      ...(title ? { subtitle: { tag: "plain_text", content: tone.title } } : {}),
      template: tone.template
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 16px 12px",
      elements: [{ tag: "markdown", content }]
    }
  };
}

function sessionStatusTone(status) {
  const normalized = optionalText(status).toLowerCase();
  const title = `Corptie · ${displayStatus(status)}`;
  if (/failed|error/.test(normalized)) return { title, template: "red" };
  if (/completed|complete|succeeded|success/.test(normalized)) return { title, template: "green" };
  if (/waiting|approval|input/.test(normalized)) return { title, template: "orange" };
  if (/running|processing|working|connecting/.test(normalized)) return { title, template: "blue" };
  return { title, template: "grey" };
}

function messageTone(content) {
  if (/失败|错误|无效|过期|不可用|error|failed/i.test(content)) {
    return { title: "Corptie · 操作未完成", template: "red" };
  }
  if (/已完成|完成$|成功|已连接/.test(content)) {
    return { title: "Corptie · 已完成", template: "green" };
  }
  if (/正在|处理中|已排队|等待/.test(content)) {
    return { title: "Corptie · 进行中", template: "blue" };
  }
  return { title: "Corptie", template: "indigo" };
}

function plainTextSummary(content) {
  const text = content
    .replace(/```[\s\S]*?```/g, "代码片段")
    .replace(/[*_`#>\[\]()|~-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, 120) || "Corptie 消息";
}

function cardActionButton(label, action, page, primary = false) {
  return {
    tag: "button",
    text: { tag: "plain_text", content: label },
    type: primary ? "primary_filled" : "default",
    width: "fill",
    behaviors: [{
      type: "callback",
      value: { corptie_action: action, page }
    }]
  };
}

function compactPath(path) {
  const value = optionalText(path);
  if (!value) return "";
  const home = os.homedir();
  const compact = value === home ? "~" : value.startsWith(`${home}/`) ? `~/${value.slice(home.length + 1)}` : value;
  return compact.length > 52 ? `…${compact.slice(-51)}` : compact;
}

function workspaceIdForPath(path) {
  return `ws_${createHash("sha256").update(String(path)).digest("hex").slice(0, 20)}`;
}

function normalizeGatewayAgent(value) {
  return value === "claude" ? "claude" : "codex";
}

function escapeCardMarkdown(value) {
  return String(value ?? "").replace(/([\\`*_{}\[\]()<>#+.!|~-])/g, "\\$1");
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 0;
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

function feishuSource(botId, event) {
  return {
    type: "feishu",
    botId,
    senderId: event.openId,
    messageId: event.messageId,
    chatId: event.chatId
  };
}

function pairingHash(code) {
  return createHash("sha256").update(`corptie-feishu:${code}`).digest("hex");
}

function displayStatus(status) {
  return ({
    idle: "空闲",
    running: "正在处理",
    queued: "已排队",
    processing: "正在处理",
    blocked: "等待用户",
    waiting_for_approval: "等待审批",
    waiting_for_input: "等待输入",
    complete: "已完成",
    completed: "已完成",
    cancelled: "已停止",
    interrupted: "已停止",
    failed: "失败"
  })[status] ?? status ?? "未知";
}

function isProcessingStatus(status) {
  return ["running", "queued", "processing"].includes(status);
}

function isPendingApprovalItem(item) {
  return ["approval", "choice"].includes(item?.type)
    && item.status !== "selected"
    && Array.isArray(item.options)
    && item.options.length > 0;
}

function requiredText(value, message) {
  const text = optionalText(value);
  if (!text) throw new Error(message);
  return text;
}

function optionalText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function splitMessage(text, limit) {
  const input = String(text ?? "");
  if (input.length <= limit) return [input];
  const chunks = [];
  for (let index = 0; index < input.length; index += limit) {
    chunks.push(input.slice(index, index + limit));
  }
  return chunks;
}

async function resolveLarkCli() {
  const resolved = resolveExternalCommand("lark-cli", {
    environmentVariables: ["CORPTIE_LARK_CLI"]
  });
  return resolved === "lark-cli" ? null : resolved;
}

async function resolveIdentityLarkCli(primaryPath) {
  return primaryPath;
}

function runWithInput(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: larkCliEnvironment(command) });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(stderr.trim() || stdout.trim() || `lark-cli exited (${signal || code || "unknown"}).`));
    });
    child.stdin.end(input);
  });
}

function larkCliEnvironment(commandPath) {
  const env = { ...environmentForCommand(commandPath), LARK_CLI_NO_PROXY: "1" };
  for (const key of [
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
    "http_proxy", "https_proxy", "all_proxy", "no_proxy"
  ]) {
    delete env[key];
  }
  return env;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
