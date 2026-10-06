import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
  publicRegistration: true,
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

test("Relay isolates late frames after revocation while rejecting nonparticipants and unknown connections", { timeout: 10_000 }, async () => {
  const database = openCloudDatabase(":memory:");
  const devices = new CloudDeviceService(database);
  const accountId = "account:relay";
  const mac = devices.register(accountId, "session:mac", createTestDeviceInput({
    id: randomUUID().toUpperCase(), kind: "mac", displayName: "Mac"
  }));
  const mobile = devices.register(accountId, "session:mobile", createTestDeviceInput({
    id: randomUUID().toUpperCase(),
    kind: "mobile",
    displayName: "Phone",
    publicKey: Buffer.alloc(32, 9).toString("base64")
  }));
  const tablet = devices.register(accountId, "session:tablet", createTestDeviceInput({
    id: randomUUID().toUpperCase(), kind: "mobile", displayName: "Tablet",
    publicKey: Buffer.alloc(32, 10).toString("base64")
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
  let tabletSocket: WebSocket | undefined;
  try {
    const address = await application.listen();
    const relayUrl = `ws://127.0.0.1:${address.port}/v1/relay`;
    macSocket = new WebSocket(`${relayUrl}?deviceId=${mac.id.toLowerCase()}`, {
      headers: { "x-test-account": accountId, "x-test-session": "session:mac" }
    });
    mobileSocket = new WebSocket(`${relayUrl}?deviceId=${mobile.id.toLowerCase()}`, {
      headers: { "x-test-account": accountId, "x-test-session": "session:mobile" }
    });
    const macReady = nextJson(macSocket);
    const mobileReady = nextJson(mobileSocket);
    await Promise.all([nextOpen(macSocket), nextOpen(mobileSocket)]);
    assert.equal((await macReady).type, "ready");
    assert.equal((await mobileReady).type, "ready");

    const incoming = nextJson(macSocket);
    const connected = nextJson(mobileSocket);
    mobileSocket.send(JSON.stringify({ type: "connect", targetDeviceId: mac.id.toLowerCase(), requestId: "request:one" }));
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

    tabletSocket = new WebSocket(`${relayUrl}?deviceId=${tablet.id.toLowerCase()}`, {
      headers: { "x-test-account": accountId, "x-test-session": "session:tablet" }
    });
    const tabletReady = nextJson(tabletSocket);
    await nextOpen(tabletSocket);
    assert.equal((await tabletReady).type, "ready");
    const tabletConnected = nextJson(tabletSocket);
    const tabletIncoming = nextJson(macSocket);
    tabletSocket.send(JSON.stringify({ type: "connect", targetDeviceId: mac.id.toLowerCase() }));
    const tabletConnectionId = (await tabletConnected).connectionId as string;
    await tabletIncoming;

    const mobileClosed = nextClose(mobileSocket);
    const revokedNotice = nextJson(macSocket);
    const disconnectedNotice = new Promise<Record<string, unknown>>(resolve => {
      const listener = (data: RawData, binary: boolean) => {
        if (binary) return;
        const control = JSON.parse(data.toString());
        if (control.type !== "disconnected") return;
        macSocket!.removeListener("message", listener);
        resolve(control);
      };
      macSocket!.on("message", listener);
    });
    const revoked = await fetch(`http://127.0.0.1:${address.port}/v1/devices/${mobile.id.toLowerCase()}`, {
      method: "DELETE",
      headers: { "x-test-account": accountId }
    });
    assert.equal(revoked.status, 200);
    assert.deepEqual(await revokedNotice, { type: "device_revoked", deviceId: mobile.id });
    assert.equal((await mobileClosed).code, 4003);
    assert.equal((await disconnectedNotice).connectionId, connectionId);

    // A late Mac frame for the revoked phone must not tear down the Mac socket
    // or the unrelated tablet connection. Ordering is verified by the next frame.
    const tabletFrame = Buffer.concat([Buffer.from([1]), uuidToBytes(tabletConnectionId), opaqueCiphertext]);
    const tabletReceived = nextBinary(tabletSocket);
    macSocket.send(frame, { binary: true });
    macSocket.send(tabletFrame, { binary: true });
    assert.deepEqual(await tabletReceived, tabletFrame);
    assert.equal(macSocket.readyState, WebSocket.OPEN);

    // Another peer cannot reuse the phone's tombstone, even on the same account.
    const tabletClosed = nextClose(tabletSocket);
    tabletSocket.send(frame, { binary: true });
    assert.equal((await tabletClosed).code, 4002);
    const macClosed = nextClose(macSocket);
    macSocket.send(Buffer.concat([Buffer.from([1]), uuidToBytes(randomUUID()), opaqueCiphertext]), { binary: true });
    assert.equal((await macClosed).code, 4002);
  } finally {
    macSocket?.terminate();
    mobileSocket?.terminate();
    tabletSocket?.terminate();
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
