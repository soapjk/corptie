import XCTest
@testable import CorptieMac

final class SessionTimelineBackgroundSyncTests: XCTestCase {
    func testUnopenedSessionTimelineAdvanceSchedulesWithoutFinalUnreadCursor() {
        XCTAssertTrue(SessionTimelineBackgroundSyncPolicy.shouldSchedule(
            previousServerRevision: 7,
            desiredServerRevision: 8,
            localRevision: 7,
            isSelected: false,
            hasResidentDetail: false,
            isUnread: false
        ))
        XCTAssertFalse(SessionTimelineBackgroundSyncPolicy.shouldSchedule(
            previousServerRevision: 8,
            desiredServerRevision: 8,
            localRevision: 7,
            isSelected: false,
            hasResidentDetail: false,
            isUnread: false
        ))
    }

    func testReconnectWarmsEveryActiveTimelineWhenStale() {
        for flags in [(true, false, false), (false, true, false), (false, false, true)] {
            XCTAssertTrue(SessionTimelineBackgroundSyncPolicy.shouldSchedule(
                previousServerRevision: nil,
                desiredServerRevision: 12,
                localRevision: 9,
                isSelected: flags.0,
                hasResidentDetail: flags.1,
                isUnread: flags.2
            ))
        }
        XCTAssertTrue(SessionTimelineBackgroundSyncPolicy.shouldSchedule(
            previousServerRevision: nil,
            desiredServerRevision: 12,
            localRevision: 9,
            isSelected: false,
            hasResidentDetail: false,
            isUnread: false
        ))
        XCTAssertFalse(SessionTimelineBackgroundSyncPolicy.shouldSchedule(
            previousServerRevision: nil,
            desiredServerRevision: 12,
            localRevision: 12,
            isSelected: true,
            hasResidentDetail: true,
            isUnread: true
        ))
    }

    func testAppliesOrderedUpsertsDeletesAndPreservesTimelineOrder() throws {
        let detail = detail(items: [item("old", at: "2026-08-24T00:00:02Z")])
        let envelope = try decodeEnvelope("""
        {
          "snapshotRequired": false,
          "baseRevision": 4,
          "revision": 7,
          "currentRevision": 7,
          "hasMore": false,
          "changes": [
            {"revision": 5, "itemId": "new", "operation": "upsert", "item": {
              "id": "new", "turnId": "turn-new", "turnStatus": "complete",
              "type": "agentMessage", "title": "Agent", "text": "new",
              "createdAt": "2026-08-24T00:00:01Z"
            }},
            {"revision": 6, "itemId": "old", "operation": "delete", "item": null},
            {"revision": 7, "itemId": "new", "operation": "upsert", "item": {
              "id": "new", "turnId": "turn-new", "turnStatus": "complete",
              "type": "agentMessage", "title": "Agent", "text": "newest",
              "createdAt": "2026-08-24T00:00:01Z"
            }}
          ]
        }
        """)

        guard case .applied(let merged, let revision) = SessionTimelineChangeMerger.merge(
            envelope,
            into: detail,
            localRevision: 4
        ) else { return XCTFail("Expected an applied delta") }

        XCTAssertEqual(revision, 7)
        XCTAssertEqual(merged.items.map(\.id), ["new"])
        XCTAssertEqual(merged.items.first?.text, "newest")
    }

    func testDuplicatePageIsIdempotent() throws {
        let envelope = try decodeEnvelope("""
        {"snapshotRequired": false, "baseRevision": 1, "revision": 2,
         "currentRevision": 2, "hasMore": false, "changes": [
           {"revision": 2, "itemId": "two", "operation": "delete", "item": null}
         ]}
        """)

        XCTAssertEqual(
            SessionTimelineChangeMerger.merge(envelope, into: detail(items: []), localRevision: 2),
            .duplicate
        )
    }

    func testGapOutOfOrderAndMissingPayloadRequireSnapshot() throws {
        let gap = try decodeEnvelope("""
        {"snapshotRequired": true, "currentRevision": 20}
        """)
        let outOfOrder = try decodeEnvelope("""
        {"snapshotRequired": false, "baseRevision": 4, "revision": 6,
         "currentRevision": 6, "changes": [
           {"revision": 6, "itemId": "six", "operation": "delete", "item": null}
         ]}
        """)
        let missingItem = try decodeEnvelope("""
        {"snapshotRequired": false, "baseRevision": 4, "revision": 5,
         "currentRevision": 5, "changes": [
           {"revision": 5, "itemId": "five", "operation": "upsert", "item": null}
         ]}
        """)
        let current = detail(items: [])

        XCTAssertEqual(SessionTimelineChangeMerger.merge(gap, into: current, localRevision: 4), .requiresSnapshot)
        XCTAssertEqual(SessionTimelineChangeMerger.merge(outOfOrder, into: current, localRevision: 4), .requiresSnapshot)
        XCTAssertEqual(SessionTimelineChangeMerger.merge(missingItem, into: current, localRevision: 4), .requiresSnapshot)
    }

