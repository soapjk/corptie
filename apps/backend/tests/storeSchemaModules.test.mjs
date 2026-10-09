import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { CorptieStore } from "../src/store/corptieStore.mjs";
import { migrateTaskProjectionColumns, migrateTaskCreationOrigins, migrateTaskLifecycleGuards } from "../src/store/migrations/taskEvolutionMigrations.mjs";
import { migrateArtifactTaxonomy } from "../src/store/migrations/artifactTaxonomyMigrations.mjs";
import { migrateStartupOperations } from "../src/store/migrations/startupOperationMigrations.mjs";
import { migrateCollaborationProtocol } from "../src/store/migrations/collaborationProtocolMigrations.mjs";
import { migrateSessionEventStorage } from "../src/store/migrations/sessionEventEvolutionMigrations.mjs";
import { migrateTaskSummary } from "../src/store/taskSummaryRepository.mjs";
import { ensureMemoryFoundationTables } from "../src/store/migrations/memoryFoundationMigrations.mjs";
import { ensureCollaborationDirectoryTables } from "../src/store/migrations/collaborationDirectoryMigrations.mjs";
import { ensureHubFoundationTables } from "../src/store/migrations/hubFoundationMigrations.mjs";
import { migrateSessionAssociationGuards } from "../src/store/migrations/sessionAssociationMigrations.mjs";
import { sessionRuntimeSchemaSql, workDomainSchemaSql } from "../src/store/migrations/index.mjs";
import { ensureSkillTables } from "../src/store/migrations/skillMigrations.mjs";
import { ensureStateSyncTables } from "../src/store/migrations/stateSyncMigrations.mjs";
import { ensureProviderEventPipelineTables } from "../src/store/migrations/providerPipelineMigrations.mjs";
import {
  migrateWorkspaceCreationRequestAuditReferences, migrateTaskMemoryAssociations,
  migrateSessionOwnedArtifacts
} from "../src/store/migrations/ownershipMigrations.mjs";
import {
  migrateCanonicalSessionNames, migrateCollaborationSessionIdentities,
  migrateSessionProviderBindings, migrateWorkspaceTransitionsForDirectoryTargets
} from "../src/store/migrations/sessionRoutingMigrations.mjs";

test("schema modules preserve the original SQL batches byte for byte", () => {
  // Recorded from the unsplit migration before moving any schema text.
  const hash = value => createHash("sha256").update(value).digest("hex");
  assert.equal(hash(sessionRuntimeSchemaSql), "644e2f5d960aa144cf0533b448e4dd8f27619ed96c04fba54044c7c19083a9cc");
  assert.equal(hash(workDomainSchemaSql), "9c1de325a9e531cd988108d2c65b932372d0744ceb657093187fc11e4930c7d2");
});

test("extracted schema migrations run directly on the caller connection without schema drift", async () => {
  const store = new CorptieStore({
    dbPath: ":memory:", configPath: "/unused-schema-module-config",
    manageProcessEnvironment: false
  });
  try {
    await store.initialize({ resolveDataPath: false });
    const context = {
      db: store.db, selectOne: store.selectOne.bind(store),
      selectAll: store.selectAll.bind(store), ensureColumn: store.ensureColumn.bind(store),
      runInTransaction: store.runInTransaction.bind(store),
      runDataMigrationOnce: store.runDataMigrationOnce.bind(store),
      dropColumnIfExists: store.dropColumnIfExists.bind(store),
      migrateTaskSummary: () => migrateTaskSummary(store),
      migrateCanonicalSessionNames: store.migrateCanonicalSessionNames.bind(store),
      migrateCollaborationSessionIdentities: store.migrateCollaborationSessionIdentities.bind(store),
      migrateSessionEventAgentMessageFlag: store.migrateSessionEventAgentMessageFlag.bind(store),
      migrateCanonicalCompletionAgentMessageFlag: store.migrateCanonicalCompletionAgentMessageFlag.bind(store),
      hadSessionReadReceipts: true
    };
    const schema = () => store.selectAll(
      "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name"
    );
    const before = schema();
    const revision = store.stateRevision();
    for (let pass = 0; pass < 2; pass += 1) {
      ensureMemoryFoundationTables(context);
      ensureCollaborationDirectoryTables(context);
      ensureHubFoundationTables(context);
      migrateSessionAssociationGuards(context);
      migrateTaskProjectionColumns(context);
      migrateArtifactTaxonomy(context);
      migrateTaskCreationOrigins(context);
      migrateStartupOperations(context);
      migrateTaskLifecycleGuards(context);
      migrateCollaborationProtocol(context);
      migrateSessionEventStorage(context);
      ensureSkillTables(context);
      ensureStateSyncTables(context);
      ensureProviderEventPipelineTables(context);
      migrateWorkspaceCreationRequestAuditReferences(context);
      migrateTaskMemoryAssociations(context);
      migrateSessionOwnedArtifacts(context);
      migrateCanonicalSessionNames(context);
      migrateCollaborationSessionIdentities(context);
      migrateSessionProviderBindings(context);
      migrateWorkspaceTransitionsForDirectoryTargets(context);
      assert.deepEqual(schema(), before);
      assert.equal(store.stateRevision(), revision);
      assert.deepEqual(store.selectAll("PRAGMA foreign_key_check"), []);
    }
  } finally {
    await store.close();
  }
});

test("empty database and repeated migration preserve schema and migration receipts", async () => {
  const store = new CorptieStore({
    dbPath: ":memory:", configPath: "/unused-schema-test-config",
    manageProcessEnvironment: false
  });
  try {
    await store.initialize({ resolveDataPath: false });
    const schema = () => store.selectAll(
      "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name"
    );
    const receipts = () => store.selectAll("SELECT * FROM data_migrations ORDER BY migration_id");
    const beforeSchema = schema();
    const beforeReceipts = receipts();
    store.migrate();
    assert.deepEqual(schema(), beforeSchema);
    assert.deepEqual(receipts(), beforeReceipts);
    assert.deepEqual(store.selectAll("PRAGMA foreign_key_check"), []);
  } finally {
    await store.close();
  }
});
