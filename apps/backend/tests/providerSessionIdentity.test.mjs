import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import {
  resolveDurableEventSessionId,
  resolveStableSessionIdForProviderDetail
} from "../src/application/providerSessionIdentity.mjs";

function fixture({ logical = null, sessions = [] } = {}) {
  const byID = new Set(sessions);
  return {
    getLogicalSessionByLegacySessionId: (id) => (
      id === logical?.legacySessionId ? logical : null
    ),
    getLogicalSession: (id) => (
      id === logical?.logicalSessionId ? logical : null
    ),
    getLogicalSessionByProviderSessionId: (providerId, id) => (
      providerId === logical?.providerId && id === logical?.providerSessionId ? logical : null
    ),
    getLogicalSessionByProviderThreadId: (id) => (
      id === logical?.providerThreadId ? logical : null
    ),
    getSession: (id) => (byID.has(id) ? { id } : null)
  };
}

test("physical Provider detail ids resolve to the stable Logical Session projection", () => {
  const store = fixture({
    logical: {
      legacySessionId: "session:stable",
      providerId: "openclacky",
      providerSessionId: "physical:one",
      providerThreadId: "physical:one"
    }
  });

  assert.equal(resolveStableSessionIdForProviderDetail({
    store,
    providerId: "openclacky",
    physicalSessionId: "physical:one"
  }), "session:stable");
});

test("legacy provider-only detail ids resolve to the prefixed durable Session", () => {
  const store = fixture({ sessions: ["openclacky:physical-one"] });

  assert.equal(resolveStableSessionIdForProviderDetail({
    store,
    providerId: "openclacky",
    physicalSessionId: "physical-one"
  }), "openclacky:physical-one");
  assert.equal(resolveStableSessionIdForProviderDetail({
    store,
    providerId: "openclacky",
    physicalSessionId: "openclacky:physical-one"
  }), "openclacky:physical-one");
});

test("unknown Provider details are rejected instead of writing an orphan timeline", () => {
  assert.equal(resolveStableSessionIdForProviderDetail({
    store: fixture(),
    providerId: "openclacky",
    physicalSessionId: "missing"
  }), null);
});

test("Logical Session product events resolve to the durable provider Session foreign key", () => {
  const store = fixture({
    logical: {
      logicalSessionId: "logical:source",
      legacySessionId: "codex:provider-source"
    },
    sessions: ["codex:provider-source"]
  });

  assert.equal(
    resolveDurableEventSessionId(store, "logical:source"),
    "codex:provider-source"
  );
  assert.equal(
    resolveDurableEventSessionId(store, "codex:provider-source"),
    "codex:provider-source"
  );
});

test("unresolved product event Session ids detach instead of violating the outbox foreign key", () => {
  assert.equal(resolveDurableEventSessionId(fixture(), "logical:missing"), null);
});

test("Logical Session collaboration events persist against the concrete Session foreign key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-event-session-identity-"));
  const store = new CorptieStore({
    dbPath: join(directory, "corptie.sqlite"),
    configPath: join(directory, "config.json")
  });
  try {
    await store.initialize();
    store.createSession({
      id: "codex:provider-source",
      title: "Source",
      sessionKind: "assistantChat",
      cwd: directory
    });
    store.createLogicalSessionRoute({
      logicalSessionId: "logical:source",
      legacySessionId: "codex:provider-source",
      providerThreadId: "provider-source",
      providerSessionId: "provider-source",
      providerId: "codex",
      boundCwd: directory,
      sessionName: "Source"
    });

    const durableSessionId = resolveDurableEventSessionId(store, "logical:source");
    store.runInTransaction(() => {
      store.appendSessionEvent({
        eventId: "event:channel-authorization-requested",
        sessionId: durableSessionId,
        type: "SessionChannelAuthorizationRequested",
        payload: { requestingSessionId: "logical:source" },
        createdAt: "2026-09-04T05:52:16.415Z"
      });
      store.enqueueEventOutbox({
        outboxId: "outbox:channel-authorization-requested",
        topic: "product-events",
        sessionId: durableSessionId,
        eventType: "SessionChannelAuthorizationRequested",
        payload: { requestingSessionId: "logical:source" },
        createdAt: "2026-09-04T05:52:16.415Z"
      });
    });

    assert.equal(durableSessionId, "codex:provider-source");
    assert.equal(store.selectOne(
      "SELECT session_id FROM event_outbox WHERE outbox_id=?",
      ["outbox:channel-authorization-requested"]
    ).session_id, "codex:provider-source");
    assert.deepEqual(store.selectAll("PRAGMA foreign_key_check"), []);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