    @MainActor
    func testRepositoryRevisionNeverRegressesAndCachedDetailIsImmediatelyResident() {
        let repository = SessionTimelineRepository()
        repository.publish(detail(items: [item("new")]), for: "session", timelineRevision: 9)
        repository.publish(detail(items: [item("same-revision-stale")]), for: "session", timelineRevision: 9)
        repository.publish(detail(items: [item("stale")]), for: "session", timelineRevision: 8)

        XCTAssertEqual(repository.timelineRevision(for: "session"), 9)
        XCTAssertEqual(repository.state(for: "session").detail?.items.map(\.id), ["new"])
    }

    func testNetworkPermitPoolCapsConcurrentTimelineRequests() async {
        let pool = SessionTimelineNetworkPermitPool(limit: 2)
        let counts = ConcurrentRequestCounts()
        await withTaskGroup(of: Void.self) { group in
            for _ in 0..<8 {
                group.addTask {
                    await pool.acquire()
                    await counts.enter()
                    try? await Task.sleep(for: .milliseconds(15))
                    await counts.leave()
                    await pool.release()
                }
            }
        }

        let finalCounts = await counts.snapshot()
        XCTAssertEqual(finalCounts.maximum, 2)
        XCTAssertEqual(finalCounts.current, 0)
    }

    @MainActor
    func testActiveSyncEngineReleasesCompletedAndArchivedJobs() async {
        let fixture = ChatPerformanceFixture.make(configuration: .init(
            turnCount: 1,
            rawItemCount: 3,
            longMessageCharacters: 8
        ))
        var revisions: [String: Int] = [:]
        let engine = ActiveTimelineSyncEngine(
            localRevision: { revisions[$0] ?? 0 },
            synchronize: { session, _ in
                revisions[session.id] = 3
                return true
            }
        )

        engine.schedule(fixture.session, desiredRevision: 3)
        for _ in 0..<20 where engine.scheduledSessionCount != 0 { await Task.yield() }
        XCTAssertEqual(revisions[fixture.session.id], 3)
        XCTAssertEqual(engine.scheduledSessionCount, 0)

        engine.schedule(fixture.session, desiredRevision: 4)
        engine.retainActiveSessions([])
        XCTAssertEqual(engine.scheduledSessionCount, 0, "Archived Sessions must release their scheduler immediately")
    }

    private func decodeEnvelope(_ json: String) throws -> SessionTimelineChangeEnvelope {
        try JSONDecoder().decode(SessionTimelineChangeEnvelope.self, from: Data(json.utf8))
    }

    private func detail(items: [CodexThreadItem]) -> CodexThreadDetail {
        CodexThreadDetail(
            id: "provider-thread",
            title: "Session",
            status: .running,
            source: nil,
            connectionStatus: nil,
            currentModel: nil,
            currentReasoningLevel: nil,
            activityStatus: nil,
            cwd: "/tmp",
            createdAt: "2026-08-24T00:00:00Z",
            updatedAt: "2026-08-24T00:00:00Z",
            canSend: true,
            sendUnavailableReason: nil,
            capabilities: nil,
            turnCount: 1,
            items: items
        )
    }

    private func item(_ id: String, at createdAt: String = "2026-08-24T00:00:00Z") -> CodexThreadItem {
        CodexThreadItem(
            id: id,
            turnId: "turn-\(id)",
            turnStatus: "complete",
            type: "agentMessage",
            title: "Agent",
            text: id,
            options: nil,
            status: nil,
            createdAt: createdAt
        )
    }
}

private actor ConcurrentRequestCounts {
    private(set) var current = 0
    private(set) var maximum = 0

    func enter() {
        current += 1
        maximum = max(maximum, current)
    }

    func leave() {
        current -= 1
    }

    func snapshot() -> (current: Int, maximum: Int) {
        (current, maximum)
    }
}
