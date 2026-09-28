import assert from "node:assert/strict";
import test from "node:test";
import { createSessionInteractionCommands } from "../src/application/sessionInteractionCommands.mjs";

function fixture() {
  const calls = [];
  const session = { id: "stored", external: { activeTurnId: "turn" } };
  let item = { id: "question", type: "userInput", status: "pending", bindingId: "binding",
    userInput: { canCancel: true, questions: [] } };
  const service = {
    interrupt: async () => session,
    respondToUserInput: async () => session
  };
  const commands = createSessionInteractionCommands({
    store: {
      getSession: () => session,
      getLogicalSession: () => ({ logicalSessionId: "logical" }),
      getSessionItem: () => item,
      upsertTimelineItemProjection: (_id, next) => { item = next; calls.push(["item", next.status]); }
    },
    requireSessionReference: () => ({
      sessionId: "stored", logicalSessionId: "logical", bindingId: "binding",
      providerId: "test", providerSessionId: "native", routingVersion: 1, metadata: { session }
    }),
    sessionApplicationService: service,
    providerEventIngestion: { ingest: (event) => {
      calls.push(["ingest", event]);
      return { status: "applied", event, projection: { session } };
    } },
    handleCommittedProviderTerminalLifecycle: () => calls.push(["terminal"]),
    sendUnifiedSessionMessage: async () => {},
    emitEvent: (...args) => calls.push(["event", ...args]),
    now: () => "2026-01-01T00:00:00Z"
  });
  return { commands, calls, service, session, setItem: (next) => { item = next; }, getItem: () => item };
}

test("unavailable provider runs are durably cancelled before publishing interruption", async () => {
  const f = fixture();
  f.service.interrupt = async () => { throw Object.assign(new Error("gone"), { code: "PROVIDER_SESSION_UNAVAILABLE" }); };
  assert.equal(await f.commands.interruptUnifiedSession("public"), f.session);
  assert.deepEqual(f.calls.map(([name]) => name), ["ingest", "terminal", "event"]);
  assert.equal(f.calls[0][1].type, "turn.cancelled");
  assert.equal(f.calls[0][1].turnId, "turn");
  assert.equal(f.calls[2][1], "SessionRunInterrupted");
});

test("unrelated interrupt failures are propagated without fabricating cancellation", async () => {
  const f = fixture();
  f.service.interrupt = async () => { throw Object.assign(new Error("transport"), { code: "TRANSPORT_FAILED" }); };
  await assert.rejects(f.commands.interruptUnifiedSession("public"), { code: "TRANSPORT_FAILED" });
  assert.deepEqual(f.calls, []);
});

test("cancellable user input transitions through dispatching to cancelled", async () => {
  const f = fixture();
  await f.commands.respondUnifiedSessionUserInput("public", { itemId: "question", action: "cancel" });
  assert.deepEqual(f.calls.filter(([name]) => name === "item"), [["item", "dispatching"], ["item", "cancelled"]]);
  assert.equal(f.calls.at(-1)[1], "SessionUserInputResponded");
});

test("desktop input retains selected options and typed answers on the original card", async () => {
  const f = fixture();
  const userInput = { schemaVersion: 1, isBlocking: true, questions: [
    { id: "route", question: "Choose route", isSecret: false, isOther: false,
      options: [{ label: "A", description: "Fast" }] },
    { id: "token", question: "Token", isSecret: true, isOther: false, options: null }
  ] };
  f.setItem({ id: "question", type: "userInput", status: "pending", bindingId: "binding",
    userInput, rawMetadataJSON: JSON.stringify({ userInput }) });
  await f.commands.respondUnifiedSessionUserInput("public", {
    itemId: "question", answers: { route: ["A"], token: ["secret-value"] }
  });
  assert.equal(f.getItem().status, "submitted");
  assert.deepEqual(JSON.parse(f.getItem().rawMetadataJSON).userInput.selectedOptions, { route: ["A"] });
  assert.deepEqual(JSON.parse(f.getItem().rawMetadataJSON).userInput.submittedAnswers,
    { route: ["A"], token: ["secret-value"] });
});

test("invalid-answer failures restore pending status and release the dispatch guard", async () => {
  const f = fixture();
  f.service.respondToUserInput = async () => { throw Object.assign(new Error("answer"), { code: "INVALID_USER_INPUT_ANSWER" }); };
  await assert.rejects(f.commands.respondUnifiedSessionUserInput("public", { itemId: "question", action: "cancel" }), {
    code: "INVALID_USER_INPUT_ANSWER"
  });
  assert.deepEqual(f.calls.filter(([name]) => name === "item"), [["item", "dispatching"], ["item", "pending"]]);
  f.service.respondToUserInput = async () => f.session;
  await f.commands.respondUnifiedSessionUserInput("public", { itemId: "question", action: "cancel" });
  assert.equal(f.calls.at(-1)[2].status, "cancelled");
});
