import test from "node:test";
import assert from "node:assert/strict";
import { FeishuInboundInbox } from "../src/feishu/feishuInboundInbox.mjs";

test("message admission decodes nested events and suppresses repeated delivery", () => {
  const claims = [];
  const inbox = new FeishuInboundInbox({ claimFeishuInboundEvent: (...args) => { claims.push(args); return true; } });
  const line = JSON.stringify({ header: { event_id: "event", tenant_key: "tenant" }, event: {
    sender: { sender_id: { open_id: "sender" } },
    message: { chat_id: "chat", message_id: "message", chat_type: "p2p", message_type: "text", content: JSON.stringify({ text: " hello " }) }
  } });
  assert.equal(inbox.acceptMessage("bot", line).text, "hello");
  assert.equal(inbox.acceptMessage("bot", line), null);
  assert.deepEqual(claims, [["bot", "event"]]);
  assert.equal(inbox.acceptMessage("bot", "invalid-json"), null);
});

test("card events use a separate durable deduplication namespace", () => {
  const claims = [];
  const inbox = new FeishuInboundInbox({ claimFeishuInboundEvent: (...args) => { claims.push(args); return true; } });
  const event = inbox.acceptCardAction("bot", JSON.stringify({ token: "token", operator: { open_id: "sender" },
    context: { open_chat_id: "chat" }, action: { value: JSON.stringify({ corptie_action: "refresh_sessions" }) }
  }));
  assert.equal(event.operatorId, "sender");
  assert.equal(event.actionValue.corptie_action, "refresh_sessions");
  assert.deepEqual(claims, [["bot", "card:token"]]);
});
