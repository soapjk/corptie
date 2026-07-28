import http from "node:http";
import https from "node:https";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isIP } from "node:net";
import { extname, resolve } from "node:path";
import { createApiV1Error } from "./apiV1Contract.mjs";
import {
  isCsrfValid,
  parseCookieHeader,
  serializeWebSessionCookie,
  WEB_SESSION_COOKIE
} from "../webAccess/webAccessAuth.mjs";

const SECURITY_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY"
});
const WEB_SECURITY_HEADERS = Object.freeze({
  ...SECURITY_HEADERS,
  "content-security-policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
});

export class LanWebGateway {
  constructor(options = {}) {
    this.environmentName = options.environmentName === "development" ? "development" : "production";
    this.logger = options.logger ?? console;
    this.auth = options.auth ?? null;
    this.api = options.api ?? null;
    this.webRoot = options.webRoot ? resolve(options.webRoot) : null;
    this.allowEphemeralPort = options.allowEphemeralPort === true;
    this.eventAuthCheckIntervalMs = options.eventAuthCheckIntervalMs ?? 15_000;
    this.tlsProvider = options.tlsProvider ?? null;
    this.certificate = null;
    this.certificatePem = null;
    this.server = null;
    this.current = {
      enabled: false,
      host: "",
      port: null,
      httpsEnabled: true,
      secure: false
    };
  }

  status() {
    const address = this.server?.address();
    return {
      enabled: this.current.enabled,
      listening: Boolean(this.server?.listening),
      host: typeof address === "object" && address ? address.address : this.current.host,
      port: typeof address === "object" && address ? address.port : this.current.port,
      environment: this.environmentName,
      secure: this.current.secure === true,
      certificate: this.certificate
    };
  }

  async applySettings(input = {}) {
    const next = normalizeRuntimeSettings(input, {
      allowEphemeralPort: this.allowEphemeralPort
    });
    if (sameSettings(this.current, next) && (next.enabled === false || this.server?.listening)) {
      return this.status();
    }

    await this.close();
    this.current = next;
    if (!next.enabled) {
      return this.status();
    }

    const tls = next.httpsEnabled && this.tlsProvider ? await this.tlsProvider(next) : null;
    this.certificate = tls ? {
      type: tls.type ?? "local-ca",
      fingerprint: tls.fingerprint,
      expiresAt: tls.expiresAt,
      leafFingerprint: tls.leafFingerprint,
      leafExpiresAt: tls.leafExpiresAt
    } : null;
    this.certificatePem = tls?.caCert ?? tls?.cert ?? null;
    this.current = { ...this.current, secure: Boolean(tls) };
    const handler = createLanWebRequestHandler({
      environmentName: this.environmentName,
      auth: this.auth,
      api: this.api,
      webRoot: this.webRoot,
      certificatePem: this.certificatePem,
      secureCookies: Boolean(tls),
      eventAuthCheckIntervalMs: this.eventAuthCheckIntervalMs,
      expectedOrigin: () => originForStatus(this.status())
    });
    const server = tls ? https.createServer({ key: tls.key, cert: tls.cert }, handler) : http.createServer(handler);
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 5_000;
    server.maxRequestsPerSocket = 100;

    try {
      await listen(server, next.port, next.host);
      this.server = server;
      const status = this.status();
      this.logger.info?.(`[lan-web] listening on ${status.secure ? "https" : "http"}://${formatHost(status.host)}:${status.port}`);
      return status;
    } catch (error) {
      await closeServer(server);
      this.current = { ...next, enabled: false };
      throw error;
    }
  }

  async close() {
    const server = this.server;
    this.server = null;
    if (server) {
      await closeServer(server);
    }
    this.current = {
      ...this.current,
      enabled: false
    };
  }
}

export function createLanWebRequestHandler(options = {}) {
  const environmentName = options.environmentName === "development" ? "development" : "production";
  return (request, response) => {
    handleLanWebRequest(request, response, {
      environmentName,
      auth: options.auth ?? null,
      api: options.api ?? null,
      webRoot: options.webRoot ? resolve(options.webRoot) : null,
      certificatePem: options.certificatePem ?? null,
      secureCookies: options.secureCookies === true,
      eventAuthCheckIntervalMs: options.eventAuthCheckIntervalMs ?? 15_000,
      expectedOrigin: options.expectedOrigin
    }).catch((error) => sendApiError(response, error));
  };
}

