import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMessageResource, messageResourceLinks } from "../src/application/messageResources.mjs";

test("explicit references only, no arbitrary text substring", () => {
  assert.deepEqual(messageResourceLinks("/tmp/a.png [chart](</tmp/b c.png>) ![chart](/tmp/d.png)"), ["/tmp/b c.png", "/tmp/d.png"]);
});

test("Session resource read enforces reference, roots, type, symlinks and size", async () => {
  const root = await mkdtemp(join(tmpdir(), "corptie-resource-test-"));
  try {
    const directory = join(root, "tmp");
    await mkdir(directory);
    const file = join(directory, "chart.png");
    const outside = join(root, "secret.json");
    const escape = join(directory, "escape.json");
    const hidden = join(directory, ".secret.json");
    const executable = join(directory, "payload.html");
    await Promise.all([writeFile(file, "image"), writeFile(outside, "secret"), writeFile(hidden, "secret"), writeFile(executable, "<script/>"), symlink(outside, escape)]);
    let text = `[image](<${file}>)`;
    const input = { environmentRoot: root, reference: { sessionId: "session:one", logicalSessionId: "logical:one" }, itemId: "message",
      store: { getSessionItem: (id, item) => id === "session:one" && item === "message" ? { type: "agentMessage", text } : null,
        getSession: () => ({}) } };
    assert.equal((await readMessageResource({ ...input, path: file })).data.toString(), "image");
    await assert.rejects(readMessageResource({ ...input, reference: { logicalSessionId: "logical:two" }, path: file }));
    text = file;
    await assert.rejects(readMessageResource({ ...input, path: file }));
    for (const path of [outside, escape, hidden, executable, join(directory, "missing.png")]) {
      text = `[file](<${path}>)`;
      await assert.rejects(readMessageResource({ ...input, path }), { code: "MESSAGE_RESOURCE_UNAVAILABLE" });
    }
    const large = join(directory, "large.txt");
    await writeFile(large, Buffer.alloc(20 * 1024 * 1024 + 1));
    text = `[file](<${large}>)`;
    await assert.rejects(readMessageResource({ ...input, path: large }));
  } finally { await rm(root, { recursive: true, force: true }); }
});
