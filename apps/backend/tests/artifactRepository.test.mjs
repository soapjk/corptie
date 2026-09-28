import assert from "node:assert/strict";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";

test("Artifact read reservations retain limits and roll back with the owning Store", async () => {
  const store = new CorptieStore({
    dbPath: ":memory:", configPath: "/unused-artifact-repository-config",
    manageProcessEnvironment: false
  });
  try {
    await store.initialize({ resolveDataPath: false });
    const input = {
      logicalSessionId: "logical:test", providerBindingId: "binding:test",
      turnExecutionId: "turn:test", byteLength: 4, uniqueBytesLimit: 8,
      uniquePagesLimit: 2, updatedAt: "2026-01-01T00:00:00.000Z"
    };
    const read = () => store.getArtifactTurnReadUsage(
      input.logicalSessionId, input.providerBindingId, input.turnExecutionId
    );
    let notifications = 0;
    store.setStateDirtyListener(() => { notifications += 1; });
    const failure = new Error("injected rollback");
    assert.throws(() => store.runInTransaction(() => {
      assert.equal(store.reserveArtifactTurnRead(input).uniqueBytes, 4);
      assert.equal(notifications, 0);
      throw failure;
    }), error => error === failure);
    assert.equal(read(), null);
    assert.equal(notifications, 0);
    store.runInTransaction(() => {
      assert.equal(store.reserveArtifactTurnRead(input).resourceVersion, 1);
      assert.equal(store.reserveArtifactTurnRead(input).uniquePages, 2);
    });
    assert.equal(notifications, 1);
    assert.equal(store.reserveArtifactTurnRead(input), null);
    assert.equal(read().uniqueBytes, 8);
    assert.equal(read().resourceVersion, 2);
    const adjusted = store.adjustArtifactTurnReadReservation({
      ...input, byteDelta: -4, pageDelta: -1
    });
    assert.equal(adjusted.uniqueBytes, 4);
    assert.equal(store.reserveArtifactTurnRead(input).uniqueBytes, 8);
  } finally {
    await store.close();
  }
});
