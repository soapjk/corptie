import { createConnection } from "node:net";
import { endianness } from "node:os";
import { randomBytes } from "node:crypto";

export async function challenge(env, overrides = {}, fragmented = false) {
  const request = { executorId: env.BROWSER_USE_ACCESS_EXECUTOR_ID, sessionId: "native-thread", turnId: "native-turn",
    nonce: randomBytes(32).toString("hex"), ...overrides };
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "browser/access", params: request }));
  const header = Buffer.alloc(4);
  if (endianness() === "LE") header.writeUInt32LE(body.length); else header.writeUInt32BE(body.length);
  const bytes = Buffer.concat([header, body]);
  const response = await new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const socket = createConnection(env.BROWSER_USE_ACCESS_PIPE_PATH);
    socket.setTimeout(1500, () => socket.destroy(new Error("challenge timeout")));
    socket.on("error", reject);
    socket.on("connect", () => {
      if (fragmented) { socket.write(bytes.subarray(0, 2)); setImmediate(() => socket.write(bytes.subarray(2))); }
      else socket.write(bytes);
    });
    socket.on("data", chunk => { buffer = Buffer.concat([buffer, chunk]); });
    socket.on("end", () => {
      try { resolve(JSON.parse(buffer.subarray(4).toString("utf8"))); } catch (error) { reject(error); }
    });
  });
  return { response, request };
}
