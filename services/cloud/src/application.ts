import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";
import type { CloudConfig } from "./config.js";
import {
  AccountAlreadyExistsError,
  AuthenticationError,
  AuthorizationError,
  type InvitedUser,
  type InvitedUserInput,
  type PrincipalResolver
} from "./auth.js";
import { checkCloudDatabase } from "./database.js";
import {
  CloudDeviceService,
  DeviceConflictError,
  DeviceNotFoundError,
  registerDeviceInputSchema
} from "./devices.js";
import {
  InvitationError,
  InvitationService,
  createInvitationInputSchema,
  redeemInvitationInputSchema
} from "./invitations.js";
import { RelayHub } from "./relay.js";
import {
  NativeOAuthClientRegistry,
  OAuthClientConflictError,
  nativeOAuthClientInputSchema
} from "./oauthClients.js";
import type { AccountRevocationEvents } from "./accountSecurity.js";
import { authPageResponse } from "./authPages.js";

interface AuthHandler {
  handler(request: Request): Promise<Response>;
}

interface ApplicationDependencies {
  config: CloudConfig;
  database: DatabaseSync;
  auth: AuthHandler;
  resolvePrincipal: PrincipalResolver;
  provisionInvitedUser: (input: InvitedUserInput) => Promise<InvitedUser>;
  verifyOAuthPageQuery?: (query: string) => Promise<boolean>;
  revocations?: AccountRevocationEvents;
  now?: () => Date;
}

export function createCloudApplication(dependencies: ApplicationDependencies) {
  const devices = new CloudDeviceService(dependencies.database, dependencies.now);
  const invitations = new InvitationService(
    dependencies.database,
    dependencies.config.authSecret,
    dependencies.config.adminToken,
    dependencies.provisionInvitedUser,
    dependencies.now
  );
  const oauthClients = new NativeOAuthClientRegistry(
    dependencies.database,
    `${dependencies.config.publicBaseUrl}/v1`,
    dependencies.now
  );
  let relay: RelayHub;
  const server = createServer(async (incoming, outgoing) => {
    try {
      const request = await toWebRequest(incoming, dependencies.config);
      const response = await dispatch(request, dependencies, devices, invitations, oauthClients, relay);
      await sendWebResponse(outgoing, response);
    } catch (error) {
      await sendWebResponse(outgoing, errorResponse(error));
    }
  });
  relay = new RelayHub({
    server,
    config: dependencies.config,
    devices,
    resolvePrincipal: dependencies.resolvePrincipal
  });
  const unsubscribeRevocations = dependencies.revocations?.subscribe((accountId) => relay.revokeAccount(accountId));

  return {
    server,
    async listen(): Promise<AddressInfo> {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(dependencies.config.port, dependencies.config.host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      return server.address() as AddressInfo;
    },
    async close(): Promise<void> {
      unsubscribeRevocations?.();
      await relay.close();
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

async function dispatch(
  request: Request,
  dependencies: ApplicationDependencies,
  devices: CloudDeviceService,
  invitations: InvitationService,
  oauthClients: NativeOAuthClientRegistry,
  relay: RelayHub
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/healthz" && request.method === "GET") {
    return json(200, { status: "ok", version: dependencies.config.version });
  }
  if (url.pathname === "/readyz" && request.method === "GET") {
    checkCloudDatabase(dependencies.database);
    return json(200, { status: "ready", version: dependencies.config.version });
  }
  if (url.pathname.startsWith("/api/auth/")) {
    return dependencies.auth.handler(request);
  }
  const authPage = await authPageResponse(request, {
    verifyOAuthPageQuery: dependencies.verifyOAuthPageQuery ?? (async () => false)
  });
  if (authPage) return authPage;

  if (url.pathname === "/v1/admin/invitations" && request.method === "POST") {
    if (!invitations.authorizeAdminToken(request.headers.get("authorization"))) {
      throw new AuthenticationError("Valid local administration token required");
    }
    const input = createInvitationInputSchema.parse(await request.json());
    return json(201, { invitation: invitations.create(input) });
  }
  if (url.pathname === "/v1/admin/oauth-clients" && request.method === "POST") {
    if (!invitations.authorizeAdminToken(request.headers.get("authorization"))) {
      throw new AuthenticationError("Valid local administration token required");
    }
    const input = nativeOAuthClientInputSchema.parse(await request.json());
    return json(201, { client: oauthClients.register(input) });
  }
  if (url.pathname === "/v1/invitations/redeem" && request.method === "POST") {
    const input = redeemInvitationInputSchema.parse(await request.json());
    const user = await invitations.redeem(input);
    return json(201, { user });
  }

  enforceOrigin(request, dependencies.config.trustedOrigins);
  if (url.pathname === "/v1/devices" && request.method === "GET") {
    const principal = await dependencies.resolvePrincipal(request, ["devices:read"]);
    return json(200, { devices: devices.listForAccount(principal.accountId) });
  }
  if (url.pathname === "/v1/devices" && request.method === "POST") {
    const principal = await dependencies.resolvePrincipal(request, ["devices:write"]);
    const input = registerDeviceInputSchema.parse(await request.json());
    return json(201, { device: devices.register(principal.accountId, input) });
  }

  const deviceMatch = /^\/v1\/devices\/([0-9a-f-]+)$/i.exec(url.pathname);
  if (deviceMatch && request.method === "DELETE") {
    const deviceId = deviceMatch[1];
    if (!deviceId) return json(404, { code: "NOT_FOUND" });
    const principal = await dependencies.resolvePrincipal(request, ["devices:manage"]);
    requireRecentAuthentication(principal.reauthenticatedAt, dependencies.now?.() ?? new Date());
    const device = devices.revokeDevice(principal.accountId, deviceId);
    relay.revokeDevice(principal.accountId, deviceId);
    return json(200, { device });
  }

  return json(404, { code: "NOT_FOUND" });
}

function enforceOrigin(request: Request, trustedOrigins: readonly string[]): void {
  const origin = request.headers.get("origin");
  if (origin && !trustedOrigins.includes(origin)) {
    throw new AuthorizationError("Origin is not trusted");
  }
}

function requireRecentAuthentication(reauthenticatedAt: Date | null, now: Date): void {
  const maximumAgeMs = 5 * 60 * 1_000;
  if (!reauthenticatedAt || now.getTime() - reauthenticatedAt.getTime() > maximumAgeMs) {
    const error = new AuthorizationError("Recent authentication is required");
    Object.defineProperty(error, "code", { value: "RECENT_AUTHENTICATION_REQUIRED" });
    throw error;
  }
}

async function toWebRequest(incoming: IncomingMessage, config: CloudConfig): Promise<Request> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of incoming) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > config.maxJsonBytes) {
      const error = new Error("Request body is too large");
      Object.assign(error, { status: 413, code: "PAYLOAD_TOO_LARGE" });
      throw error;
    }
    chunks.push(buffer);
  }
  const host = incoming.headers.host ?? `${config.host}:${config.port}`;
  const url = new URL(incoming.url ?? "/", `http://${host}`);
  const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
  const init: RequestInit = {
    method: incoming.method ?? "GET",
    headers: incoming.headers as HeadersInit
  };
  if (body) init.body = body;
  return new Request(url, init);
}

