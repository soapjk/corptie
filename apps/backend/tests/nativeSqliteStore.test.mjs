import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";

test("native SQLite persists committed writes immediately in WAL mode", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-native-sqlite-"));
  const dbPath = join(directory, "corptie.sqlite");
  const store = new CorptieStore({ dbPath, configPath: join(directory, "config.json") });

  try {
    await store.initialize();
    store.upsertSession({
      id: "native-session",
      title: "Native SQLite",
      agent: "Codex",
      provider: "codex-app-server",
      status: "complete",
      updatedAt: "2026-07-20T00:00:00.000Z"
    });

    const reader = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.equal(reader.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
      assert.equal(
        reader.prepare("SELECT title FROM sessions WHERE id = ?").get("native-session").title,
        "Native SQLite"
      );
    } finally {
      reader.close();
    }
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("initialization refuses a corrupt database instead of replacing it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-corrupt-sqlite-"));
  const dbPath = join(directory, "corptie.sqlite");
  const corruptBytes = Buffer.from("not a sqlite database");

  try {
    await writeFile(dbPath, corruptBytes);
    const store = new CorptieStore({ dbPath, configPath: join(directory, "config.json") });
    await assert.rejects(store.initialize(), /database|malformed|encrypted/i);
    assert.deepEqual(await readFile(dbPath), corruptBytes);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Git workspace snapshots persist stable repository and worktree identities", async () => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-git-registry-"));
  const dbPath = join(directory, "corptie.sqlite");
  const store = new CorptieStore({ dbPath, configPath: join(directory, "config.json") });
  const snapshot = {
    repository: {
      id: "repository:abc",
      commonGitDirCanonicalPath: "/repo/.git",
      discoveredAt: "2026-07-28T00:00:00.000Z",
      lastValidatedAt: "2026-07-28T00:00:00.000Z"
    },
    inventoryVersion: "inventory-v1",
    observedAt: "2026-07-28T00:00:00.000Z",
    worktrees: [{
      worktreeId: "worktree:main",
      path: "/repo",
      canonicalPath: "/repo",
      gitDirCanonicalPath: "/repo/.git",
      isMain: true,
      availability: "available",
      headOid: "abc123",
      branchRef: "refs/heads/main",
      branchName: "main",
      isDetached: false,
      isLocked: false,
      lockReason: null,
      isPrunable: false,
      pruneReason: null
    }]
  };

  try {
    await store.initialize();
    const persisted = store.upsertGitWorkspaceSnapshot(snapshot);
    assert.deepEqual(store.getGitRepository("repository:abc"), snapshot.repository);
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].worktreeId, "worktree:main");
    assert.equal(persisted[0].branchName, "main");

    const nextSnapshot = {
      ...snapshot,
      inventoryVersion: "inventory-v2",
      observedAt: "2026-07-28T00:01:00.000Z",
      repository: {
        ...snapshot.repository,
        lastValidatedAt: "2026-07-28T00:01:00.000Z"
      },
      worktrees: []
    };
    const missing = store.upsertGitWorkspaceSnapshot(nextSnapshot);
    assert.equal(missing[0].availability, "missing");
    assert.equal(missing[0].inventoryVersion, "inventory-v2");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
