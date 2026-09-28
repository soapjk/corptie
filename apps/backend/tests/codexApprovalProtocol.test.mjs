import test from "node:test";
import assert from "node:assert/strict";
import {
  isApprovalServerRequest, mapServerRequestToItem, approvalDecisionForRequest,
  denialDecisionForRequest, approvedCommandKey
} from "../src/adapters/codexApprovalProtocol.mjs";

test("approval projection retains the request identity and declared decision protocol", () => {
  const amendment = { acceptWithExecpolicyAmendment: { execpolicyAmendment: ["ps"] } };
  const request = {
    method: "item/commandExecution/requestApproval",
    params: {
      requestId: "request", approvalId: "approval", turnId: "turn",
      command: "ps aux", cwd: "/workspace", reason: "inspect process",
      availableDecisions: [amendment, "accept", "cancel"]
    }
  };
  assert.equal(isApprovalServerRequest(request), true);
  const item = mapServerRequestToItem("thread", request);
  assert.equal(item.id, "thread:app-server-approval:request");
  assert.equal(item.turnId, "turn");
  assert.equal(item.options[0].id, "accept_with_execpolicy_amendment");
  assert.equal(item.options[1].id, "cancel");
  assert.equal(approvalDecisionForRequest(request, item.options[0].id), amendment);
  assert.equal(approvalDecisionForRequest(request, "accept"), "accept");
  assert.equal(denialDecisionForRequest(request), "cancel");
});

test("non-approval input is not projected as an approval and fallback decisions stay compatible", () => {
  assert.equal(mapServerRequestToItem("thread", { method: "item/tool/requestUserInput" }), null);
  assert.equal(approvalDecisionForRequest({}), "approved");
  assert.equal(denialDecisionForRequest({}), "deny");
  assert.equal(denialDecisionForRequest({ params: { availableDecisions: ["denied"] } }), "denied");
});

test("approved process inspection is scoped to the thread and turn, not arbitrary commands", () => {
  const request = { params: { turnId: "turn", command: "/bin/ps aux" } };
  assert.equal(approvedCommandKey("thread", request), "thread:turn:ps");
  assert.equal(approvedCommandKey("other", request), "other:turn:ps");
  assert.equal(approvedCommandKey("thread", { params: { command: "ps aux" } }), null);
  assert.equal(approvedCommandKey("thread", { params: { turnId: "turn", command: "rm file" } }), null);
});
