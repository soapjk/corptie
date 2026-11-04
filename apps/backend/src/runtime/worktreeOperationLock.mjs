import { AsyncLocalStorage } from "node:async_hooks";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

const tails = new Map();
const owners = new AsyncLocalStorage();

// Shared by project Git writes and snapshot capture; never by a Provider.
export async function withWorktreeOperationLock(path, operation) {
  const key = await realpath(path).catch(() => resolve(path));
  const held = owners.getStore();
  if (held?.has(key)) return operation();
  const previous = tails.get(key) ?? Promise.resolve();
  let release;
  const tail = new Promise(done => { release = done; });
  tails.set(key, tail);
  await previous;
  try { return await owners.run(new Set([...(held ?? []), key]), operation); }
  finally { release(); if (tails.get(key) === tail) tails.delete(key); }
}
