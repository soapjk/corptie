import assert from "node:assert/strict";
import { mkdtemp, rm, chmod, symlink, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";
import test from "node:test";
import { acquireLock, options, parseBridgeConfig, probeHTTP, probeBridge, npcProcessIDs, startOwnedNPC, stopOwnedNPC } from "../ops/npc-supervisor.mjs";

test("supervision fails closed without explicit registration permission", () => {
  assert.equal(options(["--config", "/tmp/npc.conf"])["--supervise"], undefined);
  assert.throws(() => options(["--supervise", "--config", "/tmp/npc.conf"]));
  assert.throws(() => options(["--config", "relative.conf"]));
  assert.throws(() => options(["--config", "/tmp/npc.conf", "--vkey", "secret"]));
  assert.equal(options(["--supervise", "--allow-registration", "--config", "/tmp/npc.conf", "--executable", "/bin/npc", "--state-dir", "/tmp/private-state"])["--supervise"], true);
});
test("bridge parser does not return any credential and ignores other route sections", () => {
  const parsed = parseBridgeConfig("[common]\nserver_addr=47.94.144.23:8024\nvkey=SECRET\n[other]\nserver_addr=wrong:1\n");
  assert.deepEqual(parsed, { host: "47.94.144.23", port: 8024 });
  assert.throws(() => parseBridgeConfig("[common]\nserver_addr=x:70000\nvkey=SECRET"));
  assert.throws(() => parseBridgeConfig("[common]\nserver_addr=x:8024\n"));
});
test("exact NPC process detection avoids unrelated names and exposes no argv", () => {
  assert.deepEqual(npcProcessIDs("12 /a/npc\n13 /a/npc-supervisor.mjs\n14 node\n15 npc\n"), [12, 15]);
});
test("lock permits only one supervisor and fails closed on stale, loose and symlink directories", async () => {
  const root = await mkdtemp("/private/tmp/corptie-npc-test-");
  try {
    const directory = join(root, "private");
    const release = await acquireLock(directory);
    assert.equal(await readFile(join(directory, "supervisor.lock"), "utf8"), String(process.pid));
    await assert.rejects(acquireLock(directory));
    await release();
    await chmod(directory, 0o755);
    await assert.rejects(acquireLock(directory));
    await chmod(directory, 0o700);
    await symlink(directory, join(root, "link"));
    await assert.rejects(acquireLock(join(root, "link")));
    await assert.rejects(acquireLock("/tmp"));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("HTTP and bridge probes are bounded and redirects do not leak to another destination", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/redirect") { response.writeHead(302, { location: "http://invalid.example/secret" }); }
    else response.writeHead(request.url === "/ready" ? 200 : 502);
    response.end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    assert.deepEqual(await probeHTTP(`http://127.0.0.1:${port}/ready`), { ready: true, status: 200 });
    assert.deepEqual(await probeHTTP(`http://127.0.0.1:${port}/bad`), { ready: false, status: 502 });
    assert.deepEqual(await probeHTTP(`http://127.0.0.1:${port}/redirect`), { ready: false, status: 0 });
    assert.equal(await probeBridge("127.0.0.1", port), true);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  assert.equal(await probeBridge("127.0.0.1", port), false);
});

test("owned process lifecycle is local-only, redacts output and refuses competing NPCs", async () => {
  const root = await mkdtemp("/private/tmp/corptie-npc-lifecycle-");
  let child;
  try {
    const fake = join(root, "fake-npc.sh");
    const config = join(root, "npc.conf");
    // Only a local stand-in is launched; it contains no network operations.
    await writeFile(fake, '#!/bin/sh\nprintf "Validation key TEST_SECRET incorrect\\n"\nprintf "web access login password:TEST_PASSWORD\\n" >&2\nexec /bin/sleep 30\n', { mode: 0o700 });
    await writeFile(config, "LOCAL_TEST_ONLY", { mode: 0o600 });
    const received = [];
    await assert.rejects(startOwnedNPC(fake, config, signal => received.push(signal), async () => [123]));
    const signalled = new Promise(resolve => {
      child = undefined;
      const timeout = setTimeout(() => resolve(false), 3000);
      startOwnedNPC(fake, config, signal => {
        received.push(signal);
        if (signal === "auth-rejected") { clearTimeout(timeout); resolve(true); }
      }, async () => []).then(value => { child = value; }).catch(() => { clearTimeout(timeout); resolve(false); });
    });
    assert.equal(await signalled, true);
    while (!child) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(JSON.stringify(received).includes("TEST_SECRET"), false);
    assert.equal(JSON.stringify(received).includes("TEST_PASSWORD"), false);
    await stopOwnedNPC(child);
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    await stopOwnedNPC(child);
    await assert.rejects(startOwnedNPC(join(root, "missing"), config, () => {}, async () => []));
  } finally { await stopOwnedNPC(child); await rm(root, { recursive: true, force: true }); }
});
