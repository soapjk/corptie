import { constants } from "node:fs";
import { access, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { contractError, hashCanonical, sha256Hex } from "./projectCodeContracts.mjs";

const CATALOG_SCHEMA = 1;
const TEXT_SYMBOL_SCHEMA = 5;
const RANKING_VERSION = "project-code-ranking/v2";
const MAX_OPEN_QUERY_GENERATIONS = 16;
const queryConnections = new Map();

export class ProjectCodeIndexStore {
  constructor(options = {}) {
    if (typeof options.dataRoot !== "string" || !options.dataRoot.trim()) throw new TypeError("ProjectCodeIndexStore requires dataRoot.");
    this.dataRoot = resolve(options.dataRoot);
    this.requireExternal = options.requireExternal !== false;
    this.maxBytes = options.maxBytes ?? 8 * 1024 * 1024 * 1024;
    this.maxCachedWorktrees = options.maxCachedWorktrees ?? 32;
    this.maxLoadedGenerations = options.maxLoadedGenerations ?? 4;
    this.singleFlights = new Map();
    this.loadedLayers = new Map();
    this.latestCatalogByWorktree = new Map();
    this.latestTextByWorktree = new Map();
    this.io = options.io ?? {};
    this.initialization = null;
    this.readiness = Object.freeze({ status: "uninitialized", code: null });
    this.stats = { opens: 0, builds: 0, l1Builds: 0, l2Builds: 0 };
  }

  async initialize() {
    if (!this.initialization) {
      this.initialization = this.#initialize().catch((error) => {
        this.readiness = Object.freeze({ status: "unavailable", code: error?.code ?? "DATA_ROOT_UNAVAILABLE" });
        throw error;
      });
    }
    return this.initialization;
  }

  getReadiness() {
    return this.readiness;
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
    await this.initialize();
    const cacheKey = `${snapshot.receipt.sourceFingerprint}:${layer}`;
    const cached = this.loadedLayers.get(cacheKey);
    if (cached) {
      this.loadedLayers.delete(cacheKey);
      this.loadedLayers.set(cacheKey, cached);
      return cached;
    }
    this.stats.opens += 1;
    const directory = this.#snapshotDirectory(snapshot);
    const name = layer === "L1" ? "catalog.json" : "text-symbol.json";
    try {
      const value = JSON.parse(await readFile(join(directory, name), "utf8"));
      if (layer === "L2") {
        const databasePath = join(directory, "lexical.sqlite");
        await access(databasePath, constants.R_OK);
        const loaded = Object.freeze({ ...value, databasePath });
        lruSet(this.loadedLayers, cacheKey, loaded, this.maxLoadedGenerations);
        return loaded;
      }
      lruSet(this.loadedLayers, cacheKey, value, this.maxLoadedGenerations);
      return value;
    } catch (error) {
      if (error?.code === "ENOENT") return this.#readLegacyLayer(snapshot, layer);
      throw dataRootError(error);
    }
  }

  async #readLegacyLayer(snapshot, layer) {
    const name = layer === "L1" ? "catalog.json" : "text-symbol.json";
    try {
      return JSON.parse(await readFile(join(this.#legacySnapshotDirectory(snapshot), name), "utf8"));
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
    await this.initialize();
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
      await this.#reserveCapacity(value, layer);
      await atomicJson(join(staging, fileName), value);
      if (layer === "L2") writeLexicalDatabase(join(staging, "lexical.sqlite"), value);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if (layer === "L2") await rename(join(staging, "lexical.sqlite"), join(directory, "lexical.sqlite"));
      await rename(join(staging, fileName), join(directory, fileName));
      await rename(join(staging, "journal.json"), join(directory, "journal.json"));
      await rm(staging, { recursive: true, force: true });
      await this.#writeManifest(snapshot, layer, value);
      await atomicJson(join(directory, "journal.json"), { phase: "ready", layer, sourceFingerprint: snapshot.receipt.sourceFingerprint, generationHash: value.generationHash });
      if (layer === "L1") lruSet(this.latestCatalogByWorktree, snapshot.receipt.worktreeId, value, this.maxCachedWorktrees);
      else lruSet(this.latestTextByWorktree, snapshot.receipt.worktreeId, {
        documentsByHash: new Map(value.documents.map((document) => [document.contentHash, document]))
      }, this.maxCachedWorktrees);
      const index = layer === "L2" ? Object.freeze({ ...value, databasePath: join(directory, "lexical.sqlite") }) : value;
      lruSet(this.loadedLayers, `${snapshot.receipt.sourceFingerprint}:${layer}`, index, this.maxLoadedGenerations);
      return Object.freeze({ index, indexHit: false, incremental: value.reusedFileCount > 0 });
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
      schemaVersion: 5,
      repositoryId: snapshot.receipt.repositoryId,
      worktreeId: snapshot.receipt.worktreeId,
      sourceFingerprint: snapshot.receipt.sourceFingerprint,
      layers: { ...(manifest.layers ?? {}), [layer]: value.generationHash },
      updatedAt: new Date().toISOString()
    };
    await atomicJson(join(directory, "manifest.json"), manifest);
  }

  async #initialize() {
    try {
      const parent = await realpath(dirname(this.dataRoot));
      if (this.requireExternal && process.platform === "darwin" && !parent.startsWith("/Volumes/")) {
        throw contractError("DATA_ROOT_UNAVAILABLE", "Project-code indexes require a configured external dataRoot.", 503);
      }
      await access(parent, constants.R_OK | constants.W_OK);
      try {
        const before = await lstat(this.dataRoot);
        if (before.isSymbolicLink()) throw contractError("DATA_ROOT_UNAVAILABLE", "The project-code index root cannot be a symbolic link.", 503);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      await mkdir(this.dataRoot, { recursive: true, mode: 0o700 });
      const root = await realpath(this.dataRoot);
      const parentPrefix = `${parent}/`;
      if (root !== parent && !root.startsWith(parentPrefix)) {
        throw contractError("DATA_ROOT_UNAVAILABLE", "The project-code index root escaped its configured dataRoot.", 503);
      }
      const info = await lstat(root);
      if (!info.isDirectory() || info.isSymbolicLink()) throw contractError("DATA_ROOT_UNAVAILABLE", "The project-code index root is invalid.", 503);
      await access(root, constants.R_OK | constants.W_OK);
      this.readiness = Object.freeze({ status: "ready", canonicalRoot: root, code: null });
      return this.readiness;
    } catch (error) {
      throw dataRootError(error);
    }
  }

  #snapshotDirectory(snapshot) {
    const repositoryHash = sha256Hex(Buffer.from(snapshot.receipt.repositoryId));
    const worktreeHash = sha256Hex(Buffer.from(snapshot.receipt.worktreeId));
    return join(this.dataRoot, "indexes", "project-code", "v5", "repositories", repositoryHash,
      "worktrees", worktreeHash, "generations", snapshot.receipt.sourceFingerprint);
  }

  #legacySnapshotDirectory(snapshot) {
    const repositoryHash = sha256Hex(Buffer.from(snapshot.receipt.repositoryId));
    const worktreeHash = sha256Hex(Buffer.from(snapshot.receipt.worktreeId));
    return join(this.dataRoot, "indexes", "project-code", "v4", "repositories", repositoryHash,
      "worktrees", worktreeHash, "snapshots", snapshot.receipt.sourceFingerprint);
  }

  async #reserveCapacity(value, layer) {
    const root = join(this.dataRoot, "indexes", "project-code", "v5");
    const current = await directoryBytes(root).catch(() => 0);
    const serialized = Buffer.byteLength(JSON.stringify(value));
    const estimate = layer === "L2" ? serialized * 3 : serialized;
    if (current + estimate > this.maxBytes) {
      throw contractError("REPOSITORY_LIMIT", "Project-code index capacity limit was exceeded before generation publication.", 413);
    }
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
    const indexed = indexSourceFile(text, file.path, file.language);
    documents.push({
      path: file.path,
      language: file.language,
      contentHash: file.contentHash,
      ...indexed
    });
  }
  const serializable = {
    schemaVersion: TEXT_SYMBOL_SCHEMA,
    rankingVersion: RANKING_VERSION,
    sourceFingerprint: snapshot.receipt.sourceFingerprint,
    languageIndexerVersions: Object.fromEntries([...new Set(documents.map((document) => document.language))].map((language) => [language, "regex-fallback/v2"])),
    documents,
    fileCount: documents.length,
    reusedFileCount
  };
  return Object.freeze({ ...serializable, generationHash: hashCanonical(serializable) });
}

