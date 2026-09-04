import assert from "node:assert/strict";
import test from "node:test";
import { SkillMcpGateway } from "../src/application/skillMcpGateway.mjs";

function fakeClient(name, closed) {
  return {
    listTools: async () => ({
      tools: [{
        name: `${name}_lookup`, description: `Lookup through ${name}`,
        inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }
      }]
    }),
    callTool: async (input) => ({ content: [{ type: "text", text: `${name}:${input.arguments.id}` }] }),
    close: async () => { closed.push(name); }
  };
}

test("Skill MCP gateway hot-swaps assigned servers without changing a Provider binding", async () => {
  let servers = {};
  let revision = "none";
  const closed = [];
  const gateway = new SkillMcpGateway({
    resolveServers: async () => servers,
    resolveRevision: () => revision,
    connectServer: async (name) => fakeClient(name, closed)
  });
  try {
    assert.deepEqual(await gateway.definitions({ actorId: "agent:1", providerId: "provider:1" }), []);
    servers = { investrace: { type: "stdio", command: "ignored" } };
    revision = "assigned";
    assert.equal(gateway.revision("agent:1"), "assigned");
    assert.deepEqual(
      (await gateway.definitions({ actorId: "agent:1", providerId: "provider:1" })).map((tool) => tool.name),
      ["investrace_lookup"]
    );
    const result = await gateway.execute({
      actorId: "agent:1", metadata: { providerId: "provider:1" },
      tool: "investrace_lookup", arguments: { id: "NVDA" }
    });
    assert.equal(result.content[0].text, "investrace:NVDA");
    servers = {};
    await assert.rejects(() => gateway.execute({
      actorId: "agent:1", metadata: { providerId: "provider:1" },
      tool: "investrace_lookup", arguments: { id: "NVDA" }
    }), { code: "HOST_TOOL_UNSUPPORTED" });
    assert.deepEqual(closed, ["investrace"]);
  } finally {
    await gateway.close();
  }
});

test("Skill MCP gateway rejects duplicate tool names across assigned packages", async () => {
  const gateway = new SkillMcpGateway({
    resolveServers: async () => ({ first: {}, second: {} }),
    connectServer: async () => ({
      listTools: async () => ({ tools: [{ name: "duplicate", inputSchema: { type: "object" } }] }),
      close: async () => {}
    })
  });
  try {
    await assert.rejects(
      () => gateway.definitions({ actorId: "agent:1", providerId: "provider:1" }),
      { code: "MCP_TOOL_NAME_CONFLICT" }
    );
  } finally {
    await gateway.close();
  }
});
