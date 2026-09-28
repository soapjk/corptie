import { createHash, randomInt, randomUUID } from "node:crypto";
import {
  buildSessionListCard,
  buildWorkspacePickerCard,
  buildAgentPickerCard,
  buildCreateConfirmationCard,
  buildApprovalCard,
  buildCollaborationConfirmationCard,
  buildCollaborationMessageCard,
  formatUsageText,
  buildMessageCard,
  buildCollaborationConfirmationResultCard,
  buildSessionItemCard,
  buildApprovalResultCard,
  sessionCardPageSize,
  workspaceCardPageSize,
  nonNegativeInteger,
  displayStatus
} from "./feishuPresentation.mjs";
export { buildSessionListCard, buildWorkspacePickerCard, buildAgentPickerCard, buildCreateConfirmationCard, buildApprovalCard, buildCollaborationConfirmationCard, buildCollaborationMessageCard, formatUsageText, buildMessageCard } from "./feishuPresentation.mjs";
import { FeishuEventConsumers } from "./feishuEventConsumers.mjs";
import { FeishuInboundInbox } from "./feishuInboundInbox.mjs";
import { FeishuSyncScheduler } from "./feishuSyncScheduler.mjs";
import {
  isTerminalSessionStatus,
  shouldSeedFeishuSeenItem,
  findLatestFormalAgentReply,
  feishuProjectionForSessionItem,
  pendingRequestForFinalItem,
  collaborationConfirmationStatus
} from "./feishuDeliveryPolicy.mjs";
import {
  execFileAsync, resolveLarkCli, resolveIdentityLarkCli, runWithInput,
  larkCliEnvironment, fetchBotIdentity, formatFeishuFailureForLog
} from "./feishuCliRuntime.mjs";
export { fetchBotIdentity, formatFeishuFailureForLog } from "./feishuCliRuntime.mjs";
import { isClearCommand } from "../commands/unifiedCommands.mjs";

const pairingCodePattern = /^\d{6}$/;
const completedTaskStatuses = new Set(["done", "complete", "completed"]);

export class FeishuGatewayManager {
  constructor(options) {
    this.store = options.store;
    this.listSessions = options.listSessions;
    this.describeSession = options.describeSession ?? (() => ({}));
    this.listWorkspaces = options.listWorkspaces ?? (() => []);
    this.createSession = options.createSession;
    this.getSnapshot = options.getSnapshot;
    this.getUsage = options.getUsage;
    this.sendMessage = options.sendMessage;
    this.interruptSession = options.interruptSession;
    this.respondToApproval = options.respondToApproval;
    this.respondToCollaborationConfirmation = options.respondToCollaborationConfirmation;
    this.cliPath = options.cliPath || process.env.CORPTIE_LARK_CLI || null;
    this.identityCliPath = null;
    this.consumers = new FeishuEventConsumers({
      store: this.store,
      readCliPath: () => this.cliPath,
      readIdentityCliPath: () => this.identityCliPath,
      environment: larkCliEnvironment,
      handleLine: (botId, line) => this.handleLine(botId, line),
      handleCardLine: (botId, line) => this.handleCardLine(botId, line)
    });
    this.inbox = new FeishuInboundInbox(this.store);
    this.botRuntime = new Map();
    this.syncScheduler = new FeishuSyncScheduler({
      store: this.store,
      syncBotOnce: (botId) => this.syncBotOnce(botId),
      requestSync: (botId) => this.syncBot(botId)
    });
  }

  async initialize() {
    this.cliPath = this.cliPath || await resolveLarkCli();
    this.identityCliPath = await resolveIdentityLarkCli(this.cliPath);
    await this.reconcile();
    this.syncScheduler.start();
  }

  async close() {
    const botIds = new Set([...this.consumers.processes.keys(), ...this.consumers.cardProcesses.keys()]);
    await Promise.all(Array.from(botIds).map((botId) => this.stopBot(botId, { stopDaemon: true })));
    this.syncScheduler.close();
  }

