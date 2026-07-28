import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { ApiV1Service } from "../src/webAccess/apiV1Service.mjs";

async function withService(run) {
  const directory = await mkdtemp(join(os.tmpdir(), "corptie-api-v1-test-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  try {
    await store.initialize();
    store.db.run(
      `INSERT INTO web_devices (
        id, name, permission, user_agent, source_ip, created_at, last_seen_at, revoked_at
      ) VALUES (?, ?, 'full-control', NULL, NULL, ?, ?, NULL)`,
      ["device-1", "Test iPhone", "2026-07-26T12:00:00.000Z", "2026-07-26T12:00:00.000Z"]
    );
    const webSession = {
      id: "web-session-1",
      csrfToken: "csrf-secret",
      createdAt: "2026-07-26T12:00:00.000Z",
      lastSeenAt: "2026-07-26T12:00:00.000Z",
      device: {
        id: "device-1",
        name: "Test iPhone",
        permission: "full-control",
        createdAt: "2026-07-26T12:00:00.000Z",
        lastSeenAt: "2026-07-26T12:00:00.000Z"
      }
    };
    await run({ store, webSession });
  } finally {
    await store.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}

function sampleSession() {
  return {
    id: "codex:thread-1",
    title: "Build Web API",
    agent: "Codex",
    status: "running",
    progress: 0.5,
    summary: "Working",
    updatedAt: "2026-07-26T12:00:00.000Z",
    createdAt: "2026-07-26T11:00:00.000Z",
    accent: "cyan",
    capabilities: {
      canSend: true,
      canInterrupt: true,
      canSwitchModel: true,
      canSwitchReasoning: true
    },
    external: {
      provider: "codex-app-server",
      threadId: "thread-1",
      cwd: "/private/project",
      currentModel: "gpt-test"
    },
    items: [{
      id: "message-1",
      turnId: "turn-1",
      turnStatus: "running",
      type: "agentMessage",
      title: "Codex",
      text: "Implementing",
      createdAt: "2026-07-26T12:00:00.000Z",
      secretInternalPayload: "must-not-leak"
    }]
  };
}

test("bootstrap is contract-valid and exposes no backend settings or secrets", async () => {
  await withService(async ({ store, webSession }) => {
    let performCount = 0;
    const session = sampleSession();
    const service = new ApiV1Service({
      store,
      environmentName: "development",
      listSessions: () => [session],
      getSession: async () => session,
      perform: async () => { performCount += 1; return {}; },
      eventCursor: () => 12,
      clock: () => new Date("2026-07-26T12:00:00.000Z")
    });

    const bootstrap = await service.bootstrap(webSession);
    assert.equal(bootstrap.apiVersion, "1");
    assert.equal(bootstrap.eventCursor, 12);
    assert.equal(bootstrap.device.name, "Test iPhone");
    assert.equal(bootstrap.csrfToken, "csrf-secret");
    const serialized = JSON.stringify(bootstrap);
    assert.doesNotMatch(serialized, /agentProxy|choiceParser|apiKey|tokenHash/);
    assert.equal(performCount, 0);
  });
});

test("session responses normalize provider data and derive permission-aware actions", async () => {
  await withService(async ({ store, webSession }) => {
    const session = sampleSession();
    const service = new ApiV1Service({
      store,
      listSessions: () => [session],
      getSession: async () => session,
      eventCursor: () => 9
    });

    const listed = service.sessions(webSession);
    assert.equal(listed.sessions[0].external.provider, "codex-app-server");
    assert.equal(
      listed.sessions[0].availableActions.find((action) => action.id === "session.interrupt").enabled,
      true
    );
    assert.equal(
      listed.sessions[0].availableActions.find((action) => action.id === "session.model.set").enabled,
      true
    );

    const readOnly = {
      ...webSession,
      device: { ...webSession.device, permission: "read-only" }
    };
    const detail = await service.session(session.id, readOnly);
    assert.equal(detail.session.canSend, false);
    assert.equal(detail.session.items[0].text, "Implementing");
    assert.equal("secretInternalPayload" in detail.session.items[0], false);
    assert.equal(detail.session.availableActions.every((action) => action.enabled === false), true);
  });
});

test("actions persist and replay one result for the same Idempotency-Key", async () => {
  await withService(async ({ store, webSession }) => {
    const session = sampleSession();
    let performCount = 0;
    const service = new ApiV1Service({
      store,
      listSessions: () => [session],
      perform: async (_sessionId, request) => {
        performCount += 1;
        return { title: request.payload.title };
      },
      eventCursor: () => 14,
      clock: () => new Date("2026-07-26T12:00:00.000Z")
    });
    const context = { webSession, idempotencyKey: "rename-once" };
    const request = { action: "session.rename", payload: { title: "New title" } };

    const first = await service.action(session.id, request, context);
    const replay = await service.action(session.id, request, context);
    assert.equal(first.status, "succeeded");
    assert.equal(replay.operationId, first.operationId);
    assert.deepEqual(replay.result, first.result);
    assert.equal(performCount, 1);
    assert.equal(store.getWebOperation("device-1", "rename-once").status, "succeeded");
    assert.equal(service.operation(first.operationId, webSession).operationId, first.operationId);

    await assert.rejects(
      service.action(session.id, {
        action: "session.rename",
        payload: { title: "Different title" }
      }, context),
      (error) => error.code === "IDEMPOTENCY_CONFLICT"
    );
  });
});

test("reply devices can send messages exactly once but read-only devices cannot", async () => {
  await withService(async ({ store, webSession }) => {
    const session = sampleSession();
    const performed = [];
    const service = new ApiV1Service({
      store,
      listSessions: () => [session],
      perform: async (_sessionId, request) => {
        performed.push(request);
        return { accepted: true };
      },
      eventCursor: () => 15
    });
    const replySession = {
      ...webSession,
      device: { ...webSession.device, permission: "reply" }
    };
    const input = { action: "message.send", payload: { text: "Continue" } };
    const context = { webSession: replySession, idempotencyKey: "send-once" };
    const first = await service.action(session.id, input, context);
    const replay = await service.action(session.id, input, context);
    assert.equal(first.status, "succeeded");
    assert.equal(replay.operationId, first.operationId);
    assert.equal(performed.length, 1);
    assert.equal(
      service.sessions(replySession).sessions[0].availableActions
        .find((action) => action.id === "message.send").enabled,
      true
    );

    await assert.rejects(
      service.action(session.id, input, {
        webSession: {
          ...webSession,
          device: { ...webSession.device, permission: "read-only" }
        },
        idempotencyKey: "read-only-send"
      }),
      (error) => error.code === "ACTION_NOT_AVAILABLE"
    );
  });
});

test("Session creation accepts only Mac-provided trusted workspaces and models", async () => {
  await withService(async ({ store, webSession }) => {
    const created = [];
    const service = new ApiV1Service({
      store,
      creationOptions: async () => ({
        workspaces: [{ path: "/trusted/project", name: "project" }],
        agents: ["codex", "claude"],
        models: { codex: [{ id: "gpt-test", name: "GPT Test" }], claude: [] },
        defaults: {
          agent: "codex",
          workspace: "/trusted/project",
          codexModel: "gpt-test",
          claudeModel: null,
          reasoningLevel: "medium",
          sandbox: "workspace-write",
          approvalPolicy: "on-request"
        }
      }),
      createSession: async (input) => {
        created.push(input);
        return { ...sampleSession(), id: "codex:new", external: { provider: "codex-app-server" } };
      }
    });
    const input = {
      workspace: "/trusted/project",
      agent: "codex",
      model: "gpt-test",
      reasoningLevel: "medium",
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
      prompt: "Build it"
    };
    assert.equal((await service.create(input, webSession)).session.id, "codex:new");
    assert.equal(created[0].cwd, "/trusted/project");
    await assert.rejects(
      service.create({ ...input, workspace: "/private/other" }, webSession),
      (error) => error.code === "INVALID_REQUEST"
    );
  });
});

test("Session reorder requires full-control and rejects duplicate ids", async () => {
  await withService(async ({ store, webSession }) => {
    const sessions = [sampleSession(), { ...sampleSession(), id: "codex:two" }];
    const service = new ApiV1Service({
      store,
      reorderSessions: (ids) => ids.map((id) => sessions.find((session) => session.id === id))
    });
    assert.deepEqual(
      service.reorder({ sessionIds: ["codex:two", "codex:thread-1"] }, webSession)
        .sessions.map((session) => session.id),
      ["codex:two", "codex:thread-1"]
    );
    assert.throws(
      () => service.reorder({ sessionIds: ["codex:two", "codex:two"] }, webSession),
      (error) => error.code === "INVALID_REQUEST"
    );
  });
});

test("Session metadata exposes only controlled usage fields and a same-origin avatar URL", async () => {
  await withService(async ({ store }) => {
    const session = { ...sampleSession(), avatarPath: "/private/avatar.png" };
    const service = new ApiV1Service({
      store,
      listSessions: () => [session],
      getSessionMetadata: async () => ({
        branch: "feature/web",
        accountUsage: { available: true, percent: 42, apiKey: "secret" },
        contextUsage: { totalTokens: 1000, privatePath: "/private/file" }
      })
    });
    const metadata = await service.metadata(session.id);
    assert.equal(metadata.branch, "feature/web");
    assert.match(metadata.avatarUrl, /^\/api\/v1\//);
    assert.equal("apiKey" in metadata.accountUsage, false);
    assert.equal("privatePath" in metadata.contextUsage, false);
    assert.equal(metadata.contextUsage.totalTokens, 1000);
  });
});

test("Collaboration management is sanitized and action retries are idempotent", async () => {
  await withService(async ({ store, webSession }) => {
    let actions = 0;
    const service = new ApiV1Service({
      store,
      getCollaborationOverview: () => ({
        agents: [{ agentId: "a", name: "A", repositoryRoot: "/secret" }],
        services: [],
        tasks: [{ taskId: "t", title: "Task", status: "working" }]
      }),
      getCollaborationTask: () => ({
        task: { taskId: "t", title: "Task", messages: [{ messageId: "m", body: "Hello" }] },
        deliveries: [{ deliveryId: "d", status: "failed", lastError: "offline" }]
      }),
      performCollaborationAction: () => {
        actions += 1;
        return { delivery: { deliveryId: "d", status: "pending" } };
      }
    });
    assert.equal("repositoryRoot" in service.collaborationOverview().agents[0], false);
    assert.equal(service.collaborationTask("t").task.messages[0].body, "Hello");
    const context = { webSession, idempotencyKey: "retry-d" };
    const request = { action: "delivery.retry", targetId: "d" };
    const first = service.collaborationAction(request, context);
    const replay = service.collaborationAction(request, context);
    assert.equal(first.operationId, replay.operationId);
    assert.equal(actions, 1);
  });
});

test("turn diff actions validate Session ownership and replay one mutation", async () => {
  await withService(async ({ store, webSession }) => {
    const session = sampleSession();
    let actions = 0;
    const service = new ApiV1Service({
      store,
      listSessions: () => [session],
      getTurnDiff: async () => ({ files: ["src/app.mjs"], diff: "--- a/src/app.mjs" }),
      performTurnAction: async () => {
        actions += 1;
        return { ok: true, files: ["src/app.mjs"] };
      }
    });
    assert.deepEqual((await service.turnDiff(session.id, "turn-1")).files, ["src/app.mjs"]);
    const context = { webSession, idempotencyKey: "undo-turn-1" };
    const first = await service.turnAction(session.id, "turn-1", { action: "undo" }, context);
    const replay = await service.turnAction(session.id, "turn-1", { action: "undo" }, context);
    assert.equal(first.operationId, replay.operationId);
    assert.equal(actions, 1);
  });
});

test("event replay uses versioned envelopes and requires resync for cursor gaps", async () => {
  await withService(async ({ store }) => {
    const retained = [
      {
        id: 8,
        type: "SessionProgressChanged",
        payload: { progress: 0.5 },
        createdAt: "2026-07-26T12:00:00.000Z",
        sessionId: "codex:thread-1",
        sessionRevision: 3
      },
      {
        id: 9,
        type: "SessionCompleted",
        payload: {},
        createdAt: "2026-07-26T12:00:01.000Z",
        sessionId: "codex:thread-1",
        sessionRevision: 4
      }
    ];
    let listener;
    const service = new ApiV1Service({
      store,
      eventCursor: () => 9,
      eventsAfter: (cursor) => retained.filter((event) => event.id > cursor),
      subscribeEvents: (next) => {
        listener = next;
        return () => { listener = null; };
      }
    });

    assert.deepEqual(service.events(8).map((event) => event.eventId), [9]);
    assert.equal(service.events(8)[0].schemaVersion, 1);
    assert.throws(() => service.events(4), (error) => error.code === "RESYNC_REQUIRED");
    assert.throws(() => service.events(10), (error) => error.code === "RESYNC_REQUIRED");

    const delivered = [];
    const unsubscribe = service.subscribe((event) => delivered.push(event));
    listener(retained[1]);
    assert.equal(delivered[0].sessionRevision, 4);
    unsubscribe();
    assert.equal(listener, null);
  });
});

test("attention queue normalizes and stably sorts actionable session states", async () => {
  await withService(async ({ store, webSession }) => {
    const base = sampleSession();
    const sessions = [
      {
        ...base,
        id: "codex:complete",
        title: "Completed",
        status: "complete",
        updatedAt: "2026-07-26T12:04:00.000Z",
        items: []
      },
      {
        ...base,
        id: "codex:failed",
        title: "Failed",
        status: "failed",
        updatedAt: "2026-07-26T12:03:00.000Z",
        items: []
      },
      {
        ...base,
        id: "codex:input",
        title: "Input",
        status: "blocked",
        updatedAt: "2026-07-26T12:02:00.000Z",
        items: []
      },
      {
        ...base,
        id: "codex:approval",
        title: "Approval",
        status: "blocked",
        updatedAt: "2026-07-26T12:01:00.000Z",
        items: [{
          id: "approval-1",
          type: "approval",
          text: "Run a privileged command",
          status: "pending"
        }]
      },
      {
        ...base,
        id: "codex:collaboration",
        title: "Collaboration",
        status: "blocked",
        updatedAt: "2026-07-26T12:00:00.000Z",
        items: [{
          id: "confirmation-1",
          type: "collaboration",
          text: "Send work to another agent",
          status: "pending",
          collaborationConfirmationId: "confirm-1",
          collaborationConfirmationStatus: "pending"
        }]
      }
    ];
    const service = new ApiV1Service({
      store,
      listSessions: () => sessions,
      getSession: async (id) => sessions.find((session) => session.id === id),
      eventCursor: () => 21,
      clock: () => new Date("2026-07-26T12:05:00.000Z")
    });

    const attention = await service.attention(webSession);
    assert.deepEqual(attention.items.map((item) => item.kind), [
      "high-risk-approval",
      "collaboration-confirmation",
      "input-required",
      "failure",
      "completed-unread"
    ]);
    assert.deepEqual(attention.items.map((item) => item.priority), [1, 2, 3, 4, 6]);
    assert.equal(attention.count, 5);
    assert.equal(attention.eventCursor, 21);

    service.markAttentionRead("codex:complete", webSession);
    assert.equal((await service.attention(webSession)).items.some(
      (item) => item.sessionId === "codex:complete"
    ), false);
  });
});
