import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket, type RawData } from "ws";
import { createCloudApplication } from "../src/application.js";
import type { CloudPrincipal } from "../src/auth.js";
import type { CloudConfig } from "../src/config.js";
import { openCloudDatabase } from "../src/database.js";
import { CloudDeviceService, createTestDeviceInput } from "../src/devices.js";
import { uuidToBytes } from "../src/relay.js";

const config: CloudConfig = {
  host: "127.0.0.1",
  port: 0,
  databasePath: ":memory:",
  publicBaseUrl: "http://127.0.0.1",
  authSecret: "9xS!4oz1N%r6Cb0Ye8Va3Qn7Tu5Kf2Wh",
  adminToken: "0yT!5pa2O^s7Dc1Zf9Wb4Ro8Uv6Lg3Xi",
  trustedOrigins: ["http://127.0.0.1"],
  logLevel: "error",
  maxJsonBytes: 65_536,
  relayMaxFrameBytes: 262_144,
  relayMaxQueuedBytes: 1_048_576,
  relayMaxConnectionsPerAccount: 20,
  relayHeartbeatMs: 30_000,
  version: "test",
  environment: "test",
  mail: { mode: "capture" }
};

test("Relay routes opaque binary frames only between active devices on the same account", async () => {
  const database = openCloudDatabase(":memory:");
  const devices = new CloudDeviceService(database);
  const accountId = "account:relay";
  const mac = devices.register(accountId, "session:mac", createTestDeviceInput({ kind: "mac", displayName: "Mac" }));
  const mobile = devices.register(accountId, "session:mobile", createTestDeviceInput({
    kind: "mobile",
    displayName: "Phone",
    publicKey: Buffer.alloc(32, 9).toString("base64")
  }));
  const application = createCloudApplication({
    config,
    database,
    auth: { handler: async () => new Response(null, { status: 404 }) },
    resolvePrincipal: async (request, scopes): Promise<CloudPrincipal> => ({
      accountId: request.headers.get("x-test-account") ?? "",
      authorizationSessionId: request.headers.get("x-test-session") ?? "",
      scopes: new Set(scopes),
      reauthenticatedAt: new Date()
    }),
    provisionInvitedUser: async () => { throw new Error("unused"); }
  });
  let macSocket: WebSocket | undefined;
  let mobileSocket: WebSocket | undefined;
  try {
    const address = await application.listen();
    const relayUrl = `ws://127.0.0.1:${address.port}/v1/relay`;
    macSocket = new WebSocket(`${relayUrl}?deviceId=${mac.id}`, {
      headers: { "x-test-account": accountId, "x-test-session": "session:mac" }
    });
    mobileSocket = new WebSocket(`${relayUrl}?deviceId=${mobile.id}`, {
      headers: { "x-test-account": accountId, "x-test-session": "session:mobile" }
    });
    const macReady = nextJson(macSocket);
    const mobileReady = nextJson(mobileSocket);
    await Promise.all([nextOpen(macSocket), nextOpen(mobileSocket)]);
    assert.equal((await macReady).type, "ready");
    assert.equal((await mobileReady).type, "ready");

    const incoming = nextJson(macSocket);
    const connected = nextJson(mobileSocket);
    mobileSocket.send(JSON.stringify({ type: "connect", targetDeviceId: mac.id, requestId: "request:one" }));
    const mobileControl = await connected;
    const macControl = await incoming;
    assert.equal(mobileControl.type, "connected");
    assert.equal(macControl.type, "incoming");
    assert.equal((mobileControl.peer as { id: string }).id, mac.id);
    assert.equal((macControl.peer as { id: string }).id, mobile.id);

    const connectionId = mobileControl.connectionId as string;
    const opaqueCiphertext = Buffer.from("this-is-test-ciphertext-not-business-plaintext");
    const frame = Buffer.concat([Buffer.from([1]), uuidToBytes(connectionId), opaqueCiphertext]);
    const received = nextBinary(macSocket);
    mobileSocket.send(frame, { binary: true });
    assert.deepEqual(await received, frame);

    const mobileClosed = nextClose(mobileSocket);
    const revokedNotice = nextJson(macSocket);
    const revoked = await fetch(`http://127.0.0.1:${address.port}/v1/devices/${mobile.id}`, {
      method: "DELETE",
      headers: { "x-test-account": accountId }
    });
    assert.equal(revoked.status, 200);
    assert.deepEqual(await revokedNotice, { type: "device_revoked", deviceId: mobile.id });
    assert.equal((await mobileClosed).code, 4003);
  } finally {
    macSocket?.terminate();
    mobileSocket?.terminate();
    await application.close();
    database.close();
  }
});

function nextOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function nextJson(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.once("message", (data, isBinary) => {
      if (isBinary) return reject(new Error("expected JSON control message"));
      resolve(JSON.parse(data.toString()) as Record<string, unknown>);
    });
  });
}

function nextBinary(socket: WebSocket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.once("message", (data: RawData, isBinary) => {
      if (!isBinary) return reject(new Error("expected binary relay frame"));
      resolve(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
    });
  });
}

function nextClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}
