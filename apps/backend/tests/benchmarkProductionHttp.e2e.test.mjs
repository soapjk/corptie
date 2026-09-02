import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { AgentProviderRegistry } from "../src/agent-provider/agentProviderRegistry.mjs";
import { CallbackAgentProvider } from "../src/agent-provider/callbackAgentProvider.mjs";
import { AGENT_PROVIDER_CAPABILITIES } from "../src/agent-provider/contracts.mjs";
import { SessionApplicationService } from "../src/agent-provider/sessionApplicationService.mjs";
import { ProviderEventIngestionService } from "../src/application/providerEventIngestionService.mjs";
import { ProviderNeutralCodeTaskExecutionService } from "../src/application/providerNeutralCodeTaskExecutionService.mjs";
import { createProjectToolsetProductionComposition } from "../src/application/projectToolsetProductionComposition.mjs";
import { WorkSessionStartupCoordinator } from "../src/application/workSessionStartupCoordinator.mjs";
import { ObjectiveApplicationService } from "../src/application/objectiveApplicationService.mjs";
import { BenchmarkControlPlane } from "../src/benchmark/controlPlane.mjs";
import { DEPENDENCY_MANIFEST_IDENTITY } from "../src/benchmark/contracts.mjs";
import { handleBenchmarkHttpRequest } from "../src/benchmark/httpApi.mjs";
import { createBenchmarkProductionPorts } from "../src/benchmark/productionPorts.mjs";
import { CodeTaskObservabilityService } from "../src/observability/codeTaskObservability.mjs";
import { OBSERVABILITY_DEPENDENCY_PINS } from "../src/observability/dependencyContractManifest.mjs";
import { ProjectCodeSearchApplicationService } from "../src/project-code/projectCodeApplicationService.mjs";
import { ProjectCodeIndexStore } from "../src/project-code/projectCodeIndexStore.mjs";
import { ProjectCodeSearchService } from "../src/project-code/projectCodeSearchService.mjs";
import { RepositorySourceSnapshotBuilder } from "../src/project-code/projectCodeSnapshot.mjs";
import { ProjectCodeStartupReceiptRepository } from "../src/project-code/projectCodeStartupReceiptRepository.mjs";
import { RunIsolationExecutionCoordinator } from "../src/runIsolation/index.mjs";
import { projectToolsetValidationReceiptPointer } from "../src/runIsolation/dependencyContractManifest.mjs";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { createProjectCodeFixture } from "./helpers/projectCodeTestFixture.mjs";
import { fixture as createRunFixture } from "./runIsolationTestHelpers.mjs";

const ROOT = "/Volumes/T9/.corptie/test-tmp";
const OBJECTIVE_ID = "objective:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TASK_ID = "task:cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const AGENT_ID = "agent:dddddddd-dddd-4ddd-8ddd-dddddddddddd";

