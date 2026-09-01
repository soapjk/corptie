import { Worker } from "node:worker_threads";

function runStoreWorker(options, operation) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./storeMigrationWorker.mjs", import.meta.url), {
      workerData: {
        dbPath: options.dbPath,
        configPath: options.configPath,
        dataRoot: options.dataRoot,
        operation
      }
    });
    let settled = false;
    worker.once("message", (message) => {
      settled = true;
      if (message?.ok) {
        resolve();
        return;
      }
      const error = new Error(message?.error?.message ?? "Store migration worker failed.");
      error.name = message?.error?.name ?? "Error";
      if (message?.error?.code) error.code = message.error.code;
      if (message?.error?.stack) error.stack = message.error.stack;
      reject(error);
    });
    worker.once("error", (error) => {
      settled = true;
      reject(error);
    });
    worker.once("exit", (code) => {
      if (!settled && code !== 0) reject(new Error(`Store migration worker exited with code ${code}.`));
      if (!settled) reject(new Error("Store migration worker exited without a completion result."));
    });
  });
}

export function migrateStoreOffMainThread(options) {
  return runStoreWorker(options, "migrate");
}

export function optimizeStoreOffMainThread(options) {
  return runStoreWorker(options, "optimize");
}
