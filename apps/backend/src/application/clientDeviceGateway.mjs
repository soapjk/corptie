import https from "node:https";
import { readFile } from "node:fs/promises";
import { ClientDeviceAuthority, deviceError } from "./clientDeviceAuthority.mjs";
import { requireDevicePermission } from "./clientSessionAPI.mjs";
import { ClientEventStream } from "./clientEventStream.mjs";

export const reply = (response, status, body) => {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store",
    "x-content-type-options": "nosniff" });
  response.end(JSON.stringify(body));
};
export const bearer = request => /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? "")?.[1];
async function body(request, maxBytes = 4096) {
  if (!/^application\/json(?:;|$)/i.test(request.headers["content-type"] ?? "")) throw deviceError("JSON_REQUIRED", 415);
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw deviceError("BODY_TOO_LARGE", 413);
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw deviceError("INVALID_JSON", 400); }
}

/** Separate TLS listener with a closed route list; never forwards to the legacy router. */
export class ClientDeviceGateway {
  constructor(authority, { readAPI = null, sessionAPI = null, controlAPI = null } = {}) {
    this.authority = authority;
    this.readAPI = readAPI;
    this.sessionAPI = sessionAPI;
    this.controlAPI = controlAPI;
    this.events = new ClientEventStream();
    this.buckets = new Map();
    this.sockets = new Map();
    this.onRevoke = id => {
      for (const [socket, owner] of this.sockets) if (owner === id) socket.destroy();
    };
  }

