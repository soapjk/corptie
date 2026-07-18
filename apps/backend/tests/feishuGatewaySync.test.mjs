import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  FeishuGatewayManager,
  fetchBotIdentity,
  formatUsageText
} from "../src/feishu/feishuGatewayManager.mjs";

test("bot identity reads the raw API response instead of lark-cli's normalized output", async () => {
  const calls = [];
  const identity = await fetchBotIdentity("/usr/local/bin/lark-cli", "bot-profile", {
    async execFile(command, args, options) {
      calls.push({ command, args, cwd: options.cwd });
      const outputArgument = args[args.indexOf("--output") + 1];
      await writeFile(join(options.cwd, outputArgument), JSON.stringify({
        code: 0,
        msg: "ok",
        bot: {
          app_name: "Corptie Bot",
          avatar_url: "https://example.com/avatar.png",
          open_id: "ou_bot",
          activate_status: 2
        }
      }));
      return {
        stdout: JSON.stringify({ ok: true, identity: "bot", data: {} }),
        stderr: ""
      };
    }
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(-2), ["--output", "./bot-info.json"]);
  assert.equal(identity.app_name, "Corptie Bot");
  assert.equal(identity.avatar_url, "https://example.com/avatar.png");
});

test("usage text shows remaining percentages for every Codex limit bucket", () => {
  const text = formatUsageText({
    available: true,
    model: "gpt-5.4",
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex",
        planType: "pro",
        primary: { usedPercent: 14, windowDurationMins: 300, resetsAt: null },
        secondary: { usedPercent: 10.5, windowDurationMins: 10080, resetsAt: null }
      },
      codex_spark: {
        limitId: "codex_spark",
        limitName: "Codex Spark",
        primary: { usedPercent: 2, windowDurationMins: 300, resetsAt: null },
        secondary: null
      }
    }
  });

  assert.match(text, /当前模型：gpt-5\.4/);
  assert.match(text, /账户计划：Pro/);
  assert.match(text, /5 小时：剩余 \*\*86%\*\*/);
  assert.match(text, /1 周：剩余 \*\*89\.5%\*\*/);
  assert.match(text, /Codex Spark/);
});

test("the /usage command queries the assigned session without sending a model prompt", async () => {
  const sent = [];
  const requestedSessions = [];
  const manager = new FeishuGatewayManager({
    store: {
      getFeishuAssignmentForBot() {
        return { botId: "bot-a", sessionId: "codex:thread-a" };
      }
    },
    async getUsage(sessionId) {
      requestedSessions.push(sessionId);
      return {
        available: true,
        rateLimits: {
          limitId: "codex",
          primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: null },
          secondary: null
        }
      };
    },
    async sendMessage() {
      assert.fail("/usage must not be forwarded to the model");
    }
  });
  manager.sendText = async (_botId, _chatId, text) => sent.push(text);

  await manager.handleCommand("bot-a", {}, { text: "/usage", chatId: "chat-a" });

  assert.deepEqual(requestedSessions, ["codex:thread-a"]);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /剩余 \*\*75%\*\*/);
});

test("the /clear command replaces and rebinds an app-server session", async () => {
  const sent = [];
  const assignments = [];
  const manager = new FeishuGatewayManager({
    store: {
      getFeishuAssignmentForBot() {
        return { botId: "bot-a", sessionId: "codex:thread-old" };
      }
    },
    async sendMessage(sessionId, text) {
      assert.equal(sessionId, "codex:thread-old");
      assert.equal(text, "/clear");
      return { cleared: true, sessionId: "codex:thread-new" };
    }
  });
  manager.assignSession = async (botId, bindingId, sessionId) => {
    assignments.push({ botId, bindingId, sessionId });
  };
  manager.sendText = async (_botId, _chatId, text) => sent.push(text);

  await manager.handleCommand("bot-a", { id: "binding-a" }, { text: "/clear", chatId: "chat-a" });

  assert.deepEqual(assignments, [{ botId: "bot-a", bindingId: "binding-a", sessionId: "codex:thread-new" }]);
  assert.deepEqual(sent, ["已清空上下文，可以开始新的对话。"]);
});

