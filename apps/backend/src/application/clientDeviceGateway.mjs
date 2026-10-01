import https from "node:https";
import { readFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { ClientDeviceAuthority, deviceError } from "./clientDeviceAuthority.mjs";
import { ClientEventStream } from "./clientEventStream.mjs";
import { ClientInspectorStream } from "./clientInspectorStream.mjs";

export const reply = (response, status, body) => {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store",
    "x-content-type-options": "nosniff" });
  response.end(JSON.stringify(body));
};
export const bearer = request => /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? "")?.[1];
const decode = (value, code) => {
  try { return decodeURIComponent(value); } catch { throw deviceError(code, 400); }
};
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

/** Streams a host-verified managed file; the path was resolved by the read API and is never echoed back. */
function streamFile(response, { path, contentType, size, etag }) {
  return new Promise(resolve => {
    const stream = createReadStream(path);
    stream.once("error", () => {
      if (!response.headersSent) reply(response, 404, { code: "AVATAR_NOT_FOUND" }); else response.destroy();
      resolve();
    });
    stream.once("open", () => {
      response.writeHead(200, { "content-type": contentType, "content-length": size, etag,
        "cache-control": "private, max-age=0, must-revalidate", "x-content-type-options": "nosniff" });
      stream.pipe(response);
    });
    response.once("close", () => { stream.destroy(); resolve(); });
  });
}

/** Separate TLS listener with a closed route list; never forwards to the legacy router. */
export class ClientDeviceGateway {
  constructor(authority, { readAPI = null, sessionAPI = null, controlAPI = null, worktreeAPI = null } = {}) {
    this.authority = authority;
    this.readAPI = readAPI;
    this.sessionAPI = sessionAPI;
    this.controlAPI = controlAPI;
    this.worktreeAPI = worktreeAPI;
    this.inspectorEvents = new ClientInspectorStream({ snapshot: (identity, id) => this.sessionAPI.inspector.snapshot(identity, id) });
    this.events = new ClientEventStream({
      stateSnapshot: async () => this.readAPI?.realtimeSnapshot?.() ?? null,
      controlSnapshot: async () => this.controlAPI?.realtimeSnapshot?.() ?? null,
      timeline: async (identity, sessionId, after, options) =>
        this.sessionAPI?.realtimeTimeline?.(identity, sessionId, after, options) ?? null
    });
    this.buckets = new Map();
    this.sockets = new Map();
    this.onRevoke = id => {
      for (const [socket, owner] of this.sockets) if (owner === id) socket.destroy();
    };
  }

