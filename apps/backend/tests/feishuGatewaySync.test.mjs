import assert from "node:assert/strict";
import test from "node:test";
import { FeishuGatewayManager, formatUsageText } from "../src/feishu/feishuGatewayManager.mjs";

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
  assert.equal(cards[0].header.title.content, "Corptie · 需要权限审批");
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
