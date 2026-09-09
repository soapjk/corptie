import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CorptieStore, normalizedStoredProviderCapabilities } from "../src/store/corptieStore.mjs";
import { withSessionActions } from "../src/agent-provider/sessionActions.mjs";
import { AGENT_PROVIDER_CAPABILITIES } from "../src/agent-provider/contracts.mjs";

const supported = { capabilities: [AGENT_PROVIDER_CAPABILITIES.CONVERSATION_INTERRUPT] };

for (const provider of ["claude-sdk", "codex-app-server", "openclacky"]) {
  test(`${provider} preserves explicit interrupt availability through shared actions`, () => {
    for (const canInterrupt of [true, false]) {
      const capabilities = normalizedStoredProviderCapabilities(provider, "running", { canInterrupt });
      const session = withSessionActions({ status: "running", capabilities }, supported);
      assert.equal(session.actions.interrupt.available, canInterrupt);
    }
  });
}

test("Claude missing or invalid interrupt capability remains fail-closed", () => {
  for (const persisted of [null, {}, { canInterrupt: "true" }]) {
    assert.equal(normalizedStoredProviderCapabilities("claude-sdk", "running", persisted).canInterrupt, false);
  }
  const session = withSessionActions({ status: "running", capabilities: { canInterrupt: true } }, { capabilities: [] });
  assert.equal(session.actions.interrupt.available, false);
});

test("real stored Claude Session exposes Stop while active and hides it after settlement and reload", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-interrupt-projection-"));
  const options = { dbPath: join(directory, "db.sqlite"), configPath: join(directory, "config.json") };
  let store = new CorptieStore(options);
  try {
    await store.initialize();
    for (const [status, canInterrupt] of [["running", true], ["blocked", true], ["complete", false], ["cancelled", false], ["failed", false]]) {
      store.upsertSession({ id: "pty:interrupt-test", provider: "claude-sdk", title: "Stop test",
        sessionKind: "assistantChat", status, capabilities: { canInterrupt },
        external: { provider: "claude-sdk", sessionId: "interrupt-test", threadId: "interrupt-test" } });
      const stored = store.getSession("pty:interrupt-test");
      assert.equal(stored.capabilities.canInterrupt, canInterrupt, status);
      assert.equal(withSessionActions(stored, supported).actions.interrupt.available, canInterrupt, status);
    }
    await store.close();
    store = new CorptieStore(options);
    await store.initialize();
    assert.equal(withSessionActions(store.getSession("pty:interrupt-test"), supported).actions.interrupt.available, false);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
