import assert from "node:assert/strict";
import test from "node:test";
import { connectCodexComputerUseRuntime } from "../src/adapters/codexComputerUseRuntime.mjs";

test("official tool host makes no model call and never leaks its native tools to the conversation", async () => {
  const requests = [], replies = [], elicited = [];
  let options;
  const transport = { initialize: async () => {}, close: async () => {},
    respondToServerRequest: async (...args) => replies.push(args),
    rejectUnsupportedRequest: id => replies.push([id, "unsupported"]),
    request: async (method, params) => {
      requests.push({ method, params });
      if (method === "thread/start") return { thread: { id: "private-tool-host" } };
      if (method === "mcpServerStatus/list") return { data: [{ name: "node_repl", runtimeStatus: "connected", tools: {
        js: { name: "js", inputSchema: { type: "object" } }
      } }] };
      return { content: [{ type: "text", text: "done" }] };
    } };
  const client = await connectCodexComputerUseRuntime({ cwd: "/isolated", command: "/official/node_repl", env: { CODEX_HOME: "/isolated" } }, {
    command: "/official/codex", transportFactory: input => { options = input; return transport; },
    onElicitation: async (owner, request) => { elicited.push({ owner, request }); return { action: "decline" }; }
  });
  try {
    assert.equal((await client.listTools()).tools[0].name, "js");
    const beforeConflict = requests.length;
    await assert.rejects(client.callTool({ name: "js", arguments: { code: "inspect" },
      _meta: { "x-codex-turn-metadata": { thread_id: "source-conversation", turn_id: "source-turn", call_id: "source-call" } }
    }), { code: "COMPUTER_USE_TURN_BINDING_UNSUPPORTED" });
    assert.equal(requests.length, beforeConflict, "Foreign Turn identity must be rejected before dispatch, never stripped or rebound.");
    const controller = new AbortController();
    await client.callTool({ name: "js", arguments: { code: "inspect" } }, undefined, { signal: controller.signal });
    await options.onServerRequest({ id: 1, method: "mcpServer/elicitation/request", params: { threadId: "private-tool-host" } });
    await options.onServerRequest({ id: 2, method: "mcpServer/elicitation/request", params: { threadId: "other-host" } });
    assert.equal(elicited[0].owner, client);
    assert.deepEqual(replies, [[1, { action: "decline" }], [2, "unsupported"]]);
    assert.equal(requests.some(request => request.method === "turn/start"), false);
    assert.equal(requests[0].params.ephemeral, true);
    assert.equal(requests[0].params.config["features.apps"], false);
    assert.equal(options.env.CODEX_HOME, "/isolated");
    controller.abort();
    await assert.rejects(client.callTool({ name: "js" }, undefined, { signal: controller.signal }));
  } finally { await client.close(); }
});
