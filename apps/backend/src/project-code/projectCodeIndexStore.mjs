import { constants } from "node:fs";
import { access, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { contractError, hashCanonical, sha256Hex } from "./projectCodeContracts.mjs";

const CATALOG_SCHEMA = 1;
const TEXT_SYMBOL_SCHEMA = 1;

export class ProjectCodeIndexStore {
  constructor(options = {}) {
    if (typeof options.dataRoot !== "string" || !options.dataRoot.trim()) throw new TypeError("ProjectCodeIndexStore requires dataRoot.");
    this.dataRoot = resolve(options.dataRoot);
    this.requireExternal = options.requireExternal !== false;
    this.maxBytes = options.maxBytes ?? 8 * 1024 * 1024 * 1024;
    this.singleFlights = new Map();
    this.latestCatalogByWorktree = new Map();
    this.latestTextByWorktree = new Map();
    this.io = options.io ?? {};
    this.stats = { opens: 0, builds: 0, l1Builds: 0, l2Builds: 0 };
  }

  async ensureLayer(snapshot, layer, options = {}) {
    if (layer !== "L1" && layer !== "L2") throw new TypeError(`Unsupported index layer ${layer}.`);
    const key = `${snapshot.receipt.sourceFingerprint}:${layer}`;
    if (!this.singleFlights.has(key)) {
      this.singleFlights.set(key, this.#ensureLayer(snapshot, layer, options).finally(() => this.singleFlights.delete(key)));
    }
    return this.singleFlights.get(key);
  }

  async readLayer(snapshot, layer) {
    await this.#verifyDataRoot();
    this.stats.opens += 1;
    const directory = this.#snapshotDirectory(snapshot);
    const name = layer === "L1" ? "catalog.json" : "text-symbol.json";
    try {
      return JSON.parse(await readFile(join(directory, name), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw dataRootError(error);
    }
  }

  snapshotDirectory(snapshot) {
    return this.#snapshotDirectory(snapshot);
  }

  async #ensureLayer(snapshot, layer, options) {
    throwIfAborted(options.signal);
    await this.#verifyDataRoot();
    const existing = await this.readLayer(snapshot, layer);
    if (existing) return Object.freeze({ index: existing, indexHit: true, incremental: true });
    if (layer === "L2") await this.ensureLayer(snapshot, "L1", options);
    this.stats.builds += 1;
    this.stats[layer === "L1" ? "l1Builds" : "l2Builds"] += 1;
    const directory = this.#snapshotDirectory(snapshot);
    const staging = `${directory}.staging-${process.pid}-${randomUUID()}`;
    try {
      await mkdir(staging, { recursive: true, mode: 0o700 });
      await atomicJson(join(staging, "journal.json"), { phase: "staging", layer, sourceFingerprint: snapshot.receipt.sourceFingerprint });
      const layerOptions = layer === "L1"
        ? { ...options, previousCatalog: this.latestCatalogByWorktree.get(snapshot.receipt.worktreeId) ?? null }
        : { ...options, previousIndex: options.previousIndex ?? this.latestTextByWorktree.get(snapshot.receipt.worktreeId) ?? null };
      const value = layer === "L1"
        ? await buildCatalog(snapshot, layerOptions)
        : await buildTextSymbol(snapshot, await this.readLayer(snapshot, "L1"), layerOptions);
      const fileName = layer === "L1" ? "catalog.json" : "text-symbol.json";
      await atomicJson(join(staging, fileName), value);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await rename(join(staging, fileName), join(directory, fileName));
      await rename(join(staging, "journal.json"), join(directory, "journal.json"));
      await rm(staging, { recursive: true, force: true });
      await this.#writeManifest(snapshot, layer, value);
      await atomicJson(join(directory, "journal.json"), { phase: "ready", layer, sourceFingerprint: snapshot.receipt.sourceFingerprint, generationHash: value.generationHash });
      if (layer === "L1") this.latestCatalogByWorktree.set(snapshot.receipt.worktreeId, value);
      else this.latestTextByWorktree.set(snapshot.receipt.worktreeId, {
        documentsByHash: new Map(value.documents.map((document) => [document.contentHash, document]))
      });
      await this.#enforceCapacity();
      return Object.freeze({ index: value, indexHit: false, incremental: value.reusedFileCount > 0 });
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      if (error?.name === "AbortError") throw error;
      throw dataRootError(error);
    }
  }

  async #writeManifest(snapshot, layer, value) {
    const directory = this.#snapshotDirectory(snapshot);
    let manifest = {};
    try { manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")); } catch {}
    manifest = {
      schemaVersion: 4,
      repositoryId: snapshot.receipt.repositoryId,
      worktreeId: snapshot.receipt.worktreeId,
      sourceFingerprint: snapshot.receipt.sourceFingerprint,
      layers: { ...(manifest.layers ?? {}), [layer]: value.generationHash },
      updatedAt: new Date().toISOString()
    };
    await atomicJson(join(directory, "manifest.json"), manifest);
  }

  async #verifyDataRoot() {
    try {
      const root = await realpath(this.dataRoot);
      if (this.requireExternal && process.platform === "darwin" && !root.startsWith("/Volumes/")) {
        throw contractError("DATA_ROOT_UNAVAILABLE", "Project-code indexes require a configured external dataRoot.", 503);
      }
      await access(root, constants.R_OK | constants.W_OK);
      return root;
    } catch (error) {
      throw dataRootError(error);
    }
  }

  #snapshotDirectory(snapshot) {
    const repositoryHash = sha256Hex(Buffer.from(snapshot.receipt.repositoryId));
    const worktreeHash = sha256Hex(Buffer.from(snapshot.receipt.worktreeId));
    return join(this.dataRoot, "indexes", "project-code", "v4", "repositories", repositoryHash,
      "worktrees", worktreeHash, "snapshots", snapshot.receipt.sourceFingerprint);
  }

  async #enforceCapacity() {
    const root = join(this.dataRoot, "indexes", "project-code", "v4");
    const bytes = await directoryBytes(root).catch(() => 0);
    if (bytes > this.maxBytes) throw contractError("REPOSITORY_LIMIT", "Project-code index capacity limit was exceeded.", 413);
  }
}