test("pending approvals are delivered exactly once, including on the first sync", async () => {
  const cards = [];
  const manager = new FeishuGatewayManager({
    store: {
      getFeishuAssignmentForBot() {
        return { botId: "bot-a", sessionId: "codex:thread-a" };
      },
      listFeishuBindings() {
        return [{ chatId: "chat-a" }];
      }
    },
    async getSnapshot() {
      return {
        title: "Session A",
        status: "blocked",
        items: [{
          id: "approval-a",
          type: "approval",
          text: "Codex wants approval",
          status: "pending",
          options: [
            { id: "approved", label: "Approve", role: "approve", index: 0 },
            { id: "denied", label: "Deny", role: "deny", index: 1 }
          ]
        }]
      };
    }
  });
  manager.sendText = async () => {};
  manager.sendCard = async (_botId, _chatId, card) => cards.push(card);

  await manager.syncBot("bot-a");
  await manager.syncBot("bot-a");

  assert.equal(cards.length, 1);
  assert.equal(cards[0].header.title.content, "Session A");
  assert.equal(cards[0].header.subtitle.content, "Corptie · 需要权限审批");
});

test("pending collaboration confirmations are delivered exactly once on the first sync", async () => {
  const cards = [];
  const manager = new FeishuGatewayManager({
    store: {
      getFeishuAssignmentForBot() {
        return { botId: "bot-a", sessionId: "codex:thread-a" };
      },
      listFeishuBindings() {
        return [{ chatId: "chat-a" }];
      }
    },
    async getSnapshot() {
      return {
        title: "Session A",
        status: "complete",
        items: [{
          id: "collaboration-confirmation:confirmation-a",
          type: "collaborationConfirmation",
          status: "pending",
          collaborationConfirmationId: "confirmation-a",
          collaborationConfirmationStatus: "pending",
          collaborationRecipientName: "Target Agent",
          collaborationTaskTitle: "Fix service",
          presentationText: "Please fix the service."
        }]
      };
    }
  });
  manager.sendText = async () => {};
  manager.sendCard = async (_botId, _chatId, card) => {
    cards.push(card);
    return { data: { message_id: "message-a" } };
  };

  await manager.syncBot("bot-a");
  await manager.syncBot("bot-a");

  assert.equal(cards.length, 1);
  assert.equal(cards[0].header.subtitle.content, "Corptie · 确认发送协作任务");
});

test("collaboration requests and the receiving Agent's follow-up are both projected to Feishu", async () => {
  const cards = [];
  const manager = new FeishuGatewayManager({
    store: {
      getFeishuAssignmentForBot() {
        return { botId: "bot-a", sessionId: "codex:thread-a" };
      },
      listFeishuBindings() {
        return [{ chatId: "chat-a" }];
      }
    },
    async getSnapshot() {
      return {
        title: "Session A",
        status: "complete",
        items: [{
          id: "collaboration-request-a",
          type: "userMessage",
          sourceType: "collaboration",
          localVisibility: "status_only",
          collaborationSenderName: "Peer Agent",
          collaborationTaskTitle: "Review API",
          presentationText: "Please review the API.",
          text: "<peer_content>trusted envelope</peer_content>"
        }, {
          id: "collaboration-agent-detail-a",
          type: "agentMessage",
          sourceType: "collaboration",
          localVisibility: "status_only",
          text: "Internal handling detail"
        }]
      };
    }
  });
  manager.botRuntime.set("bot-a", { lastStatus: "complete", seenItems: new Set() });
  manager.sendCard = async (_botId, _chatId, card) => cards.push(card);

  await manager.syncBot("bot-a");

  assert.equal(cards.length, 2);
  assert.equal(cards[0].header.subtitle.content, "Corptie · 来自 Peer Agent");
  assert.doesNotMatch(cards[0].body.elements.at(-1).content, /trusted envelope/);
  assert.equal(cards[1].body.elements[0].content, "Internal handling detail");
});