async function sendWebResponse(outgoing: ServerResponse, response: Response): Promise<void> {
  outgoing.statusCode = response.status;
  response.headers.forEach((value, name) => outgoing.setHeader(name, value));
  const buffer = Buffer.from(await response.arrayBuffer());
  outgoing.end(buffer);
}

function json(status: number, body: unknown): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8"
    }
  });
}

function errorResponse(error: unknown): Response {
  if (error instanceof AuthenticationError || error instanceof AuthorizationError) {
    return json(error.status, { code: error.code, message: error.message });
  }
  if (error instanceof DeviceConflictError) return json(409, { code: error.code, message: error.message });
  if (error instanceof DeviceNotFoundError) return json(404, { code: error.code, message: error.message });
  if (error instanceof AccountAlreadyExistsError) return json(409, { code: error.code, message: error.message });
  if (error instanceof InvitationError) {
    const status = error.code === "INVITATION_EXPIRY_INVALID" ? 400 : 409;
    return json(status, { code: error.code, message: error.message });
  }
  if (error instanceof OAuthClientConflictError) return json(409, { code: error.code, message: error.message });
  if (error && typeof error === "object" && "issues" in error) {
    return json(400, { code: "INVALID_REQUEST", message: "Request validation failed" });
  }
  if (error && typeof error === "object" && "status" in error && "code" in error) {
    const candidate = error as { status: unknown; code: unknown; message?: unknown };
    if (typeof candidate.status === "number" && typeof candidate.code === "string") {
      return json(candidate.status, {
        code: candidate.code,
        message: typeof candidate.message === "string" ? candidate.message : "Request failed"
      });
    }
  }
  return json(500, { code: "INTERNAL_ERROR", message: "The request could not be completed" });
}
