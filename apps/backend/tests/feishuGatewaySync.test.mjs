import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  FeishuGatewayManager,
  fetchBotIdentity,
  formatFeishuFailureForLog,
  formatUsageText
} from "../src/feishu/feishuGatewayManager.mjs";

test("Feishu failure diagnostics redact secrets and stay on one line", () => {
  const secret = "super-secret-value";
  const diagnostic = formatFeishuFailureForLog(
    new Error(`profile failed\napp_secret=${secret}\nretry`),
    [secret]
  );

  assert.equal(diagnostic, "profile failed app_secret=[REDACTED] retry");
  assert.equal(diagnostic.includes(secret), false);
});

test("credential setup guides users to an existing CLI profile with the same App ID", async () => {
  const manager = new FeishuGatewayManager({
    cliPath: "/unused/lark-cli",
    store: {
      listFeishuBots() {
        return [];
      }
    }
  });
  manager.listProfiles = async () => [{
    name: "existing-profile",
    appId: "cli_existing",
    brand: "feishu"
  }];

  await assert.rejects(
    manager.createBot({ appId: "cli_existing", appSecret: "not-logged" }),
    (error) => {
      assert.equal(error.feishuStage, "profile_conflict");
      assert.match(error.message, /现有 CLI 配置/);
      assert.match(error.message, /existing-profile/);
      return true;
    }
  );
});

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

test("an immediately started message adds Typing without sending a processing card", async () => {
  const sent = [];
  const reactions = [];
  const manager = new FeishuGatewayManager({
    store: {
      getFeishuAssignmentForBot() {
        return { botId: "bot-a", sessionId: "codex:thread-a" };
      }
    },
    async sendMessage() {
      return { accepted: true, queued: false, queuePosition: 0 };
    }
  });
  manager.addReaction = async (_botId, messageId, emojiType) => {
    reactions.push({ messageId, emojiType });
    return "typing-a";
  };
  manager.sendText = async (_botId, _chatId, text) => sent.push(text);

  await manager.handleCommand("bot-a", { id: "binding-a" }, {
    text: "开始处理",
    chatId: "chat-a",
    messageId: "message-a"
  });

  assert.deepEqual(sent, []);
  assert.deepEqual(reactions, [{ messageId: "message-a", emojiType: "Typing" }]);
  assert.equal(manager.botRuntime.get("bot-a").pendingFeishuRequests[0].messageId, "message-a");
});

test("a slow typing reaction does not delay handing the message to the Agent", async () => {
  let resolveTyping;
  let sendCalled = false;
  const typingBlocked = new Promise((resolve) => { resolveTyping = resolve; });
  const manager = new FeishuGatewayManager({
    store: {
      getFeishuAssignmentForBot() {
        return { botId: "bot-a", sessionId: "codex:thread-a" };
      }
    },
    async sendMessage() {
      sendCalled = true;
      return { accepted: true, queued: false, queuePosition: 0 };
    }
  });
  manager.addReaction = async () => typingBlocked;
  manager.sendText = async () => assert.fail("processing cards must not be sent");

  const command = manager.handleCommand("bot-a", { id: "binding-a" }, {
    text: "开始处理",
    chatId: "chat-a",
    messageId: "message-a"
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sendCalled, true);
  resolveTyping();
  await command;
});

test("a terminal failure removes Typing and never adds DONE", async () => {
  const apiCalls = [];
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
        status: "failed",
        items: []
      };
    }
  });
  manager.botRuntime.set("bot-a", {
    lastStatus: "running",
    seenItems: new Set(),
    pendingFeishuRequests: [{
      messageId: "message-a",
      sessionId: "codex:thread-a",
      typingReactionId: "typing-a",
      typingPromise: Promise.resolve("typing-a"),
      finalDelivered: false
    }]
  });
  manager.callApi = async (_botId, method, path, data = null) => {
    apiCalls.push({ method, path, data });
    return {};
  };

  await manager.syncBot("bot-a");

  assert.deepEqual(apiCalls, [{
    method: "DELETE",
    path: "/open-apis/im/v1/messages/message-a/reactions/typing-a",
    data: null
  }]);
  assert.deepEqual(manager.botRuntime.get("bot-a").pendingFeishuRequests, []);
});

