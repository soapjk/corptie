import Foundation
import Testing
@testable import CorptieMac

struct DataRootSettingsTests {
    @Test func backendSettingsDecodesTheUnifiedRootAndMigrationReceipt() throws {
        let data = Data(#"""
        {
          "environment":"development",
          "dataRoot":"/Users/example/.corptie",
          "migration":{
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
        """#.utf8)
        let settings = try JSONDecoder().decode(BackendSettings.self, from: data)
        #expect(settings.dataRoot == "/Users/example/.corptie")
        #expect(settings.migration?.databaseIntegrity == "ok")
        #expect(settings.migration?.keyRecordCounts["sessions"] == 4)
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
        #expect(!contents.contains("Text(L10n(\"Log Directory\"))"))
        #expect(!contents.contains("settings.dbPath"))
        #expect(!contents.contains("settings.configPath"))
    }
}