  limit(request) {
    const now = Date.now();
    for (const [key, value] of this.buckets) if (value.until <= now) this.buckets.delete(key);
    const read = request.method === "GET" && /^\/client\/v1\/(works|tasks|sessions|commands|control)(\/|\?|$)/.test(request.url);
    const key = `${request.socket.remoteAddress}:${read ? "read" : "command"}`;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= 1024) throw deviceError("RATE_LIMITED", 429);
      this.buckets.set(key, bucket = { until: now + 60_000, count: 0 });
    }
    if (++bucket.count > (read ? 600 : 60)) throw deviceError("RATE_LIMITED", 429);
  }

  async handle(request, response) {
    try {
      this.limit(request);
      if (request.headers.origin || request.headers["x-corptie-agent-id"]) {
        throw deviceError("REQUEST_NOT_ALLOWED", 403);
      }
      const url = new URL(request.url, "https://client.invalid");
      const path = url.pathname;
      const inventory = /^\/client\/v1\/(works|tasks|sessions)$/.exec(path);
      const control = /^\/client\/v1\/control\/(automations|agents|skills|repositories)$/.exec(path);
      const repository = /^\/client\/v1\/control\/repositories\/([^/]+)$/.exec(path);
      const conversation = /^\/client\/v1\/sessions\/([^/]+)\/(messages|stop|capabilities)$/.exec(path);
      const commandReceipt = /^\/client\/v1\/commands\/([A-Za-z0-9_-]{8,128})$/.exec(path);
      if (url.search && !inventory && !control && !(conversation?.[2] === "messages" && request.method === "GET")) throw deviceError("REQUEST_NOT_ALLOWED", 403);
      if (request.method === "POST" && path === "/client/v1/pairing/claim") {
        return reply(response, 200, this.authority.claim(await body(request)));
      }
      if (request.method === "POST" && path === "/client/v1/pairing/exchange") {
        return reply(response, 200, await this.authority.exchange(await body(request)));
      }
      if (request.method === "POST" && path === "/client/v1/auth/refresh") {
        return reply(response, 200, await this.authority.refresh(await body(request)));
      }
      const identity = this.authority.authenticate(bearer(request));
      this.sockets.set(request.socket, identity.deviceId);
      if (request.method === "GET" && (control || repository) && this.controlAPI) {
        requireDevicePermission(identity, "control.read");
        let result;
        if (control) result = await this.controlAPI.list(control[1], url.searchParams);
        else {
          let id;
          try { id = decodeURIComponent(repository[1]); } catch { throw deviceError("INVALID_REPOSITORY_ID", 400); }
          result = await this.controlAPI.repository(id);
        }
        requireDevicePermission(this.authority.authenticate(bearer(request)), "control.read");
        return reply(response, 200, result);
      }
      if (request.method === "GET" && path === "/client/v1/events") {
        return this.events.attach(response, () => this.authority.authenticate(bearer(request)));
      }
      if (conversation && this.sessionAPI) {
        let sessionId;
        try { sessionId = decodeURIComponent(conversation[1]); } catch { throw deviceError("INVALID_SESSION_ID", 400); }
        if (request.method === "GET" && conversation[2] === "messages") {
          const result = await this.sessionAPI.messages(identity, sessionId, url.searchParams);
          requireDevicePermission(this.authority.authenticate(bearer(request)), "messages.read");
          return reply(response, 200, result);
        }
        if (request.method === "GET" && conversation[2] === "capabilities") {
          return reply(response, 200, this.sessionAPI.capabilities(identity, sessionId));
        }
        if (request.method === "POST" && ["messages", "stop"].includes(conversation[2])) {
          const input = await body(request, conversation[2] === "messages" ? 65536 : 4096);
          // Recheck after reading the body: permission may have been revoked meanwhile.
          const current = this.authority.authenticate(bearer(request));
          return reply(response, 202, await this.sessionAPI.command(current, sessionId,
            conversation[2] === "messages" ? "send" : "stop", input));
        }
      }
      if (commandReceipt && request.method === "GET" && this.sessionAPI) {
        return reply(response, 200, this.sessionAPI.receipt(identity, commandReceipt[1]));
      }
      if (request.method === "GET" && inventory && this.readAPI) {
        requireDevicePermission(identity, "inventory.read");
        return reply(response, 200, this.readAPI.list(inventory[1], url.searchParams));
      }
      if (request.method === "GET" && path === "/client/v1/me") return reply(response, 200, identity);
      // Pairing readiness is deliberately distinct from business API readiness.
      if (request.method === "GET" && path === "/client/v1/capabilities") {
        return reply(response, 200, { schemaVersion: 1, service: "corptie", deviceAuthentication: true,
          businessAPI: Boolean(this.readAPI), readOnly: !identity.permissions.some(p => ["messages.write", "sessions.stop"].includes(p)),
          inventoryLists: Boolean(this.readAPI) && identity.permissions.includes("inventory.read"),
          messages: Boolean(this.sessionAPI) && identity.permissions.includes("messages.read"),
          controlRead: Boolean(this.controlAPI) && identity.permissions.includes("control.read"), controlWrite: false,
          permissions: identity.permissions, eventStream: true, eventRecovery: "snapshot-on-connect", remoteFileAccess: false });
      }
      throw deviceError("ROUTE_NOT_AVAILABLE", 404);
    } catch (error) {
      reply(response, error.status ?? 500, { code: error.code ?? "DEVICE_SERVICE_ERROR" });
    }
  }

  async start({ key, cert, host = "127.0.0.1", port = 0 }) {
    this.server = https.createServer({ key, cert, minVersion: "TLSv1.2", maxHeaderSize: 8192,
      requestTimeout: 10_000, headersTimeout: 5000, keepAliveTimeout: 5000 },
    (request, response) => void this.handle(request, response));
    this.server.on("secureConnection", socket => {
      this.sockets.set(socket, null);
      socket.once("close", () => this.sockets.delete(socket));
    });
    this.server.maxConnections = 128;
    this.authority.listeners.add(this.onRevoke);
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, resolve);
    });
    return this.server.address();
  }

  async close() {
    this.events.close();
    this.authority.listeners.delete(this.onRevoke);
    if (!this.server?.listening) return;
    for (const socket of this.sockets.keys()) socket.destroy();
    this.server.closeAllConnections();
    await new Promise(resolve => this.server.close(resolve));
  }

  async handleAdmin(request, response) {
    try {
      const address = request.socket.remoteAddress;
      if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address)
          || request.headers.origin || !this.authority.checkAdmin(bearer(request))) {
        throw deviceError("ADMIN_AUTH_REQUIRED", 403);
      }
      this.limit(request);
      if (request.method === "GET" && request.url === "/internal/client-devices") return reply(response, 200, this.authority.list());
      if (request.method === "POST" && request.url === "/internal/client-devices/invite") return reply(response, 201, this.authority.invite());
      if (request.method === "POST" && request.url === "/internal/client-devices/approve") {
        const input = await body(request);
        if (typeof input.approved !== "boolean") throw deviceError("APPROVAL_REQUIRED", 400);
        return reply(response, 200, this.authority.approve(input.pairingId, input.approved));
      }
      if (request.method === "POST" && request.url === "/internal/client-devices/revoke") {
        await this.authority.revoke((await body(request)).deviceId);
        return reply(response, 200, { revoked: true });
      }
      if (request.method === "POST" && request.url === "/internal/client-devices/permissions") {
        const input = await body(request);
        return reply(response, 200, await this.authority.setPermissions(input.deviceId, input.permissions));
      }
      throw deviceError("ROUTE_NOT_AVAILABLE", 404);
    } catch (error) { reply(response, error.status ?? 500, { code: error.code ?? "DEVICE_SERVICE_ERROR" }); }
  }
}

export async function startConfiguredDeviceGateway({ directory, preview, readAPI = null, controlAPI = null, sessionAPIFactory = null, environment = process.env }) {
  if (preview || environment.CORPTIE_REMOTE_ACCESS !== "1") return null;
  const host = environment.CORPTIE_REMOTE_HOST;
  const port = Number(environment.CORPTIE_REMOTE_PORT);
  if (!host || !Number.isInteger(port) || port < 1024 || port > 65535
      || !environment.CORPTIE_REMOTE_TLS_KEY || !environment.CORPTIE_REMOTE_TLS_CERT) {
    throw deviceError("REMOTE_TLS_CONFIGURATION_REQUIRED", 500);
  }
  const [key, cert] = await Promise.all([
    readFile(environment.CORPTIE_REMOTE_TLS_KEY), readFile(environment.CORPTIE_REMOTE_TLS_CERT)
  ]);
  const authority = new ClientDeviceAuthority(directory);
  await authority.initialize();
  const gateway = new ClientDeviceGateway(authority, { readAPI, controlAPI, sessionAPI: sessionAPIFactory?.() ?? null });
  try { await gateway.start({ host, port, key, cert }); }
  catch (error) { await gateway.close(); throw error; }
  return gateway;
}
