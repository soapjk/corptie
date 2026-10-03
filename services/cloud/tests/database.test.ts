import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { openCloudDatabase } from "../src/database.js";

test("application schema migrates existing v1 device stores exactly once", () => {
  const directory = mkdtempSync("/private/tmp/corptie-cloud-database-");
  const path = join(directory, "cloud.sqlite");
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE cloud_schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO cloud_schema_migrations VALUES (1, '2026-10-03T00:00:00.000Z');
      CREATE TABLE cloud_devices (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL, kind TEXT NOT NULL,
        display_name TEXT NOT NULL, public_key_algorithm TEXT NOT NULL, public_key TEXT NOT NULL,
        auth_source TEXT NOT NULL, auth_epoch INTEGER NOT NULL, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, revoked_at TEXT
      );
    `);
    legacy.close();

    const migrated = openCloudDatabase(path);
    const columns = migrated.prepare(`PRAGMA table_info(cloud_devices)`).all() as unknown as Array<{ name: string }>;
    assert.equal(columns.some((column) => column.name === "authorization_session_id"), true);
    assert.deepEqual(
      (migrated.prepare(`SELECT version FROM cloud_schema_migrations ORDER BY version`).all() as unknown as Array<{ version: number }>)
        .map((row) => row.version),
      [1, 2]
    );
    migrated.close();

    const reopened = openCloudDatabase(path);
    assert.equal(reopened.prepare(`SELECT COUNT(*) AS count FROM cloud_schema_migrations`).get()!.count, 2);
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