async function handleLanWebRequest(request, response, options) {
    let url;
    try {
      url = new URL(request.url, "http://corptie.lan");
    } catch {
      sendJson(response, 400, {
        error: {
          code: "INVALID_REQUEST",
          message: "Invalid request URL."
        }
      });
      return;
    }

    const expectedOrigin = options.expectedOrigin?.() ?? null;
    if (expectedOrigin && request.headers.host !== new URL(expectedOrigin).host) {
      throw requestError("ORIGIN_NOT_ALLOWED", "Request host is not allowed.");
    }
    const suppliedOrigin = request.headers.origin;
    const requiresOrigin = !["GET", "HEAD", "OPTIONS"].includes(request.method);
    if (expectedOrigin && ((requiresOrigin && !suppliedOrigin) || (suppliedOrigin && suppliedOrigin !== expectedOrigin))) {
      throw requestError("ORIGIN_NOT_ALLOWED", "Request origin is not allowed.");
    }

    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, {
        ok: true,
        service: "corptie-lan-web-gateway",
        environment: options.environmentName
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/pair/certificate") {
      if (!options.certificatePem) {
        sendJson(response, 404, {
          error: {
            code: "NOT_FOUND",
            message: "No HTTPS certificate is available."
          }
        });
        return;
      }
      response.writeHead(200, {
        ...SECURITY_HEADERS,
        "content-type": "application/x-pem-file",
        "content-disposition": "attachment; filename=\"corptie-local-root-ca.pem\"",
        "content-length": options.certificatePem.length
      });
      response.end(options.certificatePem);
      return;
    }

    if (request.method === "GET" && url.pathname === "/pair/certificate.cer") {
      if (!options.certificatePem) {
        sendJson(response, 404, {
          error: {
            code: "NOT_FOUND",
            message: "No HTTPS certificate authority is available."
          }
        });
        return;
      }
      const der = pemCertificateToDer(options.certificatePem);
      response.writeHead(200, {
        ...SECURITY_HEADERS,
        "content-type": "application/x-x509-ca-cert",
        "content-disposition": "attachment; filename=\"corptie-local-root-ca.cer\"",
        "content-length": der.length
      });
      response.end(der);
      return;
    }

    if (request.method === "GET" && url.pathname === "/pair/certificate.mobileconfig") {
      if (!options.certificatePem) {
        sendJson(response, 404, {
          error: {
            code: "NOT_FOUND",
            message: "No HTTPS certificate authority is available."
          }
        });
        return;
      }
      const profile = appleCertificateProfile(options.certificatePem);
      response.writeHead(200, {
        ...SECURITY_HEADERS,
        "content-type": "application/x-apple-aspen-config",
        "content-disposition": "attachment; filename=\"corptie-local-root-ca.mobileconfig\"",
        "content-length": Buffer.byteLength(profile)
      });
      response.end(profile);
      return;
    }

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      if (await tryServeWebAsset(request, response, url.pathname, options.webRoot)) return;
      sendJson(response, 503, {
        error: {
          code: "WEB_FRONTEND_NOT_READY",
          message: "The Corptie Web frontend is not installed yet."
        }
      });
      return;
    }

    if ((request.method === "GET" || request.method === "HEAD")
      && !url.pathname.startsWith("/api/")
      && !url.pathname.startsWith("/pair/")
      && await tryServeWebAsset(request, response, url.pathname, options.webRoot)) {
      return;
    }

    if (request.method === "POST" && url.pathname === "/pair/requests") {
      if (!options.auth) throw requestError("INTERNAL_ERROR", "Pairing is not configured.");
      const input = await readJson(request);
      const pairing = options.auth.requestPairing(input, {
        userAgent: request.headers["user-agent"],
        sourceIp: request.socket.remoteAddress
      });
      sendJson(response, 202, pairing);
      return;
    }

    const pairingRequestMatch = url.pathname.match(/^\/pair\/requests\/([^/]+)\/claim$/);
    if (request.method === "POST" && pairingRequestMatch) {
      if (!options.auth) throw requestError("INTERNAL_ERROR", "Pairing is not configured.");
      const requestId = decodeURIComponent(pairingRequestMatch[1]);
      const input = await readJson(request);
      const result = options.auth.claimRequest(requestId, input.exchangeToken);
      const headers = result.sessionToken
        ? { "set-cookie": serializeWebSessionCookie(result.sessionToken, { secure: options.secureCookies }) }
        : {};
      const publicResult = { ...result };
      delete publicResult.sessionToken;
      sendJson(response, result.status === "pending" ? 202 : 200, publicResult, headers);
      return;
    }

    if (url.pathname.startsWith("/api/v1/")) {
      if (!options.auth) throw requestError("AUTHENTICATION_REQUIRED", "A paired device session is required.");
      const token = parseCookieHeader(request.headers.cookie)[WEB_SESSION_COOKIE];
      const session = options.auth.authenticate(token);
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method)
        && !isCsrfValid(session, request.headers["x-csrf-token"])) {
        throw requestError("CSRF_INVALID", "CSRF token is missing or invalid.");
      }
      if (!options.api) {
        sendJson(response, 503, {
          error: {
            code: "WEB_API_NOT_READY",
            message: "The Corptie LAN Web API is not configured."
          }
        });
        return;
      }
      await handleApiV1Request(request, response, url, options.api, session, {
        auth: options.auth,
        sessionToken: token,
        eventAuthCheckIntervalMs: options.eventAuthCheckIntervalMs
      });
      return;
    }

    sendJson(response, 404, {
      error: {
        code: "NOT_FOUND",
        message: "Not found."
      }
    });
}

