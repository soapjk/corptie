import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";
import test from "node:test";

import {
  BackendDataRootOwnership,
  BackendDataRootOwnershipError
} from "../src/runtime/backendDataRootOwnership.mjs";

test("one live Backend exclusively owns an environment Data Root", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "corptie-backend-owner-"));
  try {
    const first = await BackendDataRootOwnership.acquire({
      stateDirectory: directory, pid: 101, port: 47321,
      processAlive: async (pid) => pid === 101
    });
    await assert.rejects(() => BackendDataRootOwnership.acquire({
      stateDirectory: directory, pid: 202, port: 47326,
      processAlive: async (pid) => pid === 101
    }), (error) => {
      assert.equal(error instanceof BackendDataRootOwnershipError, true);
      assert.equal(error.code, "BACKEND_DATA_ROOT_IN_USE");
      assert.deepEqual(error.owner, {
        pid: 101, hostname: os.hostname(), environment: "production",
        port: 47321, acquiredAt: first.owner.acquiredAt
      });
      return true;
    });
    assert.equal(await first.release(), true);
    assert.equal(await first.release(), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a dead Backend owner is retired and replaced atomically", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "corptie-backend-owner-stale-"));
  try {
    const first = await BackendDataRootOwnership.acquire({
      stateDirectory: directory, pid: 303, port: 47321,
      processAlive: async () => false
    });
    const second = await BackendDataRootOwnership.acquire({
      stateDirectory: directory, pid: 404, port: 47321,
      processAlive: async () => false
    });
    const persisted = JSON.parse(await readFile(join(directory, "backend-owner.lock", "owner.json"), "utf8"));
    assert.equal(persisted.ownershipId, second.owner.ownershipId);
    assert.equal(await first.release(), false, "the stale owner must not delete the replacement claim");
    assert.equal(await second.release(), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