export function queryTextSymbolIndex(index, query, options = {}) {
  throwIfAborted(options.signal);
  if (!index?.databasePath) return queryLegacyTextSymbolIndex(index, query, options);
  const statements = queryStatements(index.databasePath);
  const needle = queryIdentifier(query);
  const tokens = options.includeText === true ? expandQueryTokens(query) : [];
  const results = [];
  let symbolRows = statements.symbolExact.all(needle);
  if (symbolRows.length === 0) symbolRows = statements.symbolPrefix.all(`${needle}%`);
  for (const row of symbolRows) results.push(resultFromRow(row, row.normalized_name === needle ? 1 : 0.92));
  const wantsCalls = /(?:caller|usage|uses|调用|谁调用)/iu.test(query);
  if (wantsCalls || symbolRows.length === 0) {
    let callRows = statements.callExact.all(needle);
    if (callRows.length === 0) callRows = statements.callPrefix.all(`${needle}%`);
    for (const row of callRows) results.push(resultFromRow(row, wantsCalls ? 0.96 : 0.84));
  }
  if (/(?:import|dependency|depends|引用|依赖)/iu.test(query) || symbolRows.length === 0) {
    let importRows = statements.importExact.all(needle);
    if (importRows.length === 0) importRows = statements.importContains.all(`%${needle}%`);
    for (const row of importRows) results.push(resultFromRow(row, 0.8));
  }
  if (tokens.length > 0) {
    const match = tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ");
    const rows = statements.fts.all(match);
    for (const row of rows) results.push(resultFromRow(row, Math.max(0.3, Math.min(0.78, 0.76 - Number(row.rank ?? 0) / 100))));
  }
  return deduplicateResults(results).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line).slice(0, options.limit ?? 50);
}

