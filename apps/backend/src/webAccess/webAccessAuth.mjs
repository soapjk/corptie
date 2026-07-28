import {
  createHash,
  randomBytes,
  randomInt,
  randomUUID,
  scryptSync,
  timingSafeEqual
} from "node:crypto";

export const WEB_SESSION_COOKIE = "corptie_web_session";

const PAIRING_TTL_MS = 5 * 60 * 1000;
const PAIRING_REQUEST_TTL_MS = 10 * 60 * 1000;
const SESSION_IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PERMISSIONS = new Set(["read-only", "reply", "full-control"]);

export class WebAccessAuth {
  constructor(options) {
    this.store = options.store;
    this.clock = options.clock ?? (() => Date.now());
  }

  createPairingCode() {
    const createdAtMs = this.clock();
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const codeSalt = randomBytes(16).toString("hex");
    const expiresAt = new Date(createdAtMs + PAIRING_TTL_MS).toISOString();
    this.store.replaceWebPairingCode({
      id: randomUUID(),
      codeSalt,
      codeHash: hashPairingCode(code, codeSalt),
      maxAttempts: 5,
      expiresAt,
      createdAt: new Date(createdAtMs).toISOString()
    });
    return {
      code,
      expiresAt
    };
  }

  requestPairing(input = {}, context = {}) {
    const code = typeof input.code === "string" ? input.code.trim() : "";
    const deviceName = normalizeDeviceName(input.deviceName);
    if (!/^\d{6}$/.test(code)) {
      throw webAuthError("PAIRING_CODE_INVALID", "Enter the 6-digit pairing code.");
    }
    const now = new Date(this.clock()).toISOString();
    const usableCodes = this.store.listUsableWebPairingCodes(now);
    const pairingCode = usableCodes.find((candidate) => safeEqual(
      candidate.codeHash,
      hashPairingCode(code, candidate.codeSalt)
    ));
    if (!pairingCode) {
      if (usableCodes[0]) {
        this.store.recordWebPairingFailure(usableCodes[0].id, now);
      }
      throw webAuthError("PAIRING_CODE_INVALID", "The pairing code is invalid or expired.");
    }

    const exchangeToken = randomToken();
    const request = this.store.createWebPairingRequest({
      id: randomUUID(),
      pairingCodeId: pairingCode.id,
      exchangeTokenHash: hashToken(exchangeToken),
      deviceName,
      userAgent: normalizeOptionalText(context.userAgent, 300),
      sourceIp: normalizeOptionalText(context.sourceIp, 100),
      requestedPermission: normalizePermission(input.permission),
      createdAt: now,
      expiresAt: new Date(this.clock() + PAIRING_REQUEST_TTL_MS).toISOString()
    });
    return {
      requestId: request.id,
      exchangeToken,
      status: request.status,
      expiresAt: request.expiresAt
    };
  }

  pendingRequests() {
    return this.store.listPendingWebPairingRequests(new Date(this.clock()).toISOString())
      .map(publicPairingRequest);
  }

  approveRequest(requestId, permission = "full-control") {
    const resolvedAt = new Date(this.clock()).toISOString();
    const request = this.store.resolveWebPairingRequest(requestId, {
      approved: true,
      deviceId: randomUUID(),
      permission: normalizePermission(permission),
      resolvedAt
    });
    if (!request) {
      throw webAuthError("ACTION_EXPIRED", "The pairing request is no longer pending.");
    }
    return publicPairingRequest(request);
  }

  rejectRequest(requestId) {
    const request = this.store.resolveWebPairingRequest(requestId, {
      approved: false,
      resolvedAt: new Date(this.clock()).toISOString()
    });
    if (!request) {
      throw webAuthError("ACTION_EXPIRED", "The pairing request is no longer pending.");
    }
    return publicPairingRequest(request);
  }

