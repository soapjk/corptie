import XCTest
@testable import CorptieMac

final class SessionTimelineBackgroundSyncTests: XCTestCase {
    func testWarmCacheReconcilesWhenMessageCursorIsAheadDespiteEqualTimelineRevision() {
        XCTAssertTrue(SessionMessageCursorReconciliation.requiresSnapshot(serverSequence: 120, cachedSequence: 119))
        XCTAssertTrue(SessionMessageCursorReconciliation.requiresSnapshot(serverSequence: 120, cachedSequence: nil))
        XCTAssertFalse(SessionMessageCursorReconciliation.requiresSnapshot(serverSequence: 120, cachedSequence: 120))
        XCTAssertFalse(SessionMessageCursorReconciliation.requiresSnapshot(serverSequence: 119, cachedSequence: 120))
        XCTAssertFalse(SessionMessageCursorReconciliation.requiresSnapshot(serverSequence: nil, cachedSequence: 120))
        XCTAssertFalse(SessionMessageCursorReconciliation.requiresSnapshot(serverSequence: 0, cachedSequence: nil))
    }

    func testFinalMessageCursorRecoversWhenRunningTransitionWasMissed() {
        XCTAssertTrue(SessionTerminalTimelineReconciliation.shouldReconcile(
            wasRunning: false, isRunning: false, isSelected: true, messageCursorAdvanced: true))
        XCTAssertFalse(SessionTerminalTimelineReconciliation.shouldReconcile(
            wasRunning: false, isRunning: true, isSelected: true, messageCursorAdvanced: true))
        XCTAssertFalse(SessionTerminalTimelineReconciliation.shouldReconcile(
            wasRunning: false, isRunning: false, isSelected: false, messageCursorAdvanced: true))
    }

    func testUnopenedSessionTimelineAdvanceSchedulesWithoutFinalUnreadCursor() {
        XCTAssertTrue(SessionTimelineBackgroundSyncPolicy.shouldSchedule(
            previousServerRevision: 7,
            desiredServerRevision: 8,
            localRevision: 7
        ))
        XCTAssertTrue(SessionTimelineBackgroundSyncPolicy.shouldSchedule(
            previousServerRevision: 8,
            desiredServerRevision: 8,
            localRevision: 7
        ))
    }