export function closeProjectCodeQueryConnections() {
  for (const { database } of queryConnections.values()) database.close();
  queryConnections.clear();
}

function queryStatements(databasePath) {
  const cached = queryConnections.get(databasePath);
  if (cached) {
    queryConnections.delete(databasePath);
    queryConnections.set(databasePath, cached);
    return cached.statements;
  }
  const database = new DatabaseSync(databasePath, { readOnly: true });
  database.exec("PRAGMA query_only=ON; PRAGMA cache_size=-8192; PRAGMA mmap_size=268435456;");
  const statements = Object.freeze({
    symbolExact: database.prepare(`SELECT f.path,s.start_line AS line,s.name AS symbol,s.kind,s.snippet,s.normalized_name
      FROM symbols s JOIN files f ON f.file_id=s.file_id WHERE s.normalized_name=? LIMIT 100`),
    symbolPrefix: database.prepare(`SELECT f.path,s.start_line AS line,s.name AS symbol,s.kind,s.snippet,s.normalized_name
      FROM symbols s JOIN files f ON f.file_id=s.file_id WHERE s.normalized_name LIKE ? LIMIT 100`),
    callExact: database.prepare(`SELECT f.path,c.line,NULL AS symbol,'call' AS kind,c.snippet,c.normalized_callee
      FROM calls c JOIN files f ON f.file_id=c.file_id WHERE c.normalized_callee=? LIMIT 100`),
    callPrefix: database.prepare(`SELECT f.path,c.line,NULL AS symbol,'call' AS kind,c.snippet,c.normalized_callee
      FROM calls c JOIN files f ON f.file_id=c.file_id WHERE c.normalized_callee LIKE ? LIMIT 100`),
    importExact: database.prepare(`SELECT f.path,i.line,NULL AS symbol,'import' AS kind,i.snippet,i.normalized_name
      FROM imports i JOIN files f ON f.file_id=i.file_id WHERE i.normalized_name=? LIMIT 50`),
    importContains: database.prepare(`SELECT f.path,i.line,NULL AS symbol,'import' AS kind,i.snippet,i.normalized_name
      FROM imports i JOIN files f ON f.file_id=i.file_id WHERE i.normalized_name LIKE ? LIMIT 50`),
    fts: database.prepare(`SELECT f.path,l.line,NULL AS symbol,'text' AS kind,l.snippet,lexical_fts.rank AS rank
      FROM lexical_fts JOIN lexical_segments l ON l.segment_id=lexical_fts.rowid
      JOIN files f ON f.file_id=l.file_id
      WHERE lexical_fts MATCH ? AND lexical_fts.rank MATCH 'bm25(5.0,4.0,1.0)'
      ORDER BY lexical_fts.rank LIMIT 100`)
  });
  queryConnections.set(databasePath, { database, statements });
  while (queryConnections.size > MAX_OPEN_QUERY_GENERATIONS) {
    const oldest = queryConnections.keys().next().value;
    queryConnections.get(oldest).database.close();
    queryConnections.delete(oldest);
  }
  return statements;
}

