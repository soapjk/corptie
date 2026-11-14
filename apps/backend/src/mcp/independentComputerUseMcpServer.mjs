import { pathToFileURL } from "node:url";
import { mkdir } from "node:fs/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { IndependentComputerUseClient } from "./independentComputerUseClient.mjs";

export const COMPUTER_USE_SCHEMA = {
  type: "object", additionalProperties: false, required: ["action"],
  properties: {
    action: { type: "string", enum: ["status", "apps", "windows", "read", "screenshot", "click", "type", "key", "scroll"] },
    pid: { type: "integer", minimum: 1, maximum: 2147483647 },
    windowId: { type: "integer", minimum: 1, maximum: 4294967295 },
    element: { type: "array", maxItems: 24, items: { type: "integer", minimum: 0, maximum: 10000 } },
    text: { type: "string", maxLength: 10000 },
    key: { type: "string", enum: ["return", "tab", "escape", "space", "delete", "forwardDelete", "left", "right", "up", "down", "home", "end", "pageUp", "pageDown", "a", "c", "v", "x", "z", "s", "f", "l", "n", "t", "w", "r"] },
    modifiers: { type: "array", uniqueItems: true, maxItems: 4, items: { type: "string", enum: ["command", "shift", "option", "control"] } },
    x: { type: "number" }, y: { type: "number" },
    deltaX: { type: "integer", minimum: -2000, maximum: 2000 },
    deltaY: { type: "integer", minimum: -2000, maximum: 2000 }
  }
};
export function validateComputerUseArguments(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Arguments must be an object");
  for (const [key, value] of Object.entries(args)) {
    const rule = COMPUTER_USE_SCHEMA.properties[key];
    if (!rule) throw new Error(`Unknown argument: ${key}`);
    if (rule.type === "integer" && (!Number.isInteger(value) || value < rule.minimum || value > rule.maximum)) throw new Error(`Invalid ${key}`);
    if (rule.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) throw new Error(`Invalid ${key}`);
    if (rule.type === "string" && (typeof value !== "string" || value.length > (rule.maxLength ?? Infinity))) throw new Error(`Invalid ${key}`);
    if (rule.enum && !rule.enum.includes(value)) throw new Error(`Invalid ${key}`);
    if (rule.type === "array" && (!Array.isArray(value) || value.length > rule.maxItems || value.some(v => rule.items.enum ? !rule.items.enum.includes(v) : !Number.isInteger(v) || v < 0 || v > 10000))) throw new Error(`Invalid ${key}`);
  }
  if (!COMPUTER_USE_SCHEMA.properties.action.enum.includes(args.action)) throw new Error("Invalid action");
  if (!["status", "apps"].includes(args.action) && !args.pid) throw new Error("pid is required");
  if (!["status", "apps", "windows"].includes(args.action) && !args.windowId) throw new Error("windowId is required");
  if (args.action === "click" && !args.element && !(Number.isFinite(args.x) && Number.isFinite(args.y))) throw new Error("click requires element or window-relative x/y");
  if (args.action === "type" && typeof args.text !== "string") throw new Error("type requires text");
  if (args.action === "key" && !args.key) throw new Error("key is required");
  return args;
}
export function createIndependentComputerUseMcpServer({ client, approve } = {}) {
  // The enclosing desktop facade closes this host at the Turn boundary.
  // One grant covers this target for that host, never unrelated PIDs or later Turns.
  const approvedTargets = new Set();
  const server = new Server({ name: "corptie-independent-computer-use", version: "1.0.0" }, {
    capabilities: { tools: {} },
    instructions: "Corptie native macOS Computer Use. Select an explicit PID/window. Coordinates are window-relative logical points. AX paths are ephemeral; read again after UI changes. The helper never explicitly activates targets; applications may activate in reaction to actions. Unsupported controls fail explicitly. Click uses AXPress. Type with an element replaces its AX value; without an element it posts Unicode to the app-focused window. Keyboard/scroll posting reports unverified delivery until a follow-up read. Status only checks permissions; approved first use can request missing macOS permissions."
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{
    name: "computer_use", description: "Inspect or operate a selected macOS application window using Corptie's signed native helper. First access to each target in this Turn requires approval. No clipboard or model calls.",
    inputSchema: COMPUTER_USE_SCHEMA
  }] }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      if (request.params.name !== "computer_use") throw new Error("Unknown tool");
      const args = validateComputerUseArguments(request.params.arguments);
      extra.signal.throwIfAborted();
      const target = args.pid ?? "application-list";
      if (args.action !== "status" && !approvedTargets.has(target)) {
        const prompt = { mode: "form", message: args.pid
          ? `Allow Computer Use to read and operate PID ${args.pid} in this Turn${args.windowId ? `, starting with window ${args.windowId}` : ""}?`
          : "Allow Computer Use to list running applications in this Turn?",
          requestedSchema: { type: "object", properties: { allow: { type: "boolean", title: "Allow this target for this Turn", default: false } }, required: ["allow"] } };
        const approval = approve ? await approve(prompt, extra.signal) : await server.elicitInput(prompt, { signal: extra.signal });
        if (approval?.action !== "accept" || approval.content?.allow !== true) throw new Error("Computer Use approval denied");
        extra.signal.throwIfAborted();
        approvedTargets.add(target);
      }
      extra.signal.throwIfAborted();
      const { action, ...params } = args;
      const result = await client.call(action, params, { signal: extra.signal });
      const { image, ...metadata } = result;
      const content = [{ type: "text", text: JSON.stringify(metadata) }];
      if (image) content.push({ type: "image", mimeType: "image/png", data: image });
      return { content };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error.message }] };
    }
  });
  server.onclose = () => client.close();
  return server;
}
async function main() {
  const stateRoot = process.env.CORPTIE_COMPUTER_USE_STATE_ROOT;
  const client = new IndependentComputerUseClient({ helperPath: process.env.CORPTIE_COMPUTER_USE_HELPER, stateRoot });
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const server = createIndependentComputerUseMcpServer({ client });
  const shutdown = () => { client.close(); void server.close(); };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  process.once("exit", () => client.close());
  await server.connect(new StdioServerTransport());
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(`[independent-computer-use] ${error.message}`); process.exitCode = 1; });
}
