import { dirname, join, resolve, sep } from "node:path";
import { contractError } from "./projectCodeContracts.mjs";
import { loadProjectCodeSourceJournalPort } from "./projectCodeSourceJournalPort.mjs";
import { createValidatedSnapshotLease } from "./projectCodeValidationLease.mjs";

export class ProjectCodeSourceRevisionMonitor {
  constructor(options = {}) {
    this.port = options.port === undefined ? loadProjectCodeSourceJournalPort() : options.port;
    this.maxMonitors = options.maxMonitors ?? 4;
    this.entries = new Map();
    this.bindings = new WeakMap();
    this.stats = { fastBefore: 0, fastAfter: 0, fullFallbacks: 0, invalidations: 0, uncertain: 0, baselineRetries: 0 };
  }

  get capability() { return this.port?.capability ?? "full-validation"; }

  async establish({ worktreeId, canonicalRoot, build, verify, maxAttempts = 2 }) {
    if (!this.port) return build();
    const entry = this.#entry(worktreeId, canonicalRoot);
    const previous = entry.establishFlight ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(() => this.#establishBaseline(entry, { build, verify, maxAttempts }));
    entry.establishFlight = operation;
    try { return await operation; }
    finally { if (entry.establishFlight === operation) entry.establishFlight = null; }
  }

  async #establishBaseline(entry, { build, verify, maxAttempts }) {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (!this.#barrier(entry).trusted) return this.#fallbackBuild(entry, build);
      const snapshot = await build();
      this.#ensureJournal(entry, snapshot.workspaceIdentity?.gitDirCanonicalPath);
      this.#ensureJournal(entry, snapshot.workspaceIdentity?.commonGitDirCanonicalPath);
      this.#configure(entry, snapshot);
      const validationBefore = this.#barrier(entry);
      if (!validationBefore.trusted) return this.#fallbackSnapshot(entry, snapshot, verify);
      await verify(snapshot);
      const after = this.#barrier(entry);
      if (!after.trusted) return this.#fallbackSnapshot(entry, snapshot, verify);
      if (tokensEqual(validationBefore, after)) {
        this.bindings.set(snapshot, Object.freeze({ entry, epochs: after.epochs }));
        return snapshot;
      }
      this.stats.baselineRetries += 1;
    }
    throw contractError("SOURCE_SNAPSHOT_STALE", "Worktree changed while establishing the source revision baseline.", 409);
  }

  adopt(snapshot, sourceSnapshot) {
    const binding = this.bindings.get(sourceSnapshot);
    if (binding) this.bindings.set(snapshot, binding);
    return snapshot;
  }

  lease(snapshot, snapshotBuilder) {
    const binding = this.bindings.get(snapshot);
    if (!binding) return createValidatedSnapshotLease(snapshot, snapshotBuilder);
    let captured = null;
    let fullFallback = false;
    return createValidatedSnapshotLease(snapshot, snapshotBuilder, {
      mode: "native-journal",
      verifyBefore: async (options = {}) => {
        const token = this.#barrier(binding.entry);
        if (!token.trusted) {
          fullFallback = true;
          this.stats.fullFallbacks += 1;
          return snapshotBuilder.assertCurrent(snapshot, options);
        }
        if (!epochsEqual(binding.epochs, token.epochs)) {
          this.stats.invalidations += 1;
          throw contractError("SOURCE_SNAPSHOT_STALE", "Worktree changed after the source Snapshot was indexed.", 409);
        }
        captured = token.epochs;
        this.stats.fastBefore += 1;
        return true;
      },
      verifyAfter: async (options = {}) => {
        if (fullFallback) return snapshotBuilder.assertCurrent(snapshot, options);
        const token = this.#barrier(binding.entry);
        if (!token.trusted) {
          this.stats.fullFallbacks += 1;
          return snapshotBuilder.assertCurrent(snapshot, options);
        }
        if (!captured || !epochsEqual(captured, token.epochs)) {
          this.stats.invalidations += 1;
          throw contractError("SOURCE_SNAPSHOT_STALE", "Worktree changed while project-code search was executing.", 409);
        }
        this.stats.fastAfter += 1;
        return true;
      }
    });
  }

  summary() {
    return Object.freeze({ capability: this.capability, monitors: this.entries.size, ...this.stats });
  }

  close() {
    for (const entry of this.entries.values()) {
      for (const journal of entry.journals.values()) {
        try { this.port?.close(journal); } catch {}
      }
    }
    this.entries.clear();
  }

  #entry(worktreeId, canonicalRoot) {
    const root = resolve(canonicalRoot);
    const existing = this.entries.get(worktreeId);
    if (existing) {
      if (existing.root !== root) throw contractError("STARTUP_BINDING_MISMATCH", "Worktree revision monitor root changed.", 409);
      this.entries.delete(worktreeId);
      this.entries.set(worktreeId, existing);
      return existing;
    }
    while (this.entries.size >= this.maxMonitors) {
      const oldestKey = this.entries.keys().next().value;
      const oldest = this.entries.get(oldestKey);
      for (const journal of oldest.journals.values()) {
        try { this.port.close(journal); } catch {}
      }
      this.entries.delete(oldestKey);
    }
    const entry = { worktreeId, root, journals: new Map(), uncertain: false, establishFlight: null };
    this.entries.set(worktreeId, entry);
    this.#ensureJournal(entry, root);
    return entry;
  }

  #ensureJournal(entry, path) {
    if (!path) return;
    const root = resolve(path);
    if (entry.journals.has(root)) return;
    try {
      const journal = this.port.open(root);
      if (!journal.trusted) entry.uncertain = true;
      entry.journals.set(root, journal);
    } catch {
      entry.uncertain = true;
      this.stats.uncertain += 1;
    }
  }

  #configure(entry, snapshot) {
    for (const [root, journal] of entry.journals) {
      const paths = root === entry.root ? sourceWatchPaths(snapshot, entry.root) : gitWatchPaths(root, snapshot);
      try {
        const result = this.port.reset(journal, paths);
        if (!result.trusted) entry.uncertain = true;
      } catch {
        entry.uncertain = true;
        this.stats.uncertain += 1;
      }
    }
  }

  #barrier(entry) {
    const epochs = {};
    let trusted = !entry.uncertain;
    for (const [root, journal] of entry.journals) {
      try {
        const value = this.port.barrier(journal);
        epochs[root] = value.epoch;
        if (!value.trusted) trusted = false;
      } catch { trusted = false; }
    }
    if (!trusted) {
      entry.uncertain = true;
      this.stats.uncertain += 1;
    }
    return Object.freeze({ trusted, epochs: Object.freeze(epochs), roots: Object.freeze(Object.keys(epochs)) });
  }

  async #fallbackBuild(entry, build) {
    entry.uncertain = true;
    this.stats.fullFallbacks += 1;
    return build();
  }

  async #fallbackSnapshot(entry, snapshot, verify) {
    entry.uncertain = true;
    this.stats.fullFallbacks += 1;
    await verify(snapshot);
    return snapshot;
  }
}