function queryLegacyTextSymbolIndex(index, query, options = {}) {
  const needle = normalizeIdentifier(query);
  const queryTokens = expandQueryTokens(query);
  const results = [];
  for (const document of index?.documents ?? []) {
    for (const symbol of document.symbols ?? []) {
      const normalized = normalizeIdentifier(symbol.name);
      if (normalized === needle || normalized.includes(needle)) results.push({ path: document.path, line: symbol.line ?? symbol.startLine, symbol: symbol.name, kind: symbol.kind, score: normalized === needle ? 1 : 0.88, snippet: symbol.snippet });
    }
    for (const segment of document.segments ?? []) {
      const overlap = queryTokens.filter((token) => segment.tokens.includes(token)).length;
      if (overlap) results.push({ path: document.path, line: segment.line, symbol: null, kind: "text", score: Math.min(0.78, overlap / queryTokens.length), snippet: segment.snippet });
    }
    if (!document.segments && Array.isArray(document.tokens)) {
      const overlap = queryTokens.filter((token) => document.tokens.includes(token)).length;
      if (overlap) results.push({ path: document.path, line: document.symbols?.[0]?.line ?? 1,
        symbol: null, kind: "text", score: Math.min(0.7, overlap / queryTokens.length),
        snippet: document.symbols?.[0]?.snippet ?? "Legacy v4 document match" });
    }
  }
  return deduplicateResults(results).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, options.limit ?? 50);
}

function indexSourceFile(text, path, language) {
  const lines = text.split(/\r?\n/);
  const lineOffsets = sourceLineOffsets(text);
  const symbols = extractSymbols(text, language, lines, lineOffsets);
  const calls = extractCalls(text, symbols, lines, lineOffsets);
  const imports = extractImports(text, lines, lineOffsets);
  const symbolLines = new Set(symbols.map((symbol) => symbol.line));
  const segments = [];
  for (let index = 0; index < lines.length && segments.length < 20_000; index += 1) {
    const snippet = lines[index].trim().slice(0, 240);
    if (!snippet) continue;
    const tokens = normalizeTokens(snippet);
    if (tokens.length === 0) continue;
    segments.push({ line: index + 1, snippet, tokens, symbolTokens: symbolLines.has(index + 1) ? normalizeTokens(snippet) : [] });
  }
  return { symbols, calls, imports, segments, parserQuality: "fallback" };
}

function extractSymbols(text, language, lines, lineOffsets) {
  const patterns = language === "swift"
    ? [[/\b(class|struct|enum|protocol|func|var|let)\s+([\p{L}_][\p{L}\p{N}_]*)/gu, { func: "function", var: "property", let: "property" }]]
    : [[/\b(class|interface|enum|function|const|let|var|def|fn|func)\s+([\p{L}_$][\p{L}\p{N}_$]*)/gu, { def: "function", fn: "function", func: "function", const: "property", let: "property", var: "property", interface: "protocol" }]];
  const symbols = [];
  for (const [pattern, mapping] of patterns) {
    for (const match of text.matchAll(pattern)) {
      const line = lineNumberAtOffset(lineOffsets, match.index);
      const declaration = match[1];
      const name = match[2];
      symbols.push({ name, normalizedName: normalizeIdentifier(name), qualifiedName: null, containerName: null,
        kind: /test/i.test(name) ? "test" : mapping[declaration] ?? declaration,
        line, startLine: line, endLine: null, signature: lineAt(lines, line), snippet: lineAt(lines, line) });
    }
  }
  return symbols;
}

