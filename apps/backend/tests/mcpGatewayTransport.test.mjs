import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SkillMcpGateway } from "../src/application/skillMcpGateway.mjs";

test("stdio gateway negotiates real MCP elicitation and returns an explicit rejection", async () => {
  const requests = [];
  const gateway = new SkillMcpGateway({
    resolveServers: async () => ({ fixture: { type: "stdio", command: process.execPath,
      args: [fileURLToPath(new URL("./fixtures/elicitingMcpServer.mjs", import.meta.url))] } }),
    onElicitation: async request => { requests.push(request); return { action: "decline" }; }
  });
  try {
    const result = await gateway.execute({ actorId: "role", providerId: "provider", tool: "confirm",
      metadata: { logicalSessionId: "session", providerBindingId: "binding", turnId: "real-turn" } });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].metadata.logicalSessionId, "session");
    assert.equal(requests[0].request._meta.tool_params.app, "fixture.app");
    assert.equal(JSON.parse(result.content[0].text).action, "decline");
  } finally { await gateway.close(); }
});