  limit(request) {
    const now = Date.now();
    for (const [key, value] of this.buckets) if (value.until <= now) this.buckets.delete(key);
    const read = request.method === "GET" && /^\/client\/v1\/(works|tasks|sessions|commands|control|worktrees)(\/|\?|$)/.test(request.url);
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
      const eventV2 = path === "/client/v2/events";
      const inventory = /^\/client\/v1\/(works|tasks|sessions)$/.exec(path);
      const discussion = /^\/client\/v1\/works\/([^/]+)\/discussion$/.exec(path);
      const taskEntity = /^\/client\/v1\/tasks\/([^/]+)\/(management|deletion|update|archive|restart|delete)$/.exec(path);
      const workEntity = /^\/client\/v1\/works\/([^/]+)\/(management|update|delete)$/.exec(path);
      const workAvatar = /^\/client\/v1\/works\/([^/]+)\/avatar$/.exec(path);
      const control = /^\/client\/v1\/control\/(automations|agents|skills|repositories)$/.exec(path);
      const repository = /^\/client\/v1\/control\/repositories\/([^/]+)$/.exec(path);
      const worktreeRepository = /^\/client\/v1\/worktrees\/repositories\/([^/]+)$/.exec(path);
      const worktreePushStatus = /^\/client\/v1\/worktrees\/repositories\/([^/]+)\/worktrees\/([^/]+)\/github-push-status$/.exec(path);
      const worktreeDelete = /^\/client\/v1\/worktrees\/repositories\/([^/]+)\/worktrees\/([^/]+)\/delete$/.exec(path);
      const worktreeWorkspaceAction = /^\/client\/v1\/worktrees\/repositories\/([^/]+)\/workspaces\/([^/]+)\/actions\/([^/]+)$/.exec(path);
      const worktreeService = /^\/client\/v1\/worktrees\/repositories\/([^/]+)\/development-service$/.exec(path);
      const worktreeServiceAction = /^\/client\/v1\/worktrees\/repositories\/([^/]+)\/development-service\/actions\/([^/]+)$/.exec(path);
      const worktreePlan = /^\/client\/v1\/worktrees\/repositories\/([^/]+)\/integration-plans$/.exec(path);
      const worktreeJob = /^\/client\/v1\/worktrees\/jobs\/([^/]+)$/.exec(path);
      const worktreeJobAction = /^\/client\/v1\/worktrees\/jobs\/([^/]+)\/actions\/([^/]+)$/.exec(path);
      const conversation = /^\/client\/v1\/sessions\/([^/]+)\/(messages|stop|capabilities|composer|conversation-commands|tasks|read-receipt|images|usage|approval|user-input)$/.exec(path);
      const commandReceipt = /^\/client\/v1\/commands\/([A-Za-z0-9_-]{8,128})$/.exec(path);
      if (url.search && !inventory && !control && !eventV2 && !worktreeRepository
          && !(["messages", "tasks", "images", "usage"].includes(conversation?.[2]) && request.method === "GET")) {
        throw deviceError("REQUEST_NOT_ALLOWED", 403);
      }
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
      const inspector = /^\/client\/v1\/sessions\/([^/]+)\/inspector(?:\/(events|read|commands))?$/.exec(path);
      if (inspector && this.sessionAPI?.inspector) {
        const id = decode(inspector[1], "INVALID_SESSION_ID");
        const authenticate = () => this.authority.authenticate(bearer(request));
        this.sessionAPI.inspector.scope(id, identity);
        if (request.method === "GET" && inspector[2] === "events") {
          return this.inspectorEvents.attach(response, authenticate, id);
        }
        if (request.method === "GET" && !inspector[2]) {
          const result = await this.sessionAPI.inspector.snapshot(identity, id);
          authenticate(); return reply(response, 200, result);
        }
        if (request.method === "POST" && inspector[2] === "read") {
          const input = await body(request);
          const result = await this.sessionAPI.inspector.read(authenticate(), id, input.resource, input.parameters);
          authenticate(); return reply(response, 200, result);
        }
        if (request.method === "POST" && inspector[2] === "commands") {
          const input = await body(request, 12 * 1024 * 1024);
          const result = await this.sessionAPI.inspector.command(this.sessionAPI, authenticate(), id, input, authenticate);
          this.inspectorEvents.invalidate();
          return reply(response, 202, result);
        }
        throw deviceError("ROUTE_NOT_AVAILABLE", 404);
      }
      if (path === "/client/v1/works/create" && this.sessionAPI) {
        if (request.method === "GET") {
          const result = this.sessionAPI.workCreationOptions();
          this.authority.authenticate(bearer(request));
          return reply(response, 200, result);
        }
        if (request.method === "POST") {
          const input = await body(request, 64 * 1024);
          return reply(response, 202, await this.sessionAPI.createWork(this.authority.authenticate(bearer(request)),
            input, () => this.authority.authenticate(bearer(request))));
        }
        throw deviceError("ROUTE_NOT_AVAILABLE", 404);
      }
      if (discussion && this.sessionAPI && ["GET", "POST"].includes(request.method)) {
        let workId;
        try { workId = decodeURIComponent(discussion[1]); } catch { throw deviceError("INVALID_WORK_ID", 400); }
        if (request.method === "GET") {
          const result = await this.sessionAPI.discussionOptions(identity, workId);
          this.authority.authenticate(bearer(request));
          return reply(response, 200, result);
        }
        const input = await body(request);
        return reply(response, 202, await this.sessionAPI.openDiscussion(this.authority.authenticate(bearer(request)), workId,
          input, () => this.authority.authenticate(bearer(request))));
      }
      if ((taskEntity || workEntity) && this.sessionAPI) {
        let entityId;
        try { entityId = decodeURIComponent((taskEntity ?? workEntity)[1]); } catch { throw deviceError(taskEntity ? "INVALID_TASK_ID" : "INVALID_WORK_ID", 400); }
        const route = (taskEntity ?? workEntity)[2];
        const isRead = route === "management" || route === "deletion";
        if (request.method === "GET" && isRead) {
          const result = route === "deletion" ? await this.sessionAPI.taskDeletionPlan(identity, entityId)
            : taskEntity ? this.sessionAPI.taskManagement(identity, entityId) : this.sessionAPI.workManagement(identity, entityId);
          this.authority.authenticate(bearer(request));
          return reply(response, 200, result);
        }
        if (request.method === "POST" && !isRead) {
          const input = await body(request, 64 * 1024);
          const current = this.authority.authenticate(bearer(request));
          const revalidate = () => this.authority.authenticate(bearer(request));
          return reply(response, 202, await (taskEntity
            ? this.sessionAPI.taskCommand(current, entityId, route, input, revalidate)
            : this.sessionAPI.workCommand(current, entityId, route, input, revalidate)));
        }
        throw deviceError("ROUTE_NOT_AVAILABLE", 404);
      }
      if (request.method === "GET" && (control || repository) && this.controlAPI) {
        let result;
        if (control) result = await this.controlAPI.list(control[1], url.searchParams);
        else {
          let id;
          try { id = decodeURIComponent(repository[1]); } catch { throw deviceError("INVALID_REPOSITORY_ID", 400); }
          result = await this.controlAPI.repository(id);
        }
        this.authority.authenticate(bearer(request));
        return reply(response, 200, result);
      }
      if (this.worktreeAPI && (worktreeRepository || worktreePushStatus || worktreeDelete
          || worktreeWorkspaceAction || worktreeService || worktreeServiceAction || worktreePlan
          || worktreeJob || worktreeJobAction)) {
        let result;
        if (request.method === "GET" && worktreeRepository) {
          const forceFreshValues = url.searchParams.getAll("forceFresh");
          if ([...url.searchParams.keys()].some(key => key !== "forceFresh") || forceFreshValues.length > 1
              || forceFreshValues.some(value => !["true", "false"].includes(value))) {
            throw deviceError("INVALID_QUERY", 400);
          }
          result = await this.worktreeAPI.repository(
            decode(worktreeRepository[1], "INVALID_REPOSITORY_ID"),
            { forceFresh: url.searchParams.get("forceFresh") === "true" }
          );
        } else if (request.method === "GET" && worktreePushStatus) {
          result = await this.worktreeAPI.gitHubPushStatus(
            decode(worktreePushStatus[1], "INVALID_REPOSITORY_ID"),
            decode(worktreePushStatus[2], "INVALID_WORKTREE_ID")
          );
        } else if (request.method === "GET" && worktreeService) {
          result = await this.worktreeAPI.developmentService(decode(worktreeService[1], "INVALID_REPOSITORY_ID"));
        } else if (request.method === "GET" && worktreeJob) {
          result = this.worktreeAPI.job(decode(worktreeJob[1], "INVALID_JOB_ID"));
        } else if (request.method === "POST") {
          const input = await body(request, 64 * 1024);
          this.authority.authenticate(bearer(request));
          if (worktreeDelete) result = await this.worktreeAPI.deleteWorktree(
            decode(worktreeDelete[1], "INVALID_REPOSITORY_ID"), decode(worktreeDelete[2], "INVALID_WORKTREE_ID")
          );
          else if (worktreeWorkspaceAction) result = await this.worktreeAPI.workspaceAction(
            decode(worktreeWorkspaceAction[1], "INVALID_REPOSITORY_ID"),
            decode(worktreeWorkspaceAction[2], "INVALID_WORKTREE_ID"),
            decode(worktreeWorkspaceAction[3], "INVALID_ACTION"), input
          );
          else if (worktreeServiceAction) result = await this.worktreeAPI.developmentServiceAction(
            decode(worktreeServiceAction[1], "INVALID_REPOSITORY_ID"),
            decode(worktreeServiceAction[2], "INVALID_ACTION"), input
          );
          else if (worktreePlan) result = await this.worktreeAPI.createPlan(
            decode(worktreePlan[1], "INVALID_REPOSITORY_ID"), input
          );
          else if (worktreeJobAction) result = await this.worktreeAPI.jobAction(
            decode(worktreeJobAction[1], "INVALID_JOB_ID"),
            decode(worktreeJobAction[2], "INVALID_ACTION"), input
          );
          else throw deviceError("ROUTE_NOT_AVAILABLE", 404);
        } else throw deviceError("ROUTE_NOT_AVAILABLE", 404);
        this.authority.authenticate(bearer(request));
        return reply(response, 200, result);
      }
      if (request.method === "GET" && path === "/client/v1/events") {
        return this.events.attach(response, () => this.authority.authenticate(bearer(request)));
      }
      if (request.method === "GET" && eventV2) {
        const sessionId = url.searchParams.get("sessionId");
        if (sessionId != null && (!sessionId || sessionId.length > 512)) throw deviceError("INVALID_SESSION_ID", 400);
        const stateRevision = Number(url.searchParams.get("stateRevision") ?? 0);
        const timelineRevision = Number(url.searchParams.get("timelineRevision") ?? 0);
        if (![stateRevision, timelineRevision].every(value => Number.isSafeInteger(value) && value >= 0)) {
          throw deviceError("INVALID_QUERY", 400);
        }
        return this.events.attachV2(response, () => this.authority.authenticate(bearer(request)), {
          sessionId, stateRevision, timelineRevision
        });
      }
      if (conversation && this.sessionAPI) {
        let sessionId;
        try { sessionId = decodeURIComponent(conversation[1]); } catch { throw deviceError("INVALID_SESSION_ID", 400); }
        if (conversation[2] === "tasks" && request.method === "GET") {
          const result = await this.sessionAPI.taskCreationOptions(identity, sessionId, url.searchParams);
          this.authority.authenticate(bearer(request));
          return reply(response, 200, result);
        }
        if (conversation[2] === "tasks" && request.method === "POST") {
          const input = await body(request, 160 * 1024);
          return reply(response, 202, await this.sessionAPI.createTask(this.authority.authenticate(bearer(request)),
            sessionId, input, () => this.authority.authenticate(bearer(request))));
        }
        if (conversation[2] === "conversation-commands" && request.method === "GET") {
          const result = await this.sessionAPI.commandCatalog(identity, sessionId);
          this.authority.authenticate(bearer(request));
          return reply(response, 200, result);
        }
        if (conversation[2] === "conversation-commands" && request.method === "POST") {
          const input = await body(request, 70 * 1024);
          const current = this.authority.authenticate(bearer(request));
          return reply(response, 202, await this.sessionAPI.conversationCommand(current, sessionId, input,
            () => this.authority.authenticate(bearer(request))));
        }
        if (conversation[2] === "approval" && request.method === "POST") {
          const input = await body(request, 4096);
          return reply(response, 202, await this.sessionAPI.approval(
            this.authority.authenticate(bearer(request)), sessionId, input,
            () => this.authority.authenticate(bearer(request))));
        }
        if (conversation[2] === "user-input" && request.method === "POST") {
          const input = await body(request, 64 * 1024);
          return reply(response, 202, await this.sessionAPI.userInput(
            this.authority.authenticate(bearer(request)), sessionId, input,
            () => this.authority.authenticate(bearer(request))));
        }
        if (conversation[2] === "composer" && ["GET", "POST"].includes(request.method)) {
          const input = request.method === "POST" ? await body(request, 4096) : null;
          const result = await this.sessionAPI.configuration(this.authority.authenticate(bearer(request)), sessionId, input);
          this.authority.authenticate(bearer(request));
          return reply(response, 200, result);
        }
        if (request.method === "GET" && conversation[2] === "messages") {
          const result = await this.sessionAPI.messages(identity, sessionId, url.searchParams);
          this.authority.authenticate(bearer(request));
          return reply(response, 200, result);
        }
        if (request.method === "GET" && conversation[2] === "images") {
          const image = await this.sessionAPI.image(identity, sessionId, url.searchParams);
          this.authority.authenticate(bearer(request));
          response.writeHead(200, { "content-type": image.contentType, "content-length": image.byteLength,
            "cache-control": "private, max-age=31536000, immutable", "x-content-type-options": "nosniff" });
          return response.end(image.data);
        }
        if (conversation[2] === "images") throw deviceError("ROUTE_NOT_AVAILABLE", 404);
        if (request.method === "POST" && conversation[2] === "read-receipt") {
          const input = await body(request, 1024);
          return reply(response, 200, this.sessionAPI.readReceipt(this.authority.authenticate(bearer(request)), sessionId, input));
        }
        if (request.method === "GET" && conversation[2] === "capabilities") {
          return reply(response, 200, this.sessionAPI.capabilities(identity, sessionId));
        }
        if (request.method === "GET" && conversation[2] === "usage") {
          const freshAccountValues = url.searchParams.getAll("freshAccount");
          if ([...url.searchParams.keys()].some(key => key !== "freshAccount")
              || freshAccountValues.length > 1
              || freshAccountValues.some(value => value !== "1")) {
            throw deviceError("REQUEST_NOT_ALLOWED", 403);
          }
          const result = await this.sessionAPI.usage(identity, sessionId,
            { freshAccount: freshAccountValues[0] === "1" });
          this.authority.authenticate(bearer(request));
          return reply(response, 200, result);
        }
        if (conversation[2] === "usage") throw deviceError("ROUTE_NOT_AVAILABLE", 404);
        if (request.method === "POST" && ["messages", "stop"].includes(conversation[2])) {
          const input = await body(request, conversation[2] === "messages" ? 29 * 1024 * 1024 : 4096);
          // Recheck after reading the body: the device may have been revoked meanwhile.
          const current = this.authority.authenticate(bearer(request));
          return reply(response, 202, await this.sessionAPI.command(current, sessionId,
            conversation[2] === "messages" ? "send" : "stop", input));
        }
      }
      if (commandReceipt && request.method === "GET" && this.sessionAPI) {
        return reply(response, 200, this.sessionAPI.receipt(identity, commandReceipt[1]));
      }
      if (request.method === "GET" && inventory && this.readAPI) {
        return reply(response, 200, this.readAPI.list(inventory[1], url.searchParams));
      }
      if (request.method === "GET" && workAvatar && this.readAPI?.workAvatar) {
        let workId;
        try { workId = decodeURIComponent(workAvatar[1]); } catch { throw deviceError("INVALID_WORK_ID", 400); }
        const avatar = await this.readAPI.workAvatar(workId);
        this.authority.authenticate(bearer(request));
        if (request.headers["if-none-match"] === avatar.etag) { response.writeHead(304, { etag: avatar.etag }); return response.end(); }
        return streamFile(response, avatar);
      }
      if (request.method === "GET" && path === "/client/v1/me") return reply(response, 200, identity);
      // Pairing readiness is deliberately distinct from business API readiness.
      if (request.method === "GET" && path === "/client/v1/capabilities") {
        return reply(response, 200, { schemaVersion: 1, service: "corptie", deviceAuthentication: true,
          businessAPI: Boolean(this.readAPI), readOnly: !this.sessionAPI && !this.worktreeAPI,
          workDiscussion: Boolean(this.sessionAPI?.workDiscussion),
          taskManagement: Boolean(this.sessionAPI?.entityCommands),
          workManagement: Boolean(this.sessionAPI?.entityCommands),
          workCreation: Boolean(this.sessionAPI?.entityCommands?.createWork),
          inventoryLists: Boolean(this.readAPI), messages: Boolean(this.sessionAPI),
          controlRead: Boolean(this.controlAPI), controlWrite: Boolean(this.worktreeAPI),
          eventStream: true, eventRecovery: "snapshot-on-connect",
          realtime: { protocol: "sse-v2", pushPayloads: true, serverSnapshots: true }, remoteFileAccess: false });
      }
      throw deviceError("ROUTE_NOT_AVAILABLE", 404);
    } catch (error) {
      reply(response, error.status ?? error.statusCode ?? 500, { code: error.code ?? "DEVICE_SERVICE_ERROR" });
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
      throw deviceError("ROUTE_NOT_AVAILABLE", 404);
    } catch (error) { reply(response, error.status ?? 500, { code: error.code ?? "DEVICE_SERVICE_ERROR" }); }
  }
}

export async function startConfiguredDeviceGateway({ directory, preview, readAPI = null, controlAPI = null,
  worktreeAPI = null, sessionAPIFactory = null, environment = process.env }) {
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
  const gateway = new ClientDeviceGateway(authority, {
    readAPI, controlAPI, worktreeAPI, sessionAPI: sessionAPIFactory?.() ?? null
  });
  try { await gateway.start({ host, port, key, cert }); }
  catch (error) { await gateway.close(); throw error; }
  return gateway;
}
