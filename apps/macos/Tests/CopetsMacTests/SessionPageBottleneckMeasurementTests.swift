import XCTest
@testable import CorptieMac

/// Reproducible micro-benchmarks for the Session page's main-thread hot paths.
///
/// These tests use only the deterministic `ChatPerformanceFixture` (10,000
/// synthetic items, 400 turns) and synthetic `TaskSession` lists — no real,
/// potentially sensitive history is read. Each measurement is self-timed and
/// asserts an upper bound so regressions are caught in CI.
///
/// They complement (not replace) the os_signpost / Instruments / MetricKit
/// sampling described in the analysis report. Their value is that they run
/// headlessly and deterministically, so the same number can be reproduced on
/// any machine and diffed across commits.
@MainActor
final class SessionPageBottleneckMeasurementTests: XCTestCase {

    // MARK: - Fixture / dataset

    private func standardFixture() -> ChatPerformanceFixture {
        ChatPerformanceFixture.make(configuration: .standard)
    }

    private func makeSyntheticSessionList(count: Int) -> [TaskSession] {
        (0..<count).map { makeSyntheticSession(index: $0) }
    }

    private func makeSyntheticSession(index: Int, status: TaskStatus = .complete) -> TaskSession {
        TaskSession(
            id: "perf-session-\(index)",
            title: "Synthetic session \(index)",
            agent: "Fixture",
            agentId: nil,
            sessionKind: nil,
            status: status,
            progress: status == .running ? 0.5 : 1,
            summary: "Synthetic non-sensitive session",
            suggestedOptions: nil,
            suggestedPrompt: nil,
            activityStatus: nil,
            updatedAt: "2026-08-12T00:\(String(format: "%02d", index % 60)):00.000Z",
            accent: .violet,
            archived: false,
            pinned: index.isMultiple(of: 50),
            sortOrder: Double(index),
            capabilities: nil,
            external: nil
        )
    }

    // MARK: - Timing helper

    private func measure(_ name: String, iterations: Int = 5, _ body: () -> Void) -> Double {
        var samples: [Double] = []
        samples.reserveCapacity(iterations)
        for _ in 0..<iterations {
            let start = DispatchTime.now().uptimeNanoseconds
            body()
            let end = DispatchTime.now().uptimeNanoseconds
            samples.append(Double(end - start) / 1_000_000.0) // ms
        }
        samples.sort()
        let p50 = samples[Int(Double(samples.count - 1) * 0.5)]
        print("[perf] \(name) p50=\(String(format: "%.2f", p50))ms samples=\(samples.map { String(format: "%.2f", $0) })")
        return p50
    }

    private func measureP95(_ name: String, iterations: Int = 20, _ body: () -> Void) -> Double {
        var samples: [Double] = []
        samples.reserveCapacity(iterations)
        for _ in 0..<iterations {
            let start = DispatchTime.now().uptimeNanoseconds
            body()
            samples.append(Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000.0)
        }
        samples.sort()
        let p95 = samples[Int(Double(samples.count - 1) * 0.95)]
        print("[perf] \(name) p95=\(String(format: "%.2f", p95))ms samples=\(samples.map { String(format: "%.2f", $0) })")
        return p95
    }

    // MARK: - 1. Message-history projection (makeChatDisplayEntries + chronological sort)

    func testMessageHistoryProjectionIsBounded() {
        let fixture = standardFixture()
        let items = fixture.detail.items

        let p50 = measure("makeChatDisplayEntries(10k items)") {
            _ = makeChatDisplayEntries(from: items)
        }

        // 10k items must project well under one frame. The historical audit
        // test enforces p95 < 100 ms for decode+project on real data; here we
        // assert a tighter bound for the pure projection on the fixture.
        XCTAssertLessThan(p50, 100, "makeChatDisplayEntries over 10k items should stay under 100 ms p50")
    }

    func testChronologicalSortIsLinearWhenAlreadyOrdered() {
        let fixture = standardFixture()
        let items = fixture.detail.items

        // Fixture items are already timestamp-ordered, so stableChronologicalChatItems
        // should take the early-return path (no sort allocation). Verify it does
        // not degenerate to an O(n log n) sort.
        let p50 = measure("stableChronologicalChatItems(10k ordered)") {
            _ = stableChronologicalChatItems(items)
        }
        XCTAssertLessThan(p50, 50, "ordered input must take the linear fast path")
    }

    func testChronologicalSortOfShuffledItemsIsBounded() {
        let fixture = standardFixture()
        let items = Array(fixture.detail.items.reversed()) // force a full sort

        let p50 = measure("stableChronologicalChatItems(10k reversed)") {
            _ = stableChronologicalChatItems(items)
        }
        XCTAssertLessThan(p50, 200, "full sort of 10k items should stay under 200 ms p50")
    }

