#!/usr/bin/env node

import { CorptieStore } from "../apps/backend/src/store/corptieStore.mjs";

const store = new CorptieStore();
try {
  await store.initialize();
  const records = store.auditObjectiveWorkItemAssociations({ migrate: true });
  const unresolved = records.filter((record) => record.status === "unresolved");
  const migrated = records.filter((record) => record.status === "migrated");
  process.stdout.write(`${JSON.stringify({
    database: store.settings().dbPath,
    migratedCount: migrated.length,
    unresolvedCount: unresolved.length,
    migrated,
    unresolved
  }, null, 2)}\n`);
  process.exitCode = unresolved.length > 0 ? 2 : 0;
} finally {
  await store.close();
}
