import { randomUUID } from "node:crypto";
import { benchmarkError, contentHash } from "./canonical.mjs";

const TABLES = [
  "benchmark_catalog_entries", "benchmark_experiments", "benchmark_sample_plans", "benchmark_attempts",
  "benchmark_receipt_links", "benchmark_run_reports", "benchmark_suite_reports", "benchmark_gate_policies", "benchmark_gate_decisions"
];

export class BenchmarkControlStore {
  constructor({ store, now = () => new Date().toISOString(), idFactory = randomUUID }) {
    this.store = store;
    this.now = now;
    this.idFactory = idFactory;
  }

  initialize() {
    const db = this.#db();
    db.run(`CREATE TABLE IF NOT EXISTS benchmark_catalog_entries (
      record_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, resource_version INTEGER NOT NULL,
      content_hash TEXT NOT NULL, created_by_session_id TEXT NOT NULL, created_at TEXT NOT NULL,
      suite_id TEXT NOT NULL, suite_version INTEGER NOT NULL, sample_id TEXT NOT NULL, sample_version INTEGER NOT NULL,
      payload_json TEXT NOT NULL, UNIQUE(suite_id, suite_version, sample_id, sample_version)
    ) STRICT`);
    db.run(`CREATE TABLE IF NOT EXISTS benchmark_experiments (
      record_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, resource_version INTEGER NOT NULL,
      content_hash TEXT NOT NULL, created_by_session_id TEXT NOT NULL, created_at TEXT NOT NULL,
      objective_id TEXT NOT NULL, work_item_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
      plan_hash TEXT NOT NULL, status TEXT NOT NULL, payload_json TEXT NOT NULL,
      UNIQUE(created_by_session_id, idempotency_key)
    ) STRICT`);
    db.run(`CREATE TABLE IF NOT EXISTS benchmark_sample_plans (
      record_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, resource_version INTEGER NOT NULL,
      content_hash TEXT NOT NULL, created_by_session_id TEXT NOT NULL, created_at TEXT NOT NULL,
      experiment_id TEXT NOT NULL, sample_id TEXT NOT NULL, pair_index INTEGER NOT NULL, variant_order TEXT NOT NULL,
      payload_json TEXT NOT NULL, UNIQUE(experiment_id, sample_id, pair_index)
    ) STRICT`);
    db.run(`CREATE TABLE IF NOT EXISTS benchmark_attempts (
      record_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, resource_version INTEGER NOT NULL,
      content_hash TEXT NOT NULL, created_by_session_id TEXT NOT NULL, created_at TEXT NOT NULL,
      experiment_id TEXT NOT NULL, sample_plan_id TEXT NOT NULL, variant TEXT NOT NULL, control_state TEXT NOT NULL,
      external_run_id TEXT, payload_json TEXT NOT NULL, UNIQUE(sample_plan_id, variant)
    ) STRICT`);
    db.run(`CREATE TABLE IF NOT EXISTS benchmark_receipt_links (
      record_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, resource_version INTEGER NOT NULL,
      content_hash TEXT NOT NULL, created_by_session_id TEXT NOT NULL, created_at TEXT NOT NULL,
      attempt_id TEXT NOT NULL, receipt_id TEXT NOT NULL, receipt_type TEXT NOT NULL, producer TEXT NOT NULL,
      identity_chain_hash TEXT NOT NULL, evidence_locator TEXT NOT NULL, linked_at TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      UNIQUE(attempt_id, receipt_id)
    ) STRICT`);
    for (const table of ["benchmark_run_reports", "benchmark_suite_reports"]) {
      db.run(`CREATE TABLE IF NOT EXISTS ${table} (
        record_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, resource_version INTEGER NOT NULL,
        content_hash TEXT NOT NULL, created_by_session_id TEXT NOT NULL, created_at TEXT NOT NULL,
        experiment_id TEXT NOT NULL, payload_json TEXT NOT NULL
      ) STRICT`);
    }
    db.run(`CREATE TABLE IF NOT EXISTS benchmark_gate_policies (
      record_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, resource_version INTEGER NOT NULL,
      content_hash TEXT NOT NULL, created_by_session_id TEXT NOT NULL, created_at TEXT NOT NULL,
      policy_version INTEGER NOT NULL, payload_json TEXT NOT NULL, UNIQUE(record_id, policy_version)
    ) STRICT`);
    db.run(`CREATE TABLE IF NOT EXISTS benchmark_gate_decisions (
      record_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, resource_version INTEGER NOT NULL,
      content_hash TEXT NOT NULL, created_by_session_id TEXT NOT NULL, created_at TEXT NOT NULL,
      experiment_id TEXT NOT NULL, report_id TEXT NOT NULL, action TEXT NOT NULL, payload_json TEXT NOT NULL
    ) STRICT`);
    db.run("CREATE INDEX IF NOT EXISTS idx_benchmark_experiments_scope ON benchmark_experiments(objective_id, work_item_id, created_at DESC)");
    db.run("CREATE INDEX IF NOT EXISTS idx_benchmark_attempts_experiment ON benchmark_attempts(experiment_id, created_at)");
    db.run("CREATE INDEX IF NOT EXISTS idx_benchmark_decisions_experiment ON benchmark_gate_decisions(experiment_id, created_at DESC)");
  }

