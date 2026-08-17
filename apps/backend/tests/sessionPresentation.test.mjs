import assert from "node:assert/strict";
import test from "node:test";
import {
  composeStoredSessionList,
  mergeStoredSessionPresentation,
  preferredSessionCwd,
  preferredSessionTitle,
  reconcileAuthoritativeRunState
} from "../src/utils/sessionPresentation.mjs";

test("a locally saved custom title wins over the Codex thread preview after restart", () => {
  const merged = mergeStoredSessionPresentation(
    { id: "codex:thread-a", title: "First message sent to Codex", status: "complete" },
    { id: "codex:thread-a", title: "My custom project name", pinned: false }
  );

  assert.equal(merged.title, "My custom project name");
});

test("a stored Agent binding survives merging with a provider session", () => {
  const merged = mergeStoredSessionPresentation(
    { id: "codex:thread-a", title: "Provider title", status: "complete" },
    { id: "codex:thread-a", title: "Stored title", agentId: "assistant" }
  );

  assert.equal(merged.agentId, "assistant");
});

test("a stored provider-neutral session kind survives provider refresh", () => {
  const merged = mergeStoredSessionPresentation(
    { id: "codex:thread-a", title: "Provider", sessionKind: "legacy", external: {} },
    { id: "codex:thread-a", title: "Stored", sessionKind: "assistantChat", external: {} }
  );

  assert.equal(merged.sessionKind, "assistantChat");
});

test("stored WorkItem, Objective, and Agent bindings survive a third-party Provider refresh", () => {
  const merged = mergeStoredSessionPresentation(
    {
      id: "openclacky:session-a",
      title: "Provider",
      sessionKind: "legacy",
      external: { provider: "openclacky" }
    },
    {
      id: "openclacky:session-a",
      title: "Stored",
      agentId: "agent:liang",
      objectiveId: "objective:poly",
      workItemId: "work-item:poly",
      sessionKind: "worker",
      external: {}
    }
  );

  assert.equal(merged.agentId, "agent:liang");
  assert.equal(merged.objectiveId, "objective:poly");
  assert.equal(merged.workItemId, "work-item:poly");
  assert.equal(merged.sessionKind, "worker");
});

test("stored Codex permissions survive merging with a resumed thread", () => {
  const merged = mergeStoredSessionPresentation(
    {
      id: "codex:thread-a",
      external: { provider: "codex-app-server", threadId: "thread-a" }
    },
    {
      id: "codex:thread-a",
      external: { sandbox: "danger-full-access", approvalPolicy: "never" }
    }
  );

  assert.equal(merged.external.sandbox, "danger-full-access");
  assert.equal(merged.external.approvalPolicy, "never");
  assert.equal(merged.external.threadId, "thread-a");
});

test("stored Codex model and reasoning survive a provider refresh with empty metadata", () => {
  const merged = mergeStoredSessionPresentation(
    {
      id: "codex:thread-a",
      external: {
        provider: "codex-app-server",
        threadId: "thread-a",
        currentModel: null,
        currentReasoningLevel: null
      }
    },
    {
      id: "codex:thread-a",
      external: {
        currentModel: "gpt-5.6-sol",
        currentReasoningLevel: "xhigh"
      }
    }
  );

  assert.equal(merged.external.currentModel, "gpt-5.6-sol");
  assert.equal(merged.external.currentReasoningLevel, "xhigh");
  assert.equal(merged.external.threadId, "thread-a");
});

test("the stored project path survives a provider refresh with a process directory", () => {
  const merged = mergeStoredSessionPresentation(
    {
      id: "codex:thread-a",
      external: {
        provider: "codex-app-server",
        cwd: "/Applications/Corptie.app/Contents/Resources/backend"
      }
    },
    {
      id: "codex:thread-a",
      external: { cwd: "/Volumes/T9/projects/corptie" }
    }
  );

  assert.equal(merged.external.cwd, "/Volumes/T9/projects/corptie");
});

test("a gateway snapshot prefers the Corptie summary title over detail title", () => {
  assert.equal(
    preferredSessionTitle(
      { title: "My custom project name" },
      { title: "First message sent to Codex" }
    ),
    "My custom project name"
  );
});

test("a gateway snapshot falls back to the provider title when no local title exists", () => {
  assert.equal(
    preferredSessionTitle({ title: " " }, { title: "Provider title" }),
    "Provider title"
  );
});

test("a gateway snapshot keeps the saved project path when provider detail reports its process directory", () => {
  assert.equal(
    preferredSessionCwd(
      { external: { cwd: "/Volumes/T9/projects/corptie" } },
      { cwd: "/Applications/Corptie.app/Contents/Resources/backend" }
    ),
    "/Volumes/T9/projects/corptie"
  );
});

test("a gateway snapshot uses the provider path only when no saved project path exists", () => {
  assert.equal(
    preferredSessionCwd({}, { cwd: "/Volumes/T9/projects/new-project" }),
    "/Volumes/T9/projects/new-project"
  );
});

test("the archived session list includes only explicitly archived sessions", () => {
  const sessions = composeStoredSessionList({
    archived: true,
    ptySessions: [{ id: "pty:archived", archived: true }],
    claudeSessions: [
      { id: "claude:archived", archived: true },
      { id: "claude:active", archived: false }
    ],
    codexSessions: [
      { id: "codex:archived", archived: true },
      { id: "codex:active", archived: false },
      { id: "codex:history-without-archive-marker" }
    ],
    mockSessions: [{ id: "mock:a" }]
  });

  assert.deepEqual(sessions.map((session) => session.id), [
    "pty:archived",
    "claude:archived",
    "codex:archived"
  ]);
  assert.ok(sessions.every((session) => session.sessionKind === "legacy"));
});

test("the active session list excludes explicitly archived sessions", () => {
  const sessions = composeStoredSessionList({
    archived: false,
    ptySessions: [
      { id: "pty:active", archived: false },
      { id: "pty:archived", archived: true }
    ],
    codexSessions: [
      { id: "codex:active", archived: false },
      { id: "codex:legacy-active" }
    ],
    mockSessions: [{ id: "mock:active" }]
  });

  assert.deepEqual(sessions.map((session) => session.id), [
    "pty:active",
    "codex:active",
    "codex:legacy-active",
    "mock:active"
  ]);
});

test("an authoritative idle status clears a stale active turn", () => {
  const session = {
    status: "complete",
    external: { provider: "codex-app-server", activeTurnId: "stale-turn" },
    rawStatus: { activeTurnId: "stale-turn", source: "vscode" }
  };

  assert.deepEqual(reconcileAuthoritativeRunState(session, "complete"), {
    status: "complete",
    external: { provider: "codex-app-server", activeTurnId: null },
    rawStatus: { activeTurnId: null, source: "vscode" }
  });
});

test("an authoritative running status preserves the active turn", () => {
  const session = {
    status: "running",
    external: { activeTurnId: "live-turn" },
    rawStatus: { activeTurnId: "live-turn" }
  };

  assert.equal(reconcileAuthoritativeRunState(session, "running"), session);
});