async function buildCatalog(snapshot, options = {}) {
  const files = [];
  let reusedFileCount = 0;
  const previousByPath = new Map((options.previousCatalog?.files ?? []).map((file) => [file.path, file]));
  const changedPaths = new Set((snapshot.overlayEntries ?? []).flatMap((entry) => [entry.path, entry.oldPath].filter(Boolean)));
  for (const candidate of snapshot.candidates) {
    throwIfAborted(options.signal);
    if (candidate.byteLength > (options.maxFileBytes ?? 1024 * 1024)) continue;
    const previous = previousByPath.get(candidate.path);
    if (previous && !changedPaths.has(candidate.path) && previous.byteLength === candidate.byteLength) {
      files.push(previous);
      reusedFileCount += 1;
    } else {
      const content = await stableRead(candidate.absolutePath);
      files.push({ path: candidate.path, language: candidate.language, byteLength: content.byteLength, contentHash: sha256Hex(content) });
    }
  }
  files.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  const generationHash = hashCanonical({ schema: CATALOG_SCHEMA, files });
  return Object.freeze({
    schemaVersion: CATALOG_SCHEMA,
    sourceFingerprint: snapshot.receipt.sourceFingerprint,
    files,
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.byteLength, 0),
    reusedFileCount,
    generationHash
  });
}

async function buildTextSymbol(snapshot, catalog, options = {}) {
  const documents = [];
  let reusedFileCount = 0;
  const previous = options.previousIndex?.documentsByHash ?? new Map();
  for (const file of catalog.files) {
    throwIfAborted(options.signal);
    const cached = previous.get?.(file.contentHash);
    if (cached) {
      documents.push({ ...cached, path: file.path });
      reusedFileCount += 1;
      continue;
    }
    const candidate = snapshot.candidates.find((entry) => entry.path === file.path);
    const text = (await stableRead(candidate.absolutePath)).toString("utf8");
    documents.push({
      path: file.path,
      language: file.language,
      contentHash: file.contentHash,
      tokens: tokenize(text),
      symbols: extractSymbols(text, file.language)
    });
  }
  const serializable = { schemaVersion: TEXT_SYMBOL_SCHEMA, sourceFingerprint: snapshot.receipt.sourceFingerprint, documents, reusedFileCount };
  return Object.freeze({ ...serializable, generationHash: hashCanonical(serializable) });
}

