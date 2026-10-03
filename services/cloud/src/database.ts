import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { betterAuthSchemaV1 } from "./authSchema.js";

const applicationMigration = `
CREATE TABLE IF NOT EXISTS cloud_schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cloud_devices (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('mac', 'mobile')),
  display_name TEXT NOT NULL,
  public_key_algorithm TEXT NOT NULL CHECK (public_key_algorithm = 'X25519'),
  public_key TEXT NOT NULL,
  auth_source TEXT NOT NULL CHECK (auth_source IN ('cloud_account', 'legacy_lan')),
  auth_epoch INTEGER NOT NULL DEFAULT 1 CHECK (auth_epoch > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE(account_id, public_key)
);

CREATE INDEX IF NOT EXISTS idx_cloud_devices_account_active
  ON cloud_devices(account_id, revoked_at, kind, updated_at DESC);

CREATE TABLE IF NOT EXISTS cloud_account_security_state (
  account_id TEXT PRIMARY KEY,
  auth_epoch INTEGER NOT NULL DEFAULT 1 CHECK (auth_epoch > 0),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cloud_revocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  device_id TEXT,
  reason TEXT NOT NULL,
  auth_epoch INTEGER NOT NULL,
  revoked_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cloud_revocations_account
  ON cloud_revocations(account_id, id DESC);

CREATE TABLE IF NOT EXISTS cloud_invitations (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  max_uses INTEGER NOT NULL CHECK (max_uses > 0),
  use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0 AND use_count <= max_uses),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS cloud_invitation_redemptions (
  id TEXT PRIMARY KEY,
  invitation_id TEXT NOT NULL REFERENCES cloud_invitations(id) ON DELETE CASCADE,
  normalized_email TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'complete', 'released')),
  user_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cloud_invitation_redemptions_pending
  ON cloud_invitation_redemptions(state, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_invitation_redemptions_email_active
  ON cloud_invitation_redemptions(normalized_email)
  WHERE state IN ('pending', 'complete');

CREATE TABLE IF NOT EXISTS cloud_mail_capture (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('email_verification', 'password_reset')),
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  text_body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

const applicationMigrationV2 = `
ALTER TABLE cloud_devices ADD COLUMN authorization_session_id TEXT;
CREATE UNIQUE INDEX idx_cloud_devices_active_authorization_session
  ON cloud_devices(authorization_session_id)
  WHERE revoked_at IS NULL AND authorization_session_id IS NOT NULL;
`;

export function openCloudDatabase(databasePath: string): DatabaseSync {
  if (databasePath !== ":memory:") {
    const absolutePath = resolve(databasePath);
    mkdirSync(dirname(absolutePath), { recursive: true, mode: 0o700 });
  }

  const database = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA synchronous = FULL");
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec(betterAuthSchemaV1);
  database.exec(applicationMigration);
  database.prepare(`
    INSERT OR IGNORE INTO cloud_schema_migrations(version, applied_at)
    VALUES (1, ?)
  `).run(new Date().toISOString());
  applyMigration(database, 2, applicationMigrationV2);
  return database;
}

function applyMigration(database: DatabaseSync, version: number, sql: string): void {
  const applied = database.prepare(
    "SELECT 1 FROM cloud_schema_migrations WHERE version = ?"
  ).get(version);
  if (applied) return;
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(sql);
    database.prepare(`
      INSERT INTO cloud_schema_migrations(version, applied_at)
      VALUES (?, ?)
    `).run(version, new Date().toISOString());
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function checkCloudDatabase(database: DatabaseSync): void {
  const result = database.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
  if (result?.quick_check !== "ok") {
    throw new Error("SQLite quick_check failed");
  }
  const requiredTables = ["user", "session", "account", "jwks", "oauthClient", "oauthResource", "cloud_devices"];
  const rows = database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN (${requiredTables.map(() => "?").join(", ")})
  `).all(...requiredTables) as unknown as Array<{ name: string }>;
  const present = new Set(rows.map((row) => row.name));
  const missing = requiredTables.filter((name) => !present.has(name));
  if (missing.length > 0) throw new Error(`Database schema is missing required tables: ${missing.join(", ")}`);
}
