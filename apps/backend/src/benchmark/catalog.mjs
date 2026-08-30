import { assertClosedObject, benchmarkError, contentHash } from "./canonical.mjs";

const SAMPLE_FIELDS = ["sampleId", "sampleVersion", "fixtureRef", "fixtureHash", "startTreeHash", "sizeClass", "promptTemplateId", "promptTemplateHash", "capabilityRequirements", "scenarioRefs", "expectedAssertions", "metricRequirements", "performanceBudgetId", "coldWarmPolicy", "providerEligibilityPredicate", "evidenceRequirements"];

const scenarios = {
  S1: ["backend-pure-function", ["functional", "unknown-field-rejected", "syntax-valid"]],
  S2: ["provider-neutral-tool-contract", ["schema-equal", "authorization-recomputed", "unsupported-explicit", "provider-name-neutral"]],
  S3: ["store-http-swift-field", ["field-types-match", "references-integral", "unknown-field-rejected"]],
  S4: ["swift-state-regression", ["state-transition", "main-actor-boundary", "tests-pass"]],
  S5: ["toolset-lifecycle", ["toolset-version-canonical", "validation-plan-identity", "snapshot-echo-equal"]],
  S6: ["layered-search", ["expected-hit-recall", "denied-path-zero", "snapshot-reference-equal"]],
  S7: ["workitem-e2e", ["artifact-reference-final", "turn-summary", "receipt-chain-complete", "repository-pollution-zero"]]
};

export class BenchmarkCatalog {
  constructor(entries = defaultEntries()) {
    this.entries = new Map();
    for (const entry of entries) this.register(entry);
  }

  register(input) {
    assertClosedObject(input, SAMPLE_FIELDS, "CatalogSample");
    for (const field of SAMPLE_FIELDS) if (!Object.hasOwn(input, field)) throw benchmarkError("BENCHMARK_CATALOG_INVALID", `Catalog sample is missing ${field}.`, "catalog");
    if (!/^S[1-7]$/.test(input.sampleId) || input.sampleVersion !== 2) throw benchmarkError("BENCHMARK_CATALOG_INVALID", "Catalog sample identity is invalid.", "catalog");
    const sampleHash = contentHash(input);
    this.entries.set(input.sampleId, Object.freeze({ ...structuredClone(input), sampleHash }));
    return this.entries.get(input.sampleId);
  }

  list() { return [...this.entries.values()].sort((a, b) => a.sampleId.localeCompare(b.sampleId)); }
  get(sampleId) { return this.entries.get(sampleId) ?? null; }

  suite() {
    const samples = this.list();
    const suiteHash = contentHash(samples.map((sample) => sample.sampleHash).sort());
    return { suiteId: "corptie-code-task", suiteVersion: 2, suiteHash, samples };
  }
}

function defaultEntries() {
  return Object.entries(scenarios).map(([sampleId, [name, assertions]]) => ({
    sampleId, sampleVersion: 2,
    fixtureRef: `fixture:${name}:v2`, fixtureHash: contentHash({ name, version: 2 }),
    startTreeHash: contentHash({ name, tree: "fixed" }), sizeClass: sampleId === "S6" ? "10k" : "small",
    promptTemplateId: `prompt:${name}:v2`, promptTemplateHash: contentHash({ name, prompt: "fixed-template-v2" }),
    capabilityRequirements: sampleId === "S4" ? ["swift"] : ["session-execution"],
    scenarioRefs: { startup: "startup:v2", toolset: "toolset:v3", isolation: "run:v6", search: sampleId === "S6" ? "search:v1" : null, validation: `${name}:v2` },
    expectedAssertions: [...assertions, "structured-failure"],
    metricRequirements: ["wallClockMs", "criticalPathMs", "unattributedMs"],
    performanceBudgetId: `budget:${sampleId.toLowerCase()}:v1`,
    coldWarmPolicy: { modes: ["cold", "warm"], minimumValidPairs: 30, minimumP95Runs: 100 },
    providerEligibilityPredicate: { capabilityClasses: ["A", "B", "C", "D"] },
    evidenceRequirements: ["authority-receipts", "independent-assertions"]
  }));
}
