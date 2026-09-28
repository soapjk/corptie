import { readFileSync } from "node:fs";
import { access, copyFile, cp, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import os from "node:os";
import { atomicWriteJson, defaultCorptieDataRoot, ensureDataRootLayout, resolveDataRootLayout } from "../runtime/dataRootLayout.mjs";
import { DEPRECATED_PATH_FIELDS } from "./storeSettings.mjs";
import { storeDomainError } from "./validation.mjs";

export const environmentName = normalizeEnvironment(process.env.CORPTIE_ENV);
const appSupportName = environmentName === "development" ? "Corptie Development" : "Corptie";
const legacyAppSupportName = environmentName === "development" ? "Copets Development" : "Copets";
const appSupportDir = join(os.homedir(), "Library", "Application Support", appSupportName);
const legacyAppSupportDir = join(os.homedir(), "Library", "Application Support", legacyAppSupportName);
const legacyDbPath = join(legacyAppSupportDir, "copets.sqlite");
const legacyCurrentConfigPath = join(appSupportDir, "config.json");
const legacyConfigPath = join(legacyAppSupportDir, "config.json");
const fallbackLogDir = join(os.homedir(), "Library", "Logs", appSupportName);
const rootSelectionPath = join(appSupportDir, "data-root.json");

// Owns data/configuration paths and legacy filesystem migration, not SQLite.
export class StoreDataLocation {
  constructor(options = {}) {
    const isolatedPaths = resolveRunIsolationStorePaths(process.env);
    this.explicitPaths = Boolean(options.dbPath || options.configPath || isolatedPaths);
    this.manageProcessEnvironment = options.manageProcessEnvironment !== false;
    this.dataRootExplicit = Boolean(
      options.dataRoot
      || process.env.CORPTIE_DATA_ROOT
      || process.env.CORPTIE_DATA_ROOT_SELECTION_PATH
    );
    this.rootSelectionPath = options.rootSelectionPath
      || process.env.CORPTIE_DATA_ROOT_SELECTION_PATH
      || rootSelectionPath;
    this.configPath = options.configPath || isolatedPaths?.configPath || null;
    this.dataRoot = options.dataRoot
      || process.env.CORPTIE_DATA_ROOT
      || readConfiguredDataRootSync(this.rootSelectionPath)
      || defaultCorptieDataRoot();
    if (!this.explicitPaths && this.manageProcessEnvironment) process.env.CORPTIE_HOME = resolve(this.dataRoot);
    this.layout = null;
    this.dataDir = null;
    this.dbPath = options.dbPath || isolatedPaths?.dbPath || process.env.CORPTIE_DB_PATH || null;
    this.config = {};
  }

  async resolveDataPath() {
    if (this.explicitPaths && this.dbPath) {
      this.dataDir = dirname(this.dbPath);
      // The migration Worker receives the canonical Data Root explicitly so
      // schema seed/default paths remain identical to an in-process migration.
      // Standalone Stores that specify only a DB retain the dirname behavior.
      this.dataRoot = this.dataRootExplicit ? resolve(this.dataRoot) : this.dataDir;
      this.layout = resolveDataRootLayout(this.dataRoot, environmentName);
      this.configPath ||= join(this.dataDir, "config.json");
      return;
    }

    const legacy = await this.readRootSelectionAndLegacyConfig();
    this.dataRoot = resolve(
      this.dataRoot
        || legacy.selection?.dataRoot
        || legacy.config?.dataRoot
        || legacy.config?.dataDir
        || defaultCorptieDataRoot()
    );
    this.layout = resolveDataRootLayout(this.dataRoot, environmentName);
    this.dataDir = this.layout.environmentRoot;
    this.dbPath = this.layout.databasePath;
    this.configPath = this.layout.configPath;
    if (this.manageProcessEnvironment) process.env.CORPTIE_HOME = this.dataRoot;
    await ensureDataRootLayout(this.layout);
    await this.migrateLegacyPaths(legacy.config ?? {});
    try {
      this.config = JSON.parse(await readFile(this.configPath, "utf8"));
    } catch {
      this.config = legacy.config ?? {};
    }
    for (const field of DEPRECATED_PATH_FIELDS) delete this.config[field];
    this.config.dataRoot = this.dataRoot;
    await this.writeConfig();
    await this.writeRootSelection();
  }

  async readRootSelectionAndLegacyConfig() {
    const selection = await readJsonFile(this.rootSelectionPath);
    const config = await readJsonFile(legacyCurrentConfigPath) ?? await readJsonFile(legacyConfigPath) ?? {};
    return { selection, config };
  }

  async migrateLegacyPaths(config) {
    if (await exists(this.dbPath)) return;
    if (this.dataRootExplicit) return;
    const configuredDataDir = typeof config.dataDir === "string" && config.dataDir.trim()
      ? resolve(config.dataDir.trim())
      : null;
    const databaseCandidates = [
      configuredDataDir ? join(configuredDataDir, "corptie.sqlite") : null,
      configuredDataDir ? join(configuredDataDir, "copets.sqlite") : null,
      join(appSupportDir, "corptie.sqlite"),
      join(appSupportDir, "copets.sqlite"),
      legacyDbPath
    ].filter(Boolean);
    const sourceDatabase = await firstExisting(databaseCandidates);
    if (sourceDatabase && resolve(sourceDatabase) !== resolve(this.dbPath)) {
      await copyFile(sourceDatabase, this.dbPath);
    }

    const configuredLogDir = typeof config.logDir === "string" && config.logDir.trim()
      ? resolve(config.logDir.trim())
      : fallbackLogDir;
    if (resolve(configuredLogDir) !== resolve(this.layout.logsDirectory)
      && await exists(configuredLogDir)
      && (await readdir(this.layout.logsDirectory)).length === 0) {
      await cp(configuredLogDir, this.layout.logsDirectory, { recursive: true, force: false });
    }
  }

  async writeConfig() {
    await atomicWriteJson(this.configPath, {
      ...this.config,
      dataRoot: this.dataRoot
    });
  }

  async writeRootSelection() {
    if (this.explicitPaths) return;
    const current = await readJsonFile(this.rootSelectionPath) ?? {};
    await atomicWriteJson(this.rootSelectionPath, { ...current, dataRoot: this.dataRoot });
  }

  logDirectory() {
    return this.layout?.logsDirectory ?? join(this.dataDir, "logs");
  }

  logPaths() {
    const directory = this.logDirectory();
    return {
      stdout: join(directory, "backend.out.log"),
      stderr: join(directory, "backend.err.log")
    };
  }
}

function normalizeEnvironment(value = "") {
  const normalized = String(value || "").toLowerCase();
  return normalized === "dev" || normalized === "development" ? "development" : "production";
}

export function resolveRunIsolationStorePaths(environment = {}) {
  const runId = environment.CORPTIE_RUN_ID;
  if (!runId) return null;
  const mode = environment.CORPTIE_RUN_MODE;
  if (!["development", "test"].includes(mode)) throw storeDomainError("RUN_CONTEXT_SCHEMA_UNSUPPORTED", "Isolated Store requires a valid CORPTIE_RUN_MODE.", 409);
  const required = ["CORPTIE_DATABASE_PATH", "CORPTIE_DATA_DIR", "CORPTIE_CACHE_DIR", "CORPTIE_TMP_DIR", "CORPTIE_LOG_DIR", "CORPTIE_UPLOAD_DIR", "CORPTIE_QUEUE_DIR", "CORPTIE_RUNTIME_DIR"];
  for (const key of required) if (typeof environment[key] !== "string" || !environment[key].trim()) throw storeDomainError("RUN_PATH_MISSING", `${key} is required before Store initialization.`, 409);
  const dbPath = resolve(environment.CORPTIE_DATABASE_PATH);
  const runRoot = dirname(dirname(dbPath));
  for (const key of required) {
    const candidate = resolve(environment[key]);
    if (candidate !== runRoot && !candidate.startsWith(`${runRoot}${sep}`)) throw storeDomainError("RUN_PATH_OUT_OF_BOUNDS", `${key} escapes the isolated run root.`, 409);
  }
  const forbidden = [resolve(os.homedir()), resolve("/tmp"), resolve("/private/tmp")];
  if (forbidden.some((root) => runRoot === root || runRoot.startsWith(`${root}${sep}`))) throw storeDomainError("RUN_GLOBAL_PATH_FORBIDDEN", "Isolated Store cannot use HOME or system tmp.", 409);
  return { dbPath, configPath: join(resolve(environment.CORPTIE_DATA_DIR), "config.json"), runRoot };
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile(path) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function readConfiguredDataRootSync(path) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return typeof value?.dataRoot === "string" && value.dataRoot.trim() ? value.dataRoot.trim() : null;
  } catch {
    for (const configPath of [legacyCurrentConfigPath, legacyConfigPath]) {
      try {
        const legacy = JSON.parse(readFileSync(configPath, "utf8"));
        const value = legacy?.dataRoot ?? legacy?.dataDir;
        if (typeof value !== "string" || !value.trim()) continue;
        const configured = resolve(value.trim());
        if (configured === resolve(appSupportDir) || configured === resolve(legacyAppSupportDir)) {
          return defaultCorptieDataRoot();
        }
        return configured;
      } catch {}
    }
    return null;
  }
}

async function firstExisting(paths) {
  for (const path of paths) {
    if (await exists(path)) return path;
  }
  return null;
}
