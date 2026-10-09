import assert from "node:assert/strict";
import test from "node:test";
import { createCollaborationConfirmationCommands } from "../src/collaboration/collaborationConfirmationCommands.mjs";

function fixture() {
  const calls = [];
  const request = { requestingSessionId: "source", status: "pending" };
  const preparation = {
    prepareChannelRequestTarget: async () => { calls.push("prepare"); return { sessionId: "target" }; },
    prepareTaskConfirmationTarget: async () => { calls.push("prepareTask"); return { sessionId: "target" }; }
  };
  const commands = createCollaborationConfirmationCommands({
    collaborationCore: {
      getTaskConfirmation: () => ({ sourceSessionId: "source" }),
      confirmTaskConfirmation: () => { calls.push("confirmTask"); return { sourceSessionId: "source" }; },
      rejectTaskConfirmation: () => { calls.push("rejectTask"); return { sourceSessionId: "source" }; }
    },
    sessionChannelService: {
      getRequest: () => request,
      rejectRequest: () => { calls.push("reject"); return request; },
      confirmRequest: () => { calls.push("confirm"); return request; },
      failRequest: () => { calls.push("fail"); return { ...request, status: "failed" }; }
    },
    sessionCollaborationService: preparation,
    emitEvent: () => calls.push("event"),
    syncCollaborationDeliveriesIntoAgentWorkQueue: async () => calls.push("taskDelivery"),
    syncSessionChannelDeliveriesIntoAgentWorkQueue: async () => calls.push("channelDelivery")
  });
  return { commands, calls, request, preparation };
}

test("channel approval prepares and confirms before publishing and delivering", async () => {
  const f = fixture();
  await f.commands.resolveSessionChannelRequest("request", true);
  assert.deepEqual(f.calls, ["prepare", "confirm", "event"]);
  await new Promise(setImmediate);
  assert.deepEqual(f.calls, ["prepare", "confirm", "event", "channelDelivery"]);
});

test("confirmed replay retries delivery without preparing or confirming again", async () => {
  const f = fixture();
  f.request.status = "confirmed";
  assert.equal(await f.commands.resolveSessionChannelRequest("request", true), f.request);
  await new Promise(setImmediate);
  assert.deepEqual(f.calls, ["channelDelivery"]);
});

test("a blocked delivery scan cannot delay the durable approval acknowledgement", async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  let started = false;
  const commands = createCollaborationConfirmationCommands({
    sessionChannelService: {
      getRequest: () => ({ requestingSessionId: "source", status: "pending" }),
      confirmRequest: () => ({ status: "confirmed", firstMessageId: "message:one", channelId: "channel:one" })
    },
    sessionCollaborationService: { prepareChannelRequestTarget: async () => ({ recipientSessionId: "target" }) },
    emitEvent: () => {},
    syncSessionChannelDeliveriesIntoAgentWorkQueue: async () => { started = true; await blocked; }
  });
  try {
    const result = await commands.resolveSessionChannelRequest("request", true);
    assert.equal(result.firstMessageId, "message:one");
    assert.equal(started, false);
    await new Promise(setImmediate);
    assert.equal(started, true);
  } finally { release(); }
});

test("legacy confirmed replay does not prepare the target again", async () => {
  let prepared = 0;
  const before = { status: "confirmed", taskId: "task:one" };
  const commands = createCollaborationConfirmationCommands({
    collaborationCore: { getTaskConfirmation: () => before },
    sessionCollaborationService: { prepareTaskConfirmationTarget: async () => { prepared++; } },
    syncCollaborationDeliveriesIntoAgentWorkQueue: async () => {}
  });
  assert.equal(await commands.resolveCollaborationConfirmation("one", true), before);
  assert.equal(prepared, 0);
  await new Promise(setImmediate);
});

test("rejection does not prepare a target or enqueue delivery", async () => {
  const f = fixture();
  await f.commands.resolveSessionChannelRequest("request", false);
  assert.deepEqual(f.calls, ["reject", "event"]);
  f.calls.length = 0;
  await f.commands.resolveCollaborationConfirmation("confirmation", false);
  assert.deepEqual(f.calls, ["rejectTask", "event"]);
});

test("target preparation failure records failure and does not publish success", async () => {
  const f = fixture();
  f.preparation.prepareChannelRequestTarget = async () => { throw new Error("unavailable"); };
  await assert.rejects(f.commands.resolveSessionChannelRequest("request", true), /unavailable/);
  assert.deepEqual(f.calls, ["fail", "event"]);
});
