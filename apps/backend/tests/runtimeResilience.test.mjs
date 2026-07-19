import assert from "node:assert/strict";
import test from "node:test";
import { collaborationMcpServerName } from "../src/utils/collaborationRuntime.mjs";
import { choiceParserBackoffKey, choiceParserRetryDelayMs } from "../src/utils/choiceParserBackoff.mjs";

test("collaboration MCP names are stable and isolated per Agent", () => {
  assert.equal(collaborationMcpServerName("agent-a"), collaborationMcpServerName("agent-a"));
  assert.notEqual(collaborationMcpServerName("agent-a"), collaborationMcpServerName("agent-b"));
  assert.match(collaborationMcpServerName("agent-a"), /^corptie-collaboration-[a-f0-9]{12}$/);
});

test("choice parser rate limits receive a long provider backoff", () => {
  assert.equal(choiceParserRetryDelayMs(new Error("HTTP 429 inference limit")), 5 * 60 * 1000);
  assert.equal(choiceParserRetryDelayMs(new Error("connection reset")), 30 * 1000);
  assert.equal(
    choiceParserBackoffKey({ provider: "openai", openaiModel: "model-a", openaiEndpoint: "https://example.test" }),
    choiceParserBackoffKey({ provider: "openai", openaiModel: "model-a", openaiEndpoint: "https://example.test" })
  );
});