test("a running request keeps its Typing reaction and sends no message", async () => {
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
        items: []
      };
    }
  });
  manager.botRuntime.set("bot-a", {
    lastStatus: "running",
    seenItems: new Set(),
    pendingFeishuRequests: [{
      messageId: "message-a",
      sessionId: "codex:thread-a",
      typingReactionId: "typing-a",
      typingPromise: Promise.resolve("typing-a"),
      finalDelivered: false
    }]
  });
  manager.callApi = async () => assert.fail("a running request must not change its reaction");
  manager.sendText = async () => assert.fail("a running request must not send a message");

  await manager.syncBot("bot-a");

  assert.equal(manager.botRuntime.get("bot-a").pendingFeishuRequests.length, 1);
});

test("a queued message also uses only Typing and sends no queue card", async () => {
  const sent = [];
  const reactions = [];
  const manager = new FeishuGatewayManager({
    store: {
      getFeishuAssignmentForBot() {
        return { botId: "bot-a", sessionId: "codex:thread-a" };
      }
    },
    async sendMessage() {
      return { accepted: true, queued: true, queuePosition: 2 };
    }
  });
  manager.addReaction = async (_botId, messageId, emojiType) => {
    reactions.push({ messageId, emojiType });
    return "typing-a";
  };
  manager.sendText = async (_botId, _chatId, text) => sent.push(text);

  await manager.handleCommand("bot-a", { id: "binding-a" }, {
    text: "继续处理",
    chatId: "chat-a",
    messageId: "message-a"
  });

  assert.deepEqual(sent, []);
  assert.deepEqual(reactions, [{ messageId: "message-a", emojiType: "Typing" }]);
});

test("concurrent Feishu requests reply once and remove Typing on their exact source messages without adding DONE", async () => {
  const replies = [];
  const deletedReactions = [];
  const items = [
    { id: "message-a", type: "userMessage", turnId: "turn-a", text: "Question A", status: "running" },
    { id: "commentary-a", type: "agentMessage", turnId: "turn-a", text: "Thinking A", presentationRole: "commentary", turnStatus: "completed" },
    { id: "final-a", type: "agentMessage", turnId: "turn-a", text: "Answer A", presentationRole: "final_answer", turnStatus: "completed" },
    { id: "message-b", type: "userMessage", turnId: "turn-b", text: "Question B", status: "running" },
    { id: "reasoning-b", type: "reasoning", turnId: "turn-b", text: "Private reasoning B" },
    { id: "final-b", type: "agentMessage", turnId: "turn-b", text: "Answer B", presentationRole: "final_answer", turnStatus: "completed" }
  ];
  const manager = new FeishuGatewayManager({
    store: {
      getFeishuAssignmentForBot() {
        return { botId: "bot-a", sessionId: "session-a" };
      },
      listFeishuBindings() {
        return [{ chatId: "chat-a" }];
      }
    },
    async getSnapshot() {
      return { title: "Session A", status: "complete", items };
    }
  });
  manager.botRuntime.set("bot-a", {
    lastStatus: "running",
    seenItems: new Set(),
    pendingFeishuRequests: [
      { messageId: "message-a", sessionId: "session-a", typingReactionId: "typing-a", typingPromise: Promise.resolve("typing-a"), finalDelivered: false },
      { messageId: "message-b", sessionId: "session-a", typingReactionId: "typing-b", typingPromise: Promise.resolve("typing-b"), finalDelivered: false }
    ]
  });
  manager.sendText = async () => assert.fail("Feishu final answers must use the source-message reply endpoint");
  manager.sendFinalReply = async (_botId, messageId, text) => {
    replies.push({ messageId, text });
    return { text, result: { data: { message_id: `reply-${messageId}` } } };
  };
  manager.callApi = async (_botId, method, path) => {
    assert.equal(method, "DELETE");
    deletedReactions.push(path);
    return {};
  };
  manager.addReaction = async () => assert.fail("a completed request must not add a DONE reaction");

  await manager.syncBot("bot-a");

  assert.deepEqual(replies, [
    { messageId: "message-a", text: "Answer A" },
    { messageId: "message-b", text: "Answer B" }
  ]);
  assert.deepEqual(deletedReactions, [
    "/open-apis/im/v1/messages/message-a/reactions/typing-a",
    "/open-apis/im/v1/messages/message-b/reactions/typing-b"
  ]);
  assert.deepEqual(manager.botRuntime.get("bot-a").pendingFeishuRequests, []);
  assert.equal(manager.botRuntime.get("bot-a").seenItems.has("commentary-a"), true);
  assert.equal(manager.botRuntime.get("bot-a").seenItems.has("reasoning-b"), true);
});

