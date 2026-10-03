// Generated from Better Auth 1.7.7 with `npm run auth:schema:generate`.
// Keep this migration immutable; future schema changes get a new migration.
export const betterAuthSchemaV1 = `
CREATE TABLE IF NOT EXISTS "user" ("id" TEXT NOT NULL PRIMARY KEY, "name" TEXT NOT NULL, "email" TEXT NOT NULL UNIQUE, "emailVerified" INTEGER NOT NULL, "image" TEXT, "createdAt" DATE NOT NULL, "updatedAt" DATE NOT NULL);
CREATE TABLE IF NOT EXISTS "session" ("id" TEXT NOT NULL PRIMARY KEY, "expiresAt" DATE NOT NULL, "token" TEXT NOT NULL UNIQUE, "createdAt" DATE NOT NULL, "updatedAt" DATE NOT NULL, "ipAddress" TEXT, "userAgent" TEXT, "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS "account" ("id" TEXT NOT NULL PRIMARY KEY, "accountId" TEXT NOT NULL, "providerId" TEXT NOT NULL, "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE, "accessToken" TEXT, "refreshToken" TEXT, "idToken" TEXT, "accessTokenExpiresAt" DATE, "refreshTokenExpiresAt" DATE, "scope" TEXT, "password" TEXT, "createdAt" DATE NOT NULL, "updatedAt" DATE NOT NULL);
CREATE TABLE IF NOT EXISTS "verification" ("id" TEXT NOT NULL PRIMARY KEY, "identifier" TEXT NOT NULL, "value" TEXT NOT NULL, "expiresAt" DATE NOT NULL, "createdAt" DATE NOT NULL, "updatedAt" DATE NOT NULL);
CREATE TABLE IF NOT EXISTS "jwks" ("id" TEXT NOT NULL PRIMARY KEY, "publicKey" TEXT NOT NULL, "privateKey" TEXT NOT NULL, "createdAt" DATE NOT NULL, "expiresAt" DATE, "alg" TEXT, "crv" TEXT);
CREATE TABLE IF NOT EXISTS "oauthClient" ("id" TEXT NOT NULL PRIMARY KEY, "clientId" TEXT NOT NULL UNIQUE, "clientSecret" TEXT, "clientDiscoveryId" TEXT, "disabled" INTEGER, "skipConsent" INTEGER, "enableEndSession" INTEGER, "subjectType" TEXT, "scopes" TEXT, "clientCredentialsScopes" TEXT, "userId" TEXT REFERENCES "user" ("id") ON DELETE CASCADE, "createdAt" DATE, "updatedAt" DATE, "name" TEXT, "uri" TEXT, "icon" TEXT, "contacts" TEXT, "tos" TEXT, "policy" TEXT, "softwareId" TEXT, "softwareVersion" TEXT, "softwareStatement" TEXT, "redirectUris" TEXT NOT NULL, "postLogoutRedirectUris" TEXT, "backchannelLogoutUri" TEXT, "backchannelLogoutSessionRequired" INTEGER, "tokenEndpointAuthMethod" TEXT, "applicationType" TEXT, "jwks" TEXT, "jwksUri" TEXT, "grantTypes" TEXT, "responseTypes" TEXT, "requirePKCE" INTEGER, "dpopBoundAccessTokens" INTEGER, "referenceId" TEXT, "metadata" TEXT);
CREATE TABLE IF NOT EXISTS "oauthResource" ("id" TEXT NOT NULL PRIMARY KEY, "identifier" TEXT NOT NULL UNIQUE, "name" TEXT NOT NULL, "accessTokenTtl" INTEGER, "refreshTokenTtl" INTEGER, "signingAlgorithm" TEXT, "signingKeyId" TEXT, "allowedScopes" TEXT, "customClaims" TEXT, "dpopBoundAccessTokensRequired" INTEGER, "disabled" INTEGER, "createdAt" DATE, "updatedAt" DATE, "policyVersion" INTEGER, "metadata" TEXT);
CREATE TABLE IF NOT EXISTS "oauthClientResource" ("id" TEXT NOT NULL PRIMARY KEY, "clientId" TEXT NOT NULL REFERENCES "oauthClient" ("clientId") ON DELETE CASCADE, "resourceId" TEXT NOT NULL REFERENCES "oauthResource" ("identifier") ON DELETE CASCADE, "metadata" TEXT, "createdAt" DATE);
CREATE TABLE IF NOT EXISTS "oauthRefreshToken" ("id" TEXT NOT NULL PRIMARY KEY, "token" TEXT NOT NULL UNIQUE, "clientId" TEXT NOT NULL REFERENCES "oauthClient" ("clientId") ON DELETE CASCADE, "sessionId" TEXT REFERENCES "session" ("id") ON DELETE SET NULL, "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE, "referenceId" TEXT, "authorizationCodeId" TEXT, "resources" TEXT, "requestedUserInfoClaims" TEXT, "expiresAt" DATE NOT NULL, "createdAt" DATE NOT NULL, "revoked" DATE, "rotatedAt" DATE, "rotationReplayResponse" TEXT, "rotationReplayExpiresAt" DATE, "authTime" DATE, "confirmation" TEXT, "scopes" TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS "oauthAccessToken" ("id" TEXT NOT NULL PRIMARY KEY, "token" TEXT NOT NULL UNIQUE, "clientId" TEXT NOT NULL REFERENCES "oauthClient" ("clientId") ON DELETE CASCADE, "sessionId" TEXT REFERENCES "session" ("id") ON DELETE SET NULL, "userId" TEXT REFERENCES "user" ("id") ON DELETE CASCADE, "referenceId" TEXT, "authorizationCodeId" TEXT, "resources" TEXT, "requestedUserInfoClaims" TEXT, "refreshId" TEXT REFERENCES "oauthRefreshToken" ("id") ON DELETE CASCADE, "expiresAt" DATE NOT NULL, "createdAt" DATE NOT NULL, "revoked" DATE, "confirmation" TEXT, "scopes" TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS "oauthConsent" ("id" TEXT NOT NULL PRIMARY KEY, "clientId" TEXT NOT NULL REFERENCES "oauthClient" ("clientId") ON DELETE CASCADE, "userId" TEXT REFERENCES "user" ("id") ON DELETE CASCADE, "referenceId" TEXT, "resources" TEXT, "requestedUserInfoClaims" TEXT, "scopes" TEXT NOT NULL, "createdAt" DATE NOT NULL, "updatedAt" DATE NOT NULL);
CREATE TABLE IF NOT EXISTS "oauthClientAssertion" ("id" TEXT NOT NULL PRIMARY KEY, "expiresAt" DATE NOT NULL);
CREATE INDEX IF NOT EXISTS "session_userId_idx" ON "session" ("userId");
CREATE INDEX IF NOT EXISTS "account_userId_idx" ON "account" ("userId");
CREATE INDEX IF NOT EXISTS "verification_identifier_idx" ON "verification" ("identifier");
CREATE INDEX IF NOT EXISTS "oauthClient_userId_idx" ON "oauthClient" ("userId");
CREATE INDEX IF NOT EXISTS "oauthClientResource_clientId_idx" ON "oauthClientResource" ("clientId");
CREATE INDEX IF NOT EXISTS "oauthClientResource_resourceId_idx" ON "oauthClientResource" ("resourceId");
CREATE INDEX IF NOT EXISTS "oauthRefreshToken_clientId_idx" ON "oauthRefreshToken" ("clientId");
CREATE INDEX IF NOT EXISTS "oauthRefreshToken_sessionId_idx" ON "oauthRefreshToken" ("sessionId");
CREATE INDEX IF NOT EXISTS "oauthRefreshToken_userId_idx" ON "oauthRefreshToken" ("userId");
CREATE INDEX IF NOT EXISTS "oauthRefreshToken_authorizationCodeId_idx" ON "oauthRefreshToken" ("authorizationCodeId");
CREATE INDEX IF NOT EXISTS "oauthAccessToken_clientId_idx" ON "oauthAccessToken" ("clientId");
CREATE INDEX IF NOT EXISTS "oauthAccessToken_sessionId_idx" ON "oauthAccessToken" ("sessionId");
CREATE INDEX IF NOT EXISTS "oauthAccessToken_userId_idx" ON "oauthAccessToken" ("userId");
CREATE INDEX IF NOT EXISTS "oauthAccessToken_authorizationCodeId_idx" ON "oauthAccessToken" ("authorizationCodeId");
CREATE INDEX IF NOT EXISTS "oauthAccessToken_refreshId_idx" ON "oauthAccessToken" ("refreshId");
CREATE INDEX IF NOT EXISTS "oauthConsent_clientId_idx" ON "oauthConsent" ("clientId");
CREATE INDEX IF NOT EXISTS "oauthConsent_userId_idx" ON "oauthConsent" ("userId");
CREATE UNIQUE INDEX IF NOT EXISTS "oauthClientResource_clientId_resourceId_uidx" ON "oauthClientResource" ("clientId", "resourceId");
`;