  claimRequest(requestId, exchangeToken) {
    const request = this.store.getWebPairingRequest(requestId);
    if (!request) {
      throw webAuthError("PAIRING_CODE_INVALID", "Pairing request not found.");
    }
    if (!safeEqual(request.exchangeTokenHash, hashToken(exchangeToken))) {
      throw webAuthError("AUTHENTICATION_REQUIRED", "Pairing exchange token is invalid.");
    }
    if (request.status === "pending") {
      return { status: "pending", expiresAt: request.expiresAt };
    }
    if (request.status === "rejected") {
      return { status: "rejected", expiresAt: request.expiresAt };
    }
    if (request.status !== "approved") {
      throw webAuthError("ACTION_EXPIRED", "Pairing request has already been claimed.");
    }

    const nowMs = this.clock();
    const sessionToken = randomToken();
    const csrfToken = randomToken();
    const session = this.store.claimWebPairingRequest(requestId, {
      exchangeTokenHash: hashToken(exchangeToken),
      sessionId: randomUUID(),
      tokenHash: hashToken(sessionToken),
      csrfToken,
      claimedAt: new Date(nowMs).toISOString(),
      idleExpiresAt: new Date(nowMs + SESSION_IDLE_TTL_MS).toISOString(),
      absoluteExpiresAt: new Date(nowMs + SESSION_ABSOLUTE_TTL_MS).toISOString()
    });
    if (!session) {
      throw webAuthError("ACTION_EXPIRED", "Pairing request could not be claimed.");
    }
    return {
      status: "approved",
      sessionToken,
      csrfToken,
      device: session.device,
      expiresAt: session.absoluteExpiresAt
    };
  }

  authenticate(sessionToken) {
    if (typeof sessionToken !== "string" || !sessionToken) {
      throw webAuthError("AUTHENTICATION_REQUIRED", "A paired device session is required.");
    }
    const nowMs = this.clock();
    const now = new Date(nowMs).toISOString();
    const session = this.store.getWebSessionByTokenHash(hashToken(sessionToken), now);
    if (!session) {
      throw webAuthError("AUTHENTICATION_EXPIRED", "The paired device session has expired or was revoked.");
    }
    this.store.touchWebSession(
      session.id,
      now,
      new Date(nowMs + SESSION_IDLE_TTL_MS).toISOString()
    );
    return session;
  }

  listDevices() {
    return this.store.listWebDevices();
  }

  revokeDevice(deviceId) {
    if (!this.store.revokeWebDevice(deviceId, new Date(this.clock()).toISOString())) {
      throw webAuthError("SESSION_NOT_FOUND", "Paired device not found.");
    }
  }

  revokeAllDevices() {
    return this.store.revokeAllWebDevices(new Date(this.clock()).toISOString());
  }
}

export function serializeWebSessionCookie(token, options = {}) {
  const attributes = [
    `${WEB_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.floor(SESSION_ABSOLUTE_TTL_MS / 1000)}`
  ];
  if (options.secure === true) attributes.push("Secure");
  return attributes.join("; ");
}

export function parseCookieHeader(header = "") {
  const cookies = {};
  for (const part of String(header).split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!key) continue;
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
  }
  return cookies;
}

export function isCsrfValid(session, header) {
  return safeEqual(session?.csrfToken, typeof header === "string" ? header : "");
}

function publicPairingRequest(request) {
  return {
    id: request.id,
    deviceName: request.deviceName,
    userAgent: request.userAgent,
    sourceIp: request.sourceIp,
    requestedPermission: request.requestedPermission,
    status: request.status,
    deviceId: request.deviceId,
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
    resolvedAt: request.resolvedAt
  };
}

function hashPairingCode(code, salt) {
  return scryptSync(code, salt, 32).toString("hex");
}

function hashToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

function randomToken() {
  return randomBytes(32).toString("base64url");
}

function safeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizeDeviceName(value) {
  const name = normalizeOptionalText(value, 80);
  if (!name) {
    throw webAuthError("INVALID_REQUEST", "Device name is required.");
  }
  return name;
}

function normalizePermission(value) {
  return PERMISSIONS.has(value) ? value : "full-control";
}

function normalizeOptionalText(value, maxLength) {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, maxLength)
    : null;
}

function webAuthError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
