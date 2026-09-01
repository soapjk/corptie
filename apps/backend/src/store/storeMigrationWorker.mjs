import { parentPort, workerData } from "node:worker_threads";
import { CorptieStore } from "./corptieStore.mjs";

const store = new CorptieStore({
  dbPath: workerData.dbPath,
  configPath: workerData.configPath,
  dataRoot: workerData.dataRoot,
  manageProcessEnvironment: false
});

try {
  if (workerData.operation === "optimize") {
    await store.initialize({ performMigrations: false });
    // The 0x10000 flag inspects every table that lacks recent usage history.
    // On a multi-gigabyte Store that becomes a full-database startup scan and
    // can hold SQLite's writer lock for tens of seconds. Explicit maintenance
    // may optimize only the tables SQLite already identified as useful.
    store.db.run("PRAGMA optimize");
    await store.close({ checkpoint: false });
  } else {
    await store.initialize();
    await store.close();
  }
  parentPort?.postMessage({ ok: true });
} catch (error) {
  try {
    await store.close({ checkpoint: false });
  } catch {
    // Preserve the migration failure as the primary error.
  }
  parentPort?.postMessage({
    ok: false,
    error: {
      name: error?.name ?? "Error",
      message: error?.message ?? String(error),
      code: error?.code ?? null,
      stack: error?.stack ?? null
    }
  });
}
