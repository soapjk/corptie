import { createdAtFromOrNow } from "../../utils/timestamps.mjs";
import { parseJson } from "../storedJson.mjs";
import { requiredText } from "../validation.mjs";
import { recoveryStableJson } from "../recoveryStableJson.mjs";

export class SessionToolCatalogRepository {
  constructor({ getDatabase, selectAll, selectOne, scheduleSave }) {
    this.getDatabase = getDatabase;
    this.selectAll = selectAll;
    this.selectOne = selectOne;
    this.scheduleSave = scheduleSave;
  }

  get db() {
    return this.getDatabase();
  }

  getSessionToolCatalogMaterialization(logicalSessionId, providerBindingId) {
    const row = this.selectOne(
      `SELECT * FROM session_tool_catalog_materializations
       WHERE logical_session_id = ? AND provider_binding_id = ?`,
      [logicalSessionId, providerBindingId]
    );
    return row ? sessionToolCatalogMaterializationFromRow(row) : null;
  }

  listSessionToolCatalogMaterializations(logicalSessionId = null) {
    const rows = logicalSessionId
      ? this.selectAll(
        `SELECT * FROM session_tool_catalog_materializations
         WHERE logical_session_id = ? ORDER BY created_at, provider_binding_id`,
        [logicalSessionId]
      )
      : this.selectAll(
        `SELECT * FROM session_tool_catalog_materializations
         ORDER BY logical_session_id, created_at, provider_binding_id`,
        []
      );
    return rows.map(sessionToolCatalogMaterializationFromRow);
  }

  writeSessionToolCatalogDesired(input, expectedResourceVersion = null) {
    const now = input.updatedAt ?? createdAtFromOrNow();
    const existing = this.getSessionToolCatalogMaterialization(input.logicalSessionId, input.providerBindingId);
    if (!existing) {
      if (expectedResourceVersion != null) return null;
      this.db.run(
        `INSERT INTO session_tool_catalog_materializations (
          logical_session_id, provider_binding_id, desired_version, applied_version,
          desired_catalog_version, applied_catalog_version, desired_domains_json,
          applied_domains_json, exposure_plan_json, provider_receipt_json, status,
          attempt, refresh_requested_at, resource_version, created_at, updated_at
        ) VALUES (?, ?, ?, NULL, ?, NULL, ?, '[]', ?, NULL, 'stale', 0, ?, 1, ?, ?)`,
        [
          input.logicalSessionId, input.providerBindingId, input.desiredVersion,
          input.desiredCatalogVersion, JSON.stringify(input.desiredDomains ?? []),
          JSON.stringify(input.exposurePlan ?? {}), now, now, now
        ]
      );
      this.scheduleSave();
      return this.getSessionToolCatalogMaterialization(input.logicalSessionId, input.providerBindingId);
    }
    const expected = expectedResourceVersion ?? existing.resourceVersion;
    this.db.run(
      `UPDATE session_tool_catalog_materializations SET
         desired_version = ?, desired_catalog_version = ?, desired_domains_json = ?,
         exposure_plan_json = ?, status = CASE
           WHEN desired_version = ? AND applied_version = ? THEN status ELSE 'stale' END,
         refresh_requested_at = ?, last_error_code = NULL, last_error_summary = NULL,
         resource_version = resource_version + 1, updated_at = ?
       WHERE logical_session_id = ? AND provider_binding_id = ?
         AND resource_version = ? AND status <> 'canceled'`,
      [
        input.desiredVersion, input.desiredCatalogVersion, JSON.stringify(input.desiredDomains ?? []),
        JSON.stringify(input.exposurePlan ?? {}), input.desiredVersion, input.desiredVersion,
        now, now, input.logicalSessionId, input.providerBindingId, expected
      ]
    );
    if (this.db.getRowsModified() === 0) return null;
    this.scheduleSave();
    return this.getSessionToolCatalogMaterialization(input.logicalSessionId, input.providerBindingId);
  }

  beginSessionToolCatalogRefresh(logicalSessionId, providerBindingId, expectedResourceVersion, now = createdAtFromOrNow()) {
    this.db.run(
      `UPDATE session_tool_catalog_materializations SET
         status = 'refreshing', attempt = attempt + 1, refresh_started_at = ?,
         last_error_code = NULL, last_error_summary = NULL,
         resource_version = resource_version + 1, updated_at = ?
       WHERE logical_session_id = ? AND provider_binding_id = ? AND resource_version = ?
         AND status IN ('stale', 'error', 'uninitialized')`,
      [now, now, logicalSessionId, providerBindingId, expectedResourceVersion]
    );
    if (this.db.getRowsModified() === 0) return null;
    this.scheduleSave();
    return this.getSessionToolCatalogMaterialization(logicalSessionId, providerBindingId);
  }

