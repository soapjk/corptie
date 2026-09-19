import assert from "node:assert/strict";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChatResourceService } from "../src/application/chatResourceService.mjs";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

test("device uploads use generated owned paths and never retain a source path", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "corptie-device-image-"));
  const service = new ChatResourceService({ environmentRoot: root, idFactory: () => "upload" });
  await service.initialize();
  const reference = { sessionId: "session:one" };
  const image = await service.importImageData(reference, PNG, "../../untrusted.png");
  assert.equal(image.originalPath, null);
  assert.equal(image.fileName, "untrusted.png");
  assert.equal(image.managedPath, "chat-resources/sessions/session_one/images/upload.png");
  assert.deepEqual((await service.readImage(reference, image.managedPath)).data, PNG);
  await assert.rejects(service.importImageData(reference, Buffer.from("not an image"), "image.png"), { code: "CHAT_IMAGE_FORMAT_UNSUPPORTED" });
  await assert.rejects(service.importImageData(reference, Buffer.alloc(0), "image.png"), { code: "CHAT_IMAGE_SIZE_INVALID" });
  await assert.rejects(service.readImage({ sessionId: "session:two" }, image.managedPath), { code: "CHAT_IMAGE_FORBIDDEN" });
});

test("imports a task image into its logical Session resource directory", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "corptie-chat-resource-"));
  const source = join(root, "selected.png");
  await writeFile(source, PNG);
  const service = new ChatResourceService({ environmentRoot: root, idFactory: () => "image-one" });
  await service.initialize();
  const reference = {
    sessionId: "provider:one",
    logicalSessionId: "logical:one",
    metadata: { session: { taskId: "task:one", workId: "work:one" } }
  };

  const imported = await service.importImage(reference, { sourcePath: source });
  assert.equal(
    imported.managedPath,
    "chat-resources/tasks/task_one/logical_one/images/image-one.png"
  );
  assert.equal(imported.originalPath, await realpath(source));
  assert.deepEqual((await service.readImage(reference, imported.managedPath)).data, PNG);
});

test("clipboard imports omit the temporary source path", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "corptie-chat-resource-"));
  const source = join(root, "paste.png");
  await writeFile(source, PNG);
  const service = new ChatResourceService({ environmentRoot: root, idFactory: () => "paste" });
  await service.initialize();
  const reference = {
    sessionId: "provider:one",
    logicalSessionId: "logical:one",
    metadata: { session: { workId: "work:one" } }
  };
  const imported = await service.importImage(reference, { sourcePath: source, preserveOriginal: false });
  assert.equal(imported.originalPath, null);
  assert.match(imported.managedPath, /^chat-resources\/works\/work_one\/logical_one\/images\//);
});

test("missing Provider image placeholders remain owned by their Session", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "corptie-chat-resource-"));
  const service = new ChatResourceService({ environmentRoot: root });
  await service.initialize();
  const reference = {
    sessionId: "provider:one",
    logicalSessionId: "logical:one",
    metadata: { session: { workId: "work:one" } }
  };
  const managedPath = service.missingImagePath(reference, "provider:item");
  assert.equal(managedPath, "chat-resources/works/work_one/logical_one/images/provider_item.missing");
  assert.equal(await service.exists(reference, managedPath), false);
});

test("a Session cannot read another Session's managed image", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "corptie-chat-resource-"));
  const service = new ChatResourceService({ environmentRoot: root });
  await service.initialize();
  const reference = {
    sessionId: "provider:one",
    logicalSessionId: "logical:one",
    metadata: { session: { taskId: "task:one" } }
  };
  await assert.rejects(
    service.readImage(reference, "chat-resources/tasks/task_two/logical_two/images/x.png"),
    { code: "CHAT_IMAGE_FORBIDDEN" }
  );
});
