import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configureBackendLogging, logSettings } from "../src/utils/backendLogging.mjs";

test("backend logging uses the configured directory and rotates bounded files", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "corptie-logging-"));
  configureBackendLogging(directory, { maxBytes: 100, backupCount: 2 });

  console.log("a".repeat(70));
  console.log("b".repeat(70));
  console.error("stderr-entry");
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(logSettings().directory, directory);
  assert.match(await readFile(join(directory, "backend.out.log.1"), "utf8"), /^a+/);
  assert.match(await readFile(join(directory, "backend.out.log"), "utf8"), /^b+/);
  assert.match(await readFile(join(directory, "backend.err.log"), "utf8"), /stderr-entry/);
  assert.ok((await stat(join(directory, "backend.out.log"))).size <= 100);
});
