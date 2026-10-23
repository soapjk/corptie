import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { ArtifactService } from "../src/application/artifactService.mjs";
import { CollaborationCore } from "../src/collaboration/collaborationCore.mjs";
import { ClientResourceAPI } from "../src/application/clientResourceAPI.mjs";
import { ClientDeviceGateway } from "../src/application/clientDeviceGateway.mjs";
import { rejectDevelopmentPreviewWrite } from "../src/application/backendHttpGuards.mjs";

test("Development allows catalog/immutable reads but never resource commands or imports", () => {
  const check = (path, method = "GET") => rejectDevelopmentPreviewWrite({ request: { method }, response: {}, url: new URL(path, "http://localhost"), developmentPreview: true, sendJson() {} });
  for (const path of ["/resources", "/resources/works", "/resources/artifact%3Aone", "/resources/artifact%3Aone/read?version=1"]) {
    assert.equal(check(path), false);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) assert.equal(check(path, method), true);
  }
  assert.equal(check("/resources/artifact%3Aone/commands"), true);
  assert.equal(check("/resources/artifact%3Aone/commands", "POST"), true);
});

test("resource catalog: scoped metadata, fixed versions, source discovery and authorized management", async t => {
  const directory = await mkdtemp(join(tmpdir(), "corptie-resource-test-"));
  const store = new CorptieStore({ dbPath: join(directory, "db.sqlite"), configPath: join(directory, "config.json") });
  await store.initialize();
  let id = 0;
  const artifacts = new ArtifactService({ store, contentRoot: join(directory, "objects"), idFactory: () => `resource-${++id}` });
  await artifacts.initialize();
  const api = new ClientResourceAPI({ store, artifacts }), identity = { deviceId: "test-user" };
  const core = new CollaborationCore(store);
  const agent = store.createAgent({ name: "Resource Session", provider: "claude-sdk" });
  for (const workId of ["work:a", "work:b"]) store.createWork({ id: workId, name: workId.replace(":", "-"), contributorAgentIds: [agent.agentId] });
  store.createTask({ id: "task:a", workId: "work:a", title: "SDK", mainAgentId: agent.agentId });
  store.upsertSession({ id: "session:a", title: "SDK Session", provider: "claude-sdk", status: "running", sessionKind: "worker", agentId: agent.agentId, workId: "work:a", taskId: "task:a" });
  store.bindSessionToTask("session:a", "task:a", "work:a"); core.bindSession({ agentId: agent.agentId, sessionId: "session:a" });
  const worker = { actorId: agent.agentId, sessionId: "session:a", workId: "work:a", taskId: "task:a" };
  const local = workId => ({ kind: "local_user", workId });
  let created;
  try {
    await t.test("Work creation auto-references once and keeps the reference fixed after publish", async () => {
      created = await artifacts.create(worker, { scope: "work", title: "SDK design", summary: "SDK overview", content: "\\[夏普比率=\\frac{收益}{风险}\\]", idempotencyKey: "sdk-design" });
      assert.equal(created.references.length, 1); assert.equal(created.references[0].taskId, "task:a");
      assert.equal(created.references[0].pinnedVersion, 1);
      await artifacts.create(worker, { scope: "work", title: "SDK design", summary: "SDK overview", content: "\\[夏普比率=\\frac{收益}{风险}\\]", idempotencyKey: "sdk-design" });
      assert.equal(store.listArtifactReferences({ artifactId: created.artifactId }).length, 1);
      const parallel = await Promise.all(Array.from({ length: 4 }, () => artifacts.create(worker, { scope: "work", title: "SDK design", summary: "SDK overview", content: "\\[夏普比率=\\frac{收益}{风险}\\]", idempotencyKey: "sdk-design" })));
      assert.equal(new Set(parallel.map(row => row.artifactId)).size, 1);
      await artifacts.publishVersion(local("work:a"), created.artifactId, { content: "new draft", approvalStatus: "draft", expectedResourceVersion: store.getArtifact(created.artifactId).resourceVersion });
      assert.equal(store.listArtifactReferences({ artifactId: created.artifactId })[0].pinnedVersion, 1);
    });
    await t.test("metadata-only SQL pages filter before paging, bind cursors and include drafts", async () => {
      const works = api.works(new URLSearchParams({ limit: "1" }));
      assert.equal(works.items.length, 1); assert.equal(works.hasMore, true);
      assert.equal(api.works(new URLSearchParams({ cursor: works.nextCursor })).items[0].id, "work:b");
      await artifacts.create(local("work:b"), { title: "Other Work", content: "secret body" });
      const legacy = await artifacts.create(worker, { scope: "work", title: "Legacy source-only", content: "legacy body", idempotencyKey: "legacy", associateWithSource: false });
      assert.equal(legacy.references.length, 0);
      const page = api.list(new URLSearchParams({ workId: "work:a", limit: "1" }));
      assert.equal(page.items.length, 1); assert.equal(page.hasMore, true);
      const next = api.list(new URLSearchParams({ workId: "work:a", limit: "1", cursor: page.nextCursor }));
      assert.equal(next.items.length, 1); assert.notEqual(page.items[0].id, next.items[0].id);
      assert.equal(next.hasMore, false);
      assert.throws(() => api.list(new URLSearchParams({ workId: "work:b", cursor: page.nextCursor })), { code: "INVALID_CURSOR" });
      assert.throws(() => api.list(new URLSearchParams("limit=1&limit=2")), { code: "INVALID_QUERY" });
      assert.throws(() => api.list(new URLSearchParams({ limit: "101" })), { code: "INVALID_QUERY" });
      const source = artifacts.listForSession(local("work:a"), "session:a", "task:a");
      assert.ok(source.some(row => row.artifactId === legacy.artifactId));
      const draft = api.list(new URLSearchParams({ workId: "work:a", status: "draft", query: "SDK" }));
      assert.equal(draft.items.length, 1);
      const json = JSON.stringify(draft);
      for (const key of ["storageKey", "repositoryLocator", "new draft", "legacy body", "audit"]) assert.ok(!json.includes(key));
    });
    await t.test("legal Session-owned artifacts without Work are readable and absent from Work pages", async () => {
      store.upsertSession({ id: "session:chat", title: "Independent", provider: "codex-app-server", status: "running", sessionKind: "assistantChat", agentId: agent.agentId });
      const chat = await artifacts.create({ actorId: agent.agentId, sessionId: "session:chat" }, { title: "Independent note", content: "independent bytes", idempotencyKey: "independent" });
      const item = api.list(new URLSearchParams()).items.find(row => row.id === chat.artifactId);
      assert.equal(item.workId, null); assert.equal(item.owner.type, "session");
      assert.ok(!api.list(new URLSearchParams({ workId: "work:a" })).items.some(row => row.id === item.id));
      const page = await api.read(identity, item.id, new URLSearchParams({ version: "1", hash: chat.versions[0].contentHash, readId: "independent-read" }));
      assert.equal(page.content, "independent bytes");
    });
    await t.test("fixed reads, export integrity and revoke reauthorization", async () => {
      const detail = api.detail(identity, created.artifactId, 1), old = detail.versions.find(v => v.version === 1);
      const page = await api.read(identity, created.artifactId, new URLSearchParams({ version: "1", hash: old.contentHash, readId: "fixed-resource-read" }));
      assert.ok(page.content.includes("夏普比率"));
      const exported = await api.command(identity, created.artifactId, { action: "export", version: 1, hash: old.contentHash, confirmed: true, expectedRevision: detail.resource.revision });
      assert.equal(Buffer.from(exported.dataBase64, "base64").toString(), page.content);
      assert.ok(api.detail(identity, created.artifactId).references.every(ref => ref.taskId || ref.sessionId));
      await assert.rejects(api.command(identity, created.artifactId, { action: "metadata", title: "bad", expectedRevision: -1 }), { code: "RESOURCE_REVISION_CONFLICT" });
      await api.command(identity, created.artifactId, { action: "metadata", title: "SDK updated", expectedRevision: detail.resource.revision });
      assert.equal(store.getArtifact(created.artifactId).title, "SDK updated");
      assert.ok(store.listArtifactVersions(created.artifactId).every(version => version.storageKey.startsWith("files/SDK updated")));
      await assert.rejects(api.read({ ...identity, revalidate: () => { throw Object.assign(Error("revoked"), { status: 403 }); } }, created.artifactId,
        new URLSearchParams({ version: "1", hash: old.contentHash, readId: "revoked-resource-read" })), { status: 403 });
    });
    await t.test("human reading remains paginated past the Agent Turn budget without changing that budget", async () => {
      const text = "bounded content\n".repeat(14000);
      const large = await artifacts.create(local("work:a"), { title: "Long document", content: text });
      const hash = large.versions[0].contentHash;
      let offset = 0, collected = "", pages = 0;
      do {
        const value = await api.read(identity, large.artifactId, new URLSearchParams({ version: "1", hash, offset: String(offset), readId: "long-human-read" }));
        collected += value.content; offset = value.range.nextOffset; pages += 1;
      } while (offset != null);
      assert.equal(collected, text); assert.ok(pages >= 3);
      assert.equal(artifacts.readCoordinator.limits.maxUniqueBytesPerTurn, 131072);
      assert.equal(artifacts.userReadCoordinator.limits.maxUniqueBytesPerTurn, 2097152);
    });
    await t.test("1000-row catalog is summary-only, indexed and bounded without per-row Session reads", () => {
      store.createWork({ id: "work:bulk", name: "Bulk", contributorAgentIds: [agent.agentId] });
      store.runInTransaction(() => {
        for (let i = 0; i < 1000; i++) {
          const artifactId = `artifact:bulk-${String(i).padStart(4, "0")}`;
          store.createArtifactMetadata({ artifactId, workId: "work:bulk", title: `Document ${i}`, visibility: "work_private", actorId: "test", createdAt: "2026-10-18T00:00:00Z" });
          store.createArtifactVersion({ artifactId, version: 1, contentHash: "a".repeat(64), byteLength: 0, mimeType: "text/plain", actorId: "test", createdAt: "2026-10-18T00:00:00Z", approvalStatus: "draft" });
          store.updateArtifact(artifactId, { currentVersion: 1 });
        }
      });
      const original = store.getSession;
      store.getSession = () => { throw Error("per-row Session lookup"); };
      try {
        const started = performance.now(); let cursor, count = 0, requests = 0;
        do {
          const params = new URLSearchParams({ workId: "work:bulk", limit: "50" });
          if (cursor) params.set("cursor", cursor);
          const page = api.list(params);
          assert.ok(Buffer.byteLength(JSON.stringify(page)) < 256 * 1024);
          count += page.items.length; cursor = page.nextCursor; requests += 1;
        } while (cursor);
        assert.equal(count, 1000); assert.equal(requests, 20);
        console.log(`RESOURCE_CATALOG_1000 rows=${count} pages=${requests} elapsed_ms=${(performance.now() - started).toFixed(2)}`);
      } finally { store.getSession = original; }
    });
    await t.test("user creation is idempotent; paired read-only facade advertises and enforces writes", async () => {
      const input = { workId: "work:a", title: "User note", summary: "", content: "hello", requestId: "user-create-123" };
      const a = await api.create(identity, input), b = await api.create(identity, input);
      assert.equal(a.resource.id, b.resource.id);
      const parallel = await Promise.all(Array.from({ length: 4 }, () => api.create(identity, input)));
      assert.equal(new Set(parallel.map(row => row.resource.id)).size, 1);
      const readonly = new ClientResourceAPI({ store, artifacts, writesAllowed: false });
      assert.deepEqual(readonly.list(new URLSearchParams()).capabilities, []);
      await assert.rejects(readonly.create(identity, input), { status: 403 });
      await assert.rejects(readonly.command(identity, a.resource.id, { action: "revoke", confirmed: true, expectedRevision: a.resource.revision }), { status: 403 });
    });
    await t.test("explicit file import preserves binary bytes and never accepts a host path or parses DOCX", async () => {
      const bytes = Buffer.from([0, 255, 128, 10, 65]);
      const result = await api.create(identity, { workId: "work:a", title: "Local document", dataBase64: bytes.toString("base64"), mimeType: "application/octet-stream", requestId: "binary-import-123" });
      const version = result.versions[0];
      const exported = await api.command(identity, result.resource.id, { action: "export", version: version.version, hash: version.contentHash, confirmed: true, expectedRevision: result.resource.revision });
      assert.deepEqual(Buffer.from(exported.dataBase64, "base64"), bytes);
      await assert.rejects(api.create(identity, { workId: "work:a", title: "Bad import", dataBase64: "%%%%", requestId: "bad-import-123" }), { status: 400 });
      await assert.rejects(api.create(identity, { workId: "work:a", title: "Path is not bytes", importPath: "/private/auth.json", requestId: "path-import-123" }), { status: 400 });
    });
    await t.test("Work auto-reference failure rolls back all metadata and immutable versions", async () => {
      const before = store.countArtifactsByWork("work:a"), original = store.createArtifactReference;
      store.createArtifactReference = () => { throw Error("injected reference failure"); };
      try { await assert.rejects(artifacts.create(worker, { scope: "work", title: "Rollback", content: "rollback", idempotencyKey: "rollback" }), /injected/); }
      finally { store.createArtifactReference = original; }
      assert.equal(store.countArtifactsByWork("work:a"), before);
    });
    await t.test("resource route authenticates before listing and rejects query/credential bypass", async () => {
      let authorized = false;
      const gateway = new ClientDeviceGateway({ state: { serverId: "test" }, checkAdmin: () => false,
        authenticate: () => { if (!authorized) throw Object.assign(Error("auth"), { status: 401 }); return identity; } });
      gateway.resourceAPI = api;
      const exchange = () => new Promise(resolve => {
        gateway.handle({ method: "GET", url: "/client/v1/resources?limit=1", headers: {}, socket: { remoteAddress: "127.0.0.1" } },
          { writeHead(status) { this.status = status; }, end(text) { resolve({ status: this.status, body: JSON.parse(text) }); } });
      });
      assert.equal((await exchange()).status, 401);
      authorized = true;
      const response = await exchange(); assert.equal(response.status, 200); assert.equal(response.body.items.length, 1);
    });
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});
