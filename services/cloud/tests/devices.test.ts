import assert from "node:assert/strict";
import test from "node:test";
import { openCloudDatabase } from "../src/database.js";
import {
  CloudDeviceService,
  DeviceConflictError,
  createTestDeviceInput
} from "../src/devices.js";

test("devices are account-isolated and cannot be claimed by another account", () => {
  const database = openCloudDatabase(":memory:");
  try {
    const service = new CloudDeviceService(database, () => new Date("2026-10-03T00:00:00.000Z"));
    const input = createTestDeviceInput();
    const device = service.register("account:a", input);

    assert.equal(device.accountId, "account:a");
    assert.equal(service.listForAccount("account:b").length, 0);
    assert.throws(() => service.register("account:b", input), DeviceConflictError);
  } finally {
    database.close();
  }
});

test("device revocation is durable, idempotent, and prevents identifier reuse", () => {
  const database = openCloudDatabase(":memory:");
  try {
    let now = new Date("2026-10-03T00:00:00.000Z");
    const service = new CloudDeviceService(database, () => now);
    const input = createTestDeviceInput();
    service.register("account:a", input);

    now = new Date("2026-10-03T00:01:00.000Z");
    const first = service.revokeDevice("account:a", input.id);
    const second = service.revokeDevice("account:a", input.id);
    assert.equal(first.revokedAt, now.toISOString());
    assert.equal(second.authEpoch, 2);
    assert.throws(() => service.register("account:a", input), DeviceConflictError);
  } finally {
    database.close();
  }
});

test("account-wide recovery increments the account epoch and revokes every device", () => {
  const database = openCloudDatabase(":memory:");
  try {
    const service = new CloudDeviceService(database);
    service.register("account:a", createTestDeviceInput());
    service.register("account:a", createTestDeviceInput({
      publicKey: Buffer.alloc(32, 8).toString("base64")
    }));

    assert.equal(service.revokeAccount("account:a"), 2);
    assert.equal(service.listForAccount("account:a").every((device) => device.revokedAt !== null), true);
  } finally {
    database.close();
  }
});