test("a final answer uses exactly one reply API call even when it exceeds the old chunk size", async () => {
  const calls = [];
  const longAnswer = "A".repeat(7000);
  const manager = new FeishuGatewayManager({ store: {} });
  manager.callApi = async (botId, method, path, data) => {
    calls.push({ botId, method, path, data });
    return { data: { message_id: "reply-a" } };
  };

  const sent = await manager.sendFinalReply("bot-a", "message/a", longAnswer, {
    sessionTitle: "Session A",
    sessionStatus: "complete"
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].path, "/open-apis/im/v1/messages/message%2Fa/reply");
  const card = JSON.parse(calls[0].data.content);
  assert.equal(card.body.elements[0].content, longAnswer);
  assert.equal(sent.result.data.message_id, "reply-a");
});

test("a failed turn with partial assistant text sends no reply and is never marked DONE", async () => {
  const apiCalls = [];
  const manager = new FeishuGatewayManager({
    store: {
      getFeishuAssignmentForBot() {
        return { botId: "bot-a", sessionId: "session-a" };
      },
      listFeishuBindings() {
        return [{ chatId: "chat-a" }];
      }
    },
    async getSnapshot() {
      return {
        title: "Session A",
        status: "failed",
        items: [
          { id: "message-a", type: "userMessage", turnId: "turn-a", text: "Question", status: "failed" },
          { id: "partial-a", type: "agentMessage", turnId: "turn-a", text: "Partial", presentationRole: "final_answer", turnStatus: "failed" }
        ]
      };
    }
  });
  manager.botRuntime.set("bot-a", {
    lastStatus: "running",
    seenItems: new Set(),
    pendingFeishuRequests: [{
      messageId: "message-a",
      sessionId: "session-a",
      typingReactionId: "typing-a",
      typingPromise: Promise.resolve("typing-a"),
      finalDelivered: false
    }]
  });
  manager.sendText = async () => assert.fail("failed partial text must not be sent");
  manager.sendFinalReply = async () => assert.fail("failed partial text must not be sent");
  manager.callApi = async (_botId, method, path, data = null) => {
    apiCalls.push({ method, path, data });
    return {};
  };
  manager.addReaction = async () => assert.fail("failed turns must never add DONE");

  await manager.syncBot("bot-a");

  assert.deepEqual(apiCalls, [{
    method: "DELETE",
    path: "/open-apis/im/v1/messages/message-a/reactions/typing-a",
    data: null
  }]);
});

test("connecting an existing session immediately replays only its latest formal agent reply", async () => {
  const botId = "bot-a";
  const sent = [];
  let assignment = null;
  const manager = new FeishuGatewayManager({
    store: {
      lastSessionEventSequence() {
        return 12;
      },
      assignFeishuSession(nextAssignment) {
        assignment = nextAssignment;
        return nextAssignment;
      },
      getFeishuAssignmentForBot(id) {
        return id === botId ? assignment : null;
      },
      listFeishuBindings() {
        return [
          { id: "binding-other", chatId: "chat-other" },
          { id: "binding-a", chatId: "chat-a" }
        ];
      }
    },
    async listSessions() {
      return [{ id: "session-a", title: "Session A" }];
    },
    async getSnapshot() {
      return {
        title: "Session A",
        status: "complete",
        items: [
          {
            id: "final-old",
            type: "agentMessage",
            text: "Older final answer",
            presentationRole: "final_answer",
            turnStatus: "completed"
          },
          {
            id: "final-latest",
            type: "agentMessage",
            text: "Latest final answer",
            presentationRole: "final_answer",
            turnStatus: "completed"
          },
          {
            id: "commentary-newer",
            type: "agentMessage",
            text: "Newer progress update",
            presentationRole: "commentary",
            turnStatus: "completed"
          }
        ]
      };
    }
  });
  manager.sendText = async (_botId, chatId, text) => {
    sent.push({ chatId, text });
    return [];
  };

  await manager.assignSession(botId, "binding-a", "session-a");
  await manager.syncBot(botId);

  assert.deepEqual(sent, [{ chatId: "chat-a", text: "Latest final answer" }]);
});

