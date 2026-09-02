import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { ensureDataRootLayout, resolveDataRootLayout } from "../src/runtime/dataRootLayout.mjs";

test("concurrent stored Timeline snapshots do not block backend health", { timeout: 40_000 }, async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "corptie-timeline-http-"));
  const dataRoot = join(directory, "data");
  const selectionPath = join(directory, "data-root.json");
  const layout = resolveDataRootLayout(dataRoot, "development");
  const sessionIds = Array.from({ length: 12 }, (_, index) => `timeline-http-${index}`);
  await ensureDataRootLayout(layout);
  await writeFile(selectionPath, JSON.stringify({ dataRoot }));
  const store = new CorptieStore({
    dbPath: layout.databasePath,
    configPath: layout.configPath,
    dataRoot,
    manageProcessEnvironment: false
  });
  await store.initialize();
  try {
    for (const sessionId of sessionIds) {
      store.upsertSession({
        id: sessionId,
        title: sessionId,
        agent: "Codex",
        provider: "codex-app-server",
        status: "complete",
        external: { threadId: sessionId }
      });
      for (let itemIndex = 0; itemIndex < 200; itemIndex += 1) {
        store.upsertTimelineItemProjection(sessionId, {
          id: `${sessionId}-item-${String(itemIndex).padStart(3, "0")}`,
          type: "agentMessage",
          text: "x".repeat(8_192),
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, itemIndex)).toISOString()
        });
      }
    }
  } finally {
    await store.close();
  }

  const port = await availablePort();
  const backend = startBackend({ port, selectionPath });
  try {
    await waitForHealth(port, backend);
    const startedAt = performance.now();
    const snapshots = Promise.all(sessionIds.map(async (sessionId) => {
      const response = await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/stored-snapshot`);
      if (response.status !== 200) {
        assert.fail(`stored snapshot returned ${response.status}: ${await response.text()}\n${backend.debugOutput}`);
      }
      return response.arrayBuffer();
    }));
    const healthLatencies = [];
    while (performance.now() - startedAt < 1_000) {
      const healthStartedAt = performance.now();
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).storeReady, true);
      healthLatencies.push(performance.now() - healthStartedAt);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const payloads = await snapshots;
    const elapsed = performance.now() - startedAt;
    const maximumHealthLatency = Math.max(...healthLatencies);
    console.log(
      `[perf] 12 concurrent wide Timeline snapshots ${elapsed.toFixed(1)}ms; `
      + `maximum health latency ${maximumHealthLatency.toFixed(1)}ms`
    );
    assert.ok(payloads.every((payload) => payload.byteLength > 1_000_000));
    assert.ok(elapsed < 10_000, `12 wide Session snapshots took ${elapsed.toFixed(1)}ms`);
    assert.ok(
      maximumHealthLatency < 1_000,
      `health was blocked for ${maximumHealthLatency.toFixed(1)}ms during Timeline reads`
    );
  } finally {
    backend.kill("SIGTERM");
    await waitForExit(backend).catch(() => {});
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
      CORPTIE_ENABLE_MOCK_SESSIONS: "0",
      CORPTIE_TIMELINE_READ_CONCURRENCY: "4"
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  child.debugOutput = "";
  child.stderr.on("data", (chunk) => { child.debugOutput += chunk.toString(); });
  return child;
}

async function waitForHealth(port, child) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok && (await response.json()).storeReady === true) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Backend health timeout\n${child.debugOutput}`);
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
