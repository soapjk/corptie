import Foundation
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

        try await repository.storeTimelineWindow(
            Data("newest".utf8),
            sessionID: "session:a",
            revision: 20,
            savedAtMilliseconds: 20
        )
        try await repository.storeTimelineWindow(
            Data("old".utf8),
            sessionID: "session:a",
            revision: 10,
            savedAtMilliseconds: 30
        )
        let restoredWindow = try await repository.loadTimelineWindow(sessionID: "session:a")
        XCTAssertEqual(restoredWindow?.payload, Data("newest".utf8))
    }

    func testTimelineWindowsUseBoundedLRUWithoutDeletingViewportPositions() async throws {
        let databaseURL = temporaryDatabaseURL()
        defer { try? FileManager.default.removeItem(at: databaseURL.deletingLastPathComponent()) }
        let repository = SessionTimelinePositionRepository(databaseURL: databaseURL)
        let position = AppKitChatTimelinePosition(
            rowID: "message:permanent",
            offset: 3,
            absoluteScrollY: 30,
            followsLatest: false
        )
        try await repository.upsert(position, for: "session:000", savedAtMilliseconds: 1)

        for index in 0..<257 {
            try await repository.storeTimelineWindow(
                Data("{\"session\":\(index)}".utf8),
                sessionID: "session:\(String(format: "%03d", index))",
                revision: Int64(index),
                savedAtMilliseconds: Int64(index + 1)
            )
        }

        let evictedWindow = try await repository.loadTimelineWindow(sessionID: "session:000")
        let retainedWindow = try await repository.loadTimelineWindow(sessionID: "session:256")
        let retainedPosition = try await repository.load(sessionID: "session:000")
        XCTAssertNil(evictedWindow)
        XCTAssertNotNil(retainedWindow)
        XCTAssertEqual(retainedPosition?.position, position)
    }

    private func temporaryDatabaseURL() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("SessionTimelinePositionRepositoryTests-\(UUID().uuidString)")
            .appendingPathComponent("presentation.sqlite3")
    }
}