async function tryServeWebAsset(request, response, pathname, webRoot) {
  if (!webRoot) return false;
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  const relativePath = decodedPath.replace(/^\/+/, "");
  const requestedPath = resolve(webRoot, relativePath || "index.html");
  if (requestedPath !== webRoot && !requestedPath.startsWith(`${webRoot}/`)) return false;
  let asset = await readFile(requestedPath).catch(() => null);
  let servedPath = requestedPath;
  if (!asset && !extname(relativePath)) {
    servedPath = resolve(webRoot, "index.html");
    asset = await readFile(servedPath).catch(() => null);
  }
  if (!asset) return false;
  const immutable = servedPath.includes(`${webRoot}/assets/`);
  response.writeHead(200, {
    ...WEB_SECURITY_HEADERS,
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    "content-type": contentTypeForPath(servedPath),
    "content-length": asset.length
  });
  response.end(request.method === "HEAD" ? undefined : asset);
  return true;
}

function contentTypeForPath(path) {
  switch (extname(path).toLowerCase()) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".webmanifest": return "application/manifest+json; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".woff2": return "font/woff2";
    default: return "application/octet-stream";
  }
}

async function handleApiV1Request(request, response, url, api, webSession, context = {}) {
  if (request.method === "GET" && url.pathname === "/api/v1/bootstrap") {
    sendJson(response, 200, await api.bootstrap(webSession));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/v1/sessions") {
    sendJson(response, 200, await api.sessions(webSession));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/v1/sessions") {
    sendJson(response, 201, await api.create(await readJson(request), webSession));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/v1/sessions/reorder") {
    sendJson(response, 200, await api.reorder(await readJson(request), webSession));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/v1/attention") {
    sendJson(response, 200, await api.attention(webSession));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/v1/collaboration") {
    sendJson(response, 200, await api.collaborationOverview());
    return;
  }
  const collaborationTaskMatch = url.pathname.match(/^\/api\/v1\/collaboration\/tasks\/([^/]+)$/);
  if (request.method === "GET" && collaborationTaskMatch) {
    sendJson(response, 200, await api.collaborationTask(decodeURIComponent(collaborationTaskMatch[1])));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/v1/collaboration/actions") {
    sendJson(response, 200, await api.collaborationAction(await readJson(request), {
      webSession,
      idempotencyKey: request.headers["idempotency-key"]
    }));
    return;
  }
  const attentionReadMatch = url.pathname.match(/^\/api\/v1\/attention\/([^/]+)\/read$/);
  if (request.method === "POST" && attentionReadMatch) {
    sendJson(
      response,
      200,
      await api.markAttentionRead(decodeURIComponent(attentionReadMatch[1]), webSession)
    );
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/v1/events") {
    openApiV1EventStream(request, response, url, api, context);
    return;
  }
  const operationMatch = url.pathname.match(/^\/api\/v1\/operations\/([^/]+)$/);
  if (request.method === "GET" && operationMatch) {
    sendJson(response, 200, await api.operation(decodeURIComponent(operationMatch[1]), webSession));
    return;
  }
  const sessionMatch = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)$/);
  if (request.method === "GET" && sessionMatch) {
    sendJson(response, 200, await api.session(decodeURIComponent(sessionMatch[1]), webSession));
    return;
  }
  const metadataMatch = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/metadata$/);
  if (request.method === "GET" && metadataMatch) {
    sendJson(response, 200, await api.metadata(decodeURIComponent(metadataMatch[1])));
    return;
  }
  const turnDiffMatch = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/turns\/([^/]+)\/diff$/);
  if (request.method === "GET" && turnDiffMatch) {
    sendJson(response, 200, await api.turnDiff(
      decodeURIComponent(turnDiffMatch[1]),
      decodeURIComponent(turnDiffMatch[2])
    ));
    return;
  }
  const turnActionMatch = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/turns\/([^/]+)\/actions$/);
  if (request.method === "POST" && turnActionMatch) {
    sendJson(response, 200, await api.turnAction(
      decodeURIComponent(turnActionMatch[1]),
      decodeURIComponent(turnActionMatch[2]),
      await readJson(request),
      { webSession, idempotencyKey: request.headers["idempotency-key"] }
    ));
    return;
  }
  const avatarMatch = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/avatar$/);
  if (request.method === "GET" && avatarMatch) {
    const avatar = api.avatar(decodeURIComponent(avatarMatch[1]));
    const extension = extname(avatar.path).toLowerCase();
    const contentTypes = {
      ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
      ".gif": "image/gif", ".webp": "image/webp"
    };
    const contentType = contentTypes[extension];
    if (!contentType) throw requestError("INVALID_REQUEST", "Unsupported avatar format.");
    const info = await stat(avatar.path);
    if (!info.isFile() || info.size > 5 * 1024 * 1024) {
      throw requestError("INVALID_REQUEST", "Avatar is unavailable.");
    }
    const data = await readFile(avatar.path);
    response.writeHead(200, {
      ...SECURITY_HEADERS,
      "content-type": contentType,
      "content-length": data.length,
      "cache-control": "private, max-age=300"
    });
    response.end(data);
    return;
  }
  const actionMatch = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/actions$/);
  if (request.method === "POST" && actionMatch) {
    const result = await api.action(
      decodeURIComponent(actionMatch[1]),
      await readJson(request),
      {
        webSession,
        idempotencyKey: request.headers["idempotency-key"]
      }
    );
    sendJson(response, result.status === "accepted" ? 202 : 200, result);
    return;
  }
  throw requestError("INVALID_REQUEST", "The requested API v1 route does not exist.");
}

