import assert from "node:assert/strict";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";

test("project-code receipts retain Session scoping, immutable hashes and outer transaction rollback", async () => {
  const store = new CorptieStore({ dbPath: ":memory:", configPath: "/unused-receipt-config", manageProcessEnvironment: false });
  try {
    await store.initialize({ resolveDataPath: false });
    store.createLogicalSessionRoute({ logicalSessionId: "logical:test", providerThreadId: "thread:test",
      bindingId: "binding:test", providerSessionId: "thread:test", providerId: "provider:test",
      boundCwd: "/repo", sessionName: "Receipt test" });
    const record = { receiptId: "receipt:test", receiptType: "RepositorySourceSnapshotReceipt",
      logicalSessionId: "logical:test", workId: "work:test", taskId: "task:test",
      repositoryId: "repo:test", worktreeId: "tree:test", sourceFingerprint: "fingerprint",
      receiptHash: "hash", receipt: { receiptId: "receipt:test", receiptHash: "hash" },
      createdAt: "2026-09-27T00:00:00.000Z" };
    let notifications = 0;
    store.setStateDirtyListener(() => { notifications += 1; });
    const failure = new Error("outer transaction rollback");
    assert.throws(() => store.runInTransaction(() => {
      store.putProjectCodeReceipt(record);
      assert.equal(store.getProjectCodeReceiptById(record.receiptId).logicalSessionId, record.logicalSessionId);
      assert.equal(notifications, 0);
      throw failure;
    }), error => error === failure);
    assert.equal(store.getProjectCodeReceiptById(record.receiptId), null);
    assert.equal(notifications, 0);
    const stored = store.putProjectCodeReceipt(record);
    assert.equal(notifications, 1);
    assert.deepEqual(stored.receipt, record.receipt);
    assert.equal(store.getProjectCodeReceipt(record.receiptId, "logical:other"), null);
    assert.deepEqual(store.getLatestProjectCodeSnapshot(record.logicalSessionId), stored);
    assert.equal(store.getLatestProjectCodeSnapshot("logical:other"), null);
    assert.deepEqual(store.putProjectCodeReceipt(record), stored);
    assert.throws(() => store.putProjectCodeReceipt({ ...record, receiptHash: "changed",
      receipt: { ...record.receipt, receiptHash: "changed" } }), /PROJECT_CODE_RECEIPT_IMMUTABLE/);
    assert.throws(() => store.putProjectCodeReceipt({ ...record, receiptId: "mismatch" }), /identity does not match/);
    assert.deepEqual(store.getProjectCodeReceipt(record.receiptId, record.logicalSessionId), stored);
    assert.deepEqual(store.selectAll("PRAGMA foreign_key_check"), []);
  } finally {
    await store.close();
  }
});
