import { oauthProvider, verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";
import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { jwt } from "better-auth/plugins";
import type { DatabaseSync } from "node:sqlite";
import type { CloudConfig } from "./config.js";
import type { CloudMailer } from "./mail.js";
import { CloudDeviceService } from "./devices.js";
import type { AccountRevocationEvents } from "./accountSecurity.js";

export const CLOUD_RESOURCE_SCOPES = [
  "devices:read",
  "devices:write",
  "devices:manage",
  "connections:read",
  "connections:write"
] as const;

export interface CloudPrincipal {
  accountId: string;
  scopes: ReadonlySet<string>;
  reauthenticatedAt: Date | null;
}

export type PrincipalResolver = (request: Request, requiredScopes: readonly string[]) => Promise<CloudPrincipal>;

export interface InvitedUserInput {
  email: string;
  name: string;
  password: string;
}

export interface InvitedUser {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
}

export class AccountAlreadyExistsError extends Error {
  readonly code = "ACCOUNT_ALREADY_EXISTS";
}

export function createCloudAuth(
  config: CloudConfig,
  database: DatabaseSync,
  services: { mailer?: CloudMailer; revocations?: AccountRevocationEvents } = {}
) {
  const resourceIdentifier = `${config.publicBaseUrl}/v1`;
  // OAuth Provider 1.7.7 currently exposes a stricter OpenAPI metadata type
  // than Better Auth's plugin slot, although both packages share the same
  // runtime contract and synchronized release. Keep the cast at this boundary.
  const oauthPlugin = oauthProvider({
    loginPage: "/auth/sign-in",
    consentPage: "/auth/consent",
    scopes: ["openid", "profile", "email", "offline_access", ...CLOUD_RESOURCE_SCOPES],
    resources: [{
      identifier: resourceIdentifier,
      allowedScopes: [...CLOUD_RESOURCE_SCOPES],
      accessTokenTtl: 600
    }],
    resourceSeedMode: "insertOnly",
    enforcePerClientResources: true,
    clientRegistrationDefaultResources: [resourceIdentifier],
    grantTypes: ["authorization_code", "refresh_token"]
  }) as unknown as BetterAuthPlugin;

  const auth = betterAuth({
    appName: "Corptie",
    baseURL: config.publicBaseUrl,
    secret: config.authSecret,
    database,
    trustedOrigins: config.trustedOrigins,
    emailAndPassword: {
      enabled: true,
      // Invitation redemption will create accounts through a dedicated,
      // transactional endpoint. The generic public sign-up path stays closed.
      disableSignUp: true,
      requireEmailVerification: true,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        if (!services.mailer) throw new Error("Cloud mailer is not configured");
        await services.mailer.sendPasswordReset(user.email, url);
      },
      onPasswordReset: async ({ user }) => {
        revokeAccountAfterPasswordReset(database, user.id, services.revocations);
      }
    },
    emailVerification: {
      sendOnSignIn: true,
      sendVerificationEmail: async ({ user, url }) => {
        if (!services.mailer) throw new Error("Cloud mailer is not configured");
        await services.mailer.sendVerification(user.email, url);
      }
    },
    plugins: [
      jwt(),
      oauthPlugin
    ]
  });

  const resourceActions = oauthProviderResourceClient(auth).getActions();
  const provisionInvitedUser = async (input: InvitedUserInput): Promise<InvitedUser> => {
    const context = await auth.$context;
    const email = input.email.trim().toLowerCase();
    if (await context.internalAdapter.findUserByEmail(email)) {
      throw new AccountAlreadyExistsError("An account already exists for this email address");
    }
    const password = await context.password.hash(input.password);
    const user = await context.internalAdapter.createUser({
      email,
      name: input.name.trim(),
      emailVerified: false
    }, { method: "invitation" });
    if (!user) throw new Error("Better Auth did not create the invited user");
    try {
      await context.internalAdapter.linkAccount({
        userId: user.id,
        providerId: "credential",
        accountId: user.id,
        password
      });
    } catch (error) {
      await context.internalAdapter.deleteUser(user.id);
      throw error;
    }
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      emailVerified: user.emailVerified
    };
  };
  const resolvePrincipal: PrincipalResolver = async (request, requiredScopes) => {
    const authorization = request.headers.get("authorization");
    if (authorization?.startsWith("Bearer ")) {
      const payload = await resourceActions.verifyAccessTokenRequest(request, {
        verifyOptions: { audience: resourceIdentifier },
        requiredScopes
      });
      if (typeof payload.sub !== "string" || payload.sub.length === 0) {
        throw new AuthenticationError("Access token is missing a subject");
      }
      const authTime = typeof payload.auth_time === "number" ? new Date(payload.auth_time * 1_000) : null;
      return {
        accountId: payload.sub,
        scopes: new Set(readScopeClaim(payload.scope)),
        reauthenticatedAt: authTime
      };
    }

    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) throw new AuthenticationError("Authentication required");
    const missingScope = requiredScopes.find((scope) => !CLOUD_RESOURCE_SCOPES.includes(scope as typeof CLOUD_RESOURCE_SCOPES[number]));
    if (missingScope) throw new AuthorizationError(`Unsupported scope: ${missingScope}`);
    return {
      accountId: session.user.id,
      scopes: new Set(CLOUD_RESOURCE_SCOPES),
      reauthenticatedAt: new Date(session.session.createdAt)
    };
  };

  const verifyOAuthPageQuery = async (query: string): Promise<boolean> => {
    if (!query) return false;
    const context = await auth.$context;
    return verifyOAuthQueryParams(query, context.secret);
  };

  return { auth, resolvePrincipal, provisionInvitedUser, verifyOAuthPageQuery, resourceIdentifier };
}

export function revokeAccountAfterPasswordReset(
  database: DatabaseSync,
  accountId: string,
  revocations?: AccountRevocationEvents
): void {
  new CloudDeviceService(database).revokeAccount(accountId, "password_recovery");
  database.prepare('DELETE FROM "session" WHERE "userId" = ?').run(accountId);
  revocations?.publish(accountId);
}

function readScopeClaim(claim: unknown): string[] {
  if (typeof claim === "string") return claim.split(" ").filter(Boolean);
  if (Array.isArray(claim)) return claim.filter((value): value is string => typeof value === "string");
  return [];
}

export class AuthenticationError extends Error {
  readonly status = 401;
  readonly code = "AUTHENTICATION_REQUIRED";
}

export class AuthorizationError extends Error {
  readonly status = 403;
  readonly code = "AUTHORIZATION_DENIED";
}