  status() {
    return {
      cliPath: this.cliPath,
      cliAvailable: Boolean(this.cliPath),
      runningBotIds: Array.from(this.consumers.processes.keys()),
      cardActionBotIds: Array.from(this.consumers.cardProcesses.keys())
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
      runtime: this.consumers.processes.has(bot.id) ? "running" : "stopped",
      cardActions: {
        status: this.consumers.cardProcesses.has(bot.id)
          ? "running"
          : this.consumers.cardActionErrors.has(bot.id) ? "setup_required" : "stopped",
        error: this.consumers.cardActionErrors.get(bot.id) ?? null
      }
    }));
  }

  async createBot(input = {}) {
    if (!this.cliPath) {
      throw new Error("lark-cli was not found. Install it before adding a Feishu bot.");
    }
    const existingProfile = optionalText(input.profile);
    if (existingProfile) {
      let profiles;
      try {
        profiles = await this.listProfiles();
      } catch (error) {
        error.feishuStage = "profile_lookup";
        throw error;
      }
      const profile = profiles.find((item) => item.name === existingProfile);
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
    let profiles;
    try {
      profiles = await this.listProfiles();
    } catch (error) {
      error.feishuStage = "profile_lookup";
      throw error;
    }
    const matchingProfile = profiles.find((item) => item.appId === appId);
    if (matchingProfile) {
      const error = new Error(
        `该 App ID 已存在于 lark-cli 配置“${matchingProfile.name}”。请切换到“现有 CLI 配置”并选择该配置，无需重新输入应用凭证。`
      );
      error.feishuStage = "profile_conflict";
      throw error;
    }
    const id = randomUUID();
    const profile = `corptie-${id}`;
    try {
      await runWithInput(this.cliPath, [
        "profile", "add",
        "--name", profile,
        "--app-id", appId,
        "--brand", brand,
        "--app-secret-stdin"
      ], `${appSecret}\n`);
    } catch (error) {
      error.feishuStage = "profile_create";
      throw error;
    }
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

  async assignSession(botId, bindingId, sessionId, options = {}) {
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
    const latestFormalAgentReply = options.replayLatestFormalAgentReply === false
      ? null
      : findLatestFormalAgentReply(snapshot.items);
    const seedIds = (snapshot.items ?? [])
      .filter((item) => item.id !== latestFormalAgentReply?.id && shouldSeedFeishuSeenItem(item))
      .map((item) => item.id)
      .filter(Boolean);
    this.botRuntime.set(botId, {
      lastStatus: snapshot.status,
      seenItems: this.store.initializeFeishuDelivery?.(assignment.id, seedIds) ?? new Set(seedIds)
    });
    await this.syncBot(botId).catch((error) => {
      console.error(`[feishu] bot=${botId} initial session sync failed: ${error.message}`);
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
    return this.consumers.startBot(bot);
  }

  stopBot(botId, options = {}) {
    return this.consumers.stopBot(botId, options);
  }

  async handleLine(botId, line) {
    const event = this.inbox.acceptMessage(botId, line);
    if (!event) return;

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
      await this.clearPendingRequest(botId, event.messageId).catch(() => {});
      await this.sendText(botId, event.chatId, `操作失败：${error.message}`);
      throw error;
    }
  }

  async handleCardLine(botId, line) {
    const event = this.inbox.acceptCardAction(botId, line);
    if (!event) return;

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
        await this.assignSession(botId, binding.id, session.id, { replayLatestFormalAgentReply: false });
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
    } else if (action === "respond_collaboration_confirmation") {
      const sessionId = optionalText(event.actionValue?.session_id);
      const confirmationId = optionalText(event.actionValue?.confirmation_id);
      const assignment = this.store.getFeishuAssignmentForBot(botId);
      if (!assignment || assignment.sessionId !== sessionId) {
        card = buildCollaborationConfirmationResultCard("这个协作确认所属的会话已不再连接，未执行操作。", false);
      } else if (!this.respondToCollaborationConfirmation) {
        card = buildCollaborationConfirmationResultCard("当前版本无法处理协作确认，请在电脑端操作。", false);
      } else {
        const approved = optionalText(event.actionValue?.decision) === "confirm";
        try {
          await this.respondToCollaborationConfirmation(
            confirmationId,
            approved,
            feishuSource(botId, event)
          );
          const snapshot = await this.getSnapshot(sessionId);
          const item = (snapshot.items ?? []).find((candidate) =>
            candidate.collaborationConfirmationId === confirmationId
          );
          card = item
            ? buildCollaborationConfirmationCard({ sessionId, sessionTitle: snapshot.title, item })
            : buildCollaborationConfirmationResultCard(
                approved ? "协作任务已确认发送。" : "协作任务已取消。",
                approved
              );
        } catch (error) {
          card = buildCollaborationConfirmationResultCard(`协作确认失败：${error.message}`, false);
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
        await this.assignSession(botId, binding.id, sendResult.sessionId, { replayLatestFormalAgentReply: false });
      }
      await this.sendText(botId, event.chatId, "已清空上下文，可以开始新的对话。");
      return;
    }
    const messageId = optionalText(event.messageId);
    if (!messageId) {
      const error = new Error("Feishu message ID is required before forwarding a message.");
      error.code = "FEISHU_MESSAGE_ID_REQUIRED";
      throw error;
    }
    const runtime = this.botRuntime.get(botId) ?? { lastStatus: null, seenItems: new Set() };
    const request = {
      messageId,
      chatId: event.chatId,
      sessionId: assignment.sessionId,
      text,
      typingReactionId: null,
      finalDelivered: false
    };
    runtime.pendingFeishuRequests = [...(runtime.pendingFeishuRequests ?? []), request];
    this.botRuntime.set(botId, runtime);
    request.typingPromise = this.addReaction(botId, messageId, "Typing").then((reactionId) => {
      request.typingReactionId = reactionId;
      return reactionId;
    }).catch((error) => {
      console.log(`[feishu] bot=${botId} typing reaction unavailable: ${error.message}`);
      return null;
    });
    try {
      await this.sendMessage(assignment.sessionId, text, feishuSource(botId, event));
    } catch (error) {
      await this.clearPendingRequest(botId, messageId).catch(() => {});
      throw error;
    }
  }

  async sessionListText(botId) {
    const sessions = await this.presentedSessions();
    const current = this.store.getFeishuAssignmentForBot(botId);
    const assignments = new Map(this.store.listFeishuAssignments().map((item) => [item.sessionId, item]));
    if (sessions.length === 0) {
      return "这台电脑上暂时没有可用会话。";
    }
    const lines = sessions.map((session, index) => {
      const owner = assignments.get(session.id);
      const marker = current?.sessionId === session.id ? "●" : owner ? "×" : "○";
      const occupied = owner && owner.botId !== botId ? " · 已被其他机器人占用" : "";
      const agent = ` · Agent：${session.agentName || "未绑定"}`;
      const task = session.taskTitle ? ` · Task：${session.taskTitle}` : "";
      return `${index + 1}. ${marker} ${session.title} · ${displayStatus(session.status)}${agent}${task}${occupied}`;
    });
    return `会话列表：\n${lines.join("\n")}\n\n发送 /use 序号 切换，例如 /use 2`;
  }

  async buildSessionListCard(botId, page = 0, notice = null) {
    const sessions = await this.presentedSessions();
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

  async presentedSessions() {
    const sessions = await this.listSessions({ archived: false });
    const presented = await Promise.all(sessions.filter((session) => session.archived !== true).map(async (session) => ({
      ...session,
      ...(await this.describeSession(session) ?? {})
    })));
    return presented.filter((session) => !isCompletedWorkSession(session));
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
    this.syncScheduler.handleSessionEvent(event);
  }

  syncBot(botId) {
    return this.syncScheduler.syncBot(botId);
  }

  async syncBotOnce(botId) {
    const assignment = this.store.getFeishuAssignmentForBot(botId);
    const bindings = this.store.listFeishuBindings(botId);
    const binding = bindings.find((item) => item.id === assignment?.bindingId) ?? bindings[0];
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
      const seedIds = (snapshot.items ?? [])
        .filter(shouldSeedFeishuSeenItem)
        .map((item) => item.id)
        .filter(Boolean);
      // The first migration/bootstrap intentionally does not replay history.
      // Later restarts restore actual delivery receipts so replies missed while
      // the gateway was offline remain eligible for delivery.
      runtime.seenItems = this.store.initializeFeishuDelivery?.(assignment.id, seedIds) ?? new Set(seedIds);
      runtime.collaborationConfirmationCards = [];
      this.botRuntime.set(botId, runtime);
      await this.sendText(botId, chatId, `当前会话：${snapshot.title}\n状态：${displayStatus(snapshot.status)}`, {
        sessionTitle: snapshot.title,
        sessionStatus: snapshot.status
      });
    }
    if (snapshot.status !== runtime.lastStatus) {
      runtime.lastStatus = snapshot.status;
    }
    runtime.collaborationConfirmationCards ??= [];
    for (const sent of runtime.collaborationConfirmationCards) {
      const item = (snapshot.items ?? []).find((candidate) => candidate.id === sent.itemId);
      const status = collaborationConfirmationStatus(item);
      if (!item || !status || status === sent.status) continue;
      await this.updateSentMessageCard(botId, sent.messageId, buildCollaborationConfirmationCard({
        sessionId: assignment.sessionId,
        sessionTitle: snapshot.title,
        item
      }));
      sent.status = status;
    }

    const unseenItems = (snapshot.items ?? []).filter((item) => item.id && !runtime.seenItems.has(item.id));
    for (const item of unseenItems) {
      const projection = feishuProjectionForSessionItem(item);
      // Provider projections create the stable assistant item when generation
      // starts and fill its text when the item completes. Do not consume that
      // stable id while it is still an empty placeholder, otherwise the
      // completed reply will be skipped forever as already seen.
      if (projection === "deferred") {
        continue;
      }
      if (projection === "hidden") {
        runtime.seenItems.add(item.id);
        continue;
      }

      if (projection === "collaboration_confirmation") {
        const result = await this.sendCard(botId, chatId, buildCollaborationConfirmationCard({
          sessionId: assignment.sessionId,
          sessionTitle: snapshot.title,
          item
        }));
        const messageId = sentMessageId(result);
        if (messageId) {
          runtime.collaborationConfirmationCards.push({
            itemId: item.id,
            messageId,
            status: collaborationConfirmationStatus(item)
          });
        }
      } else if (projection === "approval") {
        await this.sendCard(botId, chatId, buildApprovalCard({
          sessionId: assignment.sessionId,
          sessionTitle: snapshot.title,
          item
        }));
      } else if (projection === "collaboration") {
        await this.sendCard(botId, chatId, buildCollaborationMessageCard({
          sessionTitle: snapshot.title,
          item
        }));
      } else if (projection === "user") {
        const pendingIndex = (runtime.pendingFeishuRequests ?? []).findIndex((request) => request.messageId === item.id);
        if (pendingIndex >= 0) {
          runtime.pendingFeishuRequests[pendingIndex].userItemSeen = true;
        } else {
          await this.sendText(botId, chatId, `电脑端：${item.text}`, {
            sessionTitle: snapshot.title,
            sessionStatus: snapshot.status
          });
        }
      } else if (projection === "assistant") {
        const request = pendingRequestForFinalItem(runtime, snapshot.items, item);
        const sentCards = request
          ? [await this.sendFinalReply(botId, request.messageId, item.text, {
              sessionTitle: snapshot.title,
              sessionStatus: snapshot.status
            })]
          : await this.sendText(botId, chatId, item.text, {
              sessionTitle: snapshot.title,
              sessionStatus: snapshot.status
            });
        runtime.lastAssistantCards = (sentCards ?? [])
          .map((sent) => ({
            itemId: item.id,
            messageId: sentMessageId(sent.result),
            text: sent.text,
            sessionTitle: snapshot.title,
            sessionStatus: snapshot.status
          }))
          .filter((card) => card.messageId);
        if (request) {
          request.finalDelivered = true;
          request.finalItemId = item.id;
          await this.clearPendingRequest(botId, request.messageId).catch((error) => {
            console.log(`[feishu] bot=${botId} final typing reaction cleanup failed: ${error.message}`);
          });
        }
      } else {
        await this.sendCard(botId, chatId, buildSessionItemCard(item, {
          sessionTitle: snapshot.title,
          sessionStatus: snapshot.status
        }));
      }
      // Persist only after the remote call succeeds. A restart must not turn
      // an unsent item into an in-memory-only "seen" item.
      if (projection !== "hidden") this.store.markFeishuItemDelivered?.(assignment.id, item.id);
      runtime.seenItems.add(item.id);
    }
    for (const request of [...(runtime.pendingFeishuRequests ?? [])].filter((item) => item.finalDelivered)) {
      await this.clearPendingRequest(botId, request.messageId).catch((error) => {
        console.log(`[feishu] bot=${botId} final typing reaction cleanup retry failed: ${error.message}`);
      });
    }
    if (isTerminalSessionStatus(snapshot.status)) {
      for (const request of [...(runtime.pendingFeishuRequests ?? [])].filter((item) => !item.finalDelivered)) {
        await this.clearPendingRequest(botId, request.messageId).catch((error) => {
          console.log(`[feishu] bot=${botId} unfinished reaction cleanup failed: ${error.message}`);
        });
      }
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

  async sendFinalReply(botId, sourceMessageId, text, options = {}) {
    let sessionTitle = optionalText(options.sessionTitle);
    let sessionStatus = optionalText(options.sessionStatus);
    if (!sessionTitle || !sessionStatus) {
      const context = await this.resolveSessionContext(botId);
      sessionTitle ||= context.title;
      sessionStatus ||= context.status;
    }
    const result = await this.callApi(
      botId,
      "POST",
      `/open-apis/im/v1/messages/${encodeURIComponent(sourceMessageId)}/reply`,
      {
        msg_type: "interactive",
        content: JSON.stringify(buildMessageCard(text, { sessionTitle, sessionStatus }))
      }
    );
    return { text, result };
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

  async deleteSentMessage(botId, messageId) {
    return this.callApi(
      botId,
      "DELETE",
      `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`
    );
  }

  async addReaction(botId, messageId, emojiType) {
    const result = await this.callApi(botId, "POST", `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions`, {
      reaction_type: { emoji_type: emojiType }
    });
    return result.data?.reaction_id ?? result.data?.reaction?.reaction_id ?? null;
  }

  async clearPendingRequest(botId, messageId) {
    const runtime = this.botRuntime.get(botId);
    const request = runtime?.pendingFeishuRequests?.find((item) => item.messageId === messageId);
    if (!request) return;
    await request.typingPromise;
    if (request.typingReactionId) {
      await this.callApi(
        botId,
        "DELETE",
        `/open-apis/im/v1/messages/${encodeURIComponent(request.messageId)}/reactions/${encodeURIComponent(request.typingReactionId)}`
      );
    }
    this.removePendingRequest(botId, messageId);
  }

  removePendingRequest(botId, messageId) {
    const runtime = this.botRuntime.get(botId);
    if (!runtime?.pendingFeishuRequests) return;
    runtime.pendingFeishuRequests = runtime.pendingFeishuRequests.filter((item) => item.messageId !== messageId);
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




function workspaceIdForPath(path) {
  return `ws_${createHash("sha256").update(String(path)).digest("hex").slice(0, 20)}`;
}

function normalizeGatewayAgent(value) {
  return value === "claude" ? "claude" : "codex";
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

function isCompletedWorkSession(session) {
  const isWorker = session?.sessionKind === "worker" || Boolean(optionalText(session?.taskId));
  return isWorker && completedTaskStatuses.has(optionalText(session?.taskStatus).toLowerCase());
}



function sentMessageId(result) {
  return result?.data?.message_id ?? result?.data?.message?.message_id ?? null;
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