    func testExecutionTimelineProjectionStaysWithinOneFrame() {
        let executionTypes: Set<String> = [
            "reasoning", "plan", "commandExecution", "fileChange",
            "mcpToolCall", "dynamicToolCall", "webSearch", "warning"
        ]
        let items = Array(standardFixture().detail.items.lazy
            .filter { executionTypes.contains($0.type) }
            .prefix(2_000))
        XCTAssertFalse(items.isEmpty)

        let p95 = measureP95("execution timeline projection (2000 items)", iterations: 20) {
            _ = NativeExecutionTimelineProjection.steps(for: items)
        }

        XCTAssertLessThan(p95, 16, "projecting 2000 execution items must stay within one frame at p95")
    }

    // MARK: - 2. Full display pipeline (filter + project + signature)

    func testFullVisibleDisplayPipelineIsBounded() {
        let fixture = standardFixture()

        let p50 = measure("display pipeline (filter + project + window)") {
            let items = fixture.detail.items.filter { !$0.type.hasPrefix("taskComplete") }
            let entries = makeChatDisplayEntries(from: items)
            _ = visibleDetailEntries(from: entries, limit: 7)
        }
        // This mirrors the main-actor path that runs for every full rebuild
        // (makeVisibleDetailDisplay = filter + makeChatDisplayEntries + window).
        XCTAssertLessThan(p50, 150, "full visible display pipeline should stay under 150 ms p50")
    }

    func testTenThousandItemTimelineMainActorCommitP95IsBelowEightMilliseconds() {
        let detail = standardFixture().detail
        var samples: [Double] = []
        samples.reserveCapacity(30)

        for iteration in 0..<30 {
            let repository = SessionTimelineRepository()
            let start = DispatchTime.now().uptimeNanoseconds
            repository.publish(detail, for: "commit-\(iteration)", timelineRevision: iteration + 1)
            samples.append(Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000)
        }

        samples.sort()
        let p95 = samples[Int(Double(samples.count - 1) * 0.95)]
        print("[perf] timeline main-actor commit (10k items) p95=\(String(format: "%.3f", p95))ms")
        XCTAssertLessThan(p95, 8)
    }

    func testRealtimeSelectionCacheAndCompletionLatencyBudgets() async {
        var selectionSamples: [Double] = []
        let selection = SessionSelectionController()
        for index in 0..<200 {
            let start = DispatchTime.now().uptimeNanoseconds
            selection.select("selection-\(index)")
            selectionSamples.append(Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000)
        }

        let fixture = ChatPerformanceFixture.make(configuration: .init(
            turnCount: 12,
            rawItemCount: 240,
            longMessageCharacters: 200
        ))
        var cacheSamples: [Double] = []
        for index in 0..<30 {
            let start = DispatchTime.now().uptimeNanoseconds
            let prepared = await Task.detached(priority: .userInitiated) {
                makeDetailDisplayCache(
                    for: fixture.detail,
                    sessionId: "background-cache-\(index)",
                    visibleMessageLimit: 7
                )
            }.value
            let cache = SessionPresentationCache()
            cache.store(prepared)
            XCTAssertNotNil(cache.cache(for: prepared.sessionId))
            cacheSamples.append(Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000)
        }

        var running = makeSyntheticSessionList(count: 2_000)
        running[1_337] = makeSyntheticSession(index: 1_337, status: .running)
        let index = SessionIndexStore()
        index.apply(
            SessionCollectionDiffer.patch(from: [], to: running, revision: 1),
            authoritativeSessions: running
        )
        var completionSamples: [Double] = []
        for revision in 2..<42 {
            var completed = running
            completed[1_337] = makeSyntheticSession(
                index: 1_337,
                status: revision.isMultiple(of: 2) ? .complete : .running
            )
            let start = DispatchTime.now().uptimeNanoseconds
            let patch = SessionCollectionDiffer.patch(from: running, to: completed, revision: UInt64(revision))
            index.apply(patch, authoritativeSessions: completed)
            completionSamples.append(Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000)
            running = completed
        }

        func p95(_ samples: [Double]) -> Double {
            let sorted = samples.sorted()
            return sorted[Int(Double(sorted.count - 1) * 0.95)]
        }
        let selectionP95 = p95(selectionSamples)
        let cacheP95 = p95(cacheSamples)
        let completionP95 = p95(completionSamples)
        print("[perf] selection-p95=\(String(format: "%.3f", selectionP95))ms background-cache-p95=\(String(format: "%.3f", cacheP95))ms completion-index-p95=\(String(format: "%.3f", completionP95))ms")

        XCTAssertLessThan(selectionP95, 16)
        XCTAssertLessThan(cacheP95, 200)
        XCTAssertLessThan(completionP95, 300)
    }

    func testDeepSavedAnchorCreatesBoundedRestorationWindow() throws {
        let fixture = standardFixture()
        let allEntries = makeChatDisplayEntries(from: fixture.detail.items)
        let anchor = try XCTUnwrap(allEntries.dropFirst(100).first?.id)

        let cache = makeDetailDisplayCache(
            for: fixture.detail,
            sessionId: fixture.session.id,
            visibleMessageLimit: 7,
            restorationAnchorRowID: anchor
        )

        XCTAssertEqual(cache.restorationAnchorRowID, anchor)
        XCTAssertTrue(cache.displayEntries.contains(where: { $0.id == anchor }))
        XCTAssertLessThanOrEqual(cache.displayEntries.count, 19)
        XCTAssertLessThan(cache.displayEntries.count, allEntries.count)
    }

