import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

const publicKey = z.string().min(40).max(256).regex(/^[A-Za-z0-9+/]+={0,2}$/);

export const registerDeviceInputSchema = z.object({
  id: z.uuid(),
  kind: z.enum(["mac", "mobile"]),
  displayName: z.string().trim().min(1).max(80),
  publicKeyAlgorithm: z.literal("X25519"),
  publicKey: publicKey
});

export interface CloudDevice {
  id: string;
  accountId: string;
  kind: "mac" | "mobile";
  displayName: string;
  publicKeyAlgorithm: "X25519";
  publicKey: string;
  authSource: "cloud_account" | "legacy_lan";
  authEpoch: number;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
}

export type RegisterDeviceInput = z.infer<typeof registerDeviceInputSchema>;

interface DeviceRow {
  id: string;
  account_id: string;
  kind: "mac" | "mobile";
  display_name: string;
  public_key_algorithm: "X25519";
  public_key: string;
  auth_source: "cloud_account" | "legacy_lan";
  auth_epoch: number;
  created_at: string;
  updated_at: string;
  last_seen_at: string;
  revoked_at: string | null;
}

function mapDevice(row: DeviceRow): CloudDevice {
  return {
    id: row.id,
    accountId: row.account_id,
    kind: row.kind,
    displayName: row.display_name,
    publicKeyAlgorithm: row.public_key_algorithm,
    publicKey: row.public_key,
    authSource: row.auth_source,
    authEpoch: row.auth_epoch,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at
  };
}

export class DeviceConflictError extends Error {
  readonly code = "DEVICE_OWNED_BY_ANOTHER_ACCOUNT";
}

export class DeviceNotFoundError extends Error {
  readonly code = "DEVICE_NOT_FOUND";
}

export class CloudDeviceService {
  constructor(
    private readonly database: DatabaseSync,
    private readonly now: () => Date = () => new Date()
  ) {}

  register(accountId: string, uncheckedInput: RegisterDeviceInput): CloudDevice {
    const input = registerDeviceInputSchema.parse(uncheckedInput);
    const timestamp = this.now().toISOString();
    const existing = this.database.prepare("SELECT account_id FROM cloud_devices WHERE id = ?").get(input.id) as
      | { account_id: string }
      | undefined;
    if (existing && existing.account_id !== accountId) {
      throw new DeviceConflictError("Device identifier is already registered to another account");
    }

    this.ensureAccountState(accountId, timestamp);
    this.database.prepare(`
      INSERT INTO cloud_devices(
        id, account_id, kind, display_name, public_key_algorithm, public_key,
        auth_source, auth_epoch, created_at, updated_at, last_seen_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'cloud_account', 1, ?, ?, ?, NULL)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        display_name = excluded.display_name,
        public_key_algorithm = excluded.public_key_algorithm,
        public_key = excluded.public_key,
        updated_at = excluded.updated_at,
        last_seen_at = excluded.last_seen_at
      WHERE cloud_devices.account_id = excluded.account_id
        AND cloud_devices.revoked_at IS NULL
    `).run(
      input.id,
      accountId,
      input.kind,
      input.displayName,
      input.publicKeyAlgorithm,
      input.publicKey,
      timestamp,
      timestamp,
      timestamp
    );

    const device = this.getForAccount(accountId, input.id);
    if (!device || device.revokedAt) {
      throw new DeviceConflictError("A revoked device identifier cannot be registered again");
    }
    return device;
  }

  listForAccount(accountId: string): CloudDevice[] {
    return (this.database.prepare(`
      SELECT * FROM cloud_devices
      WHERE account_id = ?
      ORDER BY revoked_at IS NOT NULL, kind, updated_at DESC, id
    `).all(accountId) as unknown as DeviceRow[]).map(mapDevice);
  }

  getForAccount(accountId: string, deviceId: string): CloudDevice | null {
    const row = this.database.prepare(
      "SELECT * FROM cloud_devices WHERE account_id = ? AND id = ?"
    ).get(accountId, deviceId) as DeviceRow | undefined;
    return row ? mapDevice(row) : null;
  }

  revokeDevice(accountId: string, deviceId: string, reason = "user_requested"): CloudDevice {
    const timestamp = this.now().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.getForAccount(accountId, deviceId);
      if (!current) throw new DeviceNotFoundError("Device does not exist for this account");
      if (!current.revokedAt) {
        const nextEpoch = current.authEpoch + 1;
        this.database.prepare(`
          UPDATE cloud_devices
          SET revoked_at = ?, updated_at = ?, auth_epoch = ?
          WHERE account_id = ? AND id = ? AND revoked_at IS NULL
        `).run(timestamp, timestamp, nextEpoch, accountId, deviceId);
        this.database.prepare(`
          INSERT INTO cloud_revocations(account_id, device_id, reason, auth_epoch, revoked_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(accountId, deviceId, reason, nextEpoch, timestamp);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    const revoked = this.getForAccount(accountId, deviceId);
    if (!revoked) throw new DeviceNotFoundError("Device does not exist for this account");
    return revoked;
  }

  revokeAccount(accountId: string, reason = "password_recovery"): number {
    const timestamp = this.now().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.ensureAccountState(accountId, timestamp);
      const state = this.database.prepare(`
        UPDATE cloud_account_security_state
        SET auth_epoch = auth_epoch + 1, updated_at = ?
        WHERE account_id = ?
        RETURNING auth_epoch
      `).get(timestamp, accountId) as { auth_epoch: number };
      this.database.prepare(`
        UPDATE cloud_devices
        SET revoked_at = COALESCE(revoked_at, ?), updated_at = ?, auth_epoch = auth_epoch + 1
        WHERE account_id = ?
      `).run(timestamp, timestamp, accountId);
      this.database.prepare(`
        INSERT INTO cloud_revocations(account_id, device_id, reason, auth_epoch, revoked_at)
        VALUES (?, NULL, ?, ?, ?)
      `).run(accountId, reason, state.auth_epoch, timestamp);
      this.database.exec("COMMIT");
      return state.auth_epoch;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private ensureAccountState(accountId: string, timestamp: string): void {
    this.database.prepare(`
      INSERT OR IGNORE INTO cloud_account_security_state(account_id, auth_epoch, updated_at)
      VALUES (?, 1, ?)
    `).run(accountId, timestamp);
  }
}

export function createTestDeviceInput(overrides: Partial<RegisterDeviceInput> = {}): RegisterDeviceInput {
  return {
    id: randomUUID(),
    kind: "mobile",
    displayName: "Test device",
    publicKeyAlgorithm: "X25519",
    publicKey: Buffer.alloc(32, 7).toString("base64"),
    ...overrides
  };
}
