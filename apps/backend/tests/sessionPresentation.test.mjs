import assert from "node:assert/strict";
import test from "node:test";
import {
  composeStoredSessionList,
  mergeStoredSessionPresentation,
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

test("the archived session list includes stored Codex sessions", () => {
  const sessions = composeStoredSessionList({
    archived: true,
    ptySessions: [{ id: "pty:a" }],
    claudeSessions: [{ id: "claude:a" }],
    codexSessions: [{ id: "codex:a" }],
    mockSessions: [{ id: "mock:a" }]
  });

  assert.deepEqual(sessions.map((session) => session.id), [
    "pty:a",
    "claude:a",
    "codex:a"
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
