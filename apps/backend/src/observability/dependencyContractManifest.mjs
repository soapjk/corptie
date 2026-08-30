import { createHash } from "node:crypto";

export const OBSERVABILITY_DEPENDENCY_PINS = Object.freeze([
  pin("startup_binding_receipt", "approved_fixed", "artifact:7f26689a-5b9a-4b32-ad86-ad93c0be2949", 1, "472b8c34180f2c1e7f7b59d7e2c8fc620ec515971a56e5f8ecae6fe69a0aced2"),
  pin("search_snapshot_schema", "approved_fixed", "artifact:ee9b734f-799d-41b6-804f-9868697de511", 1, "920fa9b2952490e4e4c93c88ca2855c11aeac9ff615bea43f738feff7d6d93e9"),
  pin("toolset_receipt_schema", "approved_fixed", "artifact:ed9a09d9-d2b1-4446-9a34-4ef491570ef3", 1, "11211c8f21c166f50e38f07b99650e000e32f703f5417a613ffe8775e1a4a54d"),
  pin("run_isolation_receipts", "approved_fixed", "artifact:42cd149b-e230-4347-b4ff-b816c18cf25f", 1, "b64fab56fdce275b29a99dd63f1ecd84a95419d3e0c8a4e752ebdf91e5321951")
]);

export class DependencyContractManifest {
  constructor({ resolveArtifactPin, entries = OBSERVABILITY_DEPENDENCY_PINS } = {}) {
    this.resolveArtifactPin = resolveArtifactPin;
    this.entries = entries;
    this.state = "required_unresolved";
    this.diagnostics = [];
    this.manifestIdentity = manifestIdentity(this.entries);
  }

  verify() {
    this.diagnostics = [];
    const required = new Set(OBSERVABILITY_DEPENDENCY_PINS.map((entry) => entry.dependency));
    for (const entry of this.entries) {
      if (!required.delete(entry.dependency) || !entry.artifactId?.startsWith("artifact:")
        || !Number.isInteger(entry.version) || entry.version < 1 || !/^[a-f0-9]{64}$/.test(entry.contentHash ?? "")
        || entry.acceptanceState !== "approved_fixed") {
        this.diagnostics.push({ code: "DEPENDENCY_CONTRACT_ENTRY_INVALID", dependency: entry.dependency ?? null });
      }
    }
    for (const dependency of required) this.diagnostics.push({ code: "DEPENDENCY_CONTRACT_PIN_MISSING", dependency });
    if (typeof this.resolveArtifactPin === "function") {
      for (const expected of this.entries) {
        const actual = this.resolveArtifactPin(expected.artifactId, expected.version);
        if (!actual) {
          this.diagnostics.push({ code: "DEPENDENCY_CONTRACT_PIN_MISSING", dependency: expected.dependency });
          continue;
        }
        if (actual.version !== expected.version || actual.contentHash !== expected.contentHash
          || actual.acceptanceState !== expected.acceptanceState) {
          this.diagnostics.push({ code: "DEPENDENCY_CONTRACT_PIN_MISMATCH", dependency: expected.dependency });
        }
      }
    } else {
      this.diagnostics.push({ code: "DEPENDENCY_CONTRACT_RESOLVER_UNAVAILABLE", dependency: null });
    }
    this.state = this.diagnostics.length === 0 ? "resolved" : "required_unresolved";
    return this.snapshot();
  }

  requireResolved() {
    if (this.state !== "resolved") throw codedError(
      "DEPENDENCY_CONTRACT_REQUIRED_UNRESOLVED",
      "Source identity dependency contracts are not resolved.", 409,
      { diagnostics: this.diagnostics }
    );
  }

  requireArtifactRef(dependency, artifactRef, { receiptType, schemaVersion } = {}) {
    this.requireResolved();
    const expected = this.entries.find((entry) => entry.dependency === dependency);
    const allowed = new Set(["artifactId", "version", "contentHash", "relation", "receiptType", "schemaVersion"]);
    if (!expected || !artifactRef || Object.keys(artifactRef).some((key) => !allowed.has(key))
      || Object.keys(artifactRef).length !== allowed.size || artifactRef.artifactId !== expected.artifactId
      || artifactRef.version !== expected.version || artifactRef.contentHash !== expected.contentHash
      || artifactRef.relation !== "implementation_spec"
      || (receiptType != null && artifactRef.receiptType !== receiptType)
      || (schemaVersion != null && artifactRef.schemaVersion !== schemaVersion)) {
      throw codedError("DEPENDENCY_CONTRACT_RECEIPT_ARTIFACT_MISMATCH",
        `The ${dependency} receipt does not reference its approved fixed contract.`, 409,
        { dependency });
    }
    return expected;
  }

  snapshot() {
    return { schemaVersion: 1, state: this.state, manifestIdentity: this.manifestIdentity,
      entries: this.entries, diagnostics: this.diagnostics };
  }
}

function pin(dependency, acceptanceState, artifactId, version, contentHash) {
  return Object.freeze({ dependency, acceptanceState, artifactId, version, contentHash });
}

function manifestIdentity(entries) {
  const canonical = JSON.stringify({ schemaVersion: 1, entries: [...entries].sort((a, b) => a.dependency.localeCompare(b.dependency)) });
  return `dcm1:${createHash("sha256").update(canonical).digest("hex")}`;
}

export function codedError(code, message, statusCode = 400, details) {
  const error = new Error(message); error.code = code; error.statusCode = statusCode;
  if (details) error.details = details;
  return error;
}
