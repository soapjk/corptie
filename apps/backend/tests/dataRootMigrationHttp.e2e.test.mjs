import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

test("HTTP migration enters maintenance, requests host restart, and reconnects on the new root", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "corptie-data-root-http-"));
  const sourceRoot = join(directory, "source");
  const targetRoot = join(directory, "target");
  const selectionPath = join(directory, "data-root.json");
  const port = await availablePort();
  await writeFile(selectionPath, JSON.stringify({ dataRoot: sourceRoot }));
  let backend = startBackend({ port, selectionPath });
  try {
    await waitForHealth(port, backend);
    const invalid = await debugFetch(backend, `http://127.0.0.1:${port}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dataRoot: 42 })
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).code, "DATA_ROOT_INVALID");
    const staleForm = await debugFetch(backend, `http://127.0.0.1:${port}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        dataRoot: targetRoot,
        expectedSourceDataRoot: join(directory, "stale-source")
      })
    });
    const staleFailure = await staleForm.json();
    assert.equal(staleForm.status, 409);
    assert.equal(staleFailure.code, "DATA_ROOT_SOURCE_CHANGED");
    assert.equal(staleFailure.details.activeDataRoot, sourceRoot);
    assert.equal(staleFailure.operation, null, "a stale form must not create or replace a migration operation");
    assert.equal(JSON.parse(await readFile(selectionPath, "utf8")).dataRoot, sourceRoot);

    const migrationResponse = await debugFetch(backend, `http://127.0.0.1:${port}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dataRoot: targetRoot, expectedSourceDataRoot: sourceRoot })
    });
    const migrated = await migrationResponse.json();
    assert.equal(migrationResponse.status, 200, `${JSON.stringify(migrated)}\n${backend.debugOutput}`);
    assert.equal(migrated.dataRoot, sourceRoot);
    assert.equal(migrated.dataRootMigration.phase, "restartRequired");
    assert.equal(migrated.dataRootMigration.restartRequired, true);

    const rejected = await debugFetch(backend, `http://127.0.0.1:${port}/objectives`, { method: "POST" });
    assert.equal(rejected.status, 503);
    assert.equal((await rejected.json()).code, "DATA_ROOT_MAINTENANCE_MODE");

    const restart = await debugFetch(backend, `http://127.0.0.1:${port}/internal/backend/data-root-restart`, { method: "POST" });
    assert.equal(restart.status, 202);
    await waitForExit(backend);

    backend = startBackend({ port, selectionPath });
    await waitForHealth(port, backend);
    const settings = await (await fetch(`http://127.0.0.1:${port}/settings`)).json();
    assert.equal(settings.dataRoot, targetRoot);
    assert.equal(settings.dataRootMigration.operationId, migrated.dataRootMigration.operationId);
    assert.equal(settings.dataRootMigration.phase, "completed");
    assert.equal(JSON.parse(await readFile(selectionPath, "utf8")).dataRoot, targetRoot);
    assert.equal(JSON.parse(await readFile(join(targetRoot, "development", "config", "settings.json"), "utf8")).dataRoot, targetRoot);
  } finally {
    backend.kill("SIGTERM");
    await waitForExit(backend).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

function startBackend({ port, selectionPath }) {
  const child = spawn(process.execPath, [new URL("../src/server.mjs", import.meta.url).pathname], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...process.env,
      CORPTIE_ENV: "development",
      CORPTIE_BACKEND_PORT: String(port),
      CORPTIE_DATA_ROOT_SELECTION_PATH: selectionPath,
      CORPTIE_ENABLE_MOCK_SESSIONS: "0"
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  child.debugOutput = "";
  child.stderr.on("data", (chunk) => { child.debugOutput += chunk.toString(); });
  return child;
}

async function debugFetch(child, url, options) {
  try { return await fetch(url, options); } catch (error) {
    throw new Error(`${url}: ${error.message}\n${child.debugOutput}`);
  }
}

async function waitForHealth(port, child) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Backend health timeout\n${child?.debugOutput ?? ""}`);
}

function waitForExit(child) {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}