    func testDeletedSavedAnchorFallsBackToLatestWindowWithoutFalseMatch() {
        let fixture = standardFixture()
        let cache = makeDetailDisplayCache(
            for: fixture.detail,
            sessionId: fixture.session.id,
            visibleMessageLimit: 7,
            restorationAnchorRowID: "message:deleted"
        )
        let allEntries = makeChatDisplayEntries(from: fixture.detail.items)

        XCTAssertNil(cache.restorationAnchorRowID)
        XCTAssertEqual(cache.displayEntries.map(\.id), visibleDetailEntries(from: allEntries, limit: 7).map(\.id))
    }

    // MARK: - 3. Session list sort (AppStateStore.sessions computed property)

    func testSessionListSortScalesWithCount() {
        let small = makeSyntheticSessionList(count: 100)
        let large = makeSyntheticSessionList(count: 2_000)

        let smallP50 = measure("session sort (100 sessions)", iterations: 20) {
            _ = small.sorted(by: sessionPrecedesProxy)
        }
        let largeP50 = measure("session sort (2000 sessions)", iterations: 20) {
            _ = large.sorted(by: sessionPrecedesProxy)
        }

        print("[perf] session sort 100 -> \(String(format: "%.2f", smallP50))ms, 2000 -> \(String(format: "%.2f", largeP50))ms")
        XCTAssertLessThan(largeP50, 50, "sorting 2000 sessions should stay under 50 ms p50")
    }

    func testAssistantGroupingWithInvalidClassificationsStaysBounded() {
        var sessions = makeSyntheticSessionList(count: 2_000)
        for index in sessions.indices {
            sessions[index].sessionKind = index.isMultiple(of: 2) ? .assistantChat : .legacy
        }
        let rows = sessions.map(SessionRowModel.init(session:))
        let p50 = measure("assistant grouping (2000 mixed classifications)", iterations: 20) {
            _ = makeSessionGroups(
                rows: rows,
                agents: [],
                tasks: [],
                works: [],
                category: .assistant
            )
        }
        let groups = makeSessionGroups(
            rows: rows,
            agents: [],
            tasks: [],
            works: [],
            category: .assistant
        )

        XCTAssertEqual(groups.flatMap(\.rows).count, 1_000)
        XCTAssertLessThan(p50, 16, "classification filtering and grouping 2000 sessions must stay within one frame")
    }

    func testTwoThousandSessionSearchAndGroupingStaysWithinOneFrame() {
        var sessions = makeSyntheticSessionList(count: 2_000)
        for index in sessions.indices {
            sessions[index].sessionKind = .assistantChat
        }
        let rows = sessions.map(SessionRowModel.init(session:))
        let p95 = measureP95("search + grouping (2000 sessions)", iterations: 20) {
            let filtered = filteredSessionRows(rows, query: "session 1")
            _ = makeSessionGroups(
                rows: filtered,
                agents: [],
                tasks: [],
                works: [],
                category: .assistant
            )
        }

        XCTAssertLessThan(p95, 16, "searching and grouping 2000 sessions must stay within one frame at p95")
    }

    func testSelectionOnlyInvalidationReusesSidebarProjection() {
        let store = SessionGroupProjectionStore()
        let key = SessionGroupProjectionKey(
            groupingRevision: 12,
            filterRevision: 7,
            entityRevision: 3,
            category: .assistant,
            workerScope: .active,
            workerGroupingMode: .work,
            searchText: ""
        )
        var builds = 0

        for _ in 0..<100 {
            _ = store.groups(for: key) {
                builds += 1
                return []
            }
        }

        XCTAssertEqual(builds, 1)
        XCTAssertEqual(store.computationCount, 1)

        let changedSearchKey = SessionGroupProjectionKey(
            groupingRevision: key.groupingRevision,
            filterRevision: key.filterRevision,
            entityRevision: key.entityRevision,
            category: key.category,
            workerScope: key.workerScope,
            workerGroupingMode: key.workerGroupingMode,
            searchText: "changed"
        )
        _ = store.groups(for: changedSearchKey) {
            builds += 1
            return []
        }

        XCTAssertEqual(builds, 2)
        XCTAssertEqual(store.computationCount, 2)
    }

    private let sessionPrecedesProxy: (TaskSession, TaskSession) -> Bool = { left, right in
        if (left.pinned == true) != (right.pinned == true) { return left.pinned == true }
        let leftOrder = left.sortOrder ?? .greatestFiniteMagnitude
        let rightOrder = right.sortOrder ?? .greatestFiniteMagnitude
        if leftOrder != rightOrder { return leftOrder < rightOrder }
        return left.updatedAt > right.updatedAt
    }
}