export function queryTextSymbolIndex(index, query, options = {}) {
  const needle = query.normalize("NFC").toLocaleLowerCase("en-US");
  const queryTokens = tokenize(needle);
  const results = [];
  for (const document of index?.documents ?? []) {
    throwIfAborted(options.signal);
    for (const symbol of document.symbols) {
      const normalized = symbol.name.toLocaleLowerCase("en-US");
      if (normalized === needle || normalized.includes(needle)) {
        results.push({ path: document.path, line: symbol.line, symbol: symbol.name, kind: symbol.kind, score: normalized === needle ? 1 : 0.88, snippet: symbol.snippet });
      }
    }
    const overlap = queryTokens.filter((token) => document.tokens.includes(token)).length;
    if (overlap > 0) {
      results.push({ path: document.path, line: 1, symbol: null, kind: "text", score: Math.min(0.8, overlap / Math.max(queryTokens.length, 1)), snippet: "" });
    }
  }
  return deduplicateResults(results).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, options.limit ?? 50);
}

function tokenize(text) {
  return Array.from(new Set(String(text).normalize("NFC").toLocaleLowerCase("en-US").match(/[\p{L}\p{N}_]{2,}/gu) ?? [])).slice(0, 20_000);
}

function extractSymbols(text, language) {
  const patterns = language === "swift"
    ? [[/\b(class|struct|enum|protocol|func|var|let)\s+([\p{L}_][\p{L}\p{N}_]*)/gu, { func: "function", var: "property", let: "property" }]]
    : [[/\b(class|interface|enum|function|const|let|var|def|fn|func)\s+([\p{L}_$][\p{L}\p{N}_$]*)/gu, { def: "function", fn: "function", func: "function", const: "property", let: "property", var: "property", interface: "protocol" }]];
  const symbols = [];
  for (const [pattern, mapping] of patterns) {
    for (const match of text.matchAll(pattern)) {
      const prefix = text.slice(0, match.index);
      const line = prefix.split("\n").length;
      const declaration = match[1];
      symbols.push({ name: match[2], kind: mapping[declaration] ?? declaration, line, snippet: lineAt(text, line) });
    }
  }
  return symbols;
}

function lineAt(text, line) {
  return (text.split(/\r?\n/)[line - 1] ?? "").trim().slice(0, 240);
}

function deduplicateResults(results) {
  const seen = new Set();
  return results.filter((result) => {
    const key = `${result.path}\0${result.line}\0${result.symbol}\0${result.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function stableRead(path) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = await handle.stat();
      const content = await handle.readFile();
      const after = await handle.stat();
      if (before.ino === after.ino && before.dev === after.dev && before.size === after.size && before.mtimeMs === after.mtimeMs) return content;
    } finally { await handle.close(); }
  }
  throw contractError("SOURCE_SNAPSHOT_STALE", "Source changed while an index generation was being built.");
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${randomUUID()}`);
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}

async function directoryBytes(root) {
  let bytes = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    bytes += entry.isDirectory() ? await directoryBytes(path) : (await stat(path)).size;
  }
  return bytes;
}

function dataRootError(error) {
  if (error?.code === "REPOSITORY_LIMIT" || error?.code === "DATA_ROOT_UNAVAILABLE") return error;
  const wrapped = contractError("DATA_ROOT_UNAVAILABLE", "The configured external dataRoot is unavailable for project-code indexes.", 503);
  wrapped.causeCode = error?.code ?? "UNKNOWN";
  return wrapped;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error("Project-code index operation was cancelled.");
  error.name = "AbortError";
  error.code = "QUERY_CANCELLED";
  throw error;
}
