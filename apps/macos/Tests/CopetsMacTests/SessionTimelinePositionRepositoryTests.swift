import Foundation
import SQLite3
import XCTest
@testable import CorptieMac

final class SessionTimelinePositionRepositoryTests: XCTestCase {
    func testPersistsEverySessionWithoutLRUEviction() async throws {
        let databaseURL = temporaryDatabaseURL()
        defer { try? FileManager.default.removeItem(at: databaseURL.deletingLastPathComponent()) }
        let repository = SessionTimelinePositionRepository(databaseURL: databaseURL)

        for index in 0..<1_000 {
            try await repository.upsert(
                .init(
                    rowID: "message:\(index)",
                    offset: Double(index % 17),
                    absoluteScrollY: Double(index * 10),
                    followsLatest: false
                ),
                for: "session:\(index)",
                savedAtMilliseconds: Int64(index + 1)
            )
        }

        let records = try await repository.loadAll()
        let first = try await repository.load(sessionID: "session:0")
        let last = try await repository.load(sessionID: "session:999")
        XCTAssertEqual(records.count, 1_000)
        XCTAssertEqual(first?.position.rowID, "message:0")
        XCTAssertEqual(last?.position.absoluteScrollY, 9_990)
    }

    func testOlderAsynchronousWriteCannotOverwriteNewestPosition() async throws {
        let databaseURL = temporaryDatabaseURL()
        defer { try? FileManager.default.removeItem(at: databaseURL.deletingLastPathComponent()) }
        let repository = SessionTimelinePositionRepository(databaseURL: databaseURL)
        let newest = AppKitChatTimelinePosition(
            rowID: "message:newest",
            offset: 12,
            absoluteScrollY: 240,
            followsLatest: false
        )

        try await repository.upsert(newest, for: "session:a", savedAtMilliseconds: 20)
        try await repository.upsert(
            .init(rowID: "message:old", offset: 0, absoluteScrollY: 0, followsLatest: true),
            for: "session:a",
            savedAtMilliseconds: 10
        )

        let restored = try await repository.load(sessionID: "session:a")
        XCTAssertEqual(restored?.position, newest)
    }

    func testMigrationDropsTheObsoleteTimelineWindowCacheTable() async throws {
        let databaseURL = temporaryDatabaseURL()
        defer { try? FileManager.default.removeItem(at: databaseURL.deletingLastPathComponent()) }
        try FileManager.default.createDirectory(
            at: databaseURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        var handle: OpaquePointer?
        XCTAssertEqual(sqlite3_open(databaseURL.path, &handle), SQLITE_OK)
        XCTAssertEqual(sqlite3_exec(
            handle,
            "CREATE TABLE session_timeline_windows_v1 (session_id TEXT PRIMARY KEY, payload_json BLOB)",
            nil,
            nil,
            nil
        ), SQLITE_OK)
        sqlite3_close(handle)

        let repository = SessionTimelinePositionRepository(databaseURL: databaseURL)
        _ = try await repository.loadAll()

        handle = nil
        XCTAssertEqual(sqlite3_open_v2(databaseURL.path, &handle, SQLITE_OPEN_READONLY, nil), SQLITE_OK)
        defer { sqlite3_close(handle) }
        var statement: OpaquePointer?
        XCTAssertEqual(sqlite3_prepare_v2(
            handle,
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_timeline_windows_v1'",
            -1,
            &statement,
            nil
        ), SQLITE_OK)
        defer { sqlite3_finalize(statement) }
        XCTAssertEqual(sqlite3_step(statement), SQLITE_DONE)
    }

    private func temporaryDatabaseURL() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("SessionTimelinePositionRepositoryTests-\(UUID().uuidString)")
            .appendingPathComponent("presentation.sqlite3")
    }
}