function openApiV1EventStream(request, response, url, api, context) {
  const headerCursor = request.headers["last-event-id"];
  const rawCursor = url.searchParams.has("cursor") ? url.searchParams.get("cursor") : (headerCursor ?? 0);
  const cursor = Number(rawCursor);
  const backlog = api.events(cursor);
  let lastSent = cursor;
  const writeEvent = (event) => {
    if (event.eventId <= lastSent || response.destroyed || response.writableEnded) return;
    lastSent = event.eventId;
    response.write(`id: ${event.eventId}\ndata: ${JSON.stringify(event)}\n\n`);
  };

  response.writeHead(200, {
    ...SECURITY_HEADERS,
    "cache-control": "no-cache, no-transform",
    "content-type": "text/event-stream; charset=utf-8",
    connection: "keep-alive"
  });
  response.write("retry: 2000\n\n");
  for (const event of backlog) writeEvent(event);
  const unsubscribe = api.subscribe(writeEvent);
  const heartbeat = setInterval(() => {
    if (!response.destroyed && !response.writableEnded) response.write(": keepalive\n\n");
  }, 15_000);
  const authCheck = setInterval(() => {
    try {
      context.auth.authenticate(context.sessionToken);
    } catch {
      cleanup();
      response.end();
    }
  }, Math.max(10, context.eventAuthCheckIntervalMs ?? 15_000));
  const cleanup = () => {
    clearInterval(heartbeat);
    clearInterval(authCheck);
    unsubscribe();
  };
  request.once("close", cleanup);
  response.once("close", cleanup);
}

