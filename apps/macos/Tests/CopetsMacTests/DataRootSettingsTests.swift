import Foundation
import Testing
@testable import CorptieMac

struct DataRootSettingsTests {
    @Test func backendSettingsDecodesTheControlledMigrationOperation() throws {
        let data = Data(#"""
        {
          "environment":"development",
          "dataRoot":"/Users/example/.corptie",
          "dataRootMigration":{
            "operationId":"data_root_migration:one",
            "generation":8,
            "phase":"restartRequired",
            "sourceDataRoot":"/old/root",
            "targetDataRoot":"/Users/example/.corptie",
            "restartRequired":true,
            "oldDataRootRetained":true,
            "history":[{"phase":"preflight","at":"2026-08-28T00:00:00.000Z"}],
            "receipt":{
              "databaseIntegrity":"ok",
              "keyRecordCounts":{"objectives":2,"work_items":3,"sessions":4,"artifact_versions":5},
              "artifactCount":5,
              "artifactBytes":128,
              "verifiedFileCount":9,
              "verifiedFileBytes":512,
              "sourceDataRoot":"/old/root",
              "dataRoot":"/Users/example/.corptie"
            }
          }
        }
        """#.utf8)
        let settings = try JSONDecoder().decode(BackendSettings.self, from: data)
        #expect(settings.dataRoot == "/Users/example/.corptie")
        #expect(settings.dataRootMigration?.phase == "restartRequired")
        #expect(settings.dataRootMigration?.restartRequired == true)
        #expect(settings.dataRootMigration?.receipt?.keyRecordCounts["sessions"] == 4)
    }

    @Test func backendSettingsRejectsUnknownAndDeprecatedPathFields() {
        for field in ["dataDir", "logDir", "dbPath", "configPath", "mysteryPath"] {
            let data = Data("{\"dataRoot\":\"/tmp/corptie\",\"\(field)\":\"/tmp/retired\"}".utf8)
            #expect(throws: DecodingError.self) {
                try JSONDecoder().decode(BackendSettings.self, from: data)
            }
        }
    }

    @Test func settingsViewOnlyOffersTheUnifiedDataRoot() throws {
        let source = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac/CopetsMacApp.swift")
        let contents = try String(contentsOf: source, encoding: .utf8)
        #expect(contents.contains("Text(L10n(\"Data Root\"))"))
        #expect(contents.contains("chooseDataRoot()"))
        #expect(contents.contains("dataRootMigrationPhaseLabel"))
        #expect(contents.contains("DataRootMigrationDialogState"))
        #expect(contents.contains("Migrate and Restart"))
        #expect(contents.contains("confirmDataRootMigration"))
        #expect(contents.contains("dataRoot = backendClient.settings?.dataRoot ?? dialog.sourceDataRoot"))
        #expect(contents.contains("never deleted automatically"))
        #expect(!contents.contains("Text(L10n(\"Log Directory\"))"))
        #expect(!contents.contains("settings.dbPath"))
        #expect(!contents.contains("settings.configPath"))
    }

    @Test func migrationProgressAdvancesAcrossControlledRestartPhases() {
        let phases = [
            "preflight", "quiescing", "checkpointing", "copying", "verifying",
            "switching", "restartRequired", "reconnecting", "completed"
        ]
        let progress = phases.map(DataRootMigrationPresentation.progress(for:))
        #expect(progress == progress.sorted())
        #expect(progress.first == 0.08)
        #expect(progress.last == 1.0)
        #expect(DataRootMigrationPresentation.progress(for: "failed") == 0)
        #expect(DataRootMigrationPresentation.pathsEqual("/tmp/corptie", "/tmp/example/../corptie/"))
        #expect(!DataRootMigrationPresentation.pathsEqual("/tmp/corptie", "/tmp/other"))
    }

    @Test func migrationFailureDecodesConcretePersistentWriterBlockers() throws {
        let data = Data(#"""
        {
          "operationId":"data_root_migration:busy",
          "generation":2,
          "phase":"failed",
          "sourceDataRoot":"/old/root",
          "targetDataRoot":"/new/root",
          "restartRequired":false,
          "oldDataRootRetained":true,
          "error":{
            "code":"DATA_ROOT_MIGRATION_BUSY",
            "message":"Data Root migration is blocked by active persistent work.",
            "details":{"blockers":[
              {"kind":"active_session_turns","count":2},
              {"kind":"scheduled_tasks","count":1}
            ]}
          },
          "history":[]
        }
        """#.utf8)
        let operation = try JSONDecoder().decode(DataRootMigrationOperation.self, from: data)
        #expect(operation.error?.code == "DATA_ROOT_MIGRATION_BUSY")
        #expect(operation.error?.details?.blockers?.map(\.count) == [2, 1])
    }

    @Test func migrationFailureDecodesAffectedArtifactWithoutExposingAnAbsolutePath() throws {
        let data = Data(#"""
        {
          "operationId":"data_root_migration:artifact",
          "generation":3,
          "phase":"failed",
          "sourceDataRoot":"/old/root",
          "targetDataRoot":"/new/root",
          "restartRequired":false,
          "oldDataRootRetained":true,
          "error":{
            "code":"DATA_ROOT_ARTIFACT_MISSING",
            "message":"Artifact content referenced by the active database is missing.",
            "details":{"artifactId":"artifact:one","version":2,"storageKey":"objects/aa/hash"}
          },
          "history":[]
        }
        """#.utf8)
        let operation = try JSONDecoder().decode(DataRootMigrationOperation.self, from: data)
        #expect(operation.error?.details?.artifactId == "artifact:one")
        #expect(operation.error?.details?.version == 2)
        #expect(operation.error?.message.contains("/old/root") == false)
    }

    @Test func backendClientDecodesStructuredMigrationFailuresAndPollsProgress() throws {
        let source = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac/BackendClient.swift")
        let contents = try String(contentsOf: source, encoding: .utf8)
        #expect(contents.contains("DataRootMigrationErrorEnvelope"))
        #expect(contents.contains("data-root-migrations/current"))
        #expect(contents.contains("refreshDataRootMigrationStatus(expectedTarget:"))
        #expect(contents.contains("dataRootMigrationPresentationPhase = operation.phase"))
    }

    @Test func pendingMigrationRecoverySurvivesAnAppProcessRestart() throws {
        let pending = PendingDataRootMigrationRecovery(
            operationId: "data_root_migration:app-crash",
            targetDataRoot: "/Volumes/Data/Corptie",
            recordedAt: Date(timeIntervalSince1970: 1_787_875_200)
        )
        let restored = try JSONDecoder().decode(
            PendingDataRootMigrationRecovery.self,
            from: JSONEncoder().encode(pending)
        )
        #expect(restored == pending)

        let source = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac/BackendClient.swift")
        let contents = try String(contentsOf: source, encoding: .utf8)
        #expect(contents.contains("recoverPendingDataRootMigrationIfNeeded"))
        #expect(contents.contains("ensureBackendRunningForPendingDataRootMigration"))
        #expect(contents.contains("clearPendingDataRootMigration"))
    }
}
