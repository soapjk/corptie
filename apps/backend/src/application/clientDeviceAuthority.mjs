import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile, rename, chmod, lstat } from "node:fs/promises";
import { join } from "node:path";

const token = () => randomBytes(32).toString("base64url");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const validToken = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
export const deviceError = (code, status = 401) => Object.assign(new Error(code), { code, status });

/** Device credentials authorize client access, never impersonate a Session or Agent. */
export class ClientDeviceAuthority {
  constructor(directory, { now = Date.now, rotationGraceMs = 30_000 } = {}) {
    this.directory = directory;
    this.now = now;
    this.rotationGraceMs = rotationGraceMs;
    this.pending = new Map();
    this.tail = Promise.resolve();
    this.listeners = new Set();
  }

  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (!(await lstat(this.directory)).isDirectory()) throw deviceError("INVALID_AUTH_DIRECTORY", 500);
    await chmod(this.directory, 0o700);
    const file = join(this.directory, "devices.json");
    try {
      if (!(await lstat(file)).isFile()) throw deviceError("INVALID_AUTH_STORE", 500);
      this.state = JSON.parse(await readFile(file, "utf8"));
      if (this.state.version !== 1 || typeof this.state.serverId !== "string" || !Array.isArray(this.state.devices)) {
        throw deviceError("INVALID_AUTH_STORE", 500);
      }
      // Pairing approval is the sole device authorization boundary. Remove
      // legacy per-feature grants so an old device receives the same client
      // capabilities as a newly paired one.
      let migrated = false;
      for (const device of this.state.devices) {
        if (Object.hasOwn(device, "permissions")) { delete device.permissions; migrated = true; }
      }
      if (migrated) await this.save(this.state);
      await chmod(file, 0o600);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.state = { version: 1, serverId: randomUUID(), devices: [] };
      await this.save(this.state);
    }
    // Rotate local management credential on every backend start; pending invites also expire on restart.
    this.adminToken = token();
    const adminFile = join(this.directory, "admin-token");
    const adminTemporary = `${adminFile}.${randomUUID()}.new`;
    await writeFile(adminTemporary, this.adminToken, { mode: 0o600, flag: "wx", flush: true });
    await rename(adminTemporary, adminFile);
  }

  async save(state) {
    const file = join(this.directory, `devices.${randomUUID()}.tmp`);
    await writeFile(file, JSON.stringify(state), { mode: 0o600, flag: "wx", flush: true });
    await rename(file, join(this.directory, "devices.json"));
  }

  change(action) {
    const operation = this.tail.then(async () => {
      const next = structuredClone(this.state);
      const result = action(next);
      await this.save(next);
      this.state = next;
      return result;
    });
    this.tail = operation.catch(() => {});
    return operation;
  }

  checkAdmin(value) {
    return validToken(value) && timingSafeEqual(Buffer.from(value), Buffer.from(this.adminToken));
  }

  invite() {
    for (const [id, item] of this.pending) if (item.expiresAt <= this.now()) this.pending.delete(id);
    if (this.pending.size >= 20) throw deviceError("PAIRING_LIMIT", 429);
    const id = randomUUID();
    const secret = token();
    const expiresAt = this.now() + 5 * 60_000;
    this.pending.set(id, { inviteHash: hash(secret), expiresAt, status: "invited" });
    return { pairingId: id, pairingSecret: secret, expiresAt, serverId: this.state.serverId };
  }

  claim({ pairingId, pairingSecret, name }) {
    const item = this.pairing(pairingId);
    if (!validToken(pairingSecret) || item.inviteHash !== hash(pairingSecret) || item.status !== "invited") {
      throw deviceError("PAIRING_INVALID");
    }
    if (typeof name !== "string" || !name.trim() || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) {
      throw deviceError("INVALID_DEVICE_NAME", 400);
    }
    const secret = token();
    item.pollHash = hash(secret);
    item.name = name.trim();
    item.status = "pending";
    delete item.inviteHash;
    return { pairingId, exchangeSecret: secret, status: "pending", expiresAt: item.expiresAt };
  }

  pairing(id) {
    const item = this.pending.get(id);
    if (!item || item.expiresAt <= this.now()) throw deviceError("PAIRING_EXPIRED", 410);
    return item;
  }

  approve(id, approved) {
    const item = this.pairing(id);
    if (item.status !== "pending") throw deviceError("PAIRING_STATE_CONFLICT", 409);
    item.status = approved ? "approved" : "denied";
    return { pairingId: id, status: item.status };
  }

  async exchange({ pairingId, exchangeSecret }) {
    const item = this.pairing(pairingId);
    if (!validToken(exchangeSecret) || item.pollHash !== hash(exchangeSecret)) throw deviceError("PAIRING_INVALID");
    if (item.status !== "approved") throw deviceError(item.status === "denied" ? "PAIRING_DENIED" : "PAIRING_NOT_APPROVED", 403);
    item.status = "exchanging";
    try {
      const result = await this.change(state => {
        if (state.devices.length >= 100) throw deviceError("DEVICE_LIMIT", 409);
        const device = { id: randomUUID(), name: item.name, createdAt: this.now(), revoked: false,
          refreshExpiresAt: this.now() + 30 * 86400_000 };
        state.devices.push(device);
        return this.issue(device, state.serverId);
      });
      this.pending.delete(pairingId);
      return result;
    } catch (error) { item.status = "approved"; throw error; }
  }

  issueCloudGrant({ cloudDeviceId, name }) {
    if (typeof cloudDeviceId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(cloudDeviceId)) {
      throw deviceError("INVALID_CLOUD_DEVICE", 400);
    }
    if (typeof name !== "string" || !name.trim() || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) {
      throw deviceError("INVALID_DEVICE_NAME", 400);
    }
    cloudDeviceId = cloudDeviceId.toLowerCase();
    return this.change(state => {
      const now = this.now();
      let device = state.devices.find(item => item.authSource === "cloud_account" && item.cloudDeviceId === cloudDeviceId);
      if (!device) {
        if (state.devices.length >= 100) throw deviceError("DEVICE_LIMIT", 409);
        device = { id: randomUUID(), createdAt: now };
        state.devices.push(device);
      }
      device.name = name.trim();
      device.authSource = "cloud_account";
      device.cloudDeviceId = cloudDeviceId;
      device.lastOnlineValidatedAt = now;
      device.refreshExpiresAt = now + 24 * 60 * 60_000;
      device.revoked = false;
      delete device.previousRefreshHash;
      delete device.previousRefreshExpiresAt;
      return { ...this.issue(device, state.serverId), cloudValidatedAt: now };
    });
  }

  // Only the local authenticated Mac relay may register an E2E-verified peer.
  // Keep its identity shared with LAN grants without rotating their credentials.
  registerCloudRelayPeer({ cloudDeviceId, name }) {
    if (typeof cloudDeviceId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(cloudDeviceId)
        || typeof name !== "string" || !name.trim() || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) {
      throw deviceError("INVALID_CLOUD_DEVICE", 400);
    }
    cloudDeviceId = cloudDeviceId.toLowerCase();
    return this.change(state => {
      let device = state.devices.find(item => item.authSource === "cloud_account" && item.cloudDeviceId === cloudDeviceId);
      if (!device) {
        if (state.devices.length >= 100) throw deviceError("DEVICE_LIMIT", 409);
        device = { id: randomUUID(), authSource: "cloud_account", cloudDeviceId, createdAt: this.now() };
        state.devices.push(device);
      }
      device.name = name.trim(); device.revoked = false;
      device.lastOnlineValidatedAt = this.now();
      return { deviceId: device.id };
    });
  }

  authenticateCloudRelayPeer(cloudDeviceId) {
    if (typeof cloudDeviceId !== "string") throw deviceError("DEVICE_AUTH_REQUIRED");
    const device = this.state.devices.find(item => item.authSource === "cloud_account"
      && item.cloudDeviceId === cloudDeviceId.toLowerCase());
    if (!device || device.revoked) throw deviceError("DEVICE_REVOKED");
    return { deviceId: device.id, name: device.name, serverId: this.state.serverId };
  }

  syncCloudDevices(activeCloudDeviceIds) {
    const active = new Set(activeCloudDeviceIds);
    return this.change(state => {
      const revoked = [];
      for (const device of state.devices) {
        if (device.authSource !== "cloud_account" || device.revoked || active.has(device.cloudDeviceId)) continue;
        device.revoked = true;
        delete device.accessHash;
        delete device.refreshHash;
        delete device.previousRefreshHash;
        delete device.previousRefreshExpiresAt;
        revoked.push(device.id);
      }
      return revoked;
    }).then(revoked => {
      for (const id of revoked) for (const listener of this.listeners) listener(id);
      return { revoked };
    });
  }

  revokeCloudDevice(cloudDeviceId = null) {
    return this.change(state => {
      const revoked = [];
      for (const device of state.devices) {
        if (device.authSource !== "cloud_account" || device.revoked
            || (cloudDeviceId !== null && device.cloudDeviceId !== cloudDeviceId)) continue;
        device.revoked = true;
        delete device.accessHash;
        delete device.refreshHash;
        delete device.previousRefreshHash;
        delete device.previousRefreshExpiresAt;
        revoked.push(device.id);
      }
      return revoked;
    }).then(revoked => {
      for (const id of revoked) for (const listener of this.listeners) listener(id);
      return { revoked };
    });
  }

  issue(device, serverId, { preserveGrace = false } = {}) {
    const accessToken = token();
    const refreshToken = token();
    if (!preserveGrace && this.rotationGraceMs > 0 && device.refreshHash) {
      device.previousRefreshHash = device.refreshHash;
      device.previousRefreshExpiresAt = this.now() + this.rotationGraceMs;
    }
    device.accessHash = hash(accessToken);
    device.refreshHash = hash(refreshToken);
    device.accessExpiresAt = this.now() + 15 * 60_000;
    return { serverId, deviceId: device.id, accessToken, refreshToken,
      accessExpiresAt: device.accessExpiresAt, refreshExpiresAt: device.refreshExpiresAt,
      ...(device.authSource === "cloud_account" ? { cloudValidatedAt: device.lastOnlineValidatedAt } : {}) };
  }

  refresh({ refreshToken }) {
    if (!validToken(refreshToken)) throw deviceError("INVALID_CREDENTIAL");
    return this.change(state => {
      const now = this.now();
      const tokenHash = hash(refreshToken);
      let isGrace = false;
      let device = state.devices.find(d => d.refreshHash === tokenHash);
      if (!device && this.rotationGraceMs > 0) {
        device = state.devices.find(d => d.previousRefreshHash === tokenHash && (d.previousRefreshExpiresAt ?? 0) > now);
        if (device) isGrace = true;
      }
      if (!device || device.revoked || device.refreshExpiresAt <= now) throw deviceError("INVALID_CREDENTIAL");
      return this.issue(device, state.serverId, { preserveGrace: isGrace });
    });
  }

  authenticate(accessToken) {
    if (!validToken(accessToken)) throw deviceError("INVALID_CREDENTIAL");
    const device = this.state.devices.find(d => d.accessHash === hash(accessToken));
    if (!device || device.revoked || device.accessExpiresAt <= this.now()) throw deviceError("INVALID_CREDENTIAL");
    return { deviceId: device.id, name: device.name, serverId: this.state.serverId };
  }

  canDeliverScheduledMessage(deviceId) {
    const device = this.state.devices.find(item => item.id === deviceId);
    return Boolean(device && !device.revoked && device.refreshExpiresAt > this.now());
  }

  async revoke(id) {
    await this.change(state => {
      const device = state.devices.find(d => d.id === id);
      if (!device) throw deviceError("DEVICE_NOT_FOUND", 404);
      device.revoked = true;
      delete device.accessHash;
      delete device.refreshHash;
      delete device.previousRefreshHash;
      delete device.previousRefreshExpiresAt;
    });
    for (const listener of this.listeners) listener(id);
  }

  list() {
    return { devices: this.state.devices.map(({ id, name, createdAt, revoked, authSource = "local_pairing" }) =>
      ({ id, name, createdAt, revoked, authSource })),
      pending: [...this.pending].filter(([, p]) => p.expiresAt > this.now() && p.status === "pending")
        .map(([pairingId, p]) => ({ pairingId, name: p.name, expiresAt: p.expiresAt })) };
  }
}
