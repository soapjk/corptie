import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import {
  codexTurnPermissionOptions,
  hasCodexSessionPermissions,
  readInitialCodexPermissionsFromRollout,
  withCodexSessionPermissions
} from "../src/utils/codexPermissions.mjs";

test("Full Access and Never Ask survive a SQLite persistence restart", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "corptie-permissions-test-"));
  const dbPath = join(directory, "corptie.sqlite");
  const configPath = join(directory, "config.json");
  const store = new CorptieStore({ dbPath, configPath });
  let reopened = null;

  await store.initialize();
  const created = withCodexSessionPermissions({
    id: "codex:thread-a",
    title: "Full access session",
    agent: "Codex",
    status: "complete",
    updatedAt: "2026-07-19T00:00:00.000Z",
    external: { provider: "codex-app-server", threadId: "thread-a" }
  }, {
    sandbox: "danger-full-access",
    approvalPolicy: "never"
  });
  try {
    store.upsertSession(created);
    if (store.saveTimer) {
      clearTimeout(store.saveTimer);
      store.saveTimer = null;
    }
    await store.save();

    reopened = new CorptieStore({ dbPath, configPath });
    await reopened.initialize();
    const restored = reopened.getSession(created.id);

    assert.equal(hasCodexSessionPermissions(restored), true);
    assert.equal(restored.external.sandbox, "danger-full-access");
    assert.equal(restored.external.approvalPolicy, "never");
    assert.deepEqual(codexTurnPermissionOptions(restored), {
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" }
    });
  } finally {
    if (store.saveTimer) clearTimeout(store.saveTimer);
    if (reopened?.saveTimer) clearTimeout(reopened.saveTimer);
    await rm(directory, { recursive: true, force: true });
  }
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