test("production HTTP composition runs bounded S1 and Search S6 through authoritative services", async (t) => {
  await mkdir(ROOT, { recursive: true });
  const source = await createProjectCodeFixture({ parent: ROOT, files: swiftPackageFiles() });
  const dataRoot = await mkdtemp(join(ROOT, "benchmark-production-data-"));
  const store = new CorptieStore({ dbPath: join(dataRoot, "corptie.sqlite"), configPath: join(dataRoot, "config.json") });
  await store.initialize();
  t.after(async () => { await store.close(); await rm(source.directory, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true }); });
  const startup = await establishWorkSession({ store, source });
  seedAppliedToolHost(store, startup.receipt);

  const startupReceipts = new ProjectCodeStartupReceiptRepository({ store });
  const snapshotBuilder = new RepositorySourceSnapshotBuilder();
  const projectCode = new ProjectCodeSearchApplicationService({ store, startupReceipts, snapshotBuilder,
    searchService: new ProjectCodeSearchService({ snapshotBuilder,
      indexStore: new ProjectCodeIndexStore({ dataRoot: join(dataRoot, "project-code-index"), requireExternal: false }) }) });
  const { service: runService } = await createRunFixture(t);
  const runIsolationCoordinator = new RunIsolationExecutionCoordinator({ service: runService });
  const toolsets = createProjectToolsetProductionComposition({ store, startupReceipts,
    projectCodeApplicationService: projectCode, runIsolationCoordinator,
    backgroundAgentService: { async run() { throw new Error("The fixed Swift fixture must not require generation."); } },
    dataRoot: join(dataRoot, "project-toolset"), environment: "test" });
  t.after(() => toolsets.toolsetStore.close());
  assert.deepEqual({ ownership: store.assertLogicalWorkSessionBinding(startup.receipt.logicalSessionId),
    binding: store.getLogicalSession(startup.receipt.logicalSessionId).activeBinding,
    startup: startupReceipts.require(startup.receipt.logicalSessionId) }, {
    ownership: store.assertLogicalWorkSessionBinding(startup.receipt.logicalSessionId),
    binding: store.getLogicalSession(startup.receipt.logicalSessionId).activeBinding,
    startup: startup.receipt
  });
  const diagnosticOwnership = store.assertLogicalWorkSessionBinding(startup.receipt.logicalSessionId);
  const diagnosticBinding = store.getLogicalSession(startup.receipt.logicalSessionId).activeBinding;
  assert.equal(diagnosticOwnership.objectiveId, startup.receipt.objectiveId);
  assert.equal(diagnosticOwnership.taskId, startup.receipt.taskId);
  assert.equal(diagnosticBinding.state, "active");
  assert.equal(diagnosticBinding.worktreeId, startup.receipt.worktreeId);
  assert.equal(diagnosticBinding.boundCwd, startup.receipt.canonicalWorktreePath);
  const initialized = await toolsets.service.initialize(source.directory, {
    authenticatedSession: { logicalSessionId: startup.receipt.logicalSessionId, taskId: startup.receipt.taskId },
    idempotencyKey: "benchmark-production-toolset"
  });
  assert.equal(initialized.outcome, "passed");
  const runtimeAuthority = await toolsets.runtimeAuthority(startup.receipt.logicalSessionId);
  const activeToolsetReceipt = await toolsets.resolveToolsetReceipt(runtimeAuthority.toolsetReceiptId);
  assert.equal(runtimeAuthority.snapshot.sourceFingerprint, activeToolsetReceipt.snapshotRef.sourceFingerprint);
  let resolvedPointer;
  try { resolvedPointer = projectToolsetValidationReceiptPointer(activeToolsetReceipt,
    activeToolsetReceipt.snapshotRef.sourceFingerprint, {
      logicalSessionId: startup.receipt.logicalSessionId, objectiveId: startup.receipt.objectiveId,
      taskId: startup.receipt.taskId, repositoryId: startup.receipt.repositoryId,
      worktreeId: startup.receipt.worktreeId
    }); } catch (error) { assert.fail(JSON.stringify(error.details)); }
  assert.ok(resolvedPointer);

  const observability = new CodeTaskObservabilityService({ store, environment: "test",
    dataRootResolver: () => dataRoot,
    resolveArtifactPin: (artifactId, version) => {
      const pin = OBSERVABILITY_DEPENDENCY_PINS.find((item) => item.artifactId === artifactId && item.version === version);
      return pin ? { ...pin, acceptanceState: "approved_fixed", approvalStatus: "approved" } : null;
    } });
  observability.initialize();
  const routeBindingId = store.getLogicalSession(startup.receipt.logicalSessionId).activeBinding.bindingId;
  const sourceToolHostReceipt = structuredClone(
    store.getSessionToolCatalogMaterialization(startup.receipt.logicalSessionId, routeBindingId).providerReceipt
  );
  const execution = createProviderExecutionEntry({ store, startup: startup.receipt, observability });
  const ports = createBenchmarkProductionPorts({ store, artifactEvidencePort: { readPinned: async () => null },
    startupReceipts, projectCodeApplicationService: projectCode, projectToolsetProduction: toolsets,
    runIsolationCoordinator, observabilityService: observability,
    codeTaskExecutionService: execution.codeTaskExecution });
  const controlPlane = new BenchmarkControlPlane({ store, ports,
    dependencyVerifier: async () => ({ manifestIdentity: DEPENDENCY_MANIFEST_IDENTITY,
      evidence: [{ artifactId: "artifact:test-fixture", readReceiptId: "artifact_usage:test-fixture" }] }) });
  controlPlane.initialize();
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (!handleBenchmarkHttpRequest({ request, response, url, controlPlane })) response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const headers = { "content-type": "application/json", "x-corptie-logical-session-id": startup.receipt.logicalSessionId };
  const createdResponse = await fetch(`${origin}/benchmark/experiments`, { method: "POST", headers,
    body: JSON.stringify(experimentInput()) });
  const experiment = await createdResponse.json();
  assert.equal(createdResponse.status, 201, JSON.stringify(experiment));
  const runResponse = await fetch(`${origin}/benchmark/experiments/${encodeURIComponent(experiment.recordId)}/run`, { method: "POST", headers });
  const result = await runResponse.json();
  assert.equal(runResponse.status, 200, JSON.stringify(result));
  assert.equal(result.experiment.status, "held");
  assert.equal(result.suiteReport.validRuns, 8);
  const producers = new Set(result.suiteReport.receiptRefs.map((item) => item.producerServiceId));
  assert.deepEqual(producers, new Set(["tool-host", "startup-binding", "repository-source-snapshot",
    "project-toolset", "run-isolation", "layered-search", "turn-observability"]));
  assert.equal(store.selectOne("SELECT COUNT(*) AS count FROM project_code_receipts WHERE receipt_type='SearchReceipt'").count, 4);
  assert.equal(store.selectOne("SELECT COUNT(*) AS count FROM observation_correlation_index").count, 32);
  assert.equal(store.selectOne("SELECT COUNT(*) AS count FROM observation_correlation_index WHERE producer='provider_event_ingestion'").count, 32);
  assert.equal(execution.sentTurns, 8);
  assert.deepEqual(
    store.getSessionToolCatalogMaterialization(startup.receipt.logicalSessionId, routeBindingId).providerReceipt,
    sourceToolHostReceipt,
    "Benchmark Tool Host mapping is a read-only projection"
  );
  assert.ok(runService.store.listRuns().length >= 8);

  const reportResponse = await fetch(`${origin}/benchmark/reports/${encodeURIComponent(result.suiteReport.reportId)}`, { headers });
  assert.equal(reportResponse.status, 200);
  assert.equal((await reportResponse.json()).payload.contentHash, result.suiteReport.contentHash);
  const decisionResponse = await fetch(`${origin}/benchmark/gate-decisions/${encodeURIComponent(result.decision.decisionId)}`, { headers });
  assert.equal(decisionResponse.status, 200);
  assert.equal((await decisionResponse.json()).payload.action, "hold");

  const missing = controlWith(store, {});
  const missingExperiment = missing.createExperiment(startup.receipt.logicalSessionId, experimentInput("missing-port"));
  await assert.rejects(() => missing.runExperiment(startup.receipt.logicalSessionId, missingExperiment.recordId),
    { code: "BENCHMARK_PORT_UNAVAILABLE" });

  const killedPorts = createBenchmarkProductionPorts({ store, artifactEvidencePort: { readPinned: async () => null },
    startupReceipts, projectCodeApplicationService: projectCode, projectToolsetProduction: toolsets,
    runIsolationCoordinator, observabilityService: observability,
    codeTaskExecutionService: execution.codeTaskExecution, readKillSwitch: () => true });
  const killed = controlWith(store, killedPorts);
  const killedExperiment = killed.createExperiment(startup.receipt.logicalSessionId, experimentInput("kill-switch"));
  assert.equal((await killed.runExperiment(startup.receipt.logicalSessionId, killedExperiment.recordId)).status, "held");

  const unknownToolsets = { ...toolsets, resolveToolsetReceipt: async () => null };
  const unknown = controlWith(store, createBenchmarkProductionPorts({ store,
    artifactEvidencePort: { readPinned: async () => null }, startupReceipts,
    projectCodeApplicationService: projectCode, projectToolsetProduction: unknownToolsets,
    runIsolationCoordinator, observabilityService: observability,
    codeTaskExecutionService: execution.codeTaskExecution }));
  const unknownExperiment = unknown.createExperiment(startup.receipt.logicalSessionId, experimentInput("unknown-toolset"));
  await assert.rejects(() => unknown.runExperiment(startup.receipt.logicalSessionId, unknownExperiment.recordId),
    { code: "BENCHMARK_PORT_UNAVAILABLE" });

  const activeBindingId = store.getLogicalSession(startup.receipt.logicalSessionId).activeBinding.bindingId;
  const materialization = store.getSessionToolCatalogMaterialization(startup.receipt.logicalSessionId, activeBindingId);
  store.db.run("UPDATE session_tool_catalog_materializations SET provider_receipt_json=? WHERE logical_session_id=? AND provider_binding_id=?",
    [JSON.stringify({ ...materialization.providerReceipt, appliedCatalogVersion: "catalog:mismatch" }),
      startup.receipt.logicalSessionId, activeBindingId]);
  const stale = controlWith(store, ports);
  const staleExperiment = stale.createExperiment(startup.receipt.logicalSessionId, experimentInput("stale-tool-host"));
  await assert.rejects(() => stale.runExperiment(startup.receipt.logicalSessionId, staleExperiment.recordId),
    { code: "BENCHMARK_RECEIPT_STALE" });
  store.db.run("UPDATE session_tool_catalog_materializations SET provider_receipt_json=? WHERE logical_session_id=? AND provider_binding_id=?",
    [JSON.stringify(materialization.providerReceipt), startup.receipt.logicalSessionId, activeBindingId]);

  const sourcePath = join(source.directory, "Sources/BenchmarkControlPlane/BenchmarkControlPlane.swift");
  const originalSource = await readFile(sourcePath, "utf8");
  await writeFile(sourcePath, `${originalSource}// mismatch\n`);
  const mismatched = controlWith(store, ports);
  const mismatchExperiment = mismatched.createExperiment(startup.receipt.logicalSessionId, experimentInput("source-mismatch"));
  await assert.rejects(() => mismatched.runExperiment(startup.receipt.logicalSessionId, mismatchExperiment.recordId),
    (error) => ["SOURCE_FINGERPRINT_MISMATCH", "SNAPSHOT_STALE"].includes(error.code));
  await writeFile(sourcePath, originalSource);

  const productionAdapterSource = await readFile(new URL("../src/benchmark/productionPorts.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(productionAdapterSource, /recordObservation\s*\(/);
  assert.doesNotMatch(productionAdapterSource, /benchmark_production_composition/);
});

function createProviderExecutionEntry({ store, startup, observability }) {
  const logical = store.getLogicalSession(startup.logicalSessionId);
  const binding = logical.activeBinding;
  const materialization = store.getSessionToolCatalogMaterialization(startup.logicalSessionId, binding.bindingId);
  const authoritativeBinding = {
    ...binding,
    sessionId: logical.legacySessionId,
    providerMetadata: {
      startupBindingReceipt: startup,
      startupProviderBindingMapping: {
        startupProviderBindingId: startup.providerBindingId,
        providerBindingId: binding.bindingId,
        startupBindingGeneration: startup.bindingGeneration,
        providerBindingGeneration: binding.routingVersion
      },
      toolHostAppliedReceipt: materialization.providerReceipt
    }
  };
  const ingestion = new ProviderEventIngestionService({
    store,
    resolveBinding: () => authoritativeBinding,
    project: () => ({ surface: false, outbox: [] }),
    observe: (context) => observability.ingestProviderEvent(context)
  });
  let providerSequence = 0;
  let sentTurns = 0;
  const provider = new CallbackAgentProvider({
    id: binding.providerId,
    displayName: "Benchmark Provider",
    transport: "production-test",
    capabilities: [AGENT_PROVIDER_CAPABILITIES.CONVERSATION_SEND,
      AGENT_PROVIDER_CAPABILITIES.CONVERSATION_INTERRUPT]
  }, {
    send: async (_reference, _message, context) => {
      sentTurns += 1;
      const turnId = `turn:benchmark:${context.source.attemptId}`;
      const base = Date.now() + sentTurns * 100;
      for (const [offset, type, itemId] of [
        [0, "turn.started", null], [10, "assistant.message.started", `message:${sentTurns}`],
        [20, "assistant.message.completed", `message:${sentTurns}`], [30, "turn.completed", null]
      ]) {
        providerSequence += 1;
        const result = ingestion.ingest({ schemaVersion: 1, providerId: binding.providerId,
          providerSessionId: binding.providerSessionId, bindingId: binding.bindingId,
          logicalSessionId: startup.logicalSessionId, routingVersion: binding.routingVersion,
          providerEventId: `provider-event:${sentTurns}:${providerSequence}`, providerSequence,
          turnId, itemId, type, occurredAt: new Date(base + offset).toISOString(),
          receivedAt: new Date(base + offset + 1).toISOString(),
          payload: { providerCapabilityClass: "event_stream" } });
        assert.equal(result.status, "applied");
        assert.notEqual(result.observability?.state, "skipped");
      }
      return { turn: { id: turnId } };
    },
    interrupt: async () => ({ accepted: true })
  });
  const sessionService = new SessionApplicationService({
    registry: new AgentProviderRegistry([provider]),
    resolveSessionReference: async (sessionId) => sessionId === startup.logicalSessionId
      ? { ...binding, sessionId: logical.legacySessionId, logicalSessionId: startup.logicalSessionId,
          metadata: { session: store.getSession(logical.legacySessionId) } }
      : null
  });
  return {
    codeTaskExecution: new ProviderNeutralCodeTaskExecutionService({
      sessionService, store, observabilityService: observability, pollIntervalMs: 1, timeoutMs: 2_000
    }),
    get sentTurns() { return sentTurns; }
  };
}

async function establishWorkSession({ store, source }) {
  const objectiveService = new ObjectiveApplicationService({ store });
  const agent = store.createAgent({ id: AGENT_ID, name: "Benchmark", role: "independentContributor" });
  const now = new Date().toISOString();
  store.db.run("INSERT INTO git_repositories (repository_id, common_git_dir, discovered_at, last_validated_at) VALUES (?, ?, ?, ?)",
    [source.identity.repositoryId, join(source.directory, ".git"), now, now]);
  store.db.run(`INSERT INTO git_worktrees (worktree_id,repository_id,path,canonical_path,git_dir,is_main,availability,
    head_oid,branch_ref,branch_name,detached,inventory_version,observed_at,raw_json)
    VALUES (?,?,?,?,?,0,'available',?,'refs/heads/master','master',0,'inventory:benchmark',?,'{}')`,
  [source.identity.worktreeId, source.identity.repositoryId, source.directory, source.directory,
    join(source.directory, ".git"), source.commitOid, now]);
  const objective = objectiveService.createObjective({ id: OBJECTIVE_ID, name: "Benchmark",
    contributorAgentIds: [agent.agentId], workspaceIds: [source.identity.repositoryId] });
  const task = objectiveService.createTask({ id: TASK_ID, objectiveId: objective.id,
    title: "Benchmark production", mainAgentId: agent.agentId, mainWorkspaceId: source.identity.repositoryId });
  store.createSession({ id: "provider:benchmark-source", title: "Benchmark source",
    provider: "test-provider", agentId: agent.agentId, sessionKind: "objectiveChat",
    objectiveId: objective.id, cwd: source.directory });
  store.createLogicalSessionRoute({ logicalSessionId: "session:benchmark-source",
    legacySessionId: "provider:benchmark-source", providerThreadId: "thread:benchmark-source",
    providerSessionId: "provider:benchmark-source", providerId: "test-provider",
    boundCwd: source.directory, sessionName: "Benchmark source" });
  const coordinator = new WorkSessionStartupCoordinator({ store, leaseOwner: "benchmark-test",
    authorizeStart: async (command) => ({ ...command, objectiveId: objective.id,
      repositoryId: source.identity.repositoryId, taskTitle: task.title }),
    prepareWorktree: async ({ startupOperationId }) => ({ repositoryId: source.identity.repositoryId,
      worktreeId: source.identity.worktreeId, canonicalWorktreePath: source.directory,
      headIdentity: { kind: "branch", branch: "master" }, sourceCommitOid: source.commitOid,
      sourceTreeOid: source.treeOid, baseRef: "HEAD", repositoryInventoryVersion: "inventory:benchmark",
      workspaceResourceVersion: 1, createdByStartupOperationId: startupOperationId, reused: true }),
    inspectWorktree: async ({ allocation }) => allocation,
    providerWorkSessionPort: {
      createSession: async ({ providerBindingId }) => {
        const session = store.createSession({ id: "session:benchmark", title: "Benchmark production",
          provider: "test-provider", agentId: agent.agentId, sessionKind: "worker",
          objectiveId: objective.id, taskId: task.id, cwd: source.directory,
          deferTaskProjection: true });
        store.createLogicalSessionRoute({ logicalSessionId: "logical:benchmark", legacySessionId: session.id,
          providerThreadId: "thread:benchmark", providerSessionId: "provider-session:benchmark",
          bindingId: providerBindingId, providerId: "test-provider", repositoryId: source.identity.repositoryId,
          worktreeId: source.identity.worktreeId, boundCwd: source.directory, sessionName: "Benchmark production" });
        return session;
      },
      bindWorkspace: async (input) => ({ providerBindingId: input.providerBindingId,
        bindingGeneration: input.bindingGeneration, providerResourceId: "provider-resource:benchmark",
        canonicalWorkingDirectory: input.workingDirectory, trustedContextHash: input.trustedContextHash,
        acceptedAt: new Date().toISOString() }),
      inspectBinding: async () => { throw Object.assign(new Error("not yet bound"), { code: "START_PROVIDER_BINDING_NOT_FOUND" }); },
      activateSession: async (activation) => activation.dispatchInitialTurn === true ? undefined : ({
        providerResourceId: "provider-resource:benchmark",
        canonicalWorkingDirectory: activation.workingDirectory,
        toolContractHash: "c".repeat(64), instructionSourcesHash: "d".repeat(64)
      }), compensateSession: async () => {}
    }, compensateWorktree: async () => ({ removed: false }) });
  return coordinator.start({ taskId: task.id, assigneeAgentId: agent.agentId,
    expectedTaskVersion: 1, providerId: "test-provider", idempotencyKey: "benchmark-startup",
    sourceSessionId: "session:benchmark-source" });
}

function seedAppliedToolHost(store, startup) {
  const providerBindingId = store.getLogicalSession(startup.logicalSessionId).activeBinding.bindingId;
  const desiredVersion = "materialization:benchmark"; const catalogVersion = "catalog:benchmark";
  const domains = [{ domainId: "artifacts", canonicalToolNames: ["corptie_artifacts"] }];
  const desired = store.writeSessionToolCatalogDesired({ logicalSessionId: startup.logicalSessionId,
    providerBindingId, desiredVersion, desiredCatalogVersion: catalogVersion,
    desiredDomains: domains, exposurePlan: { exposurePlanHash: "e".repeat(64) } });
  const refreshing = store.beginSessionToolCatalogRefresh(startup.logicalSessionId, providerBindingId, desired.resourceVersion);
  const receipt = { providerBindingId, providerCapabilityRevision: "capability:benchmark",
    requestedVersion: desiredVersion, appliedVersion: desiredVersion, appliedCatalogVersion: catalogVersion,
    appliedDomains: domains, appliedExposurePlanHash: "e".repeat(64), refreshMode: "replace",
    providerRevision: "provider:benchmark", receiptId: "tool_host_receipt:benchmark", appliedAt: new Date().toISOString() };
  store.applySessionToolCatalogReceipt({ logicalSessionId: startup.logicalSessionId,
    providerBindingId, appliedVersion: desiredVersion,
    appliedCatalogVersion: catalogVersion, appliedDomains: domains, providerReceipt: receipt,
    appliedAt: receipt.appliedAt }, refreshing.resourceVersion);
}

function experimentInput(idempotencyKey = "production-http") {
  return { idempotencyKey, sampleIds: idempotencyKey === "production-http" ? ["S1", "S6"] : ["S1"], pairCount: 1,
    providerCapabilityClass: "A", noiseProfile: { machineClass: "mac", osBuild: "test",
      cpuArchitecture: process.arch, memoryClass: "test", powerState: "ac", thermalState: "nominal",
      filesystemClass: "external-apfs", providerCapabilityClass: "A", observabilityLevel: "event-stream" },
    stage: "shadow", cohortRef: null, randomSeed: "production-http" };
}

function controlWith(store, ports) {
  const value = new BenchmarkControlPlane({ store, ports,
    dependencyVerifier: async () => ({ manifestIdentity: DEPENDENCY_MANIFEST_IDENTITY,
      evidence: [{ artifactId: "artifact:test-fixture", readReceiptId: "artifact_usage:test-fixture" }] }) });
  value.initialize(); return value;
}

function swiftPackageFiles() {
  return { "Package.swift": "// swift-tools-version: 5.9\nimport PackageDescription\nlet package = Package(name: \"BenchmarkControlPlane\", targets: [.target(name: \"BenchmarkControlPlane\"), .testTarget(name: \"BenchmarkControlPlaneTests\", dependencies: [\"BenchmarkControlPlane\"])])\n",
    "Sources/BenchmarkControlPlane/BenchmarkControlPlane.swift": "public struct BenchmarkControlPlane { public init() {} }\n",
    "Tests/BenchmarkControlPlaneTests/BenchmarkControlPlaneTests.swift": "import XCTest\n@testable import BenchmarkControlPlane\nfinal class BenchmarkControlPlaneTests: XCTestCase { func testInit() { _ = BenchmarkControlPlane() } }\n",
    ".gitignore": ".build/\n" };
}
