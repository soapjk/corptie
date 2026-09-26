import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createMcpSecretStore } from "../src/application/mcpSecretStore.mjs";

test("MCP Keychain adapter scopes accounts by data root and never exposes values in errors", () => {
  const saved = new Map();
  const native = {
    mcpKeychainPut(service, account, bytes) { saved.set(`${service}:${account}`, Buffer.from(bytes)); },
    mcpKeychainGet(service, account) { return saved.get(`${service}:${account}`) ?? null; },
    mcpKeychainDelete(service, account) { saved.delete(`${service}:${account}`); }
  };
  const account = "mcp:00000000-0000-4000-8000-000000000001:1";
  const first = createMcpSecretStore({ dataRoot: "/tmp/corptie-a", native });
  const second = createMcpSecretStore({ dataRoot: "/tmp/corptie-b", native });
  first.put(account, { headers: { Authorization: "Bearer secret-value" } });
  assert.deepEqual(first.get(account), { headers: { Authorization: "Bearer secret-value" } });
  assert.equal(second.get(account), null);
  first.delete(account);
  assert.equal(first.get(account), null);
  assert.equal(saved.size, 0);
  assert.throws(() => first.put("bad-account", { headers: { Authorization: "secret-value" } }),
    (error) => error.code === "MCP_CREDENTIAL_REF_INVALID" && !error.message.includes("secret-value"));
});

test("native MCP Keychain stores, reads, and removes a disposable credential", {
  skip: process.platform !== "darwin" || process.env.CORPTIE_RUN_KEYCHAIN_SMOKE !== "1"
}, () => {
  const account = `mcp:${randomUUID()}:1`;
  const store = createMcpSecretStore({ dataRoot: "/private/tmp/corptie-mcp-keychain-smoke" });
  const credential = { headers: { "X-Corptie-Smoke": "disposable-test-value" } };
  let written = false;
  try {
    store.put(account, credential);
    written = true;
    assert.deepEqual(store.get(account), credential);
  } finally {
    if (written) store.delete(account);
    else try { store.delete(account); } catch { /* preserve the original write failure */ }
  }
  assert.equal(store.get(account), null);
});