function extractCalls(text, symbols, lines, lineOffsets) {
  const declarationOffsets = new Set(symbols.map((symbol) => `${symbol.line}:${symbol.name}`));
  const calls = [];
  const pattern = /\b([\p{L}_$][\p{L}\p{N}_$]*)\s*\(/gu;
  const ignored = new Set(["if", "for", "while", "switch", "catch", "function", "func", "def", "fn"]);
  for (const match of text.matchAll(pattern)) {
    if (ignored.has(match[1])) continue;
    const line = lineNumberAtOffset(lineOffsets, match.index);
    if (declarationOffsets.has(`${line}:${match[1]}`)) continue;
    calls.push({ calleeName: match[1], normalizedCallee: normalizeIdentifier(match[1]), line, snippet: lineAt(lines, line) });
  }
  return calls.slice(0, 50_000);
}

function extractImports(text, lines, lineOffsets) {
  const imports = [];
  const pattern = /^\s*(?:import|from|use)\s+([^;\n]+)/gmu;
  for (const match of text.matchAll(pattern)) {
    const line = lineNumberAtOffset(lineOffsets, match.index);
    const importedName = match[1].trim().slice(0, 256);
    imports.push({ importedName, normalizedName: normalizeIdentifier(importedName), line, snippet: lineAt(lines, line) });
  }
  return imports;
}

function writeLexicalDatabase(path, index) {
  const database = new DatabaseSync(path);
  try {
    // This database is built in a private staging directory and is not
    // published until integrity_check succeeds, so rollback durability adds
    // latency without protecting an observable generation.
    database.exec(`PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=MEMORY; PRAGMA locking_mode=EXCLUSIVE;
      CREATE TABLE files(file_id INTEGER PRIMARY KEY,path TEXT NOT NULL UNIQUE,language TEXT NOT NULL,content_hash TEXT NOT NULL,byte_length INTEGER NOT NULL DEFAULT 0,line_count INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE symbols(symbol_id INTEGER PRIMARY KEY,file_id INTEGER NOT NULL,name TEXT NOT NULL,normalized_name TEXT NOT NULL,qualified_name TEXT,kind TEXT NOT NULL,container_name TEXT,start_line INTEGER NOT NULL,end_line INTEGER,signature TEXT,snippet TEXT NOT NULL);
      CREATE INDEX symbols_exact ON symbols(normalized_name); CREATE INDEX symbols_file ON symbols(file_id,start_line);
      CREATE TABLE calls(call_id INTEGER PRIMARY KEY,file_id INTEGER NOT NULL,callee_name TEXT NOT NULL,normalized_callee TEXT NOT NULL,line INTEGER NOT NULL,snippet TEXT NOT NULL);
      CREATE INDEX calls_callee ON calls(normalized_callee);
      CREATE TABLE imports(file_id INTEGER NOT NULL,imported_name TEXT NOT NULL,normalized_name TEXT NOT NULL,line INTEGER NOT NULL,snippet TEXT NOT NULL);
      CREATE INDEX imports_name ON imports(normalized_name);
      CREATE TABLE lexical_segments(segment_id INTEGER PRIMARY KEY,file_id INTEGER NOT NULL,line INTEGER NOT NULL,snippet TEXT NOT NULL);
      CREATE VIRTUAL TABLE lexical_fts USING fts5(path_tokens,symbol_tokens,text_tokens,tokenize='unicode61');`);
    const fileInsert = database.prepare("INSERT INTO files(path,language,content_hash,line_count) VALUES(?,?,?,?)");
    const symbolInsert = database.prepare("INSERT INTO symbols(file_id,name,normalized_name,qualified_name,kind,container_name,start_line,end_line,signature,snippet) VALUES(?,?,?,?,?,?,?,?,?,?)");
    const callInsert = database.prepare("INSERT INTO calls(file_id,callee_name,normalized_callee,line,snippet) VALUES(?,?,?,?,?)");
    const importInsert = database.prepare("INSERT INTO imports(file_id,imported_name,normalized_name,line,snippet) VALUES(?,?,?,?,?)");
    const segmentInsert = database.prepare("INSERT INTO lexical_segments(file_id,line,snippet) VALUES(?,?,?)");
    const ftsInsert = database.prepare("INSERT INTO lexical_fts(rowid,path_tokens,symbol_tokens,text_tokens) VALUES(?,?,?,?)");
    database.exec("BEGIN IMMEDIATE");
    for (const document of index.documents) {
      const fileId = Number(fileInsert.run(
        document.path, document.language, document.contentHash, document.segments.at(-1)?.line ?? 0
      ).lastInsertRowid);
      for (const symbol of document.symbols) symbolInsert.run(fileId, symbol.name, symbol.normalizedName, symbol.qualifiedName, symbol.kind, symbol.containerName, symbol.startLine, symbol.endLine, symbol.signature, symbol.snippet);
      for (const call of document.calls) callInsert.run(fileId, call.calleeName, call.normalizedCallee, call.line, call.snippet);
      for (const item of document.imports) importInsert.run(fileId, item.importedName, item.normalizedName, item.line, item.snippet);
      const pathTokens = normalizeTokens(document.path).join(" ");
      for (const segment of document.segments) {
        const segmentId = Number(segmentInsert.run(fileId, segment.line, segment.snippet).lastInsertRowid);
        ftsInsert.run(segmentId, pathTokens, segment.symbolTokens.join(" "), segment.tokens.join(" "));
      }
    }
    database.exec("COMMIT; PRAGMA optimize;");
    const integrity = database.prepare("PRAGMA integrity_check").get();
    if (integrity.integrity_check !== "ok") throw contractError("DATA_ROOT_UNAVAILABLE", "The project-code lexical generation failed integrity validation.", 503);
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch {}
    throw error;
  } finally { database.close(); }
}

function normalizeIdentifier(value) {
  return String(value).normalize("NFKC").toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]+/gu, "");
}

