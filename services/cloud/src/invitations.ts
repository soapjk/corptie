import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { InvitedUser, InvitedUserInput } from "./auth.js";

export const createInvitationInputSchema = z.object({
  maxUses: z.number().int().min(1).max(100).default(1),
  expiresAt: z.iso.datetime({ offset: true })
});

export const redeemInvitationInputSchema = z.object({
  code: z.string().min(32).max(256),
  email: z.email().max(320),
  name: z.string().trim().min(1).max(100),
  password: z.string().min(8).max(128)
});

export interface InvitationCreation {
  id: string;
  code: string;
  maxUses: number;
  expiresAt: string;
  createdAt: string;
}

interface InvitationRow {
  id: string;
  max_uses: number;
  use_count: number;
  expires_at: string;
  revoked_at: string | null;
}

export class InvitationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export class InvitationService {
  constructor(
    private readonly database: DatabaseSync,
    private readonly secret: string,
    private readonly adminToken: string,
    private readonly provisionUser: (input: InvitedUserInput) => Promise<InvitedUser>,
    private readonly now: () => Date = () => new Date()
  ) {}

  create(input: z.infer<typeof createInvitationInputSchema>, createdBy = "local_admin"): InvitationCreation {
    const parsed = createInvitationInputSchema.parse(input);
    const now = this.now();
    const expiresAt = new Date(parsed.expiresAt);
    if (expiresAt <= now) throw new InvitationError("INVITATION_EXPIRY_INVALID", "Invitation expiry must be in the future");
    if (expiresAt.getTime() - now.getTime() > 90 * 24 * 60 * 60 * 1_000) {
      throw new InvitationError("INVITATION_EXPIRY_INVALID", "Invitation expiry cannot exceed 90 days");
    }
    const id = randomUUID();
    const code = randomBytes(32).toString("base64url");
    this.database.prepare(`
      INSERT INTO cloud_invitations(id, code_hash, max_uses, use_count, expires_at, created_at, created_by)
      VALUES (?, ?, ?, 0, ?, ?, ?)
    `).run(id, this.hashCode(code), parsed.maxUses, expiresAt.toISOString(), now.toISOString(), createdBy);
    return { id, code, maxUses: parsed.maxUses, expiresAt: expiresAt.toISOString(), createdAt: now.toISOString() };
  }

  async redeem(unchecked: z.infer<typeof redeemInvitationInputSchema>): Promise<InvitedUser> {
    const input = redeemInvitationInputSchema.parse(unchecked);
    const normalizedEmail = input.email.trim().toLowerCase();
    const reservationId = this.reserve(input.code, normalizedEmail);
    try {
      const user = await this.provisionUser({ ...input, email: normalizedEmail });
      this.database.prepare(`
        UPDATE cloud_invitation_redemptions
        SET state = 'complete', user_id = ?, updated_at = ?
        WHERE id = ? AND state = 'pending'
      `).run(user.id, this.now().toISOString(), reservationId);
      return user;
    } catch (error) {
      this.release(reservationId);
      throw error;
    }
  }

  authorizeAdminToken(candidate: string | null): boolean {
    if (!candidate?.startsWith("Bearer ")) return false;
    const supplied = createHmac("sha256", this.secret).update(candidate.slice(7)).digest();
    const expected = createHmac("sha256", this.secret).update(this.adminToken).digest();
    return timingSafeEqual(supplied, expected);
  }

  private reserve(code: string, normalizedEmail: string): string {
    const now = this.now().toISOString();
    const invitation = this.database.prepare(`
      SELECT id, max_uses, use_count, expires_at, revoked_at
      FROM cloud_invitations WHERE code_hash = ?
    `).get(this.hashCode(code)) as InvitationRow | undefined;
    if (!invitation || invitation.revoked_at || invitation.expires_at <= now || invitation.use_count >= invitation.max_uses) {
      throw new InvitationError("INVITATION_INVALID", "Invitation is invalid, expired, revoked, or exhausted");
    }

    const reservationId = randomUUID();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        UPDATE cloud_invitations SET use_count = use_count + 1
        WHERE id = ? AND revoked_at IS NULL AND expires_at > ? AND use_count < max_uses
      `).run(invitation.id, now);
      if (result.changes !== 1) throw new InvitationError("INVITATION_INVALID", "Invitation is no longer available");
      this.database.prepare(`
        INSERT INTO cloud_invitation_redemptions(
          id, invitation_id, normalized_email, state, created_at, updated_at
        ) VALUES (?, ?, ?, 'pending', ?, ?)
      `).run(reservationId, invitation.id, normalizedEmail, now, now);
      this.database.exec("COMMIT");
      return reservationId;
    } catch (error) {
      this.database.exec("ROLLBACK");
      if (isUniqueConstraint(error)) {
        throw new InvitationError("ACCOUNT_ALREADY_INVITED", "This email already has an invitation redemption");
      }
      throw error;
    }
  }

  private release(reservationId: string): void {
    const row = this.database.prepare(`
      SELECT invitation_id FROM cloud_invitation_redemptions
      WHERE id = ? AND state = 'pending'
    `).get(reservationId) as { invitation_id: string } | undefined;
    if (!row) return;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        UPDATE cloud_invitation_redemptions
        SET state = 'released', updated_at = ?
        WHERE id = ? AND state = 'pending'
      `).run(this.now().toISOString(), reservationId);
      this.database.prepare(`
        UPDATE cloud_invitations SET use_count = MAX(0, use_count - 1) WHERE id = ?
      `).run(row.invitation_id);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private hashCode(code: string): string {
    return createHmac("sha256", this.secret).update(`invitation:${code}`).digest("hex");
  }
}

function isUniqueConstraint(error: unknown): boolean {
  return error instanceof Error && error.message.includes("UNIQUE constraint failed");
}
