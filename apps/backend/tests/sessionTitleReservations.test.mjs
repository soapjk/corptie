import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { resolveAvailableSessionTitle } from "../src/utils/sessionTitles.mjs";

test("automatic titles respect historical tombstone name reservations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-title-reservation-"));
  const store = new CorptieStore({ dbPath: join(directory, "db.sqlite"), configPath: join(directory, "config.json") });
  try {
    await store.initialize();
    store.createLogicalSessionRoute({ logicalSessionId: "logical:old", providerThreadId: "thread:old", providerId: "claude-sdk", boundCwd: directory, sessionName: "测试claude" });
    // Older compensation retained the key even though the route was deleted.
    store.db.run("UPDATE logical_sessions SET deleted_at=?, archived=1 WHERE logical_session_id=?", [new Date().toISOString(), "logical:old"]);
    const title = resolveAvailableSessionTitle(store.listSessionTitleIdentities(), "测试claude");
    assert.equal(title, "测试claude 1");
    assert.doesNotThrow(() => store.createLogicalSessionRoute({ logicalSessionId: "logical:new", providerThreadId: "thread:new", providerId: "claude-sdk", boundCwd: directory, sessionName: title }));
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