function queryIdentifier(value) {
  const identifiers = String(value).match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
  const ignored = new Set(["who", "calls", "caller", "usage", "uses", "find", "where"]);
  const selected = identifiers.filter((item) => !ignored.has(item.toLocaleLowerCase("en-US"))).at(-1);
  return normalizeIdentifier(selected ?? value);
}

function normalizeTokens(value) {
  const expanded = String(value).normalize("NFKC").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
  return [...new Set(expanded.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]{2,}/gu) ?? [])].slice(0, 20_000);
}

const bilingualConcepts = new Map([
  ["恢复", ["restore", "resume", "recover"]], ["会话", ["session"]], ["阅读", ["read", "viewport"]], ["位置", ["position", "viewport", "scroll"]],
  ["创建", ["create"]], ["任务", ["task"]], ["立即", ["start", "immediate"]], ["启动", ["start"]], ["工作", ["work"]],
  ["描述", ["description"]], ["上下文", ["context", "prompt"]], ["消息", ["message", "chat"]], ["验收", ["acceptance"]],
  ["调用", ["call", "caller", "usage"]]
]);

function expandQueryTokens(value) {
  const tokens = normalizeTokens(value);
  for (const [term, translations] of bilingualConcepts) if (String(value).includes(term)) tokens.push(...translations);
  return [...new Set(tokens)].slice(0, 64);
}

function resultFromRow(row, score) {
  return { path: row.path, line: Number(row.line), symbol: row.symbol ?? null, kind: row.kind, score, snippet: row.snippet };
}

function lruSet(map, key, value, maximum) {
  map.delete(key);
  map.set(key, value);
  while (map.size > maximum) map.delete(map.keys().next().value);
}

function sourceLineOffsets(text) {
  const offsets = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) offsets.push(index + 1);
  }
  return offsets;
}

function lineNumberAtOffset(offsets, offset) {
  let low = 0;
  let high = offsets.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (offsets[middle] <= offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

function lineAt(lines, line) {
  return (lines[line - 1] ?? "").trim().slice(0, 240);
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
