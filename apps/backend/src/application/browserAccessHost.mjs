import { createServer } from "node:net";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir, endianness } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";

export const BROWSER_CONTEXT_META = "corptie/browser-session-context";
const domain = "codex.browserAccess.v1";
const maxFrame = 16 * 1024;
const validId = value => typeof value === "string" && value.length > 0 && value.length <= 300;
const contextKey = c => JSON.stringify([c.logicalSessionId, c.providerBindingId, c.turnId]);

// The caller supplies context over its private MCP transport, never through tool arguments.
// Native identities are registered synchronously by the broker immediately before dispatch.
export async function createBrowserAccessHost({ authorize, timeoutMs = 9_000 } = {}) {
  if (typeof authorize !== "function") throw new TypeError("Browser authorization callback required.");
  const directory = await mkdtemp(join(tmpdir(), "corptie-ba-"));
  await chmod(directory, 0o700);
  const pipePath = join(directory, "access.sock");
  const executorId = randomUUID();
  let { privateKey, publicKey } = generateKeyPairSync("ed25519");
  let active, boundContext, nativeTurn, revoked = false, closing;
  const nonces = new Set(), sockets = new Set();
  const server = createServer(socket => {
    if (revoked || sockets.size >= 8) { socket.destroy(); return; }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setTimeout(timeoutMs, () => socket.destroy());
    let buffer = Buffer.alloc(0), processing = false;
    socket.on("data", chunk => {
      if (processing || buffer.length + chunk.length > maxFrame + 4) { socket.destroy(); return; }
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const length = endianness() === "LE" ? buffer.readUInt32LE(0) : buffer.readUInt32BE(0);
      if (length < 2 || length > maxFrame) { socket.destroy(); return; }
      if (buffer.length < length + 4) return;
      if (buffer.length !== length + 4) { socket.destroy(); return; }
      processing = true;
      let message;
      try { message = JSON.parse(buffer.subarray(4).toString("utf8")); }
      catch { socket.destroy(); return; }
      void respond(message).then(response => {
        if (revoked || socket.destroyed) { socket.destroy(); return; }
        const bytes = Buffer.from(JSON.stringify(response));
        const header = Buffer.alloc(4);
        if (endianness() === "LE") header.writeUInt32LE(bytes.length); else header.writeUInt32BE(bytes.length);
        socket.end(Buffer.concat([header, bytes]));
      }).catch(() => socket.destroy());
    });
  });
  async function respond(message) {
    const request = message?.params;
    const invocation = active;
    if (revoked || !invocation || invocation.signal?.aborted || message?.jsonrpc !== "2.0"
      || message.method !== "browser/access" || !Number.isSafeInteger(message.id)
      || !request || Object.keys(request).sort().join(",") !== "executorId,nonce,sessionId,turnId"
      || request.executorId !== executorId || request.sessionId !== invocation.native?.sessionId
      || request.turnId !== invocation.native?.turnId || typeof request.nonce !== "string"
      || !/^[a-f0-9]{64}$/.test(request.nonce) || nonces.has(request.nonce) || nonces.size >= 1024) {
      return { jsonrpc: "2.0", id: message?.id ?? null, error: { code: -32001, message: "Browser access context is invalid or expired." } };
    }
    nonces.add(request.nonce);
    let allowed = false;
    try { allowed = await authorize({ context: invocation.context, signal: invocation.signal }) === true; }
    catch { /* No response, failure and cancellation deny access. */ }
    allowed &&= !revoked && active === invocation && !invocation.signal?.aborted;
    if (revoked || !privateKey) throw new Error("Browser host closed.");
    const payload = JSON.stringify({ domain, request, allowed });
    return { jsonrpc: "2.0", id: message.id, result: {
      payload, signature: sign(null, Buffer.from(payload), privateKey).toString("base64")
    } };
  }
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(pipePath, resolve); });
    await chmod(pipePath, 0o600);
  } catch (error) { server.close(); await rm(directory, { recursive: true, force: true }); throw error; }
  return {
    env: { BROWSER_USE_ACCESS_EXECUTOR_ID: executorId, BROWSER_USE_ACCESS_PIPE_PATH: pipePath,
      BROWSER_USE_ACCESS_VERIFYING_IDENTITY: publicKey.export({ type: "spki", format: "der" }).toString("base64") },
    begin(context, signal) {
      if (revoked || active || !context || ![context.logicalSessionId, context.providerBindingId, context.turnId].every(validId)) {
        throw Object.assign(new Error("Browser use requires a live Corptie Session turn."), { code: "BROWSER_SESSION_REQUIRED" });
      }
      const key = contextKey(context);
      if (boundContext && boundContext !== key) throw Object.assign(new Error("Browser runtime belongs to another Session turn."), { code: "BROWSER_SESSION_STALE" });
      boundContext = key;
      const invocation = active = { context: Object.freeze({ logicalSessionId: context.logicalSessionId,
        providerBindingId: context.providerBindingId, turnId: context.turnId }), signal };
      return () => { if (active === invocation) active = null; };
    },
    bindNative({ sessionId, turnId, tool }) {
      if (tool === "turn_ended") return;
      if (!active || !validId(sessionId) || !validId(turnId)) throw new Error("Native browser request has no active Corptie invocation.");
      const key = JSON.stringify([sessionId, turnId]);
      if (nativeTurn && nativeTurn !== key) throw new Error("Native browser Turn changed; reconnect before continuing.");
      nativeTurn = key;
      active.native = { sessionId, turnId };
    },
    close() {
      return closing ??= (async () => {
        revoked = true; active = null; privateKey = null; publicKey = null;
        for (const socket of sockets) socket.destroy();
        await new Promise(resolve => server.close(resolve));
        await rm(directory, { recursive: true, force: true });
      })();
    }
  };
}
