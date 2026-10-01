import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import https from "node:https";
import http from "node:http";
import { ClientDeviceAuthority } from "../src/application/clientDeviceAuthority.mjs";
import { ClientDeviceGateway, startConfiguredDeviceGateway } from "../src/application/clientDeviceGateway.mjs";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "corptie-device-test-"));
  let now = Date.now();
  const authority = new ClientDeviceAuthority(join(dir, "auth"), { now: () => now });
  await authority.initialize();
  return { dir, authority, advance: ms => { now += ms; }, close: () => rm(dir, { recursive: true, force: true }) };
}

test("pairing requires local approval, exchanges once, rotates and revokes persisted credentials", async () => {
  const f = await fixture();
  try {
    const a = f.authority;
    const invite = a.invite();
    const claim = a.claim({ ...invite, name: "Test iPad" });
    await assert.rejects(a.exchange(claim), { code: "PAIRING_NOT_APPROVED" });
    assert.throws(() => a.claim({ ...invite, name: "Other" }), { code: "PAIRING_INVALID" });
    a.approve(invite.pairingId, true);
    const results = await Promise.allSettled([a.exchange(claim), a.exchange(claim)]);
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    const creds = results.find(r => r.status === "fulfilled").value;
    assert.deepEqual(Object.keys(a.authenticate(creds.accessToken)).sort(), ["deviceId", "name", "serverId"]);
    assert.equal(a.canDeliverScheduledMessage(creds.deviceId), true);
    assert.equal(a.authenticate(creds.accessToken).deviceId, creds.deviceId);
    const disk = await readFile(join(f.dir, "auth", "devices.json"), "utf8");
    assert.equal(disk.includes(creds.accessToken), false);
    assert.equal(disk.includes(creds.refreshToken), false);
    assert.equal((await stat(join(f.dir, "auth", "devices.json"))).mode & 0o777, 0o600);
    const rotated = await a.refresh(creds);
    await assert.rejects(a.refresh(creds), { code: "INVALID_CREDENTIAL" });
    assert.throws(() => a.authenticate(creds.accessToken), { code: "INVALID_CREDENTIAL" });
    const restored = new ClientDeviceAuthority(join(f.dir, "auth"));
    await restored.initialize();
    assert.equal(restored.authenticate(rotated.accessToken).deviceId, creds.deviceId);
    await restored.revoke(creds.deviceId);
    assert.equal(restored.canDeliverScheduledMessage(creds.deviceId), false);
    assert.throws(() => restored.authenticate(rotated.accessToken), { code: "INVALID_CREDENTIAL" });
    await assert.rejects(restored.refresh(rotated), { code: "INVALID_CREDENTIAL" });
  } finally { await f.close(); }
});

test("legacy per-feature grants are removed and never exposed after restart", async () => {
  const f = await fixture();
  try {
    const a = f.authority;
    const invite = a.invite();
    const claim = a.claim({ ...invite, name: "Test iPad" });
    a.approve(invite.pairingId, true);
    const creds = await a.exchange(claim);
    const file = join(f.dir, "auth", "devices.json");
    const state = JSON.parse(await readFile(file, "utf8"));
    state.devices[0].permissions = ["messages.read"];
    await writeFile(file, JSON.stringify(state));
    const restored = new ClientDeviceAuthority(join(f.dir, "auth"));
    await restored.initialize();
    assert.equal(restored.list().devices[0].permissions, undefined);
    assert.equal(JSON.parse(await readFile(file, "utf8")).devices[0].permissions, undefined);
    assert.equal(restored.authenticate(creds.accessToken).deviceId, creds.deviceId);
  } finally { await f.close(); }
});

