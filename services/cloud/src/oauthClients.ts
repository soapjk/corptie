import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

const redirectUriSchema = z.url().refine((value) => {
  const url = new URL(value);
  if (url.hash || url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") return ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  return url.protocol === "corptie:";
}, "must use HTTPS, a loopback HTTP callback, or the corptie app scheme");

export const nativeOAuthClientInputSchema = z.object({
  clientId: z.string().min(3).max(100).regex(/^[A-Za-z0-9._:-]+$/),
  name: z.string().trim().min(1).max(100),
  redirectUris: z.array(redirectUriSchema).min(1).max(8)
});

export type NativeOAuthClientInput = z.infer<typeof nativeOAuthClientInputSchema>;

export interface NativeOAuthClient {
  clientId: string;
  name: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: "none";
  requirePKCE: true;
}

export class OAuthClientConflictError extends Error {
  readonly code = "OAUTH_CLIENT_CONFLICT";
}

export class NativeOAuthClientRegistry {
  private readonly scopes = [
    "openid",
    "profile",
    "email",
    "offline_access",
    "devices:read",
    "devices:write",
    "devices:manage",
    "connections:read",
    "connections:write"
  ];

  constructor(
    private readonly database: DatabaseSync,
    private readonly resourceIdentifier: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  register(unchecked: NativeOAuthClientInput): NativeOAuthClient {
    const input = nativeOAuthClientInputSchema.parse(unchecked);
    const redirectUris = [...new Set(input.redirectUris)].sort();
    const existing = this.database.prepare(`
      SELECT name, redirectUris, tokenEndpointAuthMethod, requirePKCE
      FROM oauthClient WHERE clientId = ?
    `).get(input.clientId) as {
      name: string | null;
      redirectUris: string;
      tokenEndpointAuthMethod: string | null;
      requirePKCE: number | null;
    } | undefined;
    if (existing) {
      const same = existing.name === input.name
        && JSON.stringify(JSON.parse(existing.redirectUris)) === JSON.stringify(redirectUris)
        && existing.tokenEndpointAuthMethod === "none"
        && existing.requirePKCE === 1;
      if (!same) throw new OAuthClientConflictError("OAuth client already exists with different immutable settings");
      return this.present(input.clientId, input.name, redirectUris);
    }

    const timestamp = this.now().toISOString();
    const internalId = randomUUID();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT OR IGNORE INTO oauthResource(
          id, identifier, name, accessTokenTtl, allowedScopes, disabled,
          createdAt, updatedAt, policyVersion
        ) VALUES (?, ?, 'Corptie API', 600, ?, 0, ?, ?, 1)
      `).run(randomUUID(), this.resourceIdentifier, JSON.stringify(this.scopes.filter((scope) => scope.includes(":"))), timestamp, timestamp);
      this.database.prepare(`
        INSERT INTO oauthClient(
          id, clientId, clientSecret, disabled, skipConsent, enableEndSession,
          subjectType, scopes, createdAt, updatedAt, name, redirectUris,
          tokenEndpointAuthMethod, applicationType, grantTypes, responseTypes,
          requirePKCE, dpopBoundAccessTokens
        ) VALUES (?, ?, NULL, 0, 1, 1, 'public', ?, ?, ?, ?, ?, 'none', 'native', ?, ?, 1, 0)
      `).run(
        internalId,
        input.clientId,
        JSON.stringify(this.scopes),
        timestamp,
        timestamp,
        input.name,
        JSON.stringify(redirectUris),
        JSON.stringify(["authorization_code", "refresh_token"]),
        JSON.stringify(["code"])
      );
      this.database.prepare(`
        INSERT INTO oauthClientResource(id, clientId, resourceId, createdAt)
        VALUES (?, ?, ?, ?)
      `).run(randomUUID(), input.clientId, this.resourceIdentifier, timestamp);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.present(input.clientId, input.name, redirectUris);
  }

  private present(clientId: string, name: string, redirectUris: string[]): NativeOAuthClient {
    return { clientId, name, redirectUris, tokenEndpointAuthMethod: "none", requirePKCE: true };
  }
}
