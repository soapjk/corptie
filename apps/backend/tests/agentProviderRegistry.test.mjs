import assert from "node:assert/strict";
import test from "node:test";
import { AgentProviderRegistry } from "../src/agent-provider/agentProviderRegistry.mjs";
import {
  AGENT_PROVIDER_CAPABILITIES,
  AgentProviderCapabilityError,
  AgentProviderContractError,
  AgentProviderNotFoundError
} from "../src/agent-provider/contracts.mjs";

function fakeProvider(overrides = {}) {
  const sessions = overrides.sessions ?? [];
  return {
    descriptor: {
      id: overrides.id ?? "fake.provider",
      displayName: overrides.displayName ?? "Fake Provider",
      transport: overrides.transport ?? "fake",
      aliases: overrides.aliases ?? [],
      runtime: overrides.runtime,
      configuration: overrides.configuration,
      capabilities: overrides.capabilities ?? [
        AGENT_PROVIDER_CAPABILITIES.CONVERSATION_SEND,
        AGENT_PROVIDER_CAPABILITIES.CONVERSATION_INTERRUPT
      ]
    },
    listSessions() { return sessions; },
    async readSession(reference) { return { id: reference.providerSessionId }; },
    async send(reference, message) { return { reference, message }; },
    async interrupt(reference) { return { reference, interrupted: true }; },
    ...overrides.methods
  };
}

test("registry validates capability implementations when registering a Provider", () => {
  const provider = fakeProvider({
    capabilities: [AGENT_PROVIDER_CAPABILITIES.BACKGROUND_PROMPT]
  });
  assert.throws(
    () => new AgentProviderRegistry([provider]),
    (error) => error instanceof AgentProviderContractError
      && error.details.capability === AGENT_PROVIDER_CAPABILITIES.BACKGROUND_PROMPT
  );
});

test("registry rejects duplicate Provider ids", () => {
  const registry = new AgentProviderRegistry([fakeProvider()]);
  assert.throws(
    () => registry.register(fakeProvider()),
    (error) => error instanceof AgentProviderContractError
  );
});

test("registry resolves Provider aliases and a declared default without product branching", () => {
  const registry = new AgentProviderRegistry([
    fakeProvider({ id: "provider.codex", aliases: ["codex", "CODEX-LEGACY"] })
  ], { defaultProviderId: "codex" });

  assert.equal(registry.resolveId("codex"), "provider.codex");
  assert.equal(registry.resolveId("CODEX-LEGACY"), "provider.codex");
  assert.equal(registry.resolveId("", { useDefault: true }), "provider.codex");
  assert.equal(registry.get("codex").descriptor.id, "provider.codex");
});

test("registry rejects aliases owned by another Provider", () => {
  assert.throws(
    () => new AgentProviderRegistry([
      fakeProvider({ id: "provider.a", aliases: ["shared"] }),
      fakeProvider({ id: "provider.b", aliases: ["shared"] })
    ]),
    (error) => error instanceof AgentProviderContractError
      && error.details.identity === "shared"
      && error.details.existingProviderId === "provider.a"
  );
});

test("Provider descriptors expose normalized runtime and configuration metadata", () => {
  const registry = new AgentProviderRegistry([
    fakeProvider({
      id: "provider.http",
      aliases: ["HTTP-Agent"],
      runtime: { lifecycle: "hybrid", healthPath: "/health" },
      configuration: {
        fields: [
          { id: "baseUrl", type: "url", default: "http://127.0.0.1:7070" },
          { id: "accessKey", type: "secret", optional: true }
        ]
      }
    })
  ]);
  const descriptor = registry.descriptors()[0];

  assert.deepEqual(descriptor.aliases, ["http-agent"]);
  assert.equal(descriptor.runtime.lifecycle, "hybrid");
  assert.equal(descriptor.runtime.healthPath, "/health");
  assert.deepEqual(descriptor.configuration.fields.map((field) => field.id), ["baseUrl", "accessKey"]);
});

test("registry invokes declared capabilities through the common contract", async () => {
  const registry = new AgentProviderRegistry([fakeProvider()]);
  const reference = { providerSessionId: "session-a" };
  assert.deepEqual(
    await registry.invoke(
      "fake.provider",
      AGENT_PROVIDER_CAPABILITIES.CONVERSATION_SEND,
      reference,
      "hello"
    ),
    { reference, message: "hello" }
  );
});

test("registry returns a structured error for unsupported capabilities", () => {
  const registry = new AgentProviderRegistry([fakeProvider()]);
  assert.throws(
    () => registry.requireCapability("fake.provider", AGENT_PROVIDER_CAPABILITIES.MODEL_SWITCH),
    (error) => error instanceof AgentProviderCapabilityError
      && error.code === "CAPABILITY_UNSUPPORTED"
      && error.providerId === "fake.provider"
  );
});

test("registry returns a structured error for unknown Providers", () => {
  const registry = new AgentProviderRegistry();
  assert.throws(
    () => registry.get("missing.provider"),
    (error) => error instanceof AgentProviderNotFoundError
      && error.code === "AGENT_PROVIDER_NOT_FOUND"
  );
});

test("registry exposes Provider descriptors without a product Session read surface", async () => {
  const registry = new AgentProviderRegistry([
    fakeProvider({
      id: "provider.b",
      sessions: [{ id: "logical-b", updatedAt: "2026-08-08T01:00:00.000Z", pinned: false }]
    }),
    fakeProvider({
      id: "provider.a",
      sessions: [{ id: "logical-a", updatedAt: "2026-08-08T00:00:00.000Z", pinned: true }]
    })
  ]);
  assert.equal(typeof registry.listSessions, "undefined");
  assert.equal(typeof registry.listSessionsSync, "undefined");
  assert.deepEqual(registry.descriptors().map((descriptor) => descriptor.id), ["provider.a", "provider.b"]);
});