  applySessionToolCatalogReceipt(input, expectedResourceVersion) {
    const now = input.appliedAt ?? createdAtFromOrNow();
    this.db.run(
      `UPDATE session_tool_catalog_materializations SET
         applied_version = ?, applied_catalog_version = ?, applied_domains_json = ?,
         provider_receipt_json = ?, status = 'applied', applied_at = ?,
         last_error_code = NULL, last_error_summary = NULL,
         resource_version = resource_version + 1, updated_at = ?
       WHERE logical_session_id = ? AND provider_binding_id = ? AND resource_version = ?
         AND status = 'refreshing' AND desired_version = ?`,
      [
        input.appliedVersion, input.appliedCatalogVersion, JSON.stringify(input.appliedDomains ?? []),
        JSON.stringify(input.providerReceipt), now, now, input.logicalSessionId,
        input.providerBindingId, expectedResourceVersion, input.appliedVersion
      ]
    );
    if (this.db.getRowsModified() === 0) return null;
    this.scheduleSave();
    return this.getSessionToolCatalogMaterialization(input.logicalSessionId, input.providerBindingId);
  }

  failSessionToolCatalogRefresh(input, expectedResourceVersion) {
    const now = input.updatedAt ?? createdAtFromOrNow();
    this.db.run(
      `UPDATE session_tool_catalog_materializations SET
         status = 'error', last_error_code = ?, last_error_summary = ?,
         resource_version = resource_version + 1, updated_at = ?
       WHERE logical_session_id = ? AND provider_binding_id = ? AND resource_version = ?
         AND status = 'refreshing'`,
      [
        input.errorCode, String(input.errorSummary ?? "").slice(0, 500), now,
        input.logicalSessionId, input.providerBindingId, expectedResourceVersion
      ]
    );
    if (this.db.getRowsModified() === 0) return null;
    this.scheduleSave();
    return this.getSessionToolCatalogMaterialization(input.logicalSessionId, input.providerBindingId);
  }

  invalidateSessionToolCatalogAppliedProof(input, expectedResourceVersion) {
    const now = input.updatedAt ?? createdAtFromOrNow();
    this.db.run(
      `UPDATE session_tool_catalog_materializations SET
         status = 'error', last_error_code = ?, last_error_summary = ?,
         resource_version = resource_version + 1, updated_at = ?
       WHERE logical_session_id = ? AND provider_binding_id = ? AND resource_version = ?
         AND status = 'applied'`,
      [
        input.errorCode, String(input.errorSummary ?? "").slice(0, 500), now,
        input.logicalSessionId, input.providerBindingId, expectedResourceVersion
      ]
    );
    if (this.db.getRowsModified() === 0) return null;
    this.scheduleSave();
    return this.getSessionToolCatalogMaterialization(input.logicalSessionId, input.providerBindingId);
  }

  markSessionToolCatalogRecoveryRequired(input, expectedResourceVersion) {
    const now = input.updatedAt ?? createdAtFromOrNow();
    this.db.run(
      `UPDATE session_tool_catalog_materializations SET
         status = 'error', last_error_code = ?, last_error_summary = ?,
         resource_version = resource_version + 1, updated_at = ?
       WHERE logical_session_id = ? AND provider_binding_id = ? AND resource_version = ?
         AND status IN ('applied', 'error')`,
      [
        input.errorCode, String(input.errorSummary ?? "").slice(0, 500), now,
        input.logicalSessionId, input.providerBindingId, expectedResourceVersion
      ]
    );
    if (this.db.getRowsModified() === 0) return null;
    this.scheduleSave();
    return this.getSessionToolCatalogMaterialization(input.logicalSessionId, input.providerBindingId);
  }

