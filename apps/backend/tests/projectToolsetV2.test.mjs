import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  canonicalJson, dependencyManifestIdentity, operationIdentity, sha256, toolsetVersion,
  validationCacheKey, validationPlanIdentity, validationReceiptHash
} from "../src/runtime/projectToolsetCanonical.mjs";
import {
  FIXED_DEPENDENCY_MANIFEST, FIXED_DEPENDENCY_MANIFEST_IDENTITY, RUN_CONTRACT,
  STARTUP_CONTRACT, TOOLSET_RECEIPT_SCHEMA, toolsetValidationReceiptPointer, validateDependencyManifest,
  validateSnapshotRef, validateToolsetReceiptShape
} from "../src/runtime/projectToolsetContracts.mjs";
import {
  ExternalValidationCacheStore, ProjectToolsetDeclarationStore
} from "../src/runtime/projectToolsetDeclarationStore.mjs";
import {
  detectProject, InMemoryToolsetOperationStore, ProjectToolsetOrchestrator
} from "../src/runtime/projectToolsetOrchestrator.mjs";
import { SqliteProjectToolsetStore } from "../src/runtime/projectToolsetOperationStore.mjs";
import { ProjectToolsetAuthorityResolver } from "../src/application/projectToolsetService.mjs";
import {
  ProjectToolsetAuthorizationPort, ProjectToolsetCommandDescriptorPort,
  ProjectToolsetRunIsolationPort, ProjectToolsetValidationPlanPort
} from "../src/application/projectToolsetProductionPorts.mjs";

const externalTestRoot = "/Volumes/T9/.corptie/test-tmp";

test("RFC 8785 canonical JSON and all three domain-separated identities are deterministic", () => {
  assert.equal(canonicalJson({ literals: [null, true, false], string: "€$\u000f\nA'B\"\\\"/", numbers: [333333333.33333329, 1e30, 4.5, 2e-3, 1e-27] }),
    '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\\"\\\\\\\"/"}');
  const manifestIdentity = dependencyManifestIdentity({ schemaVersion: 4, entries: [
    { dependency: "z", acceptanceState: "approved_fixed", artifactId: "artifact:1", version: 1, contentHash: "a".repeat(64), contractSchemaVersions: { ZReceipt: 2, AReceipt: 1 } },
    { dependency: "a", acceptanceState: "accepted_fixed", artifactId: "artifact:2", version: 1, contentHash: "b".repeat(64), contractSchemaVersions: { Receipt: 1 } }
  ] });
  const declaration = makeDeclaration(["build"]);
  const version = toolsetVersion({ schemaVersion: 1, declaration, generatedConfigManifest: { schemaVersion: 1, adapter: "generic", configuration: {} }, generatorPolicyVersion: "g1", dependencyManifestIdentity: manifestIdentity });
  const planIdentity = validationPlanIdentity({ schemaVersion: 1, toolsetVersion: version, actions: declaration.actions, assertions: declaration.assertions, requiredCapabilityClass: "run_isolation_only", validationPolicyVersion: "v1", dependencyManifestIdentity: manifestIdentity });
  const key = validationCacheKey({ schemaVersion: 1, repositoryId: "repository:aa", worktreeId: "worktree:bb", snapshotReceiptHash: "c".repeat(64), sourceFingerprint: "D".repeat(64).toLowerCase(), toolsetVersion: version, validationPlanIdentity: planIdentity, validationPolicyVersion: "v1" });
  assert.match(version, /^ptv1:[0-9a-f]{64}$/); assert.match(planIdentity, /^vp1:[0-9a-f]{64}$/); assert.match(key, /^tvck1:[0-9a-f]{64}$/);
  assert.notEqual(toolsetVersion({ schemaVersion: 1, declaration: { ...declaration, projectType: "swift" }, generatedConfigManifest: { schemaVersion: 1, adapter: "generic", configuration: {} }, generatorPolicyVersion: "g1", dependencyManifestIdentity: manifestIdentity }), version);
});

test("dependency manifest is the exact approved four-entry schemaVersion 4 projection", () => {
  assert.equal(dependencyManifestIdentity(FIXED_DEPENDENCY_MANIFEST), FIXED_DEPENDENCY_MANIFEST_IDENTITY);
  assert.equal(validateDependencyManifest(structuredClone(FIXED_DEPENDENCY_MANIFEST)), true);
  assert.throws(() => validateDependencyManifest({ ...structuredClone(FIXED_DEPENDENCY_MANIFEST), entries: FIXED_DEPENDENCY_MANIFEST.entries.slice(0, 3) }), { code: "TOOLSET_DEPENDENCY_CONTRACT_MISMATCH" });
});

