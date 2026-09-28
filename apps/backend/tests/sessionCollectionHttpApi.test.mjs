import assert from "node:assert/strict";
import test from "node:test";
import { handleSessionCollectionHttpRequest } from "../src/application/sessionCollectionHttpApi.mjs";

function fixture() {
  const calls = [];
  const record = (name, value) => (...args) => { calls.push([name, ...args]); return value; };
  const cursor = { updatedAt: "2026-01-01", id: "stored" };
  const dependencies = {
    sessions: new Map([["mock", { id: "mock", pinned: true }]]),
    store: {
      listLatestSessionMessageTimes: record("times", new Map([["stored", "2026-01-02"]])),
      listSessionMessageCursors: record("cursors", new Map([["stored", { lastAgentMessageSequence: 9, lastReadMessageSequence: 4 }]])),
      listSessionTimelineRevisions: record("revisions", new Map([["stored", 8]]))
    },
    agentProviderRegistry: { descriptors: () => [{ id: "test" }, { id: "unused" }] },
    listGatewaySessionPage: record("page", { items: [{ id: "stored", external: { provider: "test" } }], hasMore: true, nextCursor: cursor }),
    requestedProviderId: (id) => id,
    createSessionThroughApplication: record("create", Promise.resolve({ id: "created" })),
    sessionForkService: {
      preview: record("preview", Promise.resolve({ available: true })),
      create: record("fork", Promise.resolve({ id: "forked" }))
    },
    readJson: async (request) => request.body,
    sendJson: (response, status, body) => response.resolve({ status, body }),
    errorStatus: (error, fallback) => error.statusCode ?? fallback,
    unifiedErrorStatus: () => 400,
    sessionTitleErrorPayload: (error) => ({ error: error.message, suggestedTitle: error.suggestedTitle })
  };
  function dispatch(path, method = "GET", body = {}) {
    let resolve;
    const result = new Promise((done) => { resolve = done; });
    const handled = handleSessionCollectionHttpRequest({ ...dependencies,
      request: { method, body }, response: { resolve }, url: new URL(path, "http://localhost") });
    return { handled, result };
  }
  return { calls, cursor, dependencies, dispatch };
}

test("collection reads cap page size and batch only returned Session identities", async () => {
  const f = fixture();
  const result = await f.dispatch("/sessions?limit=999&includeMock=true&sessionKind=worker&sessionId=%20stored%20").result;
  assert.deepEqual(f.calls, [
    ["page", { archived: false, cursor: null, limit: 100, sessionKind: "worker", sessionId: "stored" }],
    ["times", ["stored"]], ["cursors", ["stored"]], ["revisions", ["stored"]]
  ]);
  assert.deepEqual(result.body.sessions.map(({ id }) => id), ["mock", "stored"]);
  const stored = result.body.sessions[1];
  assert.equal(stored.lastMessageAt, "2026-01-02");
  assert.equal(stored.lastAgentMessageSequence, 9);
  assert.equal(stored.lastReadMessageSequence, 4);
  assert.equal(stored.timelineRevision, 8);
  assert.deepEqual(result.body.sources, { test: { ok: true, count: 1 }, unused: { ok: true, count: 0 } });
  assert.deepEqual(JSON.parse(Buffer.from(result.body.page.nextCursor, "base64url").toString()), f.cursor);
  assert.equal(result.body.page.hasMore, true);
});

test("archived pages omit mocks and cursor/filter errors fail before reads", async () => {
  const f = fixture();
  const cursor = Buffer.from(JSON.stringify(f.cursor)).toString("base64url");
  const result = await f.dispatch(`/sessions?archived=true&includeMock=true&limit=invalid&cursor=${cursor}`).result;
  assert.deepEqual(result.body.mock, { ok: true, count: 0, included: false });
  assert.deepEqual(f.calls[0][1].cursor, f.cursor);
  assert.equal(f.calls[0][1].limit, 50);
  assert.deepEqual(result.body.sessions.map(({ id }) => id), ["stored"]);
  f.calls.length = 0;
  assert.equal((await f.dispatch("/sessions?cursor=invalid").result).body.code, "INVALID_SESSION_CURSOR");
  assert.equal((await f.dispatch("/sessions?sessionKind=invalid").result).body.code, "INVALID_SESSION_KIND");
  assert.deepEqual(f.calls, []);
});

test("creation preserves provider selection and structured title failures", async () => {
  const f = fixture();
  const input = { providerId: "test", title: "title" };
  assert.deepEqual(await f.dispatch("/sessions", "POST", input).result, { status: 201, body: { session: { id: "created" } } });
  assert.deepEqual(f.calls[0], ["create", "test", input, { source: "http" }]);
  f.dependencies.createSessionThroughApplication = async () => { throw Object.assign(new Error("duplicate"), { suggestedTitle: "title 2", statusCode: 409 }); };
  assert.deepEqual(await f.dispatch("/sessions", "POST", input).result, { status: 409, body: { error: "duplicate", suggestedTitle: "title 2" } });
});

test("fork preview and creation remain separate and unsupported methods fall through", async () => {
  const f = fixture();
  assert.equal((await f.dispatch("/sessions/public%2Fid/fork?itemId=item").result).status, 200);
  assert.deepEqual(f.calls[0], ["preview", "public/id", "item"]);
  assert.equal((await f.dispatch("/sessions/public%2Fid/fork", "POST", { itemId: "item" }).result).status, 201);
  assert.deepEqual(f.calls[1], ["fork", "public/id", { itemId: "item" }]);
  assert.equal(f.dispatch("/sessions", "DELETE").handled, false);
  assert.equal(f.dispatch("/sessions/public/fork", "PATCH").handled, false);
});