  syncCatalog(sessionId, suite) {
    for (const sample of suite.samples) {
      const payload = { suiteId: suite.suiteId, suiteVersion: suite.suiteVersion, suiteHash: suite.suiteHash, ...sample };
      const hash = contentHash(payload);
      const recordId = `catalog:${suite.suiteId}:${suite.suiteVersion}:${sample.sampleId}:${sample.sampleVersion}`;
      const existing = this.#get("benchmark_catalog_entries", recordId);
      if (existing && existing.content_hash !== hash) throw benchmarkError("BENCHMARK_CATALOG_CONFLICT", "Catalog identity already has different content.", "catalog");
      if (!existing) this.#db().run(`INSERT INTO benchmark_catalog_entries VALUES (?, 1, 1, ?, ?, ?, ?, ?, ?, ?, ?)`, [recordId, hash, sessionId, this.now(), suite.suiteId, suite.suiteVersion, sample.sampleId, sample.sampleVersion, JSON.stringify(payload)]);
    }
  }

  createExperiment(scope, input) {
    const definition = structuredClone(input.definition);
    const planHash = contentHash(definition);
    const existing = this.#db().get("SELECT * FROM benchmark_experiments WHERE created_by_session_id=? AND idempotency_key=?", [scope.logicalSessionId, input.idempotencyKey], "BenchmarkControlStore.createExperiment");
    if (existing) {
      if (existing.plan_hash !== planHash) throw benchmarkError("BENCHMARK_IDEMPOTENCY_CONFLICT", "Idempotency key was used for a different experiment.", "store", { statusCode: 409 });
      return present(existing);
    }
    const recordId = `experiment:${contentHash({ logicalSessionId: scope.logicalSessionId, idempotencyKey: input.idempotencyKey }).slice(0, 32)}`;
    const payload = { experimentId: recordId, definition, manifestIdentity: input.manifestIdentity, scope };
    const createdAt = this.now();
    this.#db().run(`INSERT INTO benchmark_experiments VALUES (?, 1, 1, ?, ?, ?, ?, ?, ?, ?, 'planned', ?)`, [recordId, contentHash(payload), scope.logicalSessionId, createdAt, scope.objectiveId, scope.workItemId, input.idempotencyKey, planHash, JSON.stringify(payload)]);
    return this.getExperiment(scope, recordId);
  }

  getExperiment(scope, experimentId) {
    const row = this.#get("benchmark_experiments", experimentId);
    if (!row || row.objective_id !== scope.objectiveId || row.work_item_id !== scope.workItemId || row.created_by_session_id !== scope.logicalSessionId) throw benchmarkError("BENCHMARK_EXPERIMENT_NOT_FOUND", "Experiment is not visible to this Session.", "store", { statusCode: 404 });
    return present(row);
  }

  listExperiments(scope) {
    return this.#db().all("SELECT * FROM benchmark_experiments WHERE objective_id=? AND work_item_id=? AND created_by_session_id=? ORDER BY created_at DESC", [scope.objectiveId, scope.workItemId, scope.logicalSessionId], "BenchmarkControlStore.listExperiments").map(present);
  }

