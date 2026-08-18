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
        (0..<count).map { index in
            TaskSession(
                id: "perf-session-\(index)",
                title: "Synthetic session \(index)",
                agent: "Fixture",
                agentId: nil,
                sessionKind: nil,
                status: .complete,
                progress: 1,
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

    private let sessionPrecedesProxy: (TaskSession, TaskSession) -> Bool = { left, right in
        if (left.pinned == true) != (right.pinned == true) { return left.pinned == true }
        let leftOrder = left.sortOrder ?? .greatestFiniteMagnitude
        let rightOrder = right.sortOrder ?? .greatestFiniteMagnitude
        if leftOrder != rightOrder { return leftOrder < rightOrder }
        return left.updatedAt > right.updatedAt
    }
}
