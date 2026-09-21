import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);

test("Artifact native publication is atomic, no-replace, and rejects unsafe paths and symlinks", { skip: process.platform !== "darwin" }, async () => {
  const native = require("../native/corptie_native.node");
  const root = await realpath(await mkdtemp(join(tmpdir(), "artifact-safe-write-")));
  const outside = await realpath(await mkdtemp(join(tmpdir(), "artifact-outside-")));
  try {
    const content = Buffer.alloc(2 * 1024 * 1024, 117);
    const receipt = native.writeNewFileOpenat(root, ".corptie/artifacts/note.md", content);
    assert.equal(receipt.bytes, content.length);
    assert.deepEqual(await readFile(join(root, ".corptie/artifacts/note.md")), content);
    assert.deepEqual(await readdir(join(root, ".corptie/artifacts")), ["note.md"]);
    assert.throws(() => native.writeNewFileOpenat(root, ".corptie/artifacts/note.md", Buffer.from("overwrite")), /ARTIFACT_DESTINATION_EXISTS/);
    assert.deepEqual(await readFile(join(root, ".corptie/artifacts/note.md")), content);
    for (const path of ["/tmp/no", "../no", ".corptie/../no", ".corptie//no", ".corptie/./no", ".corptie/no/", "x\\y", "x\0y"]) {
      assert.throws(() => native.writeNewFileOpenat(root, path, Buffer.from("bad")));
    }
    await symlink(outside, join(root, ".corptie/escape"));
    assert.throws(() => native.writeNewFileOpenat(root, ".corptie/escape/no.md", content), /ARTIFACT_PATH_UNSAFE/);
    await writeFile(join(outside, "sentinel"), "untouched");
    await symlink(join(outside, "sentinel"), join(root, ".corptie/artifacts/link.md"));
    assert.throws(() => native.writeNewFileOpenat(root, ".corptie/artifacts/link.md", content), /ARTIFACT_DESTINATION_EXISTS/);
    assert.equal(await readFile(join(outside, "sentinel"), "utf8"), "untouched");
    assert.deepEqual(await readdir(outside), ["sentinel"]);
    native.writeNewFileOpenat(root, ".corptie/empty", Buffer.alloc(0));
    assert.equal((await readFile(join(root, ".corptie/empty"))).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
