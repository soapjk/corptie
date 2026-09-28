import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { NativeDatabase } from "./nativeDatabase.mjs";

export async function prepareStoreDatabaseDirectory(path, options = {}) {
  // Read Workers never create storage or queue a redundant mkdir behind reads
  // on libuv's shared filesystem pool.
  if (options.readOnly !== true) await mkdir(dirname(path), { recursive: true });
}

export function configureStoreDatabase(database, options = {}) {
  if (options.readOnly === true) {
    database.run("PRAGMA query_only = ON");
    database.run(`PRAGMA cache_size = -${Math.max(1_024, Number(options.readCacheSizeKiB) || 65_536)}`);
    database.run(`PRAGMA mmap_size = ${Math.max(0, Number(options.readMmapSizeBytes) || 268_435_456)}`);
    database.run("PRAGMA temp_store = MEMORY");
  } else {
    database.run("PRAGMA journal_mode = WAL");
    database.run("PRAGMA synchronous = FULL");
  }
  database.run("PRAGMA busy_timeout = 5000");
  database.run("PRAGMA foreign_keys = ON");
}

export function openWritableStoreDatabase(path) {
  const database = new NativeDatabase(path);
  configureStoreDatabase(database);
  return database;
}