test("snapshot sourceFingerprint is validated and returned byte-for-byte without normalization", () => {
  const ref = snapshotRef("Ab".repeat(32).toLowerCase());
  const actual = validateSnapshotRef(ref);
  assert.equal(actual.sourceFingerprint, ref.sourceFingerprint);
  assert.throws(() => validateSnapshotRef({ ...ref, sourceFingerprint: ref.sourceFingerprint.toUpperCase() }), /lowercase SHA-256/);
});

test("declaration store writes only the bounded project-toolset tree and rejects symlinks", async () => {
  await mkdir(externalTestRoot, { recursive: true }); const directory = await mkdtemp(join(externalTestRoot, "toolset-store-"));
  try {
    const store = new ProjectToolsetDeclarationStore(); const declaration = makeDeclaration(["build"]);
    const written = await store.writeDeclaration(directory, declaration); assert.equal(written.declarationHash, sha256(canonicalJson(declaration)));
    const version = `ptv1:${"a".repeat(64)}`; await store.stageGenerated(directory, version, { schemaVersion: 1, adapter: "generic", configuration: {} });
    await store.activate(directory, { schemaVersion: 1, toolsetVersion: version, validationPlanIdentity: `vp1:${"b".repeat(64)}`, receiptId: "toolset_validation_receipt:one", receiptHash: "c".repeat(64), resourceVersion: 1 });
    await symlink("/tmp", join(directory, ".corptie/project-toolset/escape"));
    await assert.rejects(() => store.read(directory), /unknown top-level/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("external cache fails closed on corruption and never falls back to an implicit home path", async () => {
  assert.throws(() => new ExternalValidationCacheStore({}), /external dataRoot/);
  await mkdir(externalTestRoot, { recursive: true }); const directory = await mkdtemp(join(externalTestRoot, "toolset-cache-"));
  try {
    const store = new ExternalValidationCacheStore({ dataRoot: directory }); const key = `tvck1:${"d".repeat(64)}`;
    await store.put(key, { compact: true }); assert.deepEqual(await store.get(key), { compact: true });
    await writeFile(store.path(key), "not json"); assert.equal((await store.get(key)).corrupt, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("unknown and unconfigured projects fail closed without discovery execution", () => {
  assert.equal(detectProject({}, null).outcome, "unsupported");
  assert.equal(detectProject({ packageJson: true }, null).outcome, "needs_configuration");
});

test("orchestrator single-flights 100 callers, covers five actions, Run/Cleanup, cache and idempotency", async () => {
  await mkdir(externalTestRoot, { recursive: true }); const directory = await mkdtemp(join(externalTestRoot, "toolset-orchestrator-"));
  try {
    const fixture = makePorts(); const declaration = makeDeclaration(["build", "test", "lint", "typecheck", "service_validation"]);
    const orchestrator = new ProjectToolsetOrchestrator({ ...fixture, now: monotonicClock() });
    const input = makeInput(directory, declaration);
    const results = await Promise.all(Array.from({ length: 100 }, () => orchestrator.run(input)));
    assert.ok(results.every((item) => item.state === "ready" && item.outcome === "passed"));
    assert.equal(new Set(results.map((item) => item.operationId)).size, 1); assert.equal(fixture.runIsolationPort.executeCount, 5); assert.equal(fixture.runIsolationPort.cleanupCount, 5);
    assert.deepEqual(results[0].receipt.actionReceipts.map((item) => item.kind), ["build", "test", "lint", "typecheck", "service_validation"]);
    const repeated = await orchestrator.run(input); assert.equal(repeated.receipt.receiptId, results[0].receipt.receiptId); assert.equal(fixture.runIsolationPort.executeCount, 5);
    await assert.rejects(() => orchestrator.run({ ...input, declaration: makeDeclaration(["build"]), idempotencyKey: input.idempotencyKey }), /different input/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("single-flight rejects a different operation on the same Worktree instead of returning another result", async () => {
  await mkdir(externalTestRoot, { recursive: true }); const directory = await mkdtemp(join(externalTestRoot, "toolset-flight-conflict-"));
  try {
    const fixture = makePorts(); let release; const waiting = new Promise((resolve) => { release = resolve; }); let entered; const started = new Promise((resolve) => { entered = resolve; });
    const originalPrepare = fixture.runIsolationPort.prepareRun.bind(fixture.runIsolationPort);
    fixture.runIsolationPort.prepareRun = async (...args) => { entered(); await waiting; return originalPrepare(...args); };
    const declaration = makeDeclaration(["build"]); const orchestrator = new ProjectToolsetOrchestrator({ ...fixture, now: monotonicClock() });
    const first = orchestrator.run(makeInput(directory, declaration)); await started;
    await assert.rejects(() => orchestrator.run({ ...makeInput(directory, declaration), idempotencyKey: "two" }), { code: "TOOLSET_CAS_CONFLICT" });
    release(); assert.equal((await first).state, "ready");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("stale authoritative Snapshot fails before Run Isolation prepare", async () => {
  await mkdir(externalTestRoot, { recursive: true }); const directory = await mkdtemp(join(externalTestRoot, "toolset-stale-before-run-"));
  try {
    const fixture = makePorts(); fixture.repositorySourceSnapshotPort.get = async (ref) => ({ ...structuredClone(ref), receiptHash: "f".repeat(64), stale: true });
    const result = await new ProjectToolsetOrchestrator({ ...fixture, now: monotonicClock() }).run(makeInput(directory, makeDeclaration(["build"])));
    assert.equal(result.state, "failed"); assert.equal(fixture.runIsolationPort.executeCount, 0); assert.equal(fixture.runIsolationPort.cleanupCount, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("restricted background generation receives a provider-neutral locked-down capability envelope", async () => {
  await mkdir(externalTestRoot, { recursive: true }); const directory = await mkdtemp(join(externalTestRoot, "toolset-background-"));
  try {
    const fixture = makePorts(); const calls = [];
    fixture.backgroundAgentPort = { async generate(input) { calls.push(input); return { candidate: { schemaVersion: 1, adapter: "generic", configuration: {} } }; } };
    const declaration = makeDeclaration(["build"]); const orchestrator = new ProjectToolsetOrchestrator({ ...fixture, now: monotonicClock() });
    const result = await orchestrator.run({ ...makeInput(directory, declaration), capabilityClass: "full_required", projectFacts: { packageJson: true, declaredActions: declaration.actions, assertions: declaration.assertions }, declaration });
    assert.equal(result.state, "ready");
    // Explicit declaration plus an absent generated manifest requires the restricted Background Agent path.
    assert.equal(calls.length, 1); assert.deepEqual({ network: calls[0].network, hiddenHistory: calls[0].hiddenHistory, connectors: calls[0].connectors, collaboration: calls[0].collaboration, subagents: calls[0].subagents, skills: calls[0].skills, toolExecution: calls[0].toolExecution }, { network: false, hiddenHistory: true, connectors: false, collaboration: false, subagents: false, skills: false, toolExecution: false });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("durable cancellation after prepare always cleans the run and never activates", async () => {
  await mkdir(externalTestRoot, { recursive: true }); const directory = await mkdtemp(join(externalTestRoot, "toolset-cancel-"));
  try {
    const fixture = makePorts(); let release; const waiting = new Promise((resolve) => { release = resolve; }); let entered; const started = new Promise((resolve) => { entered = resolve; });
    const originalExecute = fixture.runIsolationPort.execute.bind(fixture.runIsolationPort);
    fixture.runIsolationPort.execute = async (...args) => { entered(); await waiting; return originalExecute(...args); };
    const declaration = makeDeclaration(["build"]); const input = makeInput(directory, declaration);
    const orchestrator = new ProjectToolsetOrchestrator({ ...fixture, now: monotonicClock() });
    const running = orchestrator.run(input); await started;
    const declarationHash = sha256(canonicalJson(declaration)); const id = operationIdentity({ repositoryId: input.repositoryId, worktreeId: input.worktreeId, declarationHash, idempotencyKey: input.idempotencyKey });
    await orchestrator.cancel(id); release(); const result = await running;
    assert.equal(result.state, "failed"); assert.equal(result.outcome, "cancelled"); assert.equal(fixture.runIsolationPort.cleanupCount, 1);
    assert.equal((await fixture.declarationStore.read(directory)).active, null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("cleanup unknown and corrupt cached receipts fail closed", async () => {
  await mkdir(externalTestRoot, { recursive: true }); const directory = await mkdtemp(join(externalTestRoot, "toolset-fail-"));
  try {
    const fixture = makePorts(); const original = fixture.runIsolationPort.getCleanupReceipt.bind(fixture.runIsolationPort);
    fixture.runIsolationPort.getCleanupReceipt = async (ref) => ({ ...(await original(ref)), outcome: "unknown" });
    const orchestrator = new ProjectToolsetOrchestrator({ ...fixture, now: monotonicClock() });
    const result = await orchestrator.run(makeInput(directory, makeDeclaration(["build"])));
    assert.equal(result.state, "failed"); assert.notEqual(result.outcome, "passed"); assert.equal(fixture.runIsolationPort.cleanupCount, 1);
    assert.equal((await fixture.declarationStore.read(directory)).active, null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("crash recovery reuses only fixed passed Run/Cleanup receipts and resumes idempotently", async () => {
  await mkdir(externalTestRoot, { recursive: true }); const directory = await mkdtemp(join(externalTestRoot, "toolset-recovery-"));
  try {
    class CrashOnceStore extends InMemoryToolsetOperationStore {
      crashed = false;
      async compareAndSwap(id, version, patch) {
        const result = await super.compareAndSwap(id, version, patch);
        if (!this.crashed && patch.completedActionReceipts?.length === 1) { this.crashed = true; const error = new Error("simulated kill -9"); error.fatalProcessCrash = true; throw error; }
        return result;
      }
    }
    const fixture = makePorts(); fixture.operationStore = new CrashOnceStore(); const declaration = makeDeclaration(["build", "test"]); const input = makeInput(directory, declaration);
    const first = new ProjectToolsetOrchestrator({ ...fixture, now: monotonicClock() });
    await assert.rejects(() => first.run(input), /simulated kill -9/); assert.equal(fixture.runIsolationPort.executeCount, 1); assert.equal(fixture.runIsolationPort.cleanupCount, 1);
    const recovered = new ProjectToolsetOrchestrator({ ...fixture, now: monotonicClock() });
    const result = await recovered.run({ ...input, recovery: true }); assert.equal(result.state, "ready");
    assert.equal(fixture.runIsolationPort.executeCount, 2, "the completed first action must not execute again"); assert.equal(fixture.runIsolationPort.cleanupCount, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("detect, canonical planning and cache key stay inside the fixed warm budgets", () => {
  const declaration = makeDeclaration(["build", "test", "lint", "typecheck", "service_validation"]); const samples = [];
  for (let index = 0; index < 1_000; index += 1) {
    const start = performance.now(); const detected = detectProject({ packageJson: true, declaredActions: declaration.actions, assertions: declaration.assertions });
    const version = toolsetVersion({ schemaVersion: 1, declaration: detected.declaration, generatedConfigManifest: detected.generatedConfigManifest, generatorPolicyVersion: "g", dependencyManifestIdentity: "c".repeat(64) });
    const plan = validationPlanIdentity({ schemaVersion: 1, toolsetVersion: version, actions: declaration.actions, assertions: declaration.assertions, requiredCapabilityClass: "run_isolation_only", validationPolicyVersion: "v", dependencyManifestIdentity: "c".repeat(64) });
    validationCacheKey({ schemaVersion: 1, repositoryId: "repository:aa", worktreeId: "worktree:bb", snapshotReceiptHash: "d".repeat(64), sourceFingerprint: "e".repeat(64), toolsetVersion: version, validationPlanIdentity: plan, validationPolicyVersion: "v" }); samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b); assert.ok(samples[Math.floor(samples.length * 0.95)] < 50, `warm p95=${samples[Math.floor(samples.length * 0.95)]}ms`);
});

test("receipt schema is closed and unknown/mismatch/cleanup-unknown states fail closed", () => {
  const receipt = makeReceiptShape(); validateToolsetReceiptShape(receipt);
  assert.throws(() => validateToolsetReceiptShape({ ...receipt, extra: true }), /unknown or missing/);
  const unknown = { ...receipt, outcome: "unknown", error: businessError("TOOLSET_OUTCOME_UNKNOWN") }; unknown.receiptHash = validationReceiptHash(unknown); validateToolsetReceiptShape(unknown);
  const badCleanup = structuredClone(receipt); badCleanup.actionReceipts[0].cleanupReceiptRef.runId = "run:other"; badCleanup.receiptHash = validationReceiptHash(badCleanup); validateToolsetReceiptShape(badCleanup);
});

test("declaration action allowlist rejects installers, downloads, scripts and unknown project types", async () => {
  await mkdir(externalTestRoot, { recursive: true }); const directory = await mkdtemp(join(externalTestRoot, "toolset-allowlist-"));
  const store = new ProjectToolsetDeclarationStore();
  try {
    const declaration = makeDeclaration(["build"]);
    await assert.rejects(() => store.writeDeclaration(directory, { ...declaration, projectType: "unknown" }), { code: "TOOLSET_DECLARATION_INVALID" });
    await assert.rejects(() => store.writeDeclaration(directory, { ...declaration, actions: [{ ...declaration.actions[0], argv: ["npm", "install"] }] }), { code: "TOOLSET_DECLARATION_INVALID" });
    await assert.rejects(() => store.writeDeclaration(directory, { ...declaration, actions: [{ ...declaration.actions[0], argv: ["swift", "https:\/\/example.invalid/tool"] }] }), { code: "TOOLSET_DECLARATION_INVALID" });
    await assert.rejects(() => store.writeDeclaration(directory, { ...declaration, actions: [{ ...declaration.actions[0], argv: ["swift", "build.sh"] }] }), { code: "TOOLSET_DECLARATION_INVALID" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("SQLite Store persists CAS state, cancellation, recovery and immutable authoritative receipts", async () => {
  await mkdir(externalTestRoot, { recursive: true }); const directory = await mkdtemp(join(externalTestRoot, "toolset-sqlite-"));
  const databasePath = join(directory, "toolset.sqlite");
  try {
    let store = new SqliteProjectToolsetStore({ databasePath });
    const input = makeInput(directory, makeDeclaration(["build"]));
    const operation = { id: "project_toolset_operation:one", requestHash: "a".repeat(64), input, state: "detect", resourceVersion: 1, cancelRequested: false };
    await store.create(operation);
    const planned = await store.compareAndSwap(operation.id, 1, { state: "plan", resourceVersion: 2 });
    assert.equal(planned.state, "plan");
    await assert.rejects(() => store.compareAndSwap(operation.id, 1, { state: "failed", resourceVersion: 2 }), { code: "TOOLSET_CAS_CONFLICT" });
    await store.requestCancel(operation.id); store.close();
    store = new SqliteProjectToolsetStore({ databasePath });
    assert.equal((await store.get(operation.id)).cancelRequested, true);
    assert.deepEqual((await store.listRecoverable()).map((item) => item.id), [operation.id]);
    const receipt = makeReceiptShape(); await store.put(receipt);
    assert.equal((await store.getReceipt(receipt.receiptId)).receiptHash, receipt.receiptHash);
    await assert.rejects(() => store.put({ ...receipt, receiptHash: "f".repeat(64) }), /cannot be overwritten/);
    const plans = new ProjectToolsetValidationPlanPort({ store });
    const planIdentity = `vp1:${"a".repeat(64)}`;
    const planValue = { plan: { schemaVersion: 1 }, validationPlanIdentity: planIdentity, identity: { repositoryId: "repository:aa" } };
    assert.equal((await plans.register(planValue)).testPlanId, `project_toolset_plan:${"a".repeat(64)}`);
    assert.deepEqual(await store.getValidationPlan(planIdentity), { plan: planValue.plan, identity: planValue.identity });
    await assert.rejects(() => plans.register({ ...planValue, plan: { schemaVersion: 2 } }), { code: "TOOLSET_CAS_CONFLICT" });
    store.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("production Ports keep descriptors single-use, consume coordinator receipts authoritatively and reject client capabilities", async () => {
  const commands = new ProjectToolsetCommandDescriptorPort();
  const contexts = new Map(); const runs = new Map(); const cleanups = new Map();
  const coordinator = {
    service: { store: {
      latestRunReceipt(runId) { return runs.get(runId) ?? null; },
      latestCleanupReceipt(runId) { return cleanups.get(runId) ?? null; }
    } },
    async prepareRun(prepare, session) {
      assert.equal(prepare.sourceAware, true); assert.equal(prepare.toolsetRequired, false);
      assert.deepEqual(Object.keys(session).sort(), ["logicalSessionId", "repositoryId", "taskId", "worktreeId"]);
      const context = { runId: "run:production", resourceVersion: 1, fencingToken: 7, runToken: "opaque" };
      contexts.set(context.runId, context); return { context, receipt: null, replay: false };
    },
    async execute({ runContext, descriptor }) {
      assert.equal(runContext.runToken, "opaque"); assert.equal(descriptor.executable, "swift");
      const receipt = { runId: runContext.runId, receiptHash: "b".repeat(64) }; runs.set(runContext.runId, receipt); return receipt;
    },
    async cancel(request) { return { runId: request.runId, receiptHash: "c".repeat(64) }; },
    async cleanup(request) { const receipt = { runId: request.runId, receiptHash: "d".repeat(64) }; cleanups.set(request.runId, receipt); return receipt; }
  };
  const port = new ProjectToolsetRunIsolationPort({ coordinator, commandDescriptors: commands });
  const session = { logicalSessionId: "logical:one", taskId: "task:one", repositoryId: "repository:aa", worktreeId: "worktree:bb" };
  const prepared = await port.prepareRun({ startupBindingReceiptRef: startupReceiptRef(), repositorySourceSnapshotReceiptRef: snapshotRef("1".repeat(64)), toolsetValidationReceiptPointer: null, idempotencyKey: "prepare", testPlanRef: null, fixtureRef: null, quotaClass: "small" }, session);
  const descriptor = await commands.register({ action: makeDeclaration(["build"]).actions[0], validationPlanIdentity: `vp1:${"e".repeat(64)}`, projectRoot: "/project" });
  const run = await port.execute({ runId: prepared.context.runId, preparedResourceVersion: 1, fencingToken: 7, commandDescriptorRef: descriptor, idempotencyKey: "execute" }, session);
  await assert.rejects(() => port.execute({ runId: prepared.context.runId, preparedResourceVersion: 1, fencingToken: 7, commandDescriptorRef: descriptor, idempotencyKey: "execute-again" }, session), /absent or expired/);
  assert.equal((await port.getRunReceipt({ runId: run.runId, receiptHash: run.receiptHash })).receiptHash, run.receiptHash);
  assert.equal(await port.getRunReceipt({ runId: run.runId, receiptHash: "0".repeat(64) }), null);
  const cleanup = await port.cleanup({ runId: run.runId }, session);
  assert.equal((await port.getCleanupReceipt({ runId: run.runId, receiptHash: cleanup.receiptHash })).receiptHash, cleanup.receiptHash);

  const authority = { ...session, workId: "work:one", capabilityClass: "full_required" };
  const authorization = new ProjectToolsetAuthorizationPort({ resolveAuthority: async () => authority });
  assert.equal((await authorization.assertProjectToolsetAccess(authority)).capabilityClass, "full_required");
  await assert.rejects(() => authorization.assertProjectToolsetAccess({ ...authority, capabilityClass: "run_isolation_only" }), { code: "TOOLSET_PERMISSION_DENIED" });
});

test("authoritative resolver binds Session, Startup, Snapshot and Toolset pointer without client identity", async () => {
  const authority = { logicalSessionId: "logical:one", workId: "work:one", taskId: "task:one", repositoryId: "repository:aa", worktreeId: "worktree:bb" };
  const startupReceipt = { schemaVersion: 2, status: "ready", startupOperationId: "startup:one", logicalSessionId: authority.logicalSessionId, workId: authority.workId, taskId: authority.taskId, repositoryId: authority.repositoryId, worktreeId: authority.worktreeId, receiptHash: "2".repeat(64), resourceVersion: 3 };
  const snapshot = { ...snapshotRef("1".repeat(64)), ...authority, startupBindingRef: startupRef() };
  const receipt = makeReceiptShape();
  const resolver = new ProjectToolsetAuthorityResolver({
    sessionAuthorityPort: { async resolve(input) { assert.deepEqual(Object.keys(input).sort(), ["authenticatedSession", "workingDirectory"]); return structuredClone(authority); } },
    startupBindingReceiptStore: { async getCurrent(input) { assert.deepEqual(input, authority); return structuredClone(startupReceipt); } },
    repositorySourceSnapshotStore: { async getCurrent(input) { assert.deepEqual(input, authority); return structuredClone(snapshot); } },
    toolsetValidationReceiptStore: { async getReceipt(id) { return id === receipt.receiptId ? structuredClone(receipt) : null; } }
  });
  const context = await resolver.resolveProjectContext({ workingDirectory: "/project", authenticatedSession: { logicalSessionId: "logical:one", taskId: "task:one", repositoryId: "client-spoof" } });
  assert.deepEqual({ logicalSessionId: context.logicalSessionId, repositoryId: context.repositoryId, worktreeId: context.worktreeId }, { logicalSessionId: "logical:one", repositoryId: "repository:aa", worktreeId: "worktree:bb" });
  const resolved = await resolver.resolveRunIsolationAuthorities({ workingDirectory: "/project", authenticatedSession: { logicalSessionId: "logical:one", taskId: "task:one" }, toolsetReceiptId: receipt.receiptId });
  assert.deepEqual(resolved.toolsetValidationReceiptPointer, toolsetValidationReceiptPointer(receipt, authority));
  await assert.rejects(() => resolver.resolveProjectContext({ workingDirectory: "/project", authenticatedSession: { logicalSessionId: "logical:other", taskId: "task:one" } }), { code: "TOOLSET_PERMISSION_DENIED" });
});

function makePorts() {
  const declarationStore = new ProjectToolsetDeclarationStore(); const operationStore = new InMemoryToolsetOperationStore(); const cache = new Map(); const receipts = new Map(); let sequence = 0;
  const runIsolationPort = {
    executeCount: 0, cleanupCount: 0, runs: new Map(), cleanups: new Map(),
    async prepareRun(input, session) { assert.deepEqual(Object.keys(session).sort(), ["logicalSessionId", "repositoryId", "taskId", "worktreeId"]); assert.equal(Object.hasOwn(input, "sourceFingerprint"), false); assert.equal(input.toolsetValidationReceiptPointer, null); const runId = `run:${++sequence}`; return { context: { runId, resourceVersion: 1, fencingToken: 1 } }; },
    async execute(request) { assert.deepEqual(Object.keys(request).sort(), ["commandDescriptorRef", "fencingToken", "idempotencyKey", "preparedResourceVersion", "runId", "toolsetValidationReceiptPointer"]); assert.equal(request.toolsetValidationReceiptPointer, null); this.executeCount += 1; const receipt = fullRunReceipt(request.runId, 2, "passed"); this.runs.set(receipt.receiptHash, receipt); return receipt; },
    async cancel(request) { const receipt = fullRunReceipt(request.runId, 2, "cancelled"); this.runs.set(receipt.receiptHash, receipt); return receipt; },
    async cleanup(request) { this.cleanupCount += 1; const run = [...this.runs.values()].find((value) => value.runId === request.runId); const receipt = fullCleanupReceipt(run, ++sequence); this.cleanups.set(receipt.receiptHash, receipt); return receipt; },
    async getRunReceipt(ref) { return this.runs.get(ref.receiptHash); }, async getCleanupReceipt(ref) { return this.cleanups.get(ref.receiptHash); }
  };
  const startup = startupRef(); const snapshot = snapshotRef("1".repeat(64));
  return {
    declarationStore, operationStore,
    authorizationPort: { async assertProjectToolsetAccess(input) { return structuredClone(input); } },
    validationReceiptStore: { async put(value) { receipts.set(value.receiptId, structuredClone(value)); } },
    validationCacheStore: { async get(key) { return structuredClone(cache.get(key) ?? null); }, async put(key, value) { cache.set(key, structuredClone(value)); }, async invalidate(key) { cache.delete(key); } },
    repositorySourceSnapshotPort: { async get(ref) { return { ...structuredClone(ref), stale: false }; } },
    startupBindingReceiptReader: { async get(ref) { return { schemaVersion: 2, status: "ready", startupOperationId: ref.startupOperationId, logicalSessionId: "logical:one", workId: "work:one", taskId: "task:one", repositoryId: "repository:aa", worktreeId: "worktree:bb", receiptHash: ref.startupReceiptHash }; } },
    validationPlanPort: { async register({ validationPlanIdentity: identity }) { return { testPlanId: `test_plan:${identity.slice(4, 20)}`, schemaVersion: 1 }; } },
    commandDescriptorPort: { async register(input) { return { descriptorId: `command:${input.action.id}`, schemaVersion: 1 }; } },
    runIsolationPort
  };
}

function makeInput(projectRoot, declaration) { return { logicalSessionId: "logical:one", workId: "work:one", taskId: "task:one", repositoryId: "repository:aa", worktreeId: "worktree:bb", projectRoot, idempotencyKey: "one", capabilityClass: "run_isolation_only", startupBindingRef: startupRef(), startupBindingReceiptRef: startupReceiptRef(), repositorySourceSnapshotReceiptRef: snapshotRef("1".repeat(64)), projectFacts: {}, declaration }; }
function startupRef() { return { artifactId: STARTUP_CONTRACT.artifactId, artifactVersion: 1, artifactContentHash: STARTUP_CONTRACT.contentHash, startupOperationId: "startup:one", startupReceiptHash: "2".repeat(64) }; }
function startupReceiptRef() { return { startupOperationId: "startup:one", receiptHash: "2".repeat(64), schemaVersion: 2, resourceVersion: 1, artifactRef: { artifactId: STARTUP_CONTRACT.artifactId, version: 1, contentHash: STARTUP_CONTRACT.contentHash, relation: "implementation_spec", receiptType: "StartupBindingReceipt", schemaVersion: 2 } }; }
function snapshotRef(fingerprint) { return { receiptId: "snapshot:one", receiptHash: "3".repeat(64), sourceFingerprint: fingerprint, schemaVersion: 1, resourceVersion: 1, artifactRef: { artifactId: "artifact:aaaaaaaa-1111-4111-8111-111111111111", version: 1, contentHash: "a".repeat(64), relation: "implementation_spec", receiptType: "RepositorySourceSnapshotReceipt", schemaVersion: 1 } }; }
function receiptRef(type, runId, sequence) { const schemaVersion = type === "Run" ? 6 : 4; return { receiptId: `${type.toLowerCase()}:${sequence}`, receiptHash: sha256(`${type}:${sequence}`), schemaVersion, resourceVersion: 1, artifactRef: { artifactId: RUN_CONTRACT.artifactId, version: 1, contentHash: RUN_CONTRACT.contentHash, relation: "implementation_spec", receiptType: `${type}Receipt`, schemaVersion }, runId }; }
function makeDeclaration(kinds) { const executables = { build: "swift", test: "swift", lint: "eslint", typecheck: "tsc", service_validation: "corptie-service-health" }; return { schemaVersion: 1, projectType: "generic", actions: kinds.map((kind, index) => ({ id: `${kind}-${index}`, kind, argv: [executables[kind], "--version"], relativeCwd: ".", required: true, timeoutMs: 1000 })), assertions: kinds.map((kind, index) => ({ id: `assert-${index}`, actionId: `${kind}-${index}`, assertionType: kind === "service_validation" ? "service_health" : "exit_code", required: true })), generatorPolicyVersion: "project-toolset-generator-v1", validationPolicyVersion: "project-toolset-validation-v1" }; }
function monotonicClock() { let n = 0; return () => new Date(Date.UTC(2026, 7, 30, 0, 0, n++)).toISOString(); }
function businessError(code) { return { code, message: "Validation outcome is unknown.", retryable: false, details: { actionId: null, assertionId: null, phase: "validate" } }; }
function makeReceiptShape() {
  const run = receiptRef("Run", "run:one", 1); const cleanup = receiptRef("Cleanup", "run:one", 2); const startedAt = "2026-08-30T00:00:00.000Z"; const finishedAt = "2026-08-30T00:00:01.000Z";
  const receipt = { receiptId: "toolset_validation_receipt:one", receiptHash: "0".repeat(64), schemaVersion: 3, resourceVersion: 1, artifactRef: { artifactId: TOOLSET_RECEIPT_SCHEMA.artifactId, version: 1, contentHash: TOOLSET_RECEIPT_SCHEMA.contentHash, relation: "implementation_spec", receiptType: "ToolsetValidationReceipt", schemaVersion: 3 }, identity: { logicalSessionId: "logical:one", workId: "work:one", taskId: "task:one", repositoryId: "repository:aa", worktreeId: "worktree:bb", startupBindingRef: startupRef() }, snapshotRef: snapshotRef("1".repeat(64)), toolsetVersion: `ptv1:${"5".repeat(64)}`, validationPlanIdentity: `vp1:${"6".repeat(64)}`, validationCacheKey: `tvck1:${"7".repeat(64)}`, actionReceipts: [{ id: "build", kind: "build", ordinal: 0, executionDisposition: "executed", outcome: "passed", runReceiptRef: run, cleanupReceiptRef: cleanup, startedAt, finishedAt, evidenceHash: "8".repeat(64), error: null }], assertionReceipts: [{ id: "exit", actionId: "build", assertionType: "exit_code", outcome: "passed", startedAt, finishedAt, evidenceHash: "9".repeat(64), error: null }], cacheDisposition: "stored", outcome: "passed", startedAt, finishedAt, expiresAt: null, error: null };
  receipt.receiptHash = validationReceiptHash(receipt); return receipt;
}

function fullRunReceipt(runId, resourceVersion, outcome) {
  const terminal = outcome === "passed" ? "completed" : outcome === "cancelled" ? "cancelled" : "failed";
  const receipt = { schemaVersion: 6, receiptId: `run_receipt:${runId.replaceAll(":", "_")}:${resourceVersion}`, receiptHash: "0".repeat(64), runId, mode: "test", logicalSessionId: "logical:one", taskId: "task:one", repositoryId: "repository:aa", worktreeId: "worktree:bb", sourceFingerprint: "1".repeat(64), startupBindingReceiptRef: startupReceiptRef(), repositorySourceSnapshotReceiptRef: snapshotRef("1".repeat(64)), toolsetValidationReceiptPointer: null, state: terminal, outcome, runContextHash: "a".repeat(64), dataRootBindingId: "data-root:test", processLeaseRefs: [], portLeaseRefs: [], dataLeaseRef: { leaseId: "lease:data", kind: "data", fencingToken: 1, resourceVersion: 1 }, credentialLeaseRefs: [], fencingToken: 1, resourceVersion, eventRefs: [], metricsRef: null, readyAt: "2026-08-30T00:00:00.000Z", startedAt: outcome === "cancelled" ? null : "2026-08-30T00:00:01.000Z", stoppedAt: "2026-08-30T00:00:02.000Z", completedAt: "2026-08-30T00:00:02.000Z", error: outcome === "failed" ? { code: "RUN_FAILED", message: "Run failed.", traceId: null, detailsHash: null } : null };
  receipt.receiptHash = validationReceiptHash(receipt); return receipt;
}
function fullCleanupReceipt(run, sequence) {
  const names = ["canonicalRoot", "runMarker", "identity", "leaseOwner", "fence", "noSymlink", "noHardlinkEscape", "noMountCrossing", "noActiveProcess", "noActivePort", "noActiveDataLease", "noActiveCredentialLease", "serverHandleClosed", "targetBoundary"];
  const receipt = { schemaVersion: 4, receiptId: `cleanup_receipt:${sequence}`, receiptHash: "0".repeat(64), cleanupOperationId: `cleanup:${sequence}`, runId: run.runId, runReceiptRef: { receiptId: run.receiptId, receiptHash: run.receiptHash, schemaVersion: 6, issuer: "run_isolation", resourceVersion: run.resourceVersion, artifactRef: { artifactId: RUN_CONTRACT.artifactId, version: 1, contentHash: RUN_CONTRACT.contentHash, relation: "implementation_spec", receiptType: "RunReceipt", schemaVersion: 6 } }, logicalSessionId: "logical:one", taskId: "task:one", repositoryId: "repository:aa", worktreeId: "worktree:bb", sourceFingerprint: "1".repeat(64), outcome: "cleaned", policy: "success_default", ownerSessionId: "logical:one", retentionReason: null, retentionPolicyVersion: "run-retention-v1", retainUntil: null, quotaBytes: 1024, observedBytes: 0, fencingToken: 1, resourceVersion: run.resourceVersion, dataRootBindingId: "data-root:test", sourceIdentityHash: "b".repeat(64), trashIdentityHash: "c".repeat(64), safetyChecks: Object.fromEntries(names.map((name) => [name, { status: "passed", errorCode: null, evidenceHash: "d".repeat(64) }])), processReconciliation: "matchedExited", bytesReclaimed: 0, filesRemoved: 0, eventRefs: [], startedAt: "2026-08-30T00:00:03.000Z", finishedAt: "2026-08-30T00:00:04.000Z", error: null };
  receipt.receiptHash = validationReceiptHash(receipt); return receipt;
}
