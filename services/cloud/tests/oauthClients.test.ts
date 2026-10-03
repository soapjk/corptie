import assert from "node:assert/strict";
import test from "node:test";
import { openCloudDatabase } from "../src/database.js";
import { NativeOAuthClientRegistry, OAuthClientConflictError } from "../src/oauthClients.js";

test("registers a secretless native OAuth client with PKCE and exact resource binding", () => {
  const database = openCloudDatabase(":memory:");
  try {
    const registry = new NativeOAuthClientRegistry(database, "https://corptie.example.test/v1");
    const input = {
      clientId: "corptie-ios",
      name: "Corptie iOS",
      redirectUris: ["corptie://oauth/callback"]
    };
    const client = registry.register(input);
    assert.equal(client.tokenEndpointAuthMethod, "none");
    assert.equal(client.requirePKCE, true);
    assert.deepEqual(registry.register(input), client);

    const row = database.prepare(`
      SELECT clientSecret, tokenEndpointAuthMethod, requirePKCE, redirectUris
      FROM oauthClient WHERE clientId = ?
    `).get(input.clientId) as {
      clientSecret: string | null;
      tokenEndpointAuthMethod: string;
      requirePKCE: number;
      redirectUris: string;
    };
    assert.equal(row.clientSecret, null);
    assert.equal(row.tokenEndpointAuthMethod, "none");
    assert.equal(row.requirePKCE, 1);
    assert.deepEqual(JSON.parse(row.redirectUris), input.redirectUris);
    assert.equal((database.prepare(`
      SELECT resourceId FROM oauthClientResource WHERE clientId = ?
    `).get(input.clientId) as { resourceId: string }).resourceId, "https://corptie.example.test/v1");
  } finally {
    database.close();
  }
});

test("refuses silent native OAuth client mutation and unsafe callbacks", () => {
  const database = openCloudDatabase(":memory:");
  try {
    const registry = new NativeOAuthClientRegistry(database, "https://corptie.example.test/v1");
    registry.register({ clientId: "corptie-macos", name: "Corptie macOS", redirectUris: ["corptie://oauth/callback"] });
    assert.throws(() => registry.register({
      clientId: "corptie-macos",
      name: "Changed",
      redirectUris: ["https://attacker.example.test/callback"]
    }), OAuthClientConflictError);
    assert.throws(() => registry.register({
      clientId: "bad-client",
      name: "Bad",
      redirectUris: ["http://attacker.example.test/callback"]
    }));
  } finally {
    database.close();
  }
});
