import assert from "node:assert/strict";
import test from "node:test";
import { codexUserInputItem, codexUserInputResponse, normalizeCodexUserInputRequest } from "../src/adapters/codexUserInput.mjs";
import { CodexAppServerClient } from "../src/adapters/codexAppServer.mjs";

const request = {
  method: "item/tool/requestUserInput", requestId: "request:one",
  params: { turnId: "turn:one", isBlocking: true, questions: [
    { id: "strategy", header: "Strategy", question: "Which route?", isOther: true,
      isSecret: false, options: [
        { label: "A", description: "Fast" }, { label: "B", description: "Safe" }
      ] },
    { id: "token", header: "Credential", question: "Enter token", isOther: false,
      isSecret: true, options: null }
  ] }
};

test("Codex user-input request preserves typed questions without answers", () => {
  const normalized = normalizeCodexUserInputRequest(request);
  assert.equal(normalized.schemaVersion, 1);
  assert.equal(normalized.requestId, "request:one");
  assert.equal(normalized.questions.length, 2);
  assert.deepEqual(normalized.questions[0].options.map((option) => option.label), ["A", "B"]);
  assert.equal(normalized.questions[1].isSecret, true);
  assert.equal(normalized.questions[1].options, null);
  assert.equal(JSON.stringify(normalized).includes("secret-value"), false);
});

test("Codex user-input item exposes a provider-neutral question schema without answers", () => {
  const item = codexUserInputItem("thread:one", request);
  assert.equal(item.id, "thread:one:app-server-user-input:request:one");
  assert.equal(item.type, "userInput");
  assert.equal(item.status, "pending");
  const publicRequest = JSON.parse(item.rawMetadataJSON).userInput;
  assert.equal(publicRequest.schemaVersion, 1);
  assert.equal(publicRequest.questions.length, 2);
  assert.equal(publicRequest.questions[1].isSecret, true);
  assert.equal(item.rawMetadataJSON.includes("secret-value"), false);
  assert.equal(item.rawMetadataJSON.includes("request:one"), false);
  const nonBlocking = codexUserInputItem("thread:one", {
    ...request, params: { ...request.params, isBlocking: false }
  });
  assert.equal(nonBlocking.turnStatus, "inProgress");
});

test("Codex user-input response maps all question IDs and accepts declared or other answers", () => {
  const response = codexUserInputResponse(request, {
    strategy: ["A", "custom route"], token: ["secret-value"]
  });
  assert.deepEqual({ ...response.answers }, {
    strategy: { answers: ["A", "custom route"] }, token: { answers: ["secret-value"] }
  });
});

test("Codex user-input rejects missing, undeclared and oversized answers", () => {
  const noOther = structuredClone(request);
  noOther.params.questions[0].isOther = false;
  for (const answers of [
    { strategy: ["A"] },
    { strategy: ["other"], token: ["secret-value"] },
    { strategy: ["A"], token: ["secret-value"], extra: ["x"] },
    { strategy: ["A"], token: ["x".repeat(4_001)] }
  ]) {
    assert.throws(() => codexUserInputResponse(noOther, answers),
      { code: "INVALID_USER_INPUT_ANSWER" });
  }
  const duplicateQuestions = structuredClone(request);
  duplicateQuestions.params.questions[1].id = "strategy";
  assert.equal(normalizeCodexUserInputRequest(duplicateQuestions), null);
  const noTurn = structuredClone(request);
  delete noTurn.params.turnId;
  assert.equal(normalizeCodexUserInputRequest(noTurn), null);
  const duplicateOptions = structuredClone(request);
  duplicateOptions.params.questions[0].options[1].label = "A";
  assert.equal(normalizeCodexUserInputRequest(duplicateOptions), null);
});

test("Codex user-input answers only the exact pending request", async () => {
  const client = new CodexAppServerClient();
  const sent = [];
  client.respondToServerRequest = async (id, response) => {
    sent.push({ id, response });
    return { ok: true };
  };
  for (const id of ["request:one", "request:two"]) {
    client.handleServerRequest({ id, method: request.method, params: {
      ...request.params, threadId: "thread:one"
    } });
  }
  const answers = { strategy: ["B"], token: ["secret-value"] };
  await assert.rejects(client.respondToUserInput("thread:one", {
    itemId: "thread:one:app-server-user-input:request:old", answers
  }), { code: "USER_INPUT_NOT_PENDING" });
  assert.equal(sent.length, 0);
  await assert.rejects(client.respondToUserInput("thread:two", {
    itemId: "thread:one:app-server-user-input:request:two", answers
  }), { code: "USER_INPUT_NOT_PENDING" });
  await client.respondToUserInput("thread:one", {
    itemId: "thread:one:app-server-user-input:request:one", answers
  });
  assert.deepEqual(sent, [{ id: "request:one", response: codexUserInputResponse(request, answers) }]);
  assert.equal(client.serverRequestsByThread.get("thread:one").size, 2,
    "the first request remains correlated until Codex resolves it");
  await assert.rejects(client.respondToUserInput("thread:one", {
    itemId: "thread:one:app-server-user-input:request:one", answers
  }), { code: "USER_INPUT_NOT_PENDING" });
});

