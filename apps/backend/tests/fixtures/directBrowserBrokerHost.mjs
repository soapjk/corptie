import { createInterface } from "node:readline";

// Isolated protocol fixture. No official service, browser or model is started.
createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result = request.method === "thread/start" ? { thread: { id: "fixture-native-thread" } }
    : request.method === "mcpServer/tool/call" ? { content: [{ type: "text", text: JSON.stringify(request.params) }] }
    : {};
  process.stdout.write(JSON.stringify({ id: request.id, result }) + "\n");
});