test("connecting a legacy completed session replays its latest unphased agent reply", async () => {
  const botId = "bot-a";
  const sent = [];
  let assignment = null;
  const manager = new FeishuGatewayManager({
    store: {
      lastSessionEventSequence() {
        return 0;
      },
      assignFeishuSession(nextAssignment) {
        assignment = nextAssignment;
        return nextAssignment;
      },
      getFeishuAssignmentForBot() {
        return assignment;
      },
      listFeishuBindings() {
        return [{ id: "binding-a", chatId: "chat-a" }];
      }
    },
    async listSessions() {
      return [{ id: "session-a", title: "Session A" }];
    },
    async getSnapshot() {
      return {
        title: "Session A",
        status: "complete",
        items: [
          { id: "legacy-old", type: "agentMessage", text: "Old", turnStatus: "complete" },
          { id: "legacy-latest", type: "agentMessage", text: "Latest", turnStatus: "complete" }
        ]
      };
    }
  });
  manager.sendText = async (_botId, _chatId, text) => {
    sent.push(text);
    return [];
  };

  await manager.assignSession(botId, "binding-a", "session-a");

  assert.deepEqual(sent, ["Latest"]);
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

test("collaboration requests and the receiving Session's follow-up are both projected to Feishu", async () => {
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
          collaborationInitiatorSessionId: "session:peer",
          collaborationInitiatorSessionTitle: "Peer Session",
          collaborationRecipientSessionId: "session:thread-a",
          collaborationRecipientSessionTitle: "Session A",
          collaborationSourceObjectiveId: "objective:peer",
          collaborationSourceObjectiveName: "Peer Objective",
          collaborationTargetObjectiveId: "objective:current",
          collaborationTargetObjectiveName: "Current Objective",
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
  assert.equal(cards[0].header.subtitle.content, "Corptie · 来自 Peer Session");
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
          { id: "reasoning-a", type: "reasoning", text: "private process detail" },
          { id: "compaction-a", type: "contextCompaction", title: "contextCompaction", text: "must stay local" }
        ]
      };
    }
  });
  manager.botRuntime.set("bot-a", { lastStatus: "running", seenItems: new Set() });
  manager.sendCard = async (_botId, _chatId, card) => cards.push(card);

  await manager.syncBot("bot-a");

  assert.equal(cards.length, 1);
  assert.equal(cards[0].body.elements[0].content, "A future card type");
  assert.equal(manager.botRuntime.get("bot-a").seenItems.has("compaction-a"), true);
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

test("an empty started assistant item is deferred until the same item id contains the completed reply", async () => {
  const botId = "bot-a";
  const sent = [];
  let items = [{
    id: "assistant-stable-id",
    type: "agentMessage",
    status: "inProgress",
    text: ""
  }];
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
    return [];
  };

  await manager.syncBot(botId);

  assert.deepEqual(sent, []);
  assert.equal(manager.botRuntime.get(botId).seenItems.has("assistant-stable-id"), false);

  items = [{
    id: "assistant-stable-id",
    type: "agentMessage",
    status: "completed",
    presentationRole: "final_answer",
    text: "The completed reply"
  }];
  await manager.syncBot(botId);

  assert.deepEqual(sent, ["The completed reply"]);
  assert.equal(manager.botRuntime.get(botId).seenItems.has("assistant-stable-id"), true);
});

test("runtime recovery does not seed an in-progress assistant id into the seen set", async () => {
  const botId = "bot-a";
  const sent = [];
  let items = [{
    id: "assistant-recovered-id",
    type: "agentMessage",
    status: "inProgress",
    text: "Partial reply"
  }];
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
  manager.sendText = async (_botId, _chatId, text) => {
    sent.push(text);
    return [];
  };

  await manager.syncBot(botId);

  assert.deepEqual(sent, ["当前会话：Session A\n状态：正在处理"]);
  assert.equal(manager.botRuntime.get(botId).seenItems.has("assistant-recovered-id"), false);

  items = [{
    id: "assistant-recovered-id",
    type: "agentMessage",
    status: "completed",
    presentationRole: "final_answer",
    text: "Recovered completed reply"
  }];
  await manager.syncBot(botId);

  assert.deepEqual(sent, ["当前会话：Session A\n状态：正在处理", "Recovered completed reply"]);
  assert.equal(manager.botRuntime.get(botId).seenItems.has("assistant-recovered-id"), true);
});