test("unknown message card types are sent by default and process-only types are explicitly hidden", async () => {
  const cards = [];
  const manager = new FeishuGatewayManager({
    store: {
      getFeishuAssignmentForBot() {
        return { botId: "bot-a", sessionId: "codex:thread-a" };
      },
      listFeishuBindings() {
        return [{ chatId: "chat-a" }];
      }
    },
    async getSnapshot() {
      return {
        title: "Session A",
        status: "running",
        items: [
          { id: "notice-a", type: "futureMessageCard", text: "A future card type" },
          { id: "reasoning-a", type: "reasoning", text: "private process detail" }
        ]
      };
    }
  });
  manager.botRuntime.set("bot-a", { lastStatus: "running", seenItems: new Set() });
  manager.sendCard = async (_botId, _chatId, card) => cards.push(card);

  await manager.syncBot("bot-a");

  assert.equal(cards.length, 1);
  assert.equal(cards[0].body.elements[0].content, "A future card type");
});

test("approval card callbacks are forwarded only for the currently assigned session", async () => {
  const responses = [];
  const cards = [];
  const manager = new FeishuGatewayManager({
    store: {
      getFeishuBinding() {
        return { id: "binding-a", chatId: "chat-a" };
      },
      getFeishuAssignmentForBot() {
        return { botId: "bot-a", sessionId: "codex:thread-a" };
      },
      updateFeishuBindingChat() {}
    },
    async respondToApproval(sessionId, input) {
      responses.push({ sessionId, input });
    }
  });
  manager.sendCard = async (_botId, _chatId, card) => cards.push(card);

  await manager.handleCardLine("bot-a", JSON.stringify({
    operator_id: "user-a",
    chat_id: "chat-a",
    action_value: {
      corptie_action: "respond_approval",
      session_id: "codex:thread-a",
      choice_id: "approval-a",
      item_type: "approval",
      option_id: "approved",
      option_index: 0,
      option_role: "approve"
    }
  }));

  assert.deepEqual(responses, [{
    sessionId: "codex:thread-a",
    input: {
      approved: true,
      optionId: "approved",
      optionIndex: 0,
      choiceId: "approval-a",
      itemType: "approval"
    }
  }]);
  assert.equal(cards[0].header.title.content, "Corptie · 已允许");
});

test("collaboration confirmation callbacks resolve the request and replace the card", async () => {
  const responses = [];
  const cards = [];
  const manager = new FeishuGatewayManager({
    store: {
      getFeishuBinding() {
        return { id: "binding-a", chatId: "chat-a" };
      },
      getFeishuAssignmentForBot() {
        return { botId: "bot-a", sessionId: "codex:thread-a" };
      },
      updateFeishuBindingChat() {}
    },
    async getSnapshot() {
      return {
        title: "Session A",
        items: [{
          id: "collaboration-confirmation:confirmation-a",
          type: "collaborationConfirmation",
          collaborationConfirmationId: "confirmation-a",
          collaborationConfirmationStatus: "confirmed",
          collaborationRecipientName: "Target Agent",
          presentationText: "Please fix it."
        }]
      };
    },
    async respondToCollaborationConfirmation(confirmationId, approved, source) {
      responses.push({ confirmationId, approved, sourceType: source.type });
    }
  });
  manager.sendCard = async (_botId, _chatId, card) => cards.push(card);

  await manager.handleCardLine("bot-a", JSON.stringify({
    operator_id: "user-a",
    chat_id: "chat-a",
    action_value: {
      corptie_action: "respond_collaboration_confirmation",
      session_id: "codex:thread-a",
      confirmation_id: "confirmation-a",
      decision: "confirm"
    }
  }));

  assert.deepEqual(responses, [{ confirmationId: "confirmation-a", approved: true, sourceType: "feishu" }]);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].header.template, "green");
});