  adoptCompatibleSessionToolCatalogDefinition(input, expectedResourceVersion) {
    const now = input.updatedAt ?? createdAtFromOrNow();
    this.db.run(
      `UPDATE session_tool_catalog_materializations SET
         desired_version = ?, applied_version = ?,
         desired_catalog_version = ?, applied_catalog_version = ?,
         desired_domains_json = ?, applied_domains_json = ?, exposure_plan_json = ?,
         status = 'applied', last_error_code = NULL, last_error_summary = NULL,
         applied_at = COALESCE(applied_at, ?),
         resource_version = resource_version + 1, updated_at = ?
       WHERE logical_session_id = ? AND provider_binding_id = ? AND resource_version = ?
         AND status IN ('applied', 'error') AND provider_receipt_json IS NOT NULL`,
      [
        input.desiredVersion, input.desiredVersion,
        input.desiredCatalogVersion, input.desiredCatalogVersion,
        JSON.stringify(input.desiredDomains ?? []), JSON.stringify(input.desiredDomains ?? []),
        JSON.stringify(input.exposurePlan ?? {}), now, now,
        input.logicalSessionId, input.providerBindingId, expectedResourceVersion
      ]
    );
    if (this.db.getRowsModified() === 0) return null;
    this.scheduleSave();
    return this.getSessionToolCatalogMaterialization(input.logicalSessionId, input.providerBindingId);
  }