    func testReconnectWarmsEveryActiveTimelineWhenStale() {
        for _ in 0..<3 {
            XCTAssertTrue(SessionTimelineBackgroundSyncPolicy.shouldSchedule(
                previousServerRevision: nil,
                desiredServerRevision: 12,
                localRevision: 9
            ))
        }
        XCTAssertTrue(SessionTimelineBackgroundSyncPolicy.shouldSchedule(
            previousServerRevision: nil,
            desiredServerRevision: 12,
            localRevision: 9
        ))
        XCTAssertFalse(SessionTimelineBackgroundSyncPolicy.shouldSchedule(
            previousServerRevision: nil,
            desiredServerRevision: 12,
            localRevision: 12
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

    func testDeltaProcessorOwnsDecodeAndMergeOutsideTheMainActor() async throws {
        let processor = SessionTimelineDeltaProcessor()
        let data = Data("""
        {"snapshotRequired": false, "baseRevision": 8, "revision": 9,
         "currentRevision": 9, "changes": [
           {"revision": 9, "itemId": "final", "operation": "upsert", "item": {
             "id": "final", "turnId": "turn-final", "turnStatus": "complete",
             "type": "agentMessage", "title": "Agent", "text": "Done"
           }}
         ]}
        """.utf8)

        let envelope = try await processor.decode(data)
        guard case .applied(let merged, let revision) = await processor.merge(
            envelope,
            into: detail(items: []),
            localRevision: 8
        ) else { return XCTFail("Expected background delta projection") }

        XCTAssertEqual(revision, 9)
        XCTAssertEqual(merged.items.map(\.id), ["final"])
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

    func testDuplicateDeltaRecoversFromSnapshotOnlyWhenServerIsAhead() {
        // A terminal reply can be replayed under an unchanged item ID: the
        // delta is a duplicate, yet the server already owns content we lack.
        XCTAssertTrue(SessionTimelineDuplicateRecovery.requiresSnapshot(
            serverRevision: 41, localRevision: 40))
        XCTAssertFalse(SessionTimelineDuplicateRecovery.requiresSnapshot(
            serverRevision: 40, localRevision: 40))
        XCTAssertFalse(SessionTimelineDuplicateRecovery.requiresSnapshot(
            serverRevision: 39, localRevision: 40))
    }

    func testTerminalSelectedSessionReconcilesWithoutATimelineWake() {
        XCTAssertTrue(SessionTerminalTimelineReconciliation.shouldReconcile(
            wasRunning: true, isRunning: false, isSelected: true))
        XCTAssertFalse(SessionTerminalTimelineReconciliation.shouldReconcile(
            wasRunning: true, isRunning: true, isSelected: true))
        XCTAssertFalse(SessionTerminalTimelineReconciliation.shouldReconcile(
            wasRunning: false, isRunning: false, isSelected: true))
        XCTAssertFalse(SessionTerminalTimelineReconciliation.shouldReconcile(
            wasRunning: true, isRunning: false, isSelected: false))
    }

    func testDuplicateRecoveryAndTerminalReconciliationStayWiredIntoProductionPaths() throws {
        let packageRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let sources = packageRoot.appendingPathComponent("Sources/CopetsMac")
        let sync = try String(contentsOf: sources.appendingPathComponent(
            "Backend/SessionTimelineSyncController.swift"), encoding: .utf8)
        let client = try String(contentsOf: sources.appendingPathComponent(
            "BackendClient.swift"), encoding: .utf8)
        XCTAssertTrue(sync.contains("SessionTimelineDuplicateRecovery.requiresSnapshot("))
        XCTAssertFalse(sync.contains("case .duplicate:\n                return true"),
            "A duplicate delta must not report success while the server is ahead")
        XCTAssertTrue(client.contains("SessionTerminalTimelineReconciliation.shouldReconcile("))
        XCTAssertTrue(client.contains("forceSnapshot: true"))
    }

    func testStoredSnapshotTailKeepsEarlierHistoryPagesTheUserLoaded() {
        let resident = detail(items: [
            item("older-user", type: "userMessage", at: "2026-10-29T06:37:32Z"),
            item("older-reply", at: "2026-10-29T06:38:00Z"),
            item("window-first", at: "2026-11-11T13:04:30Z"),
            item("window-second", at: "2026-11-11T15:00:00Z")
        ], hasMoreHistory: true)
        let snapshot = detail(items: [
            item("window-first", text: "settled", at: "2026-11-11T13:04:30Z"),
            item("window-second", at: "2026-11-11T15:00:00Z"),
            item("final-reply", at: "2026-11-11T16:14:00Z")
        ], hasMoreHistory: true)

        let merged = SessionTimelineSnapshotHistoryMerge.preservingLoadedHistory(
            snapshot: snapshot, resident: resident)

        XCTAssertEqual(merged.items.map(\.id),
            ["older-user", "older-reply", "window-first", "window-second", "final-reply"],
            "A 200-item snapshot must not evict loaded history")
        XCTAssertEqual(merged.items.first { $0.id == "window-first" }?.text, "settled",
            "The snapshot tail stays authoritative for recent items")
        XCTAssertEqual(merged.hasMoreHistory, true)
    }

    func testCompleteStoredSnapshotStillReplacesTheResidentTimeline() {
        let resident = detail(items: [item("older"), item("tail")], hasMoreHistory: true)
        let snapshot = detail(items: [item("tail"), item("final")], hasMoreHistory: false)

        XCTAssertEqual(
            SessionTimelineSnapshotHistoryMerge.preservingLoadedHistory(
                snapshot: snapshot, resident: resident).items.map(\.id),
            ["tail", "final"],
            "Without a truncated window, the snapshot is the whole authority")
    }

    func testSnapshotHistoryMergeIsWiredIntoTheSnapshotPublishPath() throws {
        let packageRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let sync = try String(contentsOf: packageRoot.appendingPathComponent(
            "Sources/CopetsMac/Backend/SessionTimelineSyncController.swift"), encoding: .utf8)
        XCTAssertTrue(sync.contains("SessionTimelineSnapshotHistoryMerge.preservingLoadedHistory("),
            "Every stored-snapshot fallback must preserve loaded history")
    }

    func testDistinctStableMessageIDsRemainDistinctWithoutContentBasedCorrection() throws {
        let messages = [
            item("item-47", turnID: "turn-a", type: "userMessage", text: "Sent only once"),
            item("provider-native-id", turnID: "turn-a", type: "userMessage", text: "Sent   only once")
        ]

        let envelope = try decodeEnvelope("""
        {"snapshotRequired": false, "baseRevision": 3, "revision": 4,
         "currentRevision": 4, "changes": [
           {"revision": 4, "itemId": "provider-native-id", "operation": "upsert", "item": {
             "id": "provider-native-id", "turnId": "turn-a", "turnStatus": "complete",
             "type": "userMessage", "title": "User", "text": "Sent only once"
           }}
         ]}
        """)
        guard case .applied(let merged, _) = SessionTimelineChangeMerger.merge(
            envelope,
            into: detail(items: [messages[0]]),
            localRevision: 3
        ) else { return XCTFail("Expected alias delta to apply") }
        XCTAssertEqual(Set(merged.items.map(\.id)), Set(["item-47", "provider-native-id"]))
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
        repository.publish(detail(items: [item("same-revision-authority")]), for: "session", timelineRevision: 9)
        repository.publish(detail(items: [item("stale")]), for: "session", timelineRevision: 8)

        XCTAssertEqual(repository.timelineRevision(for: "session"), 9)
        XCTAssertEqual(repository.state(for: "session").detail?.items.map(\.id), ["same-revision-authority"])
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
        var deliveredRevision = 3
        let engine = ActiveTimelineSyncEngine(
            localRevision: { revisions[$0] ?? 0 },
            synchronize: { session, _ in
                revisions[session.id] = deliveredRevision
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

        deliveredRevision = 4
        engine.schedule(fixture.session, desiredRevision: 4)
        for _ in 0..<20 where engine.scheduledSessionCount != 0 { await Task.yield() }
        XCTAssertEqual(revisions[fixture.session.id], 4, "A restored Session must rejoin active Timeline sync")
        XCTAssertEqual(engine.scheduledSessionCount, 0)
    }

    @MainActor
    func testForegroundReserveAndPromotionBypassSaturatedBackground() async {
        let pool = SessionTimelineNetworkPermitPool(limit: 4)
        for id in ["a", "b", "c"] { _ = await pool.acquire(sessionID: id) }
        var promoted = false
        let waiting = Task { @MainActor in
            let acquired = await pool.acquire(sessionID: "selected")
            promoted = acquired
            if acquired { await pool.release(sessionID: "selected") }
        }
        for _ in 0..<50 { await Task.yield() }
        XCTAssertFalse(promoted, "Background requests must leave the reserved slot free")
        await pool.setForegroundSession("selected")
        for _ in 0..<100 where !promoted { await Task.yield() }
        XCTAssertTrue(promoted, "Promotion must use the reserve without waiting for a background request")
        for id in ["a", "b", "c"] { await pool.release(sessionID: id) }
        await waiting.value
    }

    @MainActor
    func testCancelledQueuedReadDoesNotHoldOrConsumePermit() async {
        let pool = SessionTimelineNetworkPermitPool(limit: 2)
        _ = await pool.acquire(sessionID: "background")
        var acquired: Bool?
        let waiting = Task { @MainActor in
            acquired = await pool.acquire(sessionID: "cancelled")
            if acquired == true { await pool.release(sessionID: "cancelled") }
        }
        for _ in 0..<50 { await Task.yield() }
        waiting.cancel()
        for _ in 0..<100 where acquired == nil { await Task.yield() }
        XCTAssertEqual(acquired, false)
        await pool.setForegroundSession("front")
        let frontAcquired = await pool.acquire(sessionID: "front")
        XCTAssertTrue(frontAcquired)
        await pool.release(sessionID: "front")
        await pool.release(sessionID: "background")
        await waiting.value
    }

    private func decodeEnvelope(_ json: String) throws -> SessionTimelineChangeEnvelope {
        try JSONDecoder().decode(SessionTimelineChangeEnvelope.self, from: Data(json.utf8))
    }

    private func detail(
        items: [CodexThreadItem],
        hasMoreHistory: Bool? = nil
    ) -> CodexThreadDetail {
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
            items: items,
            hasMoreHistory: hasMoreHistory
        )
    }

    private func item(
        _ id: String,
        turnID: String? = nil,
        type: String = "agentMessage",
        text: String? = nil,
        at createdAt: String = "2026-08-24T00:00:00Z"
    ) -> CodexThreadItem {
        CodexThreadItem(
            id: id,
            turnId: turnID ?? "turn-\(id)",
            turnStatus: "complete",
            type: type,
            title: type == "userMessage" ? "User" : "Agent",
            text: text ?? id,
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