test("collaboration confirmation cards update when resolved from another client", async () => {
  const updates = [];
  const manager = new FeishuGatewayManager({
    store: {
      getFeishuAssignmentForBot() {
        return { botId: "bot-a", sessionId: "codex:thread-a" };
      },
      listFeishuBindings() {
        return [{ chatId: "chat-a" }];
      }
    },
    async getSnapshot() {
      return {
        title: "Session A",
        status: "complete",
        items: [{
          id: "collaboration-confirmation:confirmation-a",
          type: "collaborationConfirmation",
          collaborationConfirmationId: "confirmation-a",
          collaborationConfirmationStatus: "rejected",
          collaborationRecipientName: "Target Agent",
          presentationText: "Please fix it."
        }]
      };
    }
  });
  manager.botRuntime.set("bot-a", {
    lastStatus: "complete",
    seenItems: new Set(["collaboration-confirmation:confirmation-a"]),
    collaborationConfirmationCards: [{
      itemId: "collaboration-confirmation:confirmation-a",
      messageId: "message-a",
      status: "pending"
    }]
  });
  manager.updateSentMessageCard = async (_botId, messageId, card) => updates.push({ messageId, card });

  await manager.syncBot("bot-a");

  assert.equal(updates.length, 1);
  assert.equal(updates[0].messageId, "message-a");
  assert.equal(updates[0].card.header.template, "grey");
});

test("concurrent bot syncs send each assistant message only once", async () => {
  const botId = "bot-a";
  const sent = [];
  let snapshotReads = 0;
  const manager = new FeishuGatewayManager({
    store: {
      getFeishuAssignmentForBot(id) {
        return id === botId ? { botId, sessionId: "session-a" } : null;
      },
      listFeishuBindings(id) {
        return id === botId ? [{ chatId: "chat-a" }] : [];
      }
    },
    async getSnapshot() {
      snapshotReads += 1;
      return {
        id: "session-a",
        title: "Session A",
        status: "running",
        items: [{ id: "assistant-1", type: "assistantMessage", text: "Only once" }]
      };
    }
  });
  manager.botRuntime.set(botId, { lastStatus: "running", seenItems: new Set() });
  manager.sendText = async (_botId, _chatId, text) => {
    sent.push(text);
    await new Promise((resolve) => setImmediate(resolve));
  };

  await Promise.all([
    manager.syncBot(botId),
    manager.syncBot(botId),
    manager.syncBot(botId)
  ]);

  assert.deepEqual(sent, ["Only once"]);
  assert.equal(snapshotReads, 1);
});

test("a sync requested while sending runs again after the active sync", async () => {
  const botId = "bot-a";
  const sent = [];
  let items = [{ id: "assistant-1", type: "assistantMessage", text: "First" }];
  let releaseFirstSend;
  let firstSendStarted;
  const firstSendIsStarted = new Promise((resolve) => {
    firstSendStarted = resolve;
  });
  const manager = new FeishuGatewayManager({
    store: {
      getFeishuAssignmentForBot() {
        return { botId, sessionId: "session-a" };
      },
      listFeishuBindings() {
        return [{ chatId: "chat-a" }];
      }
    },
    async getSnapshot() {
      return { title: "Session A", status: "running", items };
    }
  });
  manager.botRuntime.set(botId, { lastStatus: "running", seenItems: new Set() });
  manager.sendText = async (_botId, _chatId, text) => {
    sent.push(text);
    if (text === "First") {
      firstSendStarted();
      await new Promise((resolve) => {
        releaseFirstSend = resolve;
      });
    }
  };

  const firstSync = manager.syncBot(botId);
  await firstSendIsStarted;
  items = [...items, { id: "assistant-2", type: "assistantMessage", text: "Second" }];
  const followupSync = manager.syncBot(botId);
  releaseFirstSend();
  await Promise.all([firstSync, followupSync]);

  assert.deepEqual(sent, ["First", "Second"]);
});