test("Codex user-input validates before dispatch and prevents duplicate submissions", async () => {
  const client = new CodexAppServerClient();
  client.handleServerRequest({ id: "request:one", method: request.method, params: {
    ...request.params, threadId: "thread:one"
  } });
  let finish;
  const sent = [];
  client.respondToServerRequest = (id, response) => {
    sent.push({ id, response });
    return new Promise((resolve) => { finish = resolve; });
  };
  const itemId = "thread:one:app-server-user-input:request:one";
  await assert.rejects(client.respondToUserInput("thread:one", {
    itemId, answers: { strategy: ["B"] }
  }), { code: "INVALID_USER_INPUT_ANSWER" });
  assert.equal(sent.length, 0);
  const pending = client.respondToUserInput("thread:one", {
    itemId, answers: { strategy: ["B"], token: ["secret-value"] }
  });
  await assert.rejects(client.respondToUserInput("thread:one", {
    itemId, answers: { strategy: ["A"], token: ["another-value"] }
  }), { code: "USER_INPUT_NOT_PENDING" });
  assert.equal(sent.length, 1);
  finish({ ok: true });
  await pending;
  assert.equal(client.serverRequestsByThread.has("thread:one"), true);
  client.handleLine(JSON.stringify({ method: "serverRequest/resolved", params: {
    threadId: "thread:one", requestId: "request:one"
  } }));
  assert.equal(client.serverRequestsByThread.has("thread:one"), false);
});

test("native user-input resolution updates one item without persisting the answer", async () => {
  const notifications = [];
  const client = new CodexAppServerClient({ onNotification: (value) => notifications.push(value) });
  client.respondToServerRequest = async () => ({ ok: true });
  client.handleServerRequest({ id: "request:one", method: request.method, params: {
    ...request.params, threadId: "thread:one"
  } });
  assert.deepEqual(notifications.map((value) => value.method), ["corptie/codexUserInputRequested"]);
  assert.equal(notifications[0].params.item.status, "pending");
  await client.respondToUserInput("thread:one", { itemId: notifications[0].params.item.id,
    answers: { strategy: ["B"], token: ["secret-value"] } });
  assert.equal(notifications[1].method, "corptie/codexUserInputSubmitted");
  assert.equal(notifications[1].params.item.status, "submitted");
  client.handleLine(JSON.stringify({ method: "serverRequest/resolved", params: {
    threadId: "thread:one", requestId: "request:one"
  } }));
  assert.equal(notifications[2].method, "corptie/codexUserInputResolved");
  assert.equal(notifications[2].params.item.status, "submitted");
  assert.equal(notifications[2].params.item.turnStatus, "inProgress");
  assert.equal(new Set(notifications.map((value) => value.params.item.id)).size, 1);
  assert.equal(JSON.stringify(notifications).includes("secret-value"), false);
  assert.equal(client.serverRequestsByThread.has("thread:one"), false);
});

test("automatic native resolution expires unanswered input and terminal turns release pending requests", () => {
  const notifications = [];
  const client = new CodexAppServerClient({ onNotification: (value) => notifications.push(value) });
  client.handleServerRequest({ id: "request:one", method: request.method, params: {
    ...request.params, threadId: "thread:one"
  } });
  client.handleLine(JSON.stringify({ method: "serverRequest/resolved", params: {
    threadId: "thread:one", requestId: "request:one"
  } }));
  assert.equal(notifications.at(-1).params.item.status, "expired");
  client.handleServerRequest({ id: "request:two", method: request.method, params: {
    ...request.params, threadId: "thread:one"
  } });
  client.captureLiveItem({ method: "turn/completed", params: {
    threadId: "thread:one", turn: { id: "turn:one", status: "completed" }
  } });
  assert.equal(client.serverRequestsByThread.has("thread:one"), false);
});

test("app-server shutdown expires unanswered and submitted requests from its generation", async () => {
  const notifications = [];
  const client = new CodexAppServerClient({ onNotification: (value) => notifications.push(value) });
  const child = { kill: () => true };
  client.transport.process = child;
  client.transport.activeProcessGeneration = 1;
  client.respondToServerRequest = async () => ({ ok: true });
  for (const id of ["request:one", "request:two"]) {
    client.handleServerRequest({ id, method: request.method, params: {
      ...request.params, threadId: "thread:one"
    } });
  }
  await client.respondToUserInput("thread:one", {
    itemId: "thread:one:app-server-user-input:request:one",
    answers: { strategy: ["B"], token: ["secret-value"] }
  });
  await client.close();
  const expired = notifications.filter((value) =>
    value.method === "corptie/codexUserInputResolved");
  assert.equal(expired.length, 2);
  assert.deepEqual(expired.map((value) => value.params.item.status), ["expired", "expired"]);
  assert.equal(new Set(expired.map((value) => value.params.item.id)).size, 2);
  assert.equal(JSON.stringify(notifications).includes("secret-value"), false);
  assert.equal(client.serverRequestsByThread.size, 0);
  await client.close();
  assert.equal(notifications.filter((value) =>
    value.method === "corptie/codexUserInputResolved").length, 2);
});

test("malformed Codex user-input is not registered as a pending answerable request", () => {
  const client = new CodexAppServerClient();
  client.handleServerRequest({ id: "request:one", method: request.method, params: {
    ...request.params, threadId: "thread:one", questions: []
  } });
  assert.equal(client.serverRequestsByThread.has("thread:one"), false);
});
