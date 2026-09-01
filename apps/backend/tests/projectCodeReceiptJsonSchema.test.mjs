import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import test from "node:test";
import {
  PROJECT_CODE_SCHEMA_ARTIFACT,
  canonicalJson,
  loadProjectCodeReceiptSchema,
  sha256Hex,
  signReceipt,
  validateProjectCodeReceipt
} from "../src/project-code/projectCodeContracts.mjs";
import { RepositorySourceSnapshotBuilder } from "../src/project-code/projectCodeSnapshot.mjs";
import { createProjectCodeFixture } from "./helpers/projectCodeTestFixture.mjs";

test("bundled approved Snapshot/Search schema has the fixed Artifact bytes and closes every object", async () => {
  const path = new URL("../src/contracts/project-code-search-receipts.schema.json", import.meta.url);
  const bundled = await readFile(path);
  const artifactBytes = bundled.at(-1) === 0x0a ? bundled.subarray(0, -1) : bundled;
  assert.equal(artifactBytes.byteLength, 29_669);
  assert.equal(sha256Hex(artifactBytes), PROJECT_CODE_SCHEMA_ARTIFACT.contentHash);
  const schema = await loadProjectCodeReceiptSchema();
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  const objects = [];
  visit(schema, (node) => { if (node?.type === "object") objects.push(node); });
  assert.equal(objects.length, 23);
  assert.ok(objects.every((node) => node.additionalProperties === false));
  assert.equal(Object.hasOwn(schema.$defs.RepositorySourceSnapshotReceipt.properties, "snapshotReceiptId"), false);
  assert.equal(schema.$defs.SearchReceipt.additionalProperties, false);
});

test("Search schema and cross-field invariants reject unknown fields and mixed isolation refs", async () => {
  const fixture = await createProjectCodeFixture();
  try {
    const snapshot = await new RepositorySourceSnapshotBuilder().build(fixture);
    const { ProjectCodeSearchService } = await import("../src/project-code/projectCodeSearchService.mjs");
    const valid = (await new ProjectCodeSearchService({ snapshotBuilder: new RepositorySourceSnapshotBuilder() }).search({
      snapshot, sessionContext: fixture.sessionContext, searchScenarioId: "schema-search", query: "exactNeedle", mode: "exact"
    })).receipt;
    await assert.rejects(() => validateProjectCodeReceipt({ ...valid, rawQuery: "secret" }, "SearchReceipt"), /unknown/);
    const mixed = signReceipt({ ...valid, runId: "run:mixed", runIsolationReceiptRef: null, cleanupReceiptRef: null });
    await assert.rejects(() => validateProjectCodeReceipt(mixed, "SearchReceipt"), /all null or all non-null|allowed schema/);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test("machine validator accepts a signed Snapshot and rejects unknown fields and prefixed hashes", async () => {
  const fixture = await createProjectCodeFixture();
  try {
    const snapshot = await new RepositorySourceSnapshotBuilder().build(fixture);
    await assert.doesNotReject(() => validateProjectCodeReceipt(snapshot.receipt, "RepositorySourceSnapshotReceipt"));
    await assert.rejects(() => validateProjectCodeReceipt({ ...snapshot.receipt, snapshotReceiptId: "second-id" }, "RepositorySourceSnapshotReceipt"), /unknown/);
    await assert.rejects(() => validateProjectCodeReceipt({ ...snapshot.receipt, sourceFingerprint: `sha256:${snapshot.receipt.sourceFingerprint}` }, "RepositorySourceSnapshotReceipt"), /does not match/);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("RFC 8785 compatible canonical JSON sorts nested keys deterministically", () => {
  assert.equal(canonicalJson({ z: [3, { b: true, a: "值" }], a: -0 }), '{"a":0,"z":[3,{"a":"值","b":true}]}');
});

function visit(node, callback) {
  if (!node || typeof node !== "object") return;
  callback(node);
  if (Array.isArray(node)) node.forEach((entry) => visit(entry, callback));
  else Object.values(node).forEach((entry) => visit(entry, callback));
}
