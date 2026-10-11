import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { DetailDocumentService, projectDetailDocument, detailPatch, handleDesktopDetail } from "../src/application/detailDocumentService.mjs";

const fixture = JSON.parse(await readFile(new URL("../../../packages/CorptieClientCore/Tests/CorptieClientCoreTests/Fixtures/detail-v1.json", import.meta.url)));
function setup() {
  const session = { id: "legacy", sessionKind: "assistantChat", summary: "Summary", workId: "work", external: { credentials: "secret", cwd: "/private" } };
  const store = { getSession: id => id === "legacy" ? session : null,
    getLogicalSession: id => id === "logical:sample" ? { logicalSessionId: id, legacySessionId: "legacy" } : null,
    getLogicalSessionByLegacySessionId: () => ({ logicalSessionId: "logical:sample" }),
    getWork: () => ({ name: "Sample Work", secret: "private" }) };
  return { session, store, service: new DetailDocumentService(store) };
}
test("server and Swift consume the same native-v1 fixture", () => {
  const projected = projectDetailDocument({ session: {}, logicalSessionId: fixture.sessionId, work: { name: "Sample Work" } });
  const card = { ...projected.cards[0], dataRevision: "fixture-data" };
  assert.deepEqual(card, fixture.cards[0]);
});
test("logical identity is stable across desktop and device route aliases; no raw metadata leaks", () => {
  const { service } = setup();
  assert.deepEqual(service.snapshot("legacy"), service.snapshot("logical:sample"));
  assert.doesNotMatch(JSON.stringify(service.snapshot("legacy")), /secret|private|credentials|external/);
  assert.throws(() => service.snapshot("missing"), { code: "SESSION_NOT_FOUND" });
});
test("unchanged projection does not advance revisions; data-only update is a single-card patch", () => {
  const { service, session } = setup(), before = service.snapshot("legacy");
  assert.strictEqual(service.snapshot("legacy"), before);
  session.summary = "New summary";
  const next = service.snapshot("legacy"), patch = detailPatch(before, next);
  assert.equal(next.revision, before.revision + 1);
  assert.equal(next.generation, before.generation);
  assert.deepEqual(patch.upsertCards.map(c => c.id), ["session-summary"]);
  assert.equal(patch.order, undefined);
});
test("clearing summary emits explicit card removal", () => {
  const { service, session } = setup(), before = service.snapshot("legacy");
  session.summary = "";
  const patch = detailPatch(before, service.snapshot("legacy"));
  assert.deepEqual(patch.removeCardIds, ["session-summary"]);
  assert.deepEqual(patch.order, ["session-info"]);
});
test("resource ownership never overrides explicit Session kind", () => {
  const { service, session } = setup();
  session.sessionKind = "workChat";
  assert.deepEqual(service.snapshot("legacy").order, ["session-info"]);
  session.sessionKind = "worker";
  assert.deepEqual(service.snapshot("legacy").order, ["session-info"]);
});
test("archived sessions cannot expose cached documents", () => {
  const { service, session } = setup(); service.snapshot("legacy"); session.archived = true;
  assert.throws(() => service.snapshot("legacy"), { code: "SESSION_NOT_FOUND" });
});
test("desktop origin and agent requests are refused, not impersonated as paired devices", () => {
  const { store } = setup();
  for (const headers of [{ origin: "https://evil.invalid" }, { "x-corptie-agent-id": "agent" }, {}]) {
    let status;
    handleDesktopDetail({ request: { headers, socket: { remoteAddress: "127.0.0.1" }, method: "GET" },
      response: {}, url: new URL("http://localhost/sessions/legacy/detail"), store, sendJson: (_, value) => { status = value; } });
    assert.equal(status, Object.keys(headers).length ? 403 : 409);
  }
});

class Response extends EventEmitter {
  frames = []; writableLength = 0; writableNeedDrain = false; destroyed = false;
  writeHead() {} write(frame) { this.frames.push(frame); return !this.writableNeedDrain; }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit("close"); } }
}
test("Detail stream emits snapshot then patches and no changes after close", async () => {
  const { service, session } = setup(), response = new Response(); service.events.coalesceMs = 5;
  service.events.attach(response, () => ({ deviceId: "test" }), "legacy");
  try {
    await delay(10); assert.match(response.frames[0], /event: detail-snapshot/);
    session.summary = "Updated"; service.events.invalidate(); await delay(20);
    assert.match(response.frames[1], /event: detail-patch/);
    assert.match(response.frames[1], /"baseRevision":1/);
    service.events.invalidate(); await delay(20); assert.equal(response.frames.length, 2);
  } finally { response.destroy(); }
  service.events.invalidate(); await delay(10); assert.equal(response.frames.length, 2);
});
test("patch baseline advances only per queued frame and coalesces under backpressure", async () => {
  const { service, session } = setup(), response = new Response(); service.events.coalesceMs = 5;
  response.writableNeedDrain = true;
  service.events.attach(response, () => ({ deviceId: "test" }), "legacy");
  try {
    await delay(10);
    session.summary = "A"; service.events.invalidate(); session.summary = "B"; service.events.invalidate();
    await delay(20); assert.equal(response.frames.length, 1);
    response.writableNeedDrain = false; response.emit("drain"); await delay(20);
    assert.equal(response.frames.length, 2); assert.match(response.frames[1], /"baseRevision":1/);
    assert.match(response.frames[1], /"summary":"B"/);
  } finally { response.destroy(); }
});