test("denied and expired invitations and expired access tokens fail closed", async () => {
  const f = await fixture();
  try {
    const invite = f.authority.invite();
    const claim = f.authority.claim({ ...invite, name: "iPad" });
    f.authority.approve(invite.pairingId, false);
    await assert.rejects(f.authority.exchange(claim), { code: "PAIRING_DENIED" });
    f.advance(300_001);
    assert.throws(() => f.authority.pairing(invite.pairingId), { code: "PAIRING_EXPIRED" });
    const second = f.authority.invite();
    const request = f.authority.claim({ ...second, name: "iPad" });
    f.authority.approve(second.pairingId, true);
    const creds = await f.authority.exchange(request);
    f.advance(900_001);
    assert.equal(f.authority.canDeliverScheduledMessage(creds.deviceId), true);
    assert.throws(() => f.authority.authenticate(creds.accessToken), { code: "INVALID_CREDENTIAL" });
    assert.ok((await f.authority.refresh(creds)).accessToken);
    f.advance(31 * 86400_000);
    assert.equal(f.authority.canDeliverScheduledMessage(creds.deviceId), false);
  } finally { await f.close(); }
});

test("gateway is disabled by default and always disabled in preview", async () => {
  assert.equal(await startConfiguredDeviceGateway({ environment: {}, directory: "/unused", preview: false }), null);
  assert.equal(await startConfiguredDeviceGateway({ environment: { CORPTIE_REMOTE_ACCESS: "1" }, directory: "/unused", preview: true }), null);
  await assert.rejects(startConfiguredDeviceGateway({ environment: { CORPTIE_REMOTE_ACCESS: "1" }, directory: "/unused" }),
    { code: "REMOTE_TLS_CONFIGURATION_REQUIRED" });
});

