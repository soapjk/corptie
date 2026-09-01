import assert from "node:assert/strict";
import test from "node:test";
import {
  collaborationMcpEnvironment,
  collaborationMcpServerName
} from "../src/utils/collaborationRuntime.mjs";
import { choiceParserBackoffKey, choiceParserRetryDelayMs } from "../src/utils/choiceParserBackoff.mjs";

test("collaboration MCP names are stable and isolated per Agent", () => {
  assert.equal(collaborationMcpServerName("agent-a"), collaborationMcpServerName("agent-a"));
  assert.notEqual(collaborationMcpServerName("agent-a"), collaborationMcpServerName("agent-b"));
  assert.match(collaborationMcpServerName("agent-a"), /^ctc-[a-f0-9]{12}$/);
  assert.ok(
    `mcp__${collaborationMcpServerName("agent-a").replaceAll("-", "_")}__corptie_collaboration_request`.length < 64,
    "the longest collaboration tool name must remain below the provider boundary"
  );
});

test("collaboration MCP environment preserves authenticated Session scope", () => {
  assert.deepEqual(collaborationMcpEnvironment({
    agentId: "agent:owner",
    backendUrl: "http://127.0.0.1:47321",
    environmentName: "production",
    metadata: {
      sessionId: "codex:thread-one",
      providerBindingId: "binding:thread-one",
      sessionKind: "objectiveChat",
      objectiveId: "objective:one",
      taskId: null
    }
  }), {
    CORPTIE_AGENT_ID: "agent:owner",
    CORPTIE_BACKEND_URL: "http://127.0.0.1:47321",
    CORPTIE_ENV: "production",
    CORPTIE_SESSION_ID: "codex:thread-one",
    CORPTIE_PROVIDER_BINDING_ID: "binding:thread-one",
    CORPTIE_SESSION_KIND: "objectiveChat",
    CORPTIE_OBJECTIVE_ID: "objective:one",
    CORPTIE_TASK_ID: "",
    CORPTIE_OBJECTIVE_CHAT_ID: "objective:one",
    CORPTIE_OBJECTIVE_CHAT_SESSION_ID: "codex:thread-one"
  });
});

test("choice parser rate limits receive a long provider backoff", () => {
  assert.equal(choiceParserRetryDelayMs(new Error("HTTP 429 inference limit")), 5 * 60 * 1000);
  assert.equal(choiceParserRetryDelayMs(new Error("connection reset")), 30 * 1000);
  assert.equal(
    choiceParserBackoffKey({ provider: "openai", openaiModel: "model-a", openaiEndpoint: "https://example.test" }),
    choiceParserBackoffKey({ provider: "openai", openaiModel: "model-a", openaiEndpoint: "https://example.test" })
  );
});
