import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { StartupBindingReceiptConsumer } from "../src/project-code/projectCodeSnapshot.mjs";
import { ProjectCodeStartupReceiptRepository } from "../src/project-code/projectCodeStartupReceiptRepository.mjs";
import { createProjectCodeFixture } from "./helpers/projectCodeTestFixture.mjs";

test("Startup consumer binds exact authenticated Session, Store identity and Git HEAD/tree", async () => {
  const fixture = await createProjectCodeFixture();
  try {
    const consumer = new StartupBindingReceiptConsumer();
    await assert.doesNotReject(() => consumer.verify(fixture.startupReceipt, fixture.binding, fixture.sessionContext));
    await assert.rejects(() => consumer.verify(fixture.startupReceipt, fixture.binding, { ...fixture.sessionContext, logicalSessionId: "logical:other" }),
      (error) => error.code === "STARTUP_BINDING_MISMATCH");
    await assert.rejects(() => consumer.verify(fixture.startupReceipt, { ...fixture.binding, bindingGeneration: 2 }, fixture.sessionContext),
      (error) => error.code === "STARTUP_BINDING_MISMATCH");
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test("Startup consumer fails closed when current Worktree HEAD changed", async () => {
  const fixture = await createProjectCodeFixture();
  try {
    await writeFile(join(fixture.directory, "new.txt"), "new\n");
    const { git } = await import("./helpers/projectCodeTestFixture.mjs");
    await git(fixture.directory, ["add", "new.txt"]);
    await git(fixture.directory, ["commit", "-qm", "changed head"]);
    await assert.rejects(() => new StartupBindingReceiptConsumer().verify(fixture.startupReceipt, fixture.binding, fixture.sessionContext),
      (error) => error.code === "STARTUP_SOURCE_CHANGED");
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test("Startup consumer rejects unknown fields instead of silently accepting them", async () => {
  const fixture = await createProjectCodeFixture();
  try {
    await assert.rejects(() => new StartupBindingReceiptConsumer().verify({ ...fixture.startupReceipt, providerSessionId: "native" }, fixture.binding, fixture.sessionContext),
      (error) => error.code === "STARTUP_BINDING_MISMATCH" && /unknown/.test(error.message));
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test("production Startup adapter reads the authoritative lifecycle tables without signing duplicate state", async () => {
  const fixture = await createProjectCodeFixture();
  try {
    let query = "";
    const repository = new ProjectCodeStartupReceiptRepository({
      store: {
        selectOne(sql, parameters) {
          query = sql;
          assert.deepEqual(parameters, [fixture.sessionContext.logicalSessionId]);
          return { receipt_json: JSON.stringify(fixture.startupReceipt) };
        }
      }
    });
    assert.deepEqual(repository.require(fixture.sessionContext.logicalSessionId), fixture.startupReceipt);
    assert.match(query, /work_session_startup_bindings/);
    assert.match(query, /status='ready'/);
    assert.equal(Object.hasOwn(repository, "issue"), false);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test("production Startup adapter fails closed while the upstream Startup tables are unavailable", () => {
  const repository = new ProjectCodeStartupReceiptRepository({
    store: { selectOne() { throw new Error("no such table: work_session_startup_receipts"); } }
  });
  assert.throws(() => repository.require("logical:test"), { code: "STARTUP_BINDING_NOT_READY" });
});
