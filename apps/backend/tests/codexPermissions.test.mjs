import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import {
  codexRuntimeWorkspaceRoots,
  codexTurnPermissionOptions,
  hasCodexSessionPermissions,
  readInitialCodexPermissionsFromRollout,
  withCodexSessionPermissions
} from "../src/utils/codexPermissions.mjs";
import {
  hasCodexSessionRuntimeConfig,
  readLatestCodexRuntimeConfigFromRollout,
  withCodexSessionRuntimeConfig
} from "../src/utils/codexRuntimeConfig.mjs";
import {
  normalizeNewSessionDefaults,
  resolveNewCodexRuntimeConfig
} from "../src/utils/newSessionDefaults.mjs";

test("new session defaults normalize the values shared by desktop and Feishu", () => {
  assert.deepEqual(normalizeNewSessionDefaults({
    sandbox: "dangerFullAccess",
    approvalPolicy: "never",
    codexModel: " gpt-5.6-sol ",
    codexReasoningLevel: "XHIGH",
    claudeModel: " claude-opus-4-6 "
  }), {
    sandbox: "danger-full-access",
    approvalPolicy: "never",
    codexModel: "gpt-5.6-sol",
    codexReasoningLevel: "xhigh",
    claudeModel: "claude-opus-4-6"
  });
});

test("permissions, model, and reasoning survive a SQLite persistence restart", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "corptie-permissions-test-"));
  const dbPath = join(directory, "corptie.sqlite");
  const configPath = join(directory, "config.json");
  const store = new CorptieStore({ dbPath, configPath });
  let reopened = null;

  await store.initialize();
  const created = withCodexSessionRuntimeConfig(withCodexSessionPermissions({
    id: "codex:thread-a",
    title: "Full access session",
    agent: "Codex",
    status: "complete",
    updatedAt: "2026-07-19T00:00:00.000Z",
    external: { provider: "codex-app-server", threadId: "thread-a" }
  }, {
    sandbox: "danger-full-access",
    approvalPolicy: "never"
  }), {
    model: "gpt-5.6-sol",
    reasoningLevel: "xhigh"
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
    assert.equal(hasCodexSessionRuntimeConfig(restored), true);
    assert.equal(restored.external.currentModel, "gpt-5.6-sol");
    assert.equal(restored.external.currentReasoningLevel, "xhigh");
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
  assert.deepEqual(codexTurnPermissionOptions({
    external: { sandbox: "workspace-write", approvalPolicy: "never" }
  }, {
    runtimeWorkspaceRoots: ["/repo-integration", "/repo/.git/worktrees/integration"]
  }), {
    approvalPolicy: "never",
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: ["/repo-integration", "/repo/.git/worktrees/integration"],
      networkAccess: false
    }
  });
  assert.deepEqual(codexTurnPermissionOptions({
    external: { sandbox: "workspace-write", approvalPolicy: "on-request" }
  }, {
    forceFullAccess: true
  }), {
    approvalPolicy: "never",
    sandboxPolicy: { type: "dangerFullAccess" }
  });
});

test("later turns retain the persisted writable Git metadata roots", () => {
  const roots = ["/repo-integration", "/repo/.git/worktrees/integration"];
  assert.deepEqual(codexRuntimeWorkspaceRoots({
    permissionSnapshot: { runtimeWorkspaceRoots: roots }
  }, "/repo-integration"), roots);
  assert.deepEqual(codexRuntimeWorkspaceRoots({}, "/repo-integration"), ["/repo-integration"]);
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

test("new Codex sessions resolve an explicit model and a supported reasoning level", () => {
  const models = [
    {
      id: "gpt-5.6-sol",
      defaultReasoningLevel: "low",
      reasoningLevels: ["low", "medium", "high", "xhigh"]
    }
  ];

  assert.deepEqual(resolveNewCodexRuntimeConfig({
    request: {},
    defaults: {
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
      codexModel: "gpt-5.6-sol",
      codexReasoningLevel: "xhigh"
    },
    currentConfig: { model: "gpt-5.6-sol", reasoningLevel: "high" },
    models
  }), {
    model: "gpt-5.6-sol",
    reasoningLevel: "xhigh"
  });

  assert.deepEqual(resolveNewCodexRuntimeConfig({
    request: { model: "gpt-5.6-sol", reasoningLevel: "unsupported" },
    models
  }), {
    model: "gpt-5.6-sol",
    reasoningLevel: "low"
  });
});

test("legacy sessions recover their latest model and reasoning from the rollout", () => {
  const rollout = [
    JSON.stringify({
      type: "turn_context",
      payload: { model: "gpt-5.5", effort: "high" }
    }),
    "partially written line",
    JSON.stringify({
      type: "turn_context",
      payload: { model: "gpt-5.6-sol", effort: "xhigh" }
    })
  ].join("\n");

  assert.deepEqual(readLatestCodexRuntimeConfigFromRollout(rollout), {
    model: "gpt-5.6-sol",
    reasoningLevel: "xhigh"
  });
});
