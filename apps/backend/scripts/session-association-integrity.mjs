#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

import { CorptieStore } from "../src/store/corptieStore.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.dbPath) fail("--db <path> is required.");
if (args.apply && !args.backupPath) fail("--apply requires --backup <path>.");

const startedAt = new Date().toISOString();
let report;
if (args.apply) {
  await mkdir(dirname(args.backupPath), { recursive: true });
  const source = new DatabaseSync(args.dbPath, { readOnly: true });
  try {
    await backup(source, args.backupPath);
  } finally {
    source.close();
  }

  const store = new CorptieStore({ dbPath: args.dbPath, configPath: `${args.dbPath}.integrity-config.json` });
  try {
    await store.initialize();
    const before = store.sessionAssociationIssues();
    const repair = store.repairOrphanedWorkSessions({
      repairedBy: args.actor ?? "session-association-integrity",
      reason: args.reason ?? "Production association integrity repair"
    });
    report = {
      mode: "apply",
      database: resolve(args.dbPath),
      backup: resolve(args.backupPath),
      startedAt,
      completedAt: new Date().toISOString(),
      before,
      repaired: repair.repaired,
      unresolved: repair.unresolved,
      after: repair.remainingIssues
    };
  } finally {
    await store.close();
  }
} else {
  const database = new DatabaseSync(args.dbPath, { readOnly: true });
  try {
    report = {
      mode: "scan",
      database: resolve(args.dbPath),
      startedAt,
      completedAt: new Date().toISOString(),
      issues: scanReadOnly(database)
    };
  } finally {
    database.close();
  }
}

const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (args.outputPath) {
  await mkdir(dirname(args.outputPath), { recursive: true });
  await writeFile(args.outputPath, serialized, { encoding: "utf8", flag: "wx" });
}
process.stdout.write(serialized);
if ((report.after ?? report.issues).length > 0 || report.unresolved?.length > 0) process.exitCode = 2;

function scanReadOnly(database) {
  return database.prepare(`
    WITH anomalies AS (
      SELECT 'worker_objective_missing' AS code, s.id AS session_id,
             s.objective_id, s.work_item_id, s.session_kind, s.title
      FROM sessions s
      WHERE s.session_kind='worker' AND (s.objective_id IS NULL OR TRIM(s.objective_id)='')
      UNION ALL
      SELECT 'worker_work_item_missing', s.id, s.objective_id, s.work_item_id, s.session_kind, s.title
      FROM sessions s
      WHERE s.session_kind='worker' AND (s.work_item_id IS NULL OR TRIM(s.work_item_id)='')
      UNION ALL
      SELECT 'session_objective_not_found', s.id, s.objective_id, s.work_item_id, s.session_kind, s.title
      FROM sessions s LEFT JOIN objectives o ON o.id=s.objective_id
      WHERE s.objective_id IS NOT NULL AND TRIM(s.objective_id)<>'' AND o.id IS NULL
      UNION ALL
      SELECT 'session_work_item_not_found', s.id, s.objective_id, s.work_item_id, s.session_kind, s.title
      FROM sessions s LEFT JOIN work_items wi ON wi.id=s.work_item_id
      WHERE s.work_item_id IS NOT NULL AND TRIM(s.work_item_id)<>'' AND wi.id IS NULL
      UNION ALL
      SELECT 'session_work_item_objective_mismatch', s.id, s.objective_id, s.work_item_id, s.session_kind, s.title
      FROM sessions s JOIN work_items wi ON wi.id=s.work_item_id WHERE s.objective_id IS NOT wi.objective_id
      UNION ALL
      SELECT 'bound_session_kind_not_worker', s.id, s.objective_id, s.work_item_id, s.session_kind, s.title
      FROM sessions s WHERE s.work_item_id IS NOT NULL AND TRIM(s.work_item_id)<>'' AND s.session_kind<>'worker'
      UNION ALL
      SELECT 'objective_chat_objective_missing', s.id, s.objective_id, s.work_item_id, s.session_kind, s.title
      FROM sessions s WHERE s.session_kind='objectiveChat' AND (s.objective_id IS NULL OR TRIM(s.objective_id)='')
      UNION ALL
      SELECT 'objective_chat_has_work_item', s.id, s.objective_id, s.work_item_id, s.session_kind, s.title
      FROM sessions s WHERE s.session_kind='objectiveChat' AND s.work_item_id IS NOT NULL AND TRIM(s.work_item_id)<>''
      UNION ALL
      SELECT 'work_item_current_session_not_found', wi.current_session_id, wi.objective_id, wi.id, NULL, wi.title
      FROM work_items wi LEFT JOIN sessions s ON s.id=wi.current_session_id
      WHERE wi.current_session_id IS NOT NULL AND TRIM(wi.current_session_id)<>'' AND s.id IS NULL
      UNION ALL
      SELECT 'work_item_current_session_binding_mismatch', wi.current_session_id, wi.objective_id, wi.id, s.session_kind, wi.title
      FROM work_items wi JOIN sessions s ON s.id=wi.current_session_id
      WHERE s.work_item_id IS NOT wi.id OR s.objective_id IS NOT wi.objective_id OR s.session_kind<>'worker'
    )
    SELECT code, session_id AS sessionId, objective_id AS objectiveId,
           work_item_id AS workItemId, session_kind AS sessionKind, title
    FROM anomalies ORDER BY code, session_id
  `).all();
}

function parseArgs(argv) {
  const parsed = { apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--apply") parsed.apply = true;
    else if (token === "--db") parsed.dbPath = requiredValue(argv, ++index, token);
    else if (token === "--backup") parsed.backupPath = requiredValue(argv, ++index, token);
    else if (token === "--output") parsed.outputPath = requiredValue(argv, ++index, token);
    else if (token === "--actor") parsed.actor = requiredValue(argv, ++index, token);
    else if (token === "--reason") parsed.reason = requiredValue(argv, ++index, token);
    else fail(`Unknown argument: ${token}`);
  }
  return parsed;
}

function requiredValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) fail(`${flag} requires a value.`);
  return value;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(64);
}
