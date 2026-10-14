import test from "node:test";
import assert from "node:assert/strict";
import { DetailBusinessCollectionPager } from "../src/application/detailBusinessCollectionPager.mjs";

const scope = { authority: { principalId: "owner", accountId: "account", deviceId: "device", serverId: "server" },
  sessionId: "session", catalog: "native-v2-components-1", clientCapabilities: ["detail.resourceList"],
  generation: "generation", collectionName: "memories", revision: 1 };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
test("opaque cursor pins every authority/profile/generation/collection/revision dimension", async () => {
  const pager = new DetailBusinessCollectionPager(), cursor = pager.issue(scope, "private-source-cursor");
  assert.notEqual(cursor, "private-source-cursor"); let loads = 0;
  assert.deepEqual(await pager.read(scope, cursor, value => { loads++; assert.equal(value, "private-source-cursor"); return { items: [] }; }, () => {}), { items: [] });
  for (const variant of [
    { ...scope, authority: { ...scope.authority, accountId: "other" } }, { ...scope, sessionId: "other" },
    { ...scope, catalog: "native-v2" }, { ...scope, clientCapabilities: [] }, { ...scope, generation: "other" },
    { ...scope, collectionName: "artifacts" }, { ...scope, revision: 2 }
  ]) await assert.rejects(pager.read(variant, cursor, () => { loads++; return { items: [] }; }, () => {}), { code: "DETAIL_CURSOR_INVALID" });
  assert.equal(loads, 1); assert.equal(pager.issue(scope, null), null);
});
test("late read after retirement/revoke and TTL expiration cannot publish a page", async () => {
  for (const mode of ["retire", "revoke", "expired"]) {
    let now = 0, revoked = false; const pager = new DetailBusinessCollectionPager({ now: () => now, ttlMs: 100 });
    const cursor = pager.issue(scope, "source"), gate = deferred();
    const pending = pager.read(scope, cursor, async () => { await gate.promise; return { items: [] }; }, () => {
      if (revoked) throw Object.assign(new Error(), { code: "AUTH_REVOKED" });
    });
    if (mode === "retire") pager.clear(); else if (mode === "revoke") revoked = true; else now = 101;
    gate.resolve();
    await assert.rejects(pending, { code: mode === "revoke" ? "AUTH_REVOKED" : "DETAIL_CURSOR_INVALID" });
    assert.equal(pager.active, 0);
  }
});
test("two concurrent reads, same-cursor single flight, bounded state and page size", async () => {
  const pager = new DetailBusinessCollectionPager({ maximumCursors: 2 }), gate = deferred(); let loads = 0;
  const a = pager.issue(scope, "a"), b = pager.issue(scope, "b");
  const load = async () => { loads++; await gate.promise; return { items: [] }; };
  const first = pager.read(scope, a, load, () => {}), same = pager.read(scope, a, load, () => {}), second = pager.read(scope, b, load, () => {});
  assert.equal(loads, 2); assert.throws(() => pager.issue(scope, "c"), { code: "DETAIL_READ_BUSY" });
  gate.resolve(); await Promise.all([first, same, second]); assert.equal(pager.active, 0);
  await assert.rejects(pager.read(scope, a, () => ({ items: Array(21).fill({}) }), () => {}), { code: "DETAIL_PAGE_TOO_LARGE" });
  pager.issue(scope, "c"); assert.equal(pager.cursors.size, 2);
});
test("authority retirement preserves another account's continuation", () => {
  const pager = new DetailBusinessCollectionPager(), ours = pager.issue(scope, "a");
  const otherScope = { ...scope, authority: { ...scope.authority, accountId: "other" } };
  const other = pager.issue(otherScope, "b");
  pager.clear({ accountId: "account" });
  assert.throws(() => pager.validate(scope, ours), { code: "DETAIL_CURSOR_INVALID" });
  assert.doesNotThrow(() => pager.validate(otherScope, other));
});