  transitionExperiment(scope, experimentId, expectedResourceVersion, status, patch = {}) {
    const current = this.getExperiment(scope, experimentId);
    if (current.resourceVersion !== expectedResourceVersion) throw benchmarkError("BENCHMARK_RESOURCE_VERSION_CONFLICT", "Experiment resource version changed.", "store", { statusCode: 409 });
    const allowed = transitions[current.status] ?? [];
    if (!allowed.includes(status)) throw benchmarkError("BENCHMARK_STATE_TRANSITION_INVALID", `Cannot transition ${current.status} to ${status}.`, "orchestrator");
    const payload = { ...current.payload, ...patch };
    this.#db().run("UPDATE benchmark_experiments SET status=?, resource_version=resource_version+1, content_hash=?, payload_json=? WHERE record_id=? AND resource_version=?", [status, contentHash(payload), JSON.stringify(payload), experimentId, expectedResourceVersion]);
    if (this.#db().getRowsModified() !== 1) throw benchmarkError("BENCHMARK_RESOURCE_VERSION_CONFLICT", "Experiment resource version changed.", "store", { statusCode: 409 });
    return this.getExperiment(scope, experimentId);
  }

  createSamplePlan(scope, experimentId, sample, pairIndex, variantOrder) {
    this.getExperiment(scope, experimentId);
    const recordId = `sample_plan:${contentHash({ experimentId, sampleId: sample.sampleId, pairIndex }).slice(0, 32)}`;
    const payload = { experimentId, sampleId: sample.sampleId, sampleHash: sample.sampleHash, pairIndex, variantOrder };
    this.#insertImmutable("benchmark_sample_plans", recordId, scope.logicalSessionId, payload,
      ["experiment_id", "sample_id", "pair_index", "variant_order"], [experimentId, sample.sampleId, pairIndex, variantOrder]);
    return present(this.#get("benchmark_sample_plans", recordId));
  }

  createAttempt(scope, experimentId, samplePlanId, variant) {
    const recordId = `attempt:${contentHash({ samplePlanId, variant }).slice(0, 32)}`;
    const existing = this.#get("benchmark_attempts", recordId);
    if (existing) {
      if (existing.created_by_session_id !== scope.logicalSessionId || existing.experiment_id !== experimentId
        || existing.sample_plan_id !== samplePlanId || existing.variant !== variant) {
        throw benchmarkError("BENCHMARK_IMMUTABLE_RECORD_CONFLICT", "Attempt identity differs from the existing record.", "store", { statusCode: 409 });
      }
      return present(existing);
    }
    const payload = { experimentId, samplePlanId, variant };
    this.#insertImmutable("benchmark_attempts", recordId, scope.logicalSessionId, payload,
      ["experiment_id", "sample_plan_id", "variant", "control_state", "external_run_id"], [experimentId, samplePlanId, variant, "planned", null]);
    return present(this.#get("benchmark_attempts", recordId));
  }

  getAttempt(scope, attemptId) {
    const row = this.#get("benchmark_attempts", attemptId);
    if (!row) throw benchmarkError("BENCHMARK_ATTEMPT_NOT_FOUND", "Attempt not found.", "store", { statusCode: 404 });
    this.getExperiment(scope, row.experiment_id);
    return present(row);
  }

  updateAttemptControl(attemptId, controlState, externalRunId = null, patch = {}) {
    const row = this.#get("benchmark_attempts", attemptId);
    if (!row) throw benchmarkError("BENCHMARK_ATTEMPT_NOT_FOUND", "Attempt not found.", "store");
    if (row.external_run_id && externalRunId && row.external_run_id !== externalRunId) throw benchmarkError("BENCHMARK_IDENTITY_CHAIN_MISMATCH", "Attempt already references another runId.", "orchestrator");
    const payload = { ...JSON.parse(row.payload_json), ...patch };
    this.#db().run("UPDATE benchmark_attempts SET control_state=?, external_run_id=COALESCE(external_run_id, ?), resource_version=resource_version+1, content_hash=?, payload_json=? WHERE record_id=?", [controlState, externalRunId, contentHash(payload), JSON.stringify(payload), attemptId]);
    return present(this.#get("benchmark_attempts", attemptId));
  }

  linkReceipts(scope, attemptId, correlation, envelopes) {
    for (const envelope of envelopes) {
      const locator = envelope.evidence?.[0]?.locator ?? `receipt:${envelope.receiptId}`;
      const payload = { attemptId, receiptId: envelope.receiptId, receiptType: envelope.receiptType, producer: envelope.producerServiceId, contentHash: envelope.contentHash, identityChainHash: correlation.identityChainHash, evidenceLocator: locator, linkedAt: this.now() };
      this.#insertImmutable("benchmark_receipt_links", `receipt_link:${attemptId}:${envelope.receiptId}`, scope.logicalSessionId, payload,
        ["attempt_id", "receipt_id", "receipt_type", "producer", "identity_chain_hash", "evidence_locator", "linked_at"], [attemptId, envelope.receiptId, envelope.receiptType, envelope.producerServiceId, correlation.identityChainHash, locator, payload.linkedAt]);
    }
  }

  saveReport(scope, kind, experimentId, report) {
    const table = kind === "run" ? "benchmark_run_reports" : "benchmark_suite_reports";
    this.#insertImmutable(table, report.reportId, scope.logicalSessionId, report, ["experiment_id"], [experimentId], report.contentHash);
    return present(this.#get(table, report.reportId));
  }

  getReport(scope, reportId) {
    for (const table of ["benchmark_run_reports", "benchmark_suite_reports"]) {
      const row = this.#get(table, reportId);
      if (row && row.created_by_session_id === scope.logicalSessionId) return present(row);
    }
    throw benchmarkError("BENCHMARK_REPORT_NOT_FOUND", "Report not found.", "store", { statusCode: 404 });
  }

  listRunReports(scope, experimentId) {
    this.getExperiment(scope, experimentId);
    return this.#db().all("SELECT * FROM benchmark_run_reports WHERE experiment_id=? AND created_by_session_id=? ORDER BY created_at, record_id", [experimentId, scope.logicalSessionId], "BenchmarkControlStore.listRunReports").map((row) => present(row).payload);
  }

  saveGatePolicy(scope, policy) {
    const recordId = policy.gatePolicyId;
    this.#insertImmutable("benchmark_gate_policies", recordId, scope.logicalSessionId, policy, ["policy_version"], [policy.version]);
    return present(this.#get("benchmark_gate_policies", recordId));
  }

  saveGateDecision(scope, experimentId, decision) {
    this.#insertImmutable("benchmark_gate_decisions", decision.decisionId, scope.logicalSessionId, decision,
      ["experiment_id", "report_id", "action"], [experimentId, decision.reportHash, decision.action], decision.contentHash);
    return present(this.#get("benchmark_gate_decisions", decision.decisionId));
  }

  getGateDecision(scope, decisionId) {
    const row = this.#get("benchmark_gate_decisions", decisionId);
    if (!row || row.created_by_session_id !== scope.logicalSessionId) throw benchmarkError("BENCHMARK_DECISION_NOT_FOUND", "Gate decision not found.", "store", { statusCode: 404 });
    return present(row);
  }

  tableNames() { return [...TABLES]; }

  #insertImmutable(table, recordId, sessionId, payload, columns, values, expectedHash = null) {
    const hash = expectedHash ?? contentHash(payload);
    const existing = this.#get(table, recordId);
    if (existing) {
      if (existing.content_hash !== hash) throw benchmarkError("BENCHMARK_IMMUTABLE_RECORD_CONFLICT", "Immutable Benchmark record has different content.", "store", { statusCode: 409 });
      return;
    }
    const placeholders = Array(columns.length).fill("?").join(",");
    this.#db().run(`INSERT INTO ${table} (record_id,schema_version,resource_version,content_hash,created_by_session_id,created_at,${columns.join(",")},payload_json) VALUES (?,2,1,?,?,?,${placeholders},?)`, [recordId, hash, sessionId, this.now(), ...values, JSON.stringify(payload)]);
  }

  #get(table, recordId) { return this.#db().get(`SELECT * FROM ${table} WHERE record_id=?`, [recordId], "BenchmarkControlStore.get"); }
  #db() { if (!this.store?.db) throw benchmarkError("BENCHMARK_STORE_UNAVAILABLE", "Benchmark Store is unavailable.", "store", { retryable: true, statusCode: 503 }); return this.store.db; }
}

const transitions = {
  planned: ["prerequisites_verified", "cancelled", "held", "invalidated"],
  prerequisites_verified: ["dispatched", "cancelled", "held", "invalidated"],
  dispatched: ["awaiting_evidence", "cancelled", "stopped", "invalidated"],
  awaiting_evidence: ["correlated", "cancelled", "held", "stopped", "invalidated"],
  correlated: ["evaluated", "held", "stopped", "invalidated"],
  evaluated: ["completed", "held", "stopped"]
};

function present(row) {
  return { recordId: row.record_id, schemaVersion: Number(row.schema_version), resourceVersion: Number(row.resource_version), contentHash: row.content_hash, createdBySessionId: row.created_by_session_id, createdAt: row.created_at, status: row.status ?? row.control_state ?? null, payload: JSON.parse(row.payload_json), ...(row.external_run_id ? { externalRunId: row.external_run_id } : {}) };
}
