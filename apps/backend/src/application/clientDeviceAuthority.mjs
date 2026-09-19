import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile, rename, chmod, lstat } from "node:fs/promises";
import { join } from "node:path";

const token = () => randomBytes(32).toString("base64url");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const validToken = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
export const CLIENT_DEVICE_PERMISSIONS = ["inventory.read", "control.read", "messages.read", "messages.write", "sessions.stop"];
export const deviceError = (code, status = 401) => Object.assign(new Error(code), { code, status });

/** Device credentials authorize client access, never impersonate a Session or Agent. */
export class ClientDeviceAuthority {
  constructor(directory, { now = Date.now } = {}) {
    this.directory = directory;
    this.now = now;
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
          permissions: [...CLIENT_DEVICE_PERMISSIONS],
          refreshExpiresAt: this.now() + 30 * 86400_000 };
        state.devices.push(device);
        return this.issue(device, state.serverId);
      });
      this.pending.delete(pairingId);
      return result;
    } catch (error) { item.status = "approved"; throw error; }
  }

  issue(device, serverId) {
    const accessToken = token();
    const refreshToken = token();
    device.accessHash = hash(accessToken);
    device.refreshHash = hash(refreshToken);
    device.accessExpiresAt = this.now() + 15 * 60_000;
    return { serverId, deviceId: device.id, accessToken, refreshToken,
      accessExpiresAt: device.accessExpiresAt, refreshExpiresAt: device.refreshExpiresAt };
  }

  refresh({ refreshToken }) {
    if (!validToken(refreshToken)) throw deviceError("INVALID_CREDENTIAL");
    return this.change(state => {
      const device = state.devices.find(d => d.refreshHash === hash(refreshToken));
      if (!device || device.revoked || device.refreshExpiresAt <= this.now()) throw deviceError("INVALID_CREDENTIAL");
      return this.issue(device, state.serverId);
    });
  }

  authenticate(accessToken) {
    if (!validToken(accessToken)) throw deviceError("INVALID_CREDENTIAL");
    const device = this.state.devices.find(d => d.accessHash === hash(accessToken));
    if (!device || device.revoked || device.accessExpiresAt <= this.now()) throw deviceError("INVALID_CREDENTIAL");
    return { deviceId: device.id, name: device.name, serverId: this.state.serverId,
      permissions: device.permissions ?? [...CLIENT_DEVICE_PERMISSIONS] };
  }

  canDeliverScheduledMessage(deviceId) {
    const device = this.state.devices.find(item => item.id === deviceId);
    return Boolean(device && !device.revoked && device.refreshExpiresAt > this.now()
      && (device.permissions ?? CLIENT_DEVICE_PERMISSIONS).includes("messages.write"));
  }

  async setPermissions(id, permissions) {
    const allowed = CLIENT_DEVICE_PERMISSIONS;
    if (!Array.isArray(permissions) || permissions.length > allowed.length
        || permissions.some(p => !allowed.includes(p))) throw deviceError("INVALID_PERMISSIONS", 400);
    await this.change(state => {
      const device = state.devices.find(d => d.id === id && !d.revoked);
      if (!device) throw deviceError("DEVICE_NOT_FOUND", 404);
      device.permissions = [...new Set(permissions)];
    });
    for (const listener of this.listeners) listener(id);
    return { deviceId: id, permissions: [...new Set(permissions)] };
  }

  async revoke(id) {
    await this.change(state => {
      const device = state.devices.find(d => d.id === id);
      if (!device) throw deviceError("DEVICE_NOT_FOUND", 404);
      device.revoked = true;
      delete device.accessHash;
      delete device.refreshHash;
    });
    for (const listener of this.listeners) listener(id);
  }

  list() {
    return { devices: this.state.devices.map(({ id, name, createdAt, revoked, permissions }) => ({ id, name, createdAt, revoked,
      permissions: permissions ?? [...CLIENT_DEVICE_PERMISSIONS] })),
      pending: [...this.pending].filter(([, p]) => p.expiresAt > this.now() && p.status === "pending")
        .map(([pairingId, p]) => ({ pairingId, name: p.name, expiresAt: p.expiresAt })) };
  }
}
