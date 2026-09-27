import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectorFileImporter } from "../src/application/clientInspectorFiles.mjs";

test("iPad imports use an isolated managed path and preserve binary MIME", async () => {
  const root = await mkdtemp(join(tmpdir(), "corptie-inspector-file-"));
  const input = { fileName: "../../private.pdf", dataBase64: Buffer.from("%PDF-test").toString("base64") };
  const scope = { sessionId: "logical:s", workId: "w", context: { kind: "local_user", workId: "w" } };
  let imported;
  const importer = inspectorFileImporter({ store: { dataRoot: root }, references: {
    create: async (_, fields) => { imported = fields; return { referenceId: "ref" }; }
  }, artifacts: { importLocalFile: async (_, fields) => {
    imported = fields; assert.equal(await readFile(fields.path, "utf8"), "%PDF-test"); return { artifact: { artifactId: "a" } };
  } } });
  try {
    assert.deepEqual(await importer(scope, "artifact.import", input), { artifactId: "a" });
    assert.equal(imported.mimeType, "application/pdf");
    assert.ok(imported.path.startsWith(join(root, "client-reference-files")));
    await assert.rejects(readFile(imported.path), { code: "ENOENT" });
    await importer(scope, "reference.import", input);
    assert.equal(await readFile(imported.locator, "utf8"), "%PDF-test");
    assert.equal(imported.displayName, "private.pdf");
    await assert.rejects(() => importer(scope, "artifact.import", { ...input, dataBase64: "!!!" }), { code: "INVALID_DOCUMENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