  insertAppliedSessionToolCatalogMaterialization(input, expected = {}) {
    if (input == null) {
      if (expected.required) {
        const error = new Error("The replacement Provider binding is missing its authoritative Tool materialization.");
        error.code = "PROVIDER_TOOL_MATERIALIZATION_REQUIRED";
        throw error;
      }
      return null;
    }
    const invalid = (field, message = null) => {
      const error = new Error(message ?? `Replacement Tool materialization ${field} is invalid.`);
      error.code = "PROVIDER_TOOL_MATERIALIZATION_INVALID";
      error.field = field;
      throw error;
    };
    const logicalSessionId = requiredText(input.logicalSessionId, "toolMaterialization.logicalSessionId");
    const providerBindingId = requiredText(input.providerBindingId, "toolMaterialization.providerBindingId");
    if (logicalSessionId !== expected.logicalSessionId) invalid("logicalSessionId");
    if (providerBindingId !== expected.providerBindingId) invalid("providerBindingId");
    if (!["applied", "stale"].includes(input.status)) invalid("status");
    const desiredVersion = requiredText(input.desiredVersion, "toolMaterialization.desiredVersion");
    const desiredCatalogVersion = requiredText(
      input.desiredCatalogVersion,
      "toolMaterialization.desiredCatalogVersion"
    );
    if (!Array.isArray(input.desiredDomains)) invalid("desiredDomains");
    if (!Array.isArray(input.appliedDomains)) invalid("appliedDomains");
    const desiredDomainIds = new Set(input.desiredDomains.map((domain) => requiredText(
      domain?.domainId,
      "toolMaterialization.desiredDomains[].domainId"
    )));
    if (desiredDomainIds.size !== input.desiredDomains.length) invalid("desiredDomains");
    const sourceDesiredDomains = Array.isArray(expected.sourceDesiredDomains) ? expected.sourceDesiredDomains : [];
    const sourceAppliedDomains = Array.isArray(expected.sourceAppliedDomains) ? expected.sourceAppliedDomains : [];
    for (const sourceDomain of [...sourceDesiredDomains, ...sourceAppliedDomains]) {
      if (!desiredDomainIds.has(requiredText(sourceDomain?.domainId, "sourceToolDomain.domainId"))) {
        invalid("desiredDomains", "Replacement Tool materialization dropped a source binding Tool domain.");
      }
    }
    // Preserve the domain set, not stale serialized schema metadata. A fresh
    // binding must rematerialize each domain from the current Catalog so a
    // replacement is exactly where a newer schema can become effective.
    const exposurePlan = input.exposurePlan;
    if (!exposurePlan || typeof exposurePlan !== "object" || Array.isArray(exposurePlan)) {
      invalid("exposurePlan");
    }
    const providerCapabilityRevision = requiredText(
      exposurePlan.capabilityRevision,
      "toolMaterialization.exposurePlan.capabilityRevision"
    );
    const exposurePlanHash = requiredText(
      exposurePlan.exposurePlanHash,
      "toolMaterialization.exposurePlan.exposurePlanHash"
    );
    const providerDefinitionsHash = requiredText(
      exposurePlan.providerDefinitionsHash,
      "toolMaterialization.exposurePlan.providerDefinitionsHash"
    );
    const refreshMode = requiredText(exposurePlan.refreshMode, "toolMaterialization.exposurePlan.refreshMode");
    if (!Array.isArray(exposurePlan.providerDefinitions)) invalid("exposurePlan.providerDefinitions");
    if (input.status === "stale") {
      if (input.appliedVersion != null) invalid("appliedVersion");
      if (input.appliedCatalogVersion != null) invalid("appliedCatalogVersion");
      if (input.appliedDomains.length !== 0) invalid("appliedDomains");
      if (input.providerReceipt != null) invalid("providerReceipt");
      const now = expected.createdAt ?? input.updatedAt ?? createdAtFromOrNow();
      this.db.run(
        `INSERT INTO session_tool_catalog_materializations (
          logical_session_id, provider_binding_id, desired_version, applied_version,
          desired_catalog_version, applied_catalog_version, desired_domains_json,
          applied_domains_json, exposure_plan_json, provider_receipt_json, status,
          attempt, refresh_requested_at, resource_version, created_at, updated_at
        ) VALUES (?, ?, ?, NULL, ?, NULL, ?, '[]', ?, NULL, 'stale', 0, ?, 1, ?, ?)`,
        [
          logicalSessionId, providerBindingId, desiredVersion, desiredCatalogVersion,
          JSON.stringify(input.desiredDomains), JSON.stringify(exposurePlan), now, now, now
        ]
      );
      return this.getSessionToolCatalogMaterialization(logicalSessionId, providerBindingId);
    }
    const appliedVersion = requiredText(input.appliedVersion, "toolMaterialization.appliedVersion");
    if (desiredVersion !== appliedVersion) invalid("appliedVersion");
    const appliedCatalogVersion = requiredText(
      input.appliedCatalogVersion,
      "toolMaterialization.appliedCatalogVersion"
    );
    if (desiredCatalogVersion !== appliedCatalogVersion) invalid("appliedCatalogVersion");
    if (recoveryStableJson(input.desiredDomains) !== recoveryStableJson(input.appliedDomains)) {
      invalid("appliedDomains", "Replacement Tool materialization must apply every desired domain atomically.");
    }
    const providerReceipt = input.providerReceipt;
    if (!providerReceipt || typeof providerReceipt !== "object" || Array.isArray(providerReceipt)) {
      invalid("providerReceipt");
    }
    const receiptFields = [
      ["providerBindingId", providerBindingId],
      ["providerCapabilityRevision", providerCapabilityRevision],
      ["requestedVersion", desiredVersion],
      ["appliedVersion", appliedVersion],
      ["appliedCatalogVersion", appliedCatalogVersion],
      ["appliedExposurePlanHash", exposurePlanHash],
      ["providerDefinitionsHash", providerDefinitionsHash],
      ["refreshMode", refreshMode]
    ];
    for (const [field, value] of receiptFields) {
      if (providerReceipt[field] !== value) invalid(`providerReceipt.${field}`);
    }
    if (exposurePlan.providerContractHash != null
      && providerReceipt.providerContractHash !== exposurePlan.providerContractHash) {
      invalid("providerReceipt.providerContractHash");
    }
    if (recoveryStableJson(providerReceipt.appliedDomains ?? []) !== recoveryStableJson(input.appliedDomains)) {
      invalid("providerReceipt.appliedDomains");
    }
    if (providerReceipt.providerDefinitionsCount !== exposurePlan.providerDefinitions.length) {
      invalid("providerReceipt.providerDefinitionsCount");
    }
    const providerObservationKind = requiredText(
      providerReceipt.providerObservationKind,
      "toolMaterialization.providerReceipt.providerObservationKind"
    );
    const providerRevision = requiredText(
      providerReceipt.providerRevision,
      "toolMaterialization.providerReceipt.providerRevision"
    );
    requiredText(providerReceipt.receiptId, "toolMaterialization.providerReceipt.receiptId");
    const appliedAt = requiredText(
      input.appliedAt ?? providerReceipt.appliedAt,
      "toolMaterialization.appliedAt"
    );
    if (providerReceipt.appliedAt !== appliedAt) invalid("providerReceipt.appliedAt");
    if (expected.providerId === "codex-app-server") {
      const providerSessionId = requiredText(expected.providerSessionId, "expected.providerSessionId");
      const startProof = providerRevision.startsWith(`thread-start:${providerSessionId}:`)
        && providerObservationKind === "thread_start_accepted";
      const forkProof = providerRevision.startsWith(`thread-fork-inherited:${providerSessionId}:`)
        && providerObservationKind === "thread_fork_inherited";
      if (!startProof && !forkProof) invalid("providerReceipt.providerObservationKind");
    }
    if (expected.providerConfirmation) {
      const confirmationFields = [
        "providerRevision",
        "providerDefinitionsHash",
        "providerDefinitionsCount",
        "providerObservationKind"
      ];
      for (const field of confirmationFields) {
        if (providerReceipt[field] !== expected.providerConfirmation[field]) {
          invalid(`providerReceipt.${field}`);
        }
      }
    }
    const now = expected.createdAt ?? appliedAt;
    this.db.run(
      `INSERT INTO session_tool_catalog_materializations (
        logical_session_id, provider_binding_id, desired_version, applied_version,
        desired_catalog_version, applied_catalog_version, desired_domains_json,
        applied_domains_json, exposure_plan_json, provider_receipt_json, status,
        attempt, refresh_requested_at, refresh_started_at, applied_at,
        resource_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'applied', ?, ?, ?, ?, 1, ?, ?)`,
      [
        logicalSessionId, providerBindingId, desiredVersion, appliedVersion,
        desiredCatalogVersion, appliedCatalogVersion, JSON.stringify(input.desiredDomains),
        JSON.stringify(input.appliedDomains), JSON.stringify(exposurePlan), JSON.stringify(providerReceipt),
        Number.isSafeInteger(input.attempt) && input.attempt > 0 ? input.attempt : 1,
        now, now, appliedAt, now, now
      ]
    );
    return this.getSessionToolCatalogMaterialization(logicalSessionId, providerBindingId);
  }

