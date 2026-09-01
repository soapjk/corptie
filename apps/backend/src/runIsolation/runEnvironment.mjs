import { contractError } from "./receiptContracts.mjs";

export const FORBIDDEN_ENVIRONMENT_KEYS = Object.freeze([
  "HOME", "TMPDIR", "TMP", "TEMP", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "CFFIXED_USER_HOME",
  "CODEX_HOME", "CLAUDE_CONFIG_DIR"
]);

export function buildRunEnvironment(context, inherited = process.env) {
  for (const key of FORBIDDEN_ENVIRONMENT_KEYS) {
    if (Object.hasOwn(context.environmentOverrides ?? {}, key)) throw contractError("RUN_GLOBAL_PATH_FORBIDDEN", `${key} cannot be overridden by RunIsolation.`);
  }
  const values = {
    CORPTIE_RUN_MODE: context.mode, CORPTIE_RUN_ID: context.runId, CORPTIE_LOGICAL_SESSION_ID: context.logicalSessionId,
    CORPTIE_TASK_ID: context.taskId, CORPTIE_REPOSITORY_ID: context.repositoryId,
    CORPTIE_WORKTREE_ID: context.worktreeId, CORPTIE_SOURCE_FINGERPRINT: context.sourceFingerprint,
    CORPTIE_DATA_DIR: context.dataDir, CORPTIE_DATABASE_PATH: context.databasePath, CORPTIE_CACHE_DIR: context.cacheDir,
    CORPTIE_INDEX_DIR: context.indexDir, CORPTIE_TMP_DIR: context.tmpDir, CORPTIE_LOG_DIR: context.logDir,
    CORPTIE_UPLOAD_DIR: context.uploadDir, CORPTIE_QUEUE_DIR: context.queueDir, CORPTIE_RUNTIME_DIR: context.runtimeDir,
    CORPTIE_USER_DEFAULTS_SUITE: context.userDefaultsSuite, CORPTIE_BACKEND_HOST: context.backendHost,
    CORPTIE_BACKEND_PORT: String(context.backendPort), CORPTIE_BACKEND_LISTEN_FD: String(context.backendListenFD),
    CORPTIE_RUN_TOKEN: context.runToken, CORPTIE_LEASE_FENCE: String(context.fencingToken)
  };
  const environment = { ...inherited, ...(context.environmentOverrides ?? {}) };
  for (const [key, value] of Object.entries(values)) {
    if (value === null || value === undefined) delete environment[key]; else environment[key] = String(value);
  }
  return Object.freeze(environment);
}
