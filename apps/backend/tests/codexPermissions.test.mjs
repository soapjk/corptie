import assert from "node:assert/strict";
import test from "node:test";
import {
  codexTurnPermissionOptions,
  hasCodexSessionPermissions,
  readInitialCodexPermissionsFromRollout,
  withCodexSessionPermissions
} from "../src/utils/codexPermissions.mjs";

test("Full Access and Never Ask survive session persistence and restart", () => {
  const created = withCodexSessionPermissions({
    id: "codex:thread-a",
    external: { provider: "codex-app-server", threadId: "thread-a" }
  }, {
    sandbox: "danger-full-access",
    approvalPolicy: "never"
  });
  const reopened = JSON.parse(JSON.stringify(created));

  assert.equal(hasCodexSessionPermissions(reopened), true);
  assert.deepEqual(codexTurnPermissionOptions(reopened), {
    approvalPolicy: "never",
    sandboxPolicy: { type: "dangerFullAccess" }
  });
});

test("turn permissions use the Codex app-server sandbox policy variants", () => {
  assert.deepEqual(codexTurnPermissionOptions({
    external: { sandbox: "workspace-write", approvalPolicy: "on-request" }
  }), {
    approvalPolicy: "on-request",
    sandboxPolicy: { type: "workspaceWrite" }
  });
  assert.deepEqual(codexTurnPermissionOptions({
    external: { sandbox: "read-only", approvalPolicy: "on-failure" }
  }), {
    approvalPolicy: "on-request",
    sandboxPolicy: { type: "readOnly" }
  });
});

test("app-server sandbox variants normalize back to persisted CLI names", () => {
  const session = withCodexSessionPermissions({ id: "codex:thread-a" }, {
    sandbox: "dangerFullAccess",
    approvalPolicy: "never"
  });

  assert.equal(session.external.sandbox, "danger-full-access");
});

test("legacy sessions recover their creation-time permission context from the rollout", () => {
  const rollout = [
    JSON.stringify({
      type: "turn_context",
      payload: {
        approval_policy: "never",
        sandbox_policy: { type: "danger-full-access" }
      }
    }),
    "partially written line",
    JSON.stringify({
      type: "turn_context",
      payload: {
        approval_policy: "on-request",
        sandbox_policy: { type: "read-only" }
      }
    })
  ].join("\n");

  assert.deepEqual(readInitialCodexPermissionsFromRollout(rollout), {
    sandbox: "danger-full-access",
    approvalPolicy: "never"
  });
});