function normalizeRuntimeSettings(input, options = {}) {
  const enabled = input?.enabled === true;
  const host = typeof input?.host === "string" ? input.host.trim() : "";
  const port = Number(input?.port);
  const validPort = Number.isInteger(port)
    && ((options.allowEphemeralPort === true && port === 0) || (port >= 1 && port <= 65535));

  if (enabled && (!host || isIP(host) === 0 || host === "0.0.0.0" || host === "::")) {
    throw new Error("LAN Web Gateway requires one explicit IP address.");
  }
  if (enabled && !validPort) {
    throw new Error("LAN Web Gateway requires a valid port.");
  }

  return {
    enabled,
    host,
    port: validPort ? port : null,
    httpsEnabled: input?.httpsEnabled !== false
  };
}

function sameSettings(left, right) {
  return left.enabled === right.enabled
    && left.host === right.host
    && left.port === right.port
    && left.httpsEnabled === right.httpsEnabled;
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
    server.closeIdleConnections?.();
  });
}

function sendJson(response, statusCode, body, extraHeaders = {}) {
  if (response.headersSent) return;
  const json = JSON.stringify(body);
  response.writeHead(statusCode, {
    ...SECURITY_HEADERS,
    ...extraHeaders,
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json)
  });
  response.end(json);
}

function sendApiError(response, error) {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const payload = createApiV1Error({
    code: error?.code === "API_V1_CONTRACT_INVALID" ? "INVALID_REQUEST" : error?.code,
    message: error?.message,
    retryable: error?.code === "RATE_LIMITED"
  });
  sendJson(response, payload.statusCode, payload.body);
}

async function readJson(request, maxBytes = 16 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      throw requestError("INVALID_REQUEST", "Request body is too large.");
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw requestError("INVALID_REQUEST", "Request body must be valid JSON.");
  }
}

function requestError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function originForStatus(status) {
  if (!status.listening || !status.host || !status.port) return null;
  return `${status.secure ? "https" : "http"}://${formatHost(status.host)}:${status.port}`;
}

function formatHost(host) {
  return host.includes(":") ? `[${host}]` : host;
}

function pemCertificateToDer(value) {
  const pem = Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
  const encoded = pem
    .replace(/-----BEGIN CERTIFICATE-----/g, "")
    .replace(/-----END CERTIFICATE-----/g, "")
    .replace(/\s+/g, "");
  return Buffer.from(encoded, "base64");
}

function appleCertificateProfile(certificatePem) {
  const der = pemCertificateToDer(certificatePem);
  const digest = createHash("sha256").update(der).digest("hex");
  const rootUuid = uuidFromDigest(digest);
  const profileUuid = uuidFromDigest(createHash("sha256").update(`profile:${digest}`).digest("hex"));
  const payloadIdentifier = `app.corptie.local-ca.${digest.slice(0, 16)}`;
  return [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
    "<plist version=\"1.0\">",
    "<dict>",
    "<key>PayloadContent</key>",
    "<array>",
    "<dict>",
    "<key>PayloadCertificateFileName</key><string>Corptie Local Root CA.cer</string>",
    `<key>PayloadContent</key><data>${der.toString("base64")}</data>`,
    "<key>PayloadDescription</key><string>Trust this Mac for Corptie Web Access on the local network.</string>",
    "<key>PayloadDisplayName</key><string>Corptie Local Root CA</string>",
    `<key>PayloadIdentifier</key><string>${payloadIdentifier}.root</string>`,
    "<key>PayloadType</key><string>com.apple.security.root</string>",
    `<key>PayloadUUID</key><string>${rootUuid}</string>`,
    "<key>PayloadVersion</key><integer>1</integer>",
    "</dict>",
    "</array>",
    "<key>PayloadDescription</key><string>Installs the unique local certificate authority for this Corptie Mac.</string>",
    "<key>PayloadDisplayName</key><string>Corptie Local Web Access</string>",
    `<key>PayloadIdentifier</key><string>${payloadIdentifier}</string>`,
    "<key>PayloadOrganization</key><string>Corptie</string>",
    "<key>PayloadRemovalDisallowed</key><false/>",
    "<key>PayloadType</key><string>Configuration</string>",
    `<key>PayloadUUID</key><string>${profileUuid}</string>`,
    "<key>PayloadVersion</key><integer>1</integer>",
    "</dict>",
    "</plist>",
    ""
  ].join("\n");
}

function uuidFromDigest(digest) {
  const value = digest.slice(0, 32).toUpperCase().split("");
  value[12] = "4";
  value[16] = ["8", "9", "A", "B"][Number.parseInt(value[16], 16) % 4];
  const hex = value.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
