#!/usr/bin/env node

import { resolve } from "node:path";
import {
  durableSessionEventPayload,
  providerEventFingerprint
} from "../src/application/providerEventIngestionService.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";

const options = parseArguments(process.argv.slice(2));
if (!options.dbPath) {
  console.error("Usage: node scripts/compact-event-storage.mjs --db /absolute/path/corptie.sqlite [--batch-size 250]");
  process.exitCode = 2;
} else {
  await compactEventStorage(options);
}

async function compactEventStorage({ dbPath, batchSize }) {
  const store = new CorptieStore({
    dbPath,
    configPath: `${dbPath}.maintenance-config.json`,
    manageProcessEnvironment: false
  });
  await store.initialize({ resolveDataPath: false, performMigrations: false });
  assertMaintenanceSchema(store);
  const counts = {
    publishedOutboxDeleted: 0,
    appliedInboxCompacted: 0,
    providerSessionEventsCompacted: 0,
    inboxRowsSkipped: 0,
    sessionEventRowsSkipped: 0
  };
  try {
    let inboxCursor = 0;
    const outboxBatchSize = Math.max(batchSize, 5_000);
    while (true) {
      const rows = store.selectAll(
        `SELECT rowid AS maintenance_rowid, normalized_event_json
         FROM provider_event_inbox NOT INDEXED
         WHERE rowid > ? AND status = 'applied' AND normalized_event_json <> '{}'
         ORDER BY rowid ASC LIMIT ?`,
        [inboxCursor, batchSize]
      );
      if (rows.length === 0) break;
      inboxCursor = Number(rows.at(-1).maintenance_rowid);
      const compactable = [];
      for (const row of rows) {
        try {
          const event = JSON.parse(row.normalized_event_json);
          compactable.push({ rowid: row.maintenance_rowid, fingerprint: providerEventFingerprint(event) });
        } catch {
          counts.inboxRowsSkipped += 1;
        }
      }
      store.runInTransaction(() => {
        for (const row of compactable) {
          store.db.run(
            `UPDATE provider_event_inbox
             SET event_fingerprint = ?, raw_payload_json = '{}', normalized_event_json = '{}'
             WHERE rowid = ? AND status = 'applied'`,
            [row.fingerprint, row.rowid]
          );
        }
      });
      counts.appliedInboxCompacted += compactable.length;
      reportProgress(store, "inbox", counts.appliedInboxCompacted);
    }

    let sessionEventCursor = 0;
    while (true) {
      const rows = store.selectAll(
        `SELECT rowid AS maintenance_rowid, type, payload_json
         FROM session_events NOT INDEXED
         WHERE rowid > ? AND storage_version < 2
           AND json_extract(source_json, '$.type') = 'provider'
           AND type IN (
             'turn.completed', 'turn.failed', 'turn.cancelled',
             'user.message.accepted', 'assistant.message.started',
             'assistant.message.delta', 'assistant.message.completed',
             'tool.started', 'tool.progress', 'tool.completed', 'tool.failed',
             'approval.requested', 'approval.resolved'
           )
         ORDER BY rowid ASC LIMIT ?`,
        [sessionEventCursor, batchSize]
      );
      if (rows.length === 0) break;
      sessionEventCursor = Number(rows.at(-1).maintenance_rowid);
      const compactable = [];
      for (const row of rows) {
        try {
          const payload = JSON.parse(row.payload_json);
          compactable.push({
            rowid: row.maintenance_rowid,
            payload: JSON.stringify(durableSessionEventPayload({ type: row.type, payload }))
          });
        } catch {
          counts.sessionEventRowsSkipped += 1;
        }
      }
      store.runInTransaction(() => {
        for (const row of compactable) {
          store.db.run(
            "UPDATE session_events SET payload_json = ?, storage_version = 2 WHERE rowid = ?",
            [row.payload, row.rowid]
          );
        }
      });
      counts.providerSessionEventsCompacted += compactable.length;
      reportProgress(store, "session-events", counts.providerSessionEventsCompacted);
    }

    while (true) {
      store.db.run(
        `DELETE FROM event_outbox
         WHERE rowid IN (
           SELECT rowid FROM event_outbox
           WHERE status = 'published' ORDER BY rowid ASC LIMIT ?
         )`,
        [outboxBatchSize]
      );
      const deleted = store.db.getRowsModified();
      if (deleted === 0) break;
      counts.publishedOutboxDeleted += deleted;
      reportProgress(store, "outbox", counts.publishedOutboxDeleted);
    }
    store.db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    await store.close();
  }
  console.log(JSON.stringify({ dbPath, ...counts }, null, 2));
}

function assertMaintenanceSchema(store) {
  const inboxColumns = new Set(store.selectAll("PRAGMA table_info(provider_event_inbox)").map((row) => row.name));
  const sessionEventColumns = new Set(store.selectAll("PRAGMA table_info(session_events)").map((row) => row.name));
  const missing = [
    ...(inboxColumns.has("event_fingerprint") ? [] : ["provider_event_inbox.event_fingerprint"]),
    ...(sessionEventColumns.has("storage_version") ? [] : ["session_events.storage_version"])
  ];
  if (missing.length > 0) {
    throw new Error(`Event storage schema migration must run before compaction: ${missing.join(", ")}`);
  }
}

function reportProgress(store, phase, count) {
  if (count === 0 || count % 10_000 !== 0) return;
  store.db.checkpoint();
  process.stderr.write(`[event-storage] phase=${phase} rows=${count}\n`);
}

function parseArguments(args) {
  const result = { dbPath: null, batchSize: 250 };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--db") {
      result.dbPath = resolve(String(args[index + 1] ?? ""));
      index += 1;
    } else if (args[index] === "--batch-size") {
      result.batchSize = Math.max(1, Math.min(5_000, Number(args[index + 1]) || 250));
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${args[index]}`);
    }
  }
  return result;
}