  recordSessionToolCatalogPendingReceipt(input, expectedResourceVersion) {
    const now = input.updatedAt ?? createdAtFromOrNow();
    this.db.run(
      `UPDATE session_tool_catalog_materializations SET provider_receipt_json = ?,
         resource_version = resource_version + 1, updated_at = ?
       WHERE logical_session_id = ? AND provider_binding_id = ? AND resource_version = ?
         AND status = 'refreshing'`,
      [
        JSON.stringify(input.providerReceipt), now, input.logicalSessionId,
        input.providerBindingId, expectedResourceVersion
      ]
    );
    if (this.db.getRowsModified() === 0) return null;
    this.scheduleSave();
    return this.getSessionToolCatalogMaterialization(input.logicalSessionId, input.providerBindingId);
  }

  cancelSessionToolCatalogMaterialization(logicalSessionId, providerBindingId, expectedResourceVersion = null) {
    const now = createdAtFromOrNow();
    const versionClause = expectedResourceVersion == null ? "" : " AND resource_version = ?";
    this.db.run(
      `UPDATE session_tool_catalog_materializations SET status = 'canceled',
         last_error_code = 'SESSION_BINDING_TOMBSTONED', last_error_summary = NULL,
         resource_version = resource_version + 1, updated_at = ?
       WHERE logical_session_id = ? AND provider_binding_id = ? AND status <> 'canceled'${versionClause}`,
      [now, logicalSessionId, providerBindingId, ...(expectedResourceVersion == null ? [] : [expectedResourceVersion])]
    );
    if (this.db.getRowsModified() === 0) return null;
    this.scheduleSave();
    return this.getSessionToolCatalogMaterialization(logicalSessionId, providerBindingId);
  }
}

function sessionToolCatalogMaterializationFromRow(row) {
  return {
    logicalSessionId: row.logical_session_id,
    providerBindingId: row.provider_binding_id,
    desiredVersion: row.desired_version,
    appliedVersion: row.applied_version ?? null,
    desiredCatalogVersion: row.desired_catalog_version,
    appliedCatalogVersion: row.applied_catalog_version ?? null,
    desiredDomains: parseJson(row.desired_domains_json, []),
    appliedDomains: parseJson(row.applied_domains_json, []),
    exposurePlan: parseJson(row.exposure_plan_json, {}),
    providerReceipt: row.provider_receipt_json ? parseJson(row.provider_receipt_json, null) : null,
    status: row.status,
    attempt: Number(row.attempt ?? 0),
    lastErrorCode: row.last_error_code ?? null,
    lastErrorSummary: row.last_error_summary ?? null,
    refreshRequestedAt: row.refresh_requested_at ?? null,
    refreshStartedAt: row.refresh_started_at ?? null,
    appliedAt: row.applied_at ?? null,
    resourceVersion: Number(row.resource_version),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
