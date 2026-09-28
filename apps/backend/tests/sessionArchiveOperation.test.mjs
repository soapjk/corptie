import assert from "node:assert/strict";
import test from "node:test";
import { archiveStoredSession } from "../src/application/sessionArchiveOperation.mjs";
import { handleSessionOrganizationHttpRequest } from "../src/application/sessionOrganizationHttpApi.mjs";

function fixture(legacy = false) {
  const calls = [];
  const session = { id: "stored", sessionKind: "assistantChat" };
  const dependencies = {
    store: {
      getSession: () => session,
      archiveSession: (id, archived) => { calls.push(["archive", id, archived]); return { ...session, archived }; }
    },
    sessionRuntimeReleaseService: {
      request: (...args) => { calls.push(["request", ...args]); return Promise.resolve(); },
      cancelPending: (...args) => calls.push(["cancel", ...args]),
      restore: async (...args) => calls.push(["restore", ...args])
    },
    normalizeSessionId: () => "stored",
    legacyArchiveFor: () => legacy ? { upsert: (value) => calls.push(["upsert", value]) } : null
  };
  return { calls, session, dependencies };
}

test("ordinary archive persists before requesting release; restoration awaits runtime", async () => {
  const f = fixture();
  assert.equal((await archiveStoredSession("public", true, f.dependencies)).archived, true);
  assert.deepEqual(f.calls, [["archive", "stored", true], ["request", "stored", "manual-archive"]]);
  f.calls.length = 0;
  assert.equal((await archiveStoredSession("public", false, f.dependencies)).archived, false);
  assert.deepEqual(f.calls, [["archive", "stored", false], ["restore", "stored"]]);
});

test("legacy restoration cancels pending release and restores its projection first", async () => {
  const f = fixture(true);
  const restored = await archiveStoredSession("legacy", false, f.dependencies);
  assert.deepEqual(f.calls.map(([name]) => name), ["cancel", "upsert", "restore"]);
  assert.equal(f.calls[1][1], restored);
  assert.equal(restored.archived, false);
  assert.ok(restored.updatedAt);
  f.calls.length = 0;
  await archiveStoredSession("legacy", true, f.dependencies);
  assert.deepEqual(f.calls, [["archive", "legacy", true], ["request", "legacy", "manual-archive"]]);
});

test("unsupported and missing Sessions cannot change archive state; restore errors propagate", async () => {
  const f = fixture();
  f.session.sessionKind = "worker";
  await assert.rejects(archiveStoredSession("public", true, f.dependencies), { code: "SESSION_MANUAL_ARCHIVE_UNSUPPORTED" });
  assert.deepEqual(f.calls, []);
  f.dependencies.store.getSession = () => null;
  assert.equal(await archiveStoredSession("public", true, f.dependencies), null);
  assert.deepEqual(f.calls, []);
  f.dependencies.store.getSession = () => ({ ...f.session, sessionKind: "assistantChat" });
  f.dependencies.sessionRuntimeReleaseService.restore = async () => { throw new Error("restore failed"); };
  await assert.rejects(archiveStoredSession("public", false, f.dependencies), /restore failed/);
});

test("organization routes preserve tolerant body defaults and stored reorder identities", async () => {
  const calls = [];
  const events = [];
  let archiveFails = false;
  async function dispatch(path, body = {}, method = "POST") {
    return new Promise((resolve) => {
      const handled = handleSessionOrganizationHttpRequest({
        request: { method }, response: { resolve }, url: new URL(path, "http://localhost"),
        store: {
          pinSession: (...args) => { calls.push(["pin", ...args]); return { id: "stored" }; },
          reorderSessions: (ids) => calls.push(["reorder", ids])
        },
        archiveSession: async (...args) => { calls.push(["archive", ...args]); if (archiveFails) throw new Error("failed"); return { id: "stored" }; },
        normalizeSessionId: () => "stored", listGatewaySessions: () => [],
        readJson: async () => { if (body instanceof Error) throw body; return body; },
        sendJson: (response, status, body) => response.resolve({ status, body }),
        emitEvent: (...args) => events.push(args), errorStatus: (_error, fallback) => fallback, unifiedErrorStatus: () => 400
      });
      if (!handled) resolve({ handled: false });
    });
  }
  assert.equal((await dispatch("/sessions/public/archive", new SyntaxError("invalid"))).status, 200);
  assert.deepEqual(calls[0], ["archive", "public", true]);
  assert.equal(events[0][0], "SessionArchived");
  await dispatch("/sessions/public/pin", { pinned: false });
  assert.deepEqual(calls[1], ["pin", "stored", false]);
  assert.equal(events[1][0], "SessionUnpinned");
  await dispatch("/sessions/reorder", { sessionIds: ["pty:stored", 42] });
  assert.deepEqual(calls[2], ["reorder", ["stored", "42"]]);
  archiveFails = true;
  assert.equal((await dispatch("/sessions/public/archive")).body.code, "SESSION_ARCHIVE_FAILED");
  assert.equal(events.length, 3);
  assert.deepEqual(await dispatch("/sessions/public/archive", {}, "GET"), { handled: false });
});
