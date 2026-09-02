import { parentPort, workerData } from "node:worker_threads";

const { CorptieStore } = await import("./corptieStore.mjs");

const store = new CorptieStore({
  dbPath: workerData.dbPath,
  configPath: workerData.configPath,
  dataRoot: workerData.dataRoot,
  manageProcessEnvironment: false
});

try {
  await store.initialize({
    resolveDataPath: false,
    performMigrations: false,
    readOnly: true,
    readCacheSizeKiB: workerData.readCacheSizeKiB,
    readMmapSizeBytes: workerData.readMmapSizeBytes
  });
  parentPort?.postMessage({ type: "ready" });
} catch (error) {
  parentPort?.postMessage({ type: "fatal", error: serializeError(error) });
}

parentPort?.on("message", (message) => {
  const requestId = message?.requestId;
  if (!requestId) return;
  try {
    const result = readInOneSnapshot(() => execute(message.operation, message.input ?? {}));
    // Timeline windows contain deeply nested presentation metadata. Letting
    // Worker postMessage recursively structured-clone those objects is orders
    // of magnitude slower than the indexed SQLite read. JSON is also the HTTP
    // wire format, so encode once and transfer ownership of the byte buffer.
    const payload = new TextEncoder().encode(JSON.stringify(result));
    parentPort?.postMessage({ type: "result", requestId, payload }, [payload.buffer]);
  } catch (error) {
    parentPort?.postMessage({ type: "result", requestId, error: serializeError(error) });
  }
});

function execute(operation, input) {
  switch (operation) {
    case "storedTimelineSnapshot": {
      const window = store.getLatestTimelineItemWindow(input.sessionId, {
        limit: input.limit,
        provider: input.provider
      });
      return {
        window,
        timelineRevision: store.sessionTimelineRevision(input.sessionId),
        lastEventSequence: store.lastSessionEventSequence(input.sessionId),
        lastAgentMessageSequence: store.lastAgentMessageSequence(input.sessionId)
      };
    }
    case "timelineHistoryPage":
      return store.getSessionTimelineHistoryPage(input.sessionId, {
        beforeId: input.beforeId,
        limit: input.limit,
        provider: input.provider
      });
    case "timelineWindow": {
      const window = input.anchorId
        ? store.getTimelineItemWindow(input.sessionId, {
          anchorKind: input.anchorKind,
          anchorId: input.anchorId,
          before: input.before,
          after: input.after,
          provider: input.provider
        })
        : store.getLatestTimelineItemWindow(input.sessionId, {
          limit: input.limit,
          provider: input.provider
        });
      return {
        window,
        timelineRevision: store.sessionTimelineRevision(input.sessionId)
      };
    }
    case "timelineChanges":
      return store.sessionTimelineChangesAfter(input.sessionId, input.after, input.limit);
    default: {
      const error = new Error(`Unsupported Timeline read operation: ${operation}`);
      error.code = "TIMELINE_READ_OPERATION_UNSUPPORTED";
      throw error;
    }
  }
}

function readInOneSnapshot(operation) {
  store.db.run("BEGIN DEFERRED");
  try {
    const result = operation();
    store.db.run("COMMIT");
    return result;
  } catch (error) {
    try {
      store.db.run("ROLLBACK");
    } catch {
      // Preserve the read failure.
    }
    throw error;
  }
}

function serializeError(error) {
  return {
    name: error?.name ?? "Error",
    message: error?.message ?? String(error),
    code: error?.code ?? null,
    statusCode: error?.statusCode ?? null,
    stack: error?.stack ?? null
  };
}
