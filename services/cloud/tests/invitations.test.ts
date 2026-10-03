import assert from "node:assert/strict";
import test from "node:test";
import { openCloudDatabase } from "../src/database.js";
import { InvitationError, InvitationService } from "../src/invitations.js";

const secret = "invitation-test-secret-value-123456";
const adminToken = "admin-test-token-value-1234567890";
const now = new Date("2026-10-03T00:00:00.000Z");

test("admin token is constant-time checked and raw invitation codes are never stored", () => {
  const database = openCloudDatabase(":memory:");
  try {
    const service = new InvitationService(database, secret, adminToken, async () => {
      throw new Error("unused");
    }, () => now);
    assert.equal(service.authorizeAdminToken(`Bearer ${adminToken}`), true);
    assert.equal(service.authorizeAdminToken("Bearer incorrect-token"), false);

    const invitation = service.create({ maxUses: 1, expiresAt: "2026-10-04T00:00:00.000Z" });
    const row = database.prepare("SELECT code_hash FROM cloud_invitations WHERE id = ?").get(invitation.id) as {
      code_hash: string;
    };
    assert.notEqual(row.code_hash, invitation.code);
    assert.equal(row.code_hash.includes(invitation.code), false);
  } finally {
    database.close();
  }
});

test("single-use invitations provision exactly one normalized account", async () => {
  const database = openCloudDatabase(":memory:");
  const provisioned: string[] = [];
  try {
    const service = new InvitationService(database, secret, adminToken, async (input) => {
      provisioned.push(input.email);
      return { id: "user:one", email: input.email, name: input.name, emailVerified: false };
    }, () => now);
    const invitation = service.create({ maxUses: 1, expiresAt: "2026-10-04T00:00:00.000Z" });
    const user = await service.redeem({
      code: invitation.code,
      email: "Person@Example.Test",
      name: "Person",
      password: "correct horse battery staple"
    });
    assert.equal(user.id, "user:one");
    assert.deepEqual(provisioned, ["person@example.test"]);
    await assert.rejects(
      service.redeem({
        code: invitation.code,
        email: "second@example.test",
        name: "Second",
        password: "correct horse battery staple"
      }),
      (error: unknown) => error instanceof InvitationError && error.code === "INVITATION_INVALID"
    );
  } finally {
    database.close();
  }
});

test("failed account provisioning releases the invitation reservation for retry", async () => {
  const database = openCloudDatabase(":memory:");
  let attempts = 0;
  try {
    const service = new InvitationService(database, secret, adminToken, async (input) => {
      attempts += 1;
      if (attempts === 1) throw new Error("simulated provisioning failure");
      return { id: "user:retry", email: input.email, name: input.name, emailVerified: false };
    }, () => now);
    const invitation = service.create({ maxUses: 1, expiresAt: "2026-10-04T00:00:00.000Z" });
    const input = {
      code: invitation.code,
      email: "retry@example.test",
      name: "Retry",
      password: "correct horse battery staple"
    };
    await assert.rejects(service.redeem(input), /simulated provisioning failure/);
    assert.equal((database.prepare("SELECT use_count FROM cloud_invitations WHERE id = ?").get(invitation.id) as {
      use_count: number;
    }).use_count, 0);
    assert.equal((await service.redeem(input)).id, "user:retry");
  } finally {
    database.close();
  }
});
