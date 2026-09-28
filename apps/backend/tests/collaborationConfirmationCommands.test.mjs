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
      failRequest: () => calls.push("fail")
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
  assert.deepEqual(f.calls, ["prepare", "confirm", "event", "channelDelivery"]);
});

test("confirmed replay retries delivery without preparing or confirming again", async () => {
  const f = fixture();
  f.request.status = "confirmed";
  assert.equal(await f.commands.resolveSessionChannelRequest("request", true), f.request);
  assert.deepEqual(f.calls, ["channelDelivery"]);
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
  assert.deepEqual(f.calls, ["fail"]);
});