test("real TLS route boundary and authenticated local approval", async () => {
  const f = await fixture();
  const approvalCalls = [];
  const worktreeCalls = [];
  const usageReads = [];
  const avatarPath = join(f.dir, "avatar.png");
  await writeFile(avatarPath, Buffer.from("89504e470d0a1a0a", "hex"));
  const gateway = new ClientDeviceGateway(f.authority, { readAPI: {
    list: (kind, query) => ({ schemaVersion: 1, items: [{ id: `${kind}:one` }], limit: query.get("limit") }),
    workAvatar: async workId => {
      if (workId !== "work:one") throw Object.assign(new Error("AVATAR_NOT_FOUND"), { code: "AVATAR_NOT_FOUND", status: 404 });
      return { path: avatarPath, contentType: "image/png", size: 8, etag: '"8-1"' };
    }
  }, controlAPI: {
    list: async kind => ({ schemaVersion: 1, items: [{ id: `${kind}:one` }] }),
    repository: async id => ({ schemaVersion: 1, repository: { id } })
  }, worktreeAPI: {
    repository: async (id, options) => ({ repository: { id }, project: { worktrees: [] }, options }),
    gitHubPushStatus: async (repositoryId, worktreeId) => ({ repositoryId, worktreeId, gitHubPush: { available: true } }),
    developmentService: async repositoryId => ({ projectId: repositoryId, service: { state: "stopped" } }),
    job: id => ({ job: { id, status: "running" } }),
    createPlan: async (repositoryId, input) => ({ job: { id: "job:one", repositoryId, input } }),
    deleteWorktree: async (repositoryId, worktreeId) => ({ result: { repositoryId, worktreeId } }),
    workspaceAction: async (repositoryId, worktreeId, action, input) => {
      worktreeCalls.push({ repositoryId, worktreeId, action, input }); return { ok: true };
    },
    developmentServiceAction: async (repositoryId, action, input) => ({ repositoryId, action, input }),
    jobAction: async (jobId, action, input) => ({ job: { id: jobId, action, input } })
  }, sessionAPI: {
    inspector: {
      scope: (id, identity) => ({ sessionId: id, deviceId: identity.deviceId }),
      snapshot: async (_identity, id) => ({ schemaVersion: 1, sessionId: id, sections: {}, errors: {} })
    },
    commandCatalog(identity, sessionId) {
      return { schemaVersion: 1, sessionId, commands: [{ name: "goal" }] };
    },
    conversationCommand(identity, sessionId, input, revalidate) {
      assert.equal(revalidate().deviceId, identity.deviceId);
      return { schemaVersion: 1, sessionId, requestId: input.requestId, kind: "conversation_command", status: "completed" };
    },
    messages(identity, sessionId) { return { schemaVersion: 1, sessionId, items: [] }; },
    approval(identity, sessionId, input, revalidate) {
      assert.equal(revalidate().deviceId, identity.deviceId);
      approvalCalls.push({ sessionId, input });
      return { schemaVersion: 1, sessionId, itemId: input.itemId, status: "submitted" };
    },
    command(identity, sessionId, kind, input) {
      return { schemaVersion: 1, sessionId, kind, requestId: input.requestId, status: "dispatching" };
    },
    receipt(identity, requestId) { return { requestId, deviceId: identity.deviceId }; },
    capabilities() { return { schemaVersion: 1 }; },
    workCreationOptions() { return { schemaVersion: 1, agents: [{ id: "agent:test", name: "Test" }] }; },
    createWork(identity, input, revalidate) {
      assert.equal(revalidate().deviceId, identity.deviceId);
      return { schemaVersion: 1, requestId: input.requestId, kind: "work_create", status: "completed" };
    },
    createTask(identity, sessionId, input, revalidate) {
      assert.equal(revalidate().deviceId, identity.deviceId);
      return { schemaVersion: 1, sessionId, requestId: input.requestId, kind: "create_task", status: "completed" };
    },
    taskCreationOptions(identity, sessionId, query) {
      return { schemaVersion: 1, sourceSessionId: sessionId, providerId: query.get("providerId") };
    },
    configuration(identity, sessionId, input) {
      return { schemaVersion: 1, sessionId, currentModel: input?.model ?? "current" };
    },
    readReceipt(identity, sessionId, input) {
      return { schemaVersion: 1, sessionId, lastAgentMessageSequence: 7, lastReadMessageSequence: input.throughSequence };
    },
    image(identity, sessionId, query) {
      if (query.get("path") !== "chat-resources/session/a.png") throw Object.assign(new Error("IMAGE_NOT_AVAILABLE"), { code: "IMAGE_NOT_AVAILABLE", status: 404 });
      return { data: Buffer.from("png-bytes"), contentType: "image/png", byteLength: 9 };
    },
    async usage(identity, sessionId, options) {
      usageReads.push(options);
      return { schemaVersion: 1, sessionId, context: { usedTokens: 10, contextWindow: 100, remainingTokens: 90, usedPercent: 10 }, account: null };
    },
    entityCommands: {},
    taskManagement(identity, taskId) {
      return { schemaVersion: 1, task: { id: taskId }, actions: {} };
    },
    async taskDeletionPlan(identity, taskId) {
      return { schemaVersion: 1, taskId, status: "safe" };
    },
    workManagement(identity, workId) {
      return { schemaVersion: 1, work: { id: workId }, actions: {} };
    },
    taskCommand(identity, taskId, command, input, revalidate) {
      assert.equal(revalidate().deviceId, identity.deviceId);
      return { schemaVersion: 1, requestId: input.requestId, kind: `task_${command}`, status: "completed", entityResult: { taskId } };
    },
    workCommand(identity, workId, command, input, revalidate) {
      assert.equal(revalidate().deviceId, identity.deviceId);
      return { schemaVersion: 1, requestId: input.requestId, kind: `work_${command}`, status: "completed", entityResult: { workId } };
    }
  } });
  const remoteAgent = new https.Agent({ keepAlive: true });
  let admin;
  try {
    const keyPath = join(f.dir, "key.pem"), certPath = join(f.dir, "cert.pem");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath,
      "-out", certPath, "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore" });
    const cert = await readFile(certPath);
    const address = await gateway.start({ key: await readFile(keyPath), cert });
    admin = http.createServer((req, res) => void gateway.handleAdmin(req, res));
    await new Promise(resolve => admin.listen(0, "127.0.0.1", resolve));
    const call = (path, { local = false, method = "GET", token, value, headers = {} } = {}) => new Promise((resolve, reject) => {
      const req = (local ? http : https).request({ host: "127.0.0.1", servername: "localhost",
        port: local ? admin.address().port : address.port, path, method, ca: cert, agent: local ? false : remoteAgent,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers,
          ...(value ? { "content-type": "application/json" } : {}) } }, res => {
        const chunks = [];
        res.on("data", chunk => { chunks.push(chunk); });
        res.on("end", () => {
          const raw = Buffer.concat(chunks);
          const json = /^application\/json/.test(res.headers["content-type"] ?? "");
          resolve({ status: res.statusCode, headers: res.headers, raw, body: json && raw.length ? JSON.parse(raw.toString("utf8")) : null });
        });
      });
      req.on("error", reject);
      req.end(value ? JSON.stringify(value) : undefined);
    });
    assert.equal((await call("/internal/client-devices", { local: true })).status, 403);
    const token = f.authority.adminToken;
    assert.equal((await call("/internal/client-devices", { local: true, token, headers: { origin: "https://evil.test" } })).status, 403);
    const invitation = (await call("/internal/client-devices/invite", { local: true, token, method: "POST" })).body;
    const claim = (await call("/client/v1/pairing/claim", { method: "POST", value: { ...invitation, name: "iPad" } })).body;
    assert.equal((await call("/client/v1/pairing/exchange", { method: "POST", value: claim })).status, 403);
    await call("/internal/client-devices/approve", { local: true, token, method: "POST", value: { pairingId: invitation.pairingId, approved: true } });
    const creds = (await call("/client/v1/pairing/exchange", { method: "POST", value: claim })).body;
    assert.equal((await call("/client/v1/me", { token: creds.accessToken })).body.deviceId, creds.deviceId);
    assert.equal((await call("/client/v1/works?limit=1")).status, 401);
    for (const kind of ["works", "tasks", "sessions"]) {
      const page = await call(`/client/v1/${kind}?limit=1`, { token: creds.accessToken });
      assert.equal(page.status, 200);
      assert.equal(page.body.items[0].id, `${kind}:one`);
      assert.equal((await call(`/client/v1/${kind}`, { method: "POST", token: creds.accessToken, value: {} })).status, 404);
    }
    const avatarRoute = "/client/v1/works/work%3Aone/avatar";
    assert.equal((await call(avatarRoute)).status, 401);
    const avatar = await call(avatarRoute, { token: creds.accessToken });
    assert.equal(avatar.status, 200);
    assert.equal(avatar.headers["content-type"], "image/png");
    assert.equal(avatar.headers["x-content-type-options"], "nosniff");
    assert.equal(avatar.raw.toString("hex"), "89504e470d0a1a0a");
    assert.equal((await call(avatarRoute, { token: creds.accessToken, headers: { "if-none-match": '"8-1"' } })).status, 304);
    assert.equal((await call("/client/v1/works/work%3Atwo/avatar", { token: creds.accessToken })).status, 404);
    assert.equal((await call(`${avatarRoute}?x=1`, { token: creds.accessToken })).status, 403);
    assert.equal((await call(avatarRoute, { token: creds.accessToken, method: "POST", value: {} })).status, 404);
    for (const path of ["/settings", "/state/snapshot", "/internal/client-devices", "/sessions/x/messages"]) {
      assert.equal((await call(path, { token: creds.accessToken })).status, 404);
    }
    assert.equal((await call("/client/v1/me", { token: creds.accessToken, headers: { "x-corptie-agent-id": "a" } })).status, 403);
    const messagesPath = "/client/v1/sessions/session%3Atest/messages";
    const composerPath = "/client/v1/sessions/session%3Atest/composer";
    assert.equal((await call(composerPath)).status, 401);
    assert.equal((await call(composerPath, { token: creds.accessToken })).body.currentModel, "current");
    assert.equal((await call(composerPath, { token: creds.accessToken, method: "POST", value: { model: "new" } })).body.currentModel, "new");
    assert.equal((await call(composerPath, { token: creds.accessToken, method: "DELETE" })).status, 404);
    assert.equal((await call("/client/v1/me", { token: creds.accessToken })).body.permissions, undefined);
    assert.equal((await call("/client/v1/control/agents", { token: creds.accessToken })).status, 200);
    assert.equal((await call("/client/v1/capabilities", { token: creds.accessToken })).body.controlRead, true);
    assert.equal((await call(messagesPath, { token: creds.accessToken })).status, 200);
    const inspectorPath = "/client/v1/sessions/session%3Atest/inspector";
    assert.equal((await call(inspectorPath)).status, 401);
    const inspector = await call(inspectorPath, { token: creds.accessToken });
    assert.equal(inspector.status, 200);
    assert.equal(inspector.body.sessionId, "session:test");
    assert.equal((await call(`${inspectorPath}?x=1`, { token: creds.accessToken })).status, 403);
    assert.equal((await call("/client/v1/sessions/%ZZ/inspector", { token: creds.accessToken })).status, 400);
    const approvalPath = "/client/v1/sessions/session%3Atest/approval";
    const approvalInput = { itemId: "approval:one", optionId: "allow" };
    assert.equal((await call(approvalPath, { method: "POST", value: approvalInput })).status, 401);
    const approvalResult = await call(approvalPath, { method: "POST", token: creds.accessToken, value: approvalInput });
    assert.equal(approvalResult.status, 202);
    assert.equal(approvalResult.body.status, "submitted");
    assert.deepEqual(approvalCalls, [{ sessionId: "session:test", input: approvalInput }]);
    assert.equal((await call(approvalPath, { token: creds.accessToken })).status, 404);
    for (const kind of ["automations", "repositories", "agents", "skills"]) {
      assert.equal((await call(`/client/v1/control/${kind}?limit=1`, { token: creds.accessToken })).body.items[0].id, `${kind}:one`);
      assert.equal((await call(`/client/v1/control/${kind}`, { method: "POST", token: creds.accessToken, value: {} })).status, 404);
    }
    assert.equal((await call("/client/v1/control/repositories/repo%3Aone", { token: creds.accessToken })).body.repository.id, "repo:one");
    assert.equal((await call("/client/v1/capabilities", { token: creds.accessToken })).body.controlRead, true);
    assert.equal((await call("/client/v1/capabilities", { token: creds.accessToken })).body.controlWrite, true);
    assert.equal((await call("/client/v1/worktrees/repositories/repo%3Aone", { token: creds.accessToken })).status, 200);
    assert.equal((await call(messagesPath, { token: creds.accessToken })).body.sessionId, "session:test");
    const readReceiptPath = "/client/v1/sessions/session%3Atest/read-receipt";
    assert.equal((await call(readReceiptPath, { method: "POST", value: { throughSequence: 7 } })).status, 401);
    const acknowledged = await call(readReceiptPath, { token: creds.accessToken, method: "POST", value: { throughSequence: 7 } });
    assert.equal(acknowledged.status, 200);
    assert.equal(acknowledged.body.lastReadMessageSequence, 7);
    assert.equal((await call(readReceiptPath, { token: creds.accessToken })).status, 404);
    assert.equal((await call(`${readReceiptPath}?x=1`, { token: creds.accessToken, method: "POST", value: { throughSequence: 7 } })).status, 403);
    const imagePath = "/client/v1/sessions/session%3Atest/images?path=chat-resources%2Fsession%2Fa.png";
    assert.equal((await call(imagePath)).status, 401);
    const image = await call(imagePath, { token: creds.accessToken });
    assert.equal(image.status, 200);
    assert.equal(image.headers["content-type"], "image/png");
    assert.equal(image.headers["x-content-type-options"], "nosniff");
    assert.equal(image.raw.toString(), "png-bytes");
    assert.equal((await call("/client/v1/sessions/session%3Atest/images?path=other.png", { token: creds.accessToken })).status, 404);
    // Query strings are only tolerated on GET; other verbs never reach the route.
    assert.equal((await call(imagePath, { token: creds.accessToken, method: "POST", value: {} })).status, 403);
    assert.equal((await call("/client/v1/sessions/session%3Atest/images", { token: creds.accessToken, method: "DELETE" })).status, 404);
    const usagePath = "/client/v1/sessions/session%3Atest/usage";
    assert.equal((await call(usagePath)).status, 401);
    const usage = await call(usagePath, { token: creds.accessToken });
    assert.equal(usage.status, 200);
    assert.equal(usage.body.context.usedTokens, 10);
    assert.equal((await call(`${usagePath}?freshAccount=1`, { token: creds.accessToken })).status, 200);
    assert.deepEqual(usageReads, [{ freshAccount: false }, { freshAccount: true }]);
    assert.equal((await call(`${usagePath}?x=1`, { token: creds.accessToken })).status, 403);
    assert.equal((await call(`${usagePath}?freshAccount=0`, { token: creds.accessToken })).status, 403);
    assert.equal((await call(`${usagePath}?freshAccount=1&freshAccount=1`, { token: creds.accessToken })).status, 403);
    assert.equal((await call(usagePath, { token: creds.accessToken, method: "POST", value: {} })).status, 404);
    const commandsPath = "/client/v1/sessions/session%3Atest/conversation-commands";
    assert.equal((await call(commandsPath, { token: creds.accessToken })).body.commands[0].name, "goal");
    const commandInput = { requestId: "command_123", name: "goal", arguments: "test" };
    assert.equal((await call(commandsPath, { token: creds.accessToken, method: "POST", value: commandInput })).body.status, "completed");
    assert.equal((await call("/internal/client-devices/permissions", { local: true, token, method: "POST",
      value: { deviceId: creds.deviceId, permissions: [] } })).status, 404);
    const createPath = "/client/v1/sessions/session%3Atest/tasks";
    const newWorkPath = "/client/v1/works/create";
    assert.equal((await call(newWorkPath)).status, 401);
    assert.equal((await call(newWorkPath, { token: creds.accessToken })).body.agents[0].id, "agent:test");
    const newWork = await call(newWorkPath, { token: creds.accessToken, method: "POST", value: { requestId: "work_create_1", name: "Work" } });
    assert.equal(newWork.status, 202);
    assert.equal(newWork.body.kind, "work_create");
    assert.equal((await call(`${newWorkPath}?x=1`, { token: creds.accessToken })).status, 403);
    assert.equal((await call(newWorkPath, { token: creds.accessToken, method: "DELETE" })).status, 404);
    const createInput = { requestId: "create_123", title: "Task" };
    const created = await call(createPath, { token: creds.accessToken, method: "POST", value: createInput });
    assert.equal(created.status, 202);
    assert.equal(created.body.kind, "create_task");
    assert.equal(created.body.sessionId, "session:test");
    const choices = await call(`${createPath}?providerId=provider%3Atest`, { token: creds.accessToken });
    assert.equal(choices.status, 200);
    assert.equal(choices.body.providerId, "provider:test");
    assert.equal((await call(`${createPath}?work=other`, { token: creds.accessToken, method: "POST", value: createInput })).status, 403);
    // Pairing approval exposes every client feature supported by the server.
    const taskPath = "/client/v1/tasks/task%3Aone";
    const workPath = "/client/v1/works/work%3Aone";
    const capabilities = (await call("/client/v1/capabilities", { token: creds.accessToken })).body;
    assert.equal(capabilities.taskManagement, true);
    assert.equal(capabilities.workManagement, true);
    assert.equal((await call(`${taskPath}/management`, { token: creds.accessToken })).body.task.id, "task:one");
    assert.equal((await call(`${taskPath}/deletion`, { token: creds.accessToken })).body.status, "safe");
    assert.equal((await call(`${taskPath}/management?x=1`, { token: creds.accessToken })).status, 403);
    assert.equal((await call(`${taskPath}/management`, { token: creds.accessToken, method: "POST", value: {} })).status, 404);
    assert.equal((await call(`${taskPath}/archive`, { token: creds.accessToken })).status, 404);
    assert.equal((await call(`${taskPath}/complete`, { token: creds.accessToken, method: "POST", value: { requestId: "complete_123" } })).status, 404);
    const archived = await call(`${taskPath}/archive`, { token: creds.accessToken, method: "POST", value: { requestId: "archive_123", archived: true } });
    assert.equal(archived.status, 202);
    assert.equal(archived.body.kind, "task_archive");
    assert.deepEqual(archived.body.entityResult, { taskId: "task:one" });
    assert.equal((await call(`${taskPath}/delete`, { token: creds.accessToken, method: "POST", value: { requestId: "delete_1234", mode: "safe" } })).body.kind, "task_delete");
    assert.equal((await call(`${workPath}/management`, { token: creds.accessToken })).body.work.id, "work:one");
    const workUpdate = await call(`${workPath}/update`, { token: creds.accessToken, method: "POST", value: { requestId: "update_work1", name: "New" } });
    assert.equal(workUpdate.status, 202, JSON.stringify(workUpdate.body));
    assert.equal(workUpdate.body.kind, "work_update");
    assert.equal((await call(`${workPath}/deletion`, { token: creds.accessToken })).status, 404);
    const sent = await call(messagesPath, { token: creds.accessToken, method: "POST", value: { requestId: "request_123", text: "test" } });
    assert.equal(sent.status, 202);
    assert.equal(sent.body.kind, "send");
    assert.equal((await call("/client/v1/sessions/session%3Atest/stop", { token: creds.accessToken, method: "POST", value: { requestId: "stop_12345" } })).body.kind, "stop");
    assert.equal((await call("/client/v1/commands/request_123", { token: creds.accessToken })).body.requestId, "request_123");
    assert.equal((await call("/client/v1/events")).status, 401);
    const stream = await new Promise((resolve, reject) => {
      const req = https.get({ host: "127.0.0.1", servername: "localhost", port: address.port,
        path: "/client/v1/events", ca: cert, agent: false,
        headers: { authorization: `Bearer ${creds.accessToken}` } }, res => {
        res.once("data", chunk => {
          assert.match(chunk.toString(), /event: reset/);
          resolve(res);
        });
      });
      req.on("error", reject);
      req.setTimeout(3000, () => req.destroy(new Error("stream timeout")));
    });
    const update = new Promise(resolve => stream.once("data", chunk => resolve(chunk.toString())));
    gateway.events.invalidate({ sessionId: "session:test", inventory: true }); gateway.events.flush();
    assert.match(await update, /session:test/);
    const streamClosed = new Promise(resolve => stream.once("close", resolve));
    const authenticatedSockets = [...gateway.sockets].filter(([, owner]) => owner === creds.deviceId).map(([socket]) => socket);
    assert.ok(authenticatedSockets.length > 0);
    await call("/internal/client-devices/revoke", { local: true, token, method: "POST", value: { deviceId: creds.deviceId } });
    assert.ok(authenticatedSockets.every(socket => socket.destroyed));
    await streamClosed;
    remoteAgent.destroy();
    assert.equal((await call("/client/v1/me", { token: creds.accessToken })).status, 401);
  } finally {
    remoteAgent.destroy();
    await gateway.close();
    if (admin) await new Promise(resolve => admin.close(resolve));
    await f.close();
  }
});