function tokensEqual(before, after) {
  return epochsEqual(before.epochs, after.epochs);
}

function epochsEqual(left, right) {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => left[key] === right[key]);
}

function sourceWatchPaths(snapshot, root) {
  const paths = new Set();
  for (const candidate of snapshot.candidates ?? []) {
    paths.add(resolve(candidate.absolutePath));
    let directory = dirname(candidate.absolutePath);
    while (directory !== root && directory.startsWith(`${root}${sep}`)) {
      paths.add(directory);
      directory = dirname(directory);
    }
  }
  for (const declaration of snapshot.declarations ?? []) {
    const declared = resolve(root, declaration.path);
    paths.add(declared);
    let directory = dirname(declared);
    while (directory !== root && directory.startsWith(`${root}${sep}`)) {
      paths.add(directory);
      directory = dirname(directory);
    }
  }
  for (const source of snapshot.ignoreConfigSources ?? []) paths.add(resolve(source.absolutePath));
  return [...paths];
}

function gitWatchPaths(root, snapshot) {
  const identity = snapshot.workspaceIdentity ?? {};
  const paths = new Set();
  if (root === resolve(identity.gitDirCanonicalPath ?? root)) {
    for (const path of ["HEAD", "index", "commondir"]) paths.add(join(root, path));
  }
  if (root === resolve(identity.commonGitDirCanonicalPath ?? root)) {
    for (const path of ["packed-refs", "refs", "logs"]) paths.add(join(root, path));
  }
  const branch = snapshot.startupReceipt?.headIdentity?.branch;
  if (typeof branch === "string" && branch && !branch.includes("..") && !branch.startsWith("/") && !branch.includes("\\")) {
    const ref = join(root, "refs", "heads", branch);
    paths.add(ref);
    let directory = dirname(ref);
    while (directory !== root && directory.startsWith(`${root}${sep}`)) {
      paths.add(directory);
      directory = dirname(directory);
    }
  }
  return [...paths];
}
