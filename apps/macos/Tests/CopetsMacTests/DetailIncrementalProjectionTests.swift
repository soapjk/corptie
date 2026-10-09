import XCTest
import SwiftUI
@testable import CorptieMac

final class DetailIncrementalProjectionTests: XCTestCase {
    func testHistoricalConfirmationChangesWithoutRebuildingProviderTail() throws {
        var confirmation = item("confirmation", "product", "collaborationConfirmation")
        confirmation.collaborationConfirmationStatus = "pending"
        let previous = [confirmation, item("user", "turn", "userMessage"), item("reply", "turn", "agentMessage")]
        for status in ["submitting", "confirmed", "rejected"] {
            var next = previous
            next[0].collaborationConfirmationStatus = status
            try assertEquivalent(previous: previous, next: next, incremental: true)
        }
    }
    func testInterleavedTurnCannotReplaceWholeTurnWithContiguousSuffix() {
        let previous = [item("old-user", "old", "userMessage"),
                        item("new-user", "new", "userMessage"),
                        item("old-late", "old", "commandExecution"),
                        item("new-step", "new", "reasoning")]
        let next = previous + [item("new-step-2", "new", "commandExecution")]
        let cache = makeDetailDisplayCache(for: detail(previous), sessionId: "session", visibleMessageLimit: 100)
        let result = DetailIncrementalProjection(cache: cache).project(
            for: detail(next), sessionId: "session", visibleMessageLimit: 100)
        XCTAssertNil(result, "An interleaved source turn must use full projection")
        let visible = result?.visibleEntries ?? makeDetailDisplayCache(
            for: detail(next), sessionId: "session", visibleMessageLimit: 100).displayEntries
        XCTAssertTrue(visible.contains { $0.id == "message:new-user" })
    }

    func testContinuousStreamAndIndependentNewTurnRetainFastPath() throws {
        let initial = [item("user", "turn", "userMessage"), item("step", "turn", "reasoning")]
        try assertEquivalent(previous: initial, next: initial + [item("step2", "turn", "commandExecution")], incremental: true)
        try assertEquivalent(previous: initial, next: initial + [item("user2", "next", "userMessage")], incremental: true)
    }

    func testAllUserMessageStatesKeepBodyAndIdentity() throws {
        var previous = [item("user", "turn", "userMessage"), item("step", "turn", "reasoning")]
        for status in ["queued", "processing", "consumed", "failed", "cancelled"] {
            var next = previous
            next[0].userMessageStatus = status
            try assertEquivalent(previous: previous, next: next, incremental: true)
            previous = next
        }
    }

    func testDeliveryBindingAndDeletionUseAuthoritativeProjection() throws {
        let previous = [item("user", "delivery:receipt", "userMessage")]
        let rebound = [item("user", "real-turn", "userMessage"), item("step", "real-turn", "reasoning")]
        try assertEquivalent(previous: previous, next: rebound, incremental: false)
        try assertEquivalent(previous: rebound, next: [rebound[1]], incremental: false)
        try assertEquivalent(previous: rebound, next: [], incremental: false)
    }

    func testReusedAndEmptyTurnIDsRejectTailOnlyProjection() throws {
        for turn in ["", "reused"] {
            let previous = [item("user", turn, "userMessage"), item("step", turn, "reasoning"),
                            item("user2", turn, "userMessage")]
            try assertEquivalent(previous: previous, next: previous + [item("step2", turn, "reasoning")], incremental: false)
        }
    }

    func testThreeInterleavedTurnsAndRemountedCacheRetainEveryUser() throws {
        let previous = [item("u1", "one", "userMessage"), item("u2", "two", "userMessage"),
                        item("u3", "three", "userMessage"), item("late", "one", "reasoning"),
                        item("step", "three", "reasoning")]
        let next = previous + [item("step2", "three", "reasoning")]
        try assertEquivalent(previous: previous, next: next, incremental: false)
        try assertEquivalent(previous: next, next: next + [item("step3", "three", "reasoning")], incremental: false)
    }

    func testCollaborationAndCommentaryBoundariesMatchFullProjection() throws {
        var commentary = item("commentary", "turn", "agentMessage")
        commentary.presentationRole = "commentary"
        let previous = [item("user", "turn", "userMessage"), item("step", "turn", "reasoning"), commentary]
        try assertEquivalent(previous: previous, next: previous + [item("step2", "turn", "reasoning")], incremental: true)
        var collaboration = item("collab", "product-delivery", "collaborationMessage")
        collaboration.collaborationDirection = "outbound"
        try assertEquivalent(previous: previous, next: previous + [collaboration], incremental: false)
        let interleaved = previous + [collaboration, item("step2", "turn", "reasoning")]
        try assertEquivalent(previous: interleaved, next: interleaved + [item("step3", "turn", "reasoning")], incremental: false)
    }

    func testHistoryWindowAnchorAndSessionChangeRejectFastPath() {
        let items = [item("user", "turn", "userMessage")]
        let cache = makeDetailDisplayCache(for: detail(items), sessionId: "session", visibleMessageLimit: 100)
        let state = DetailIncrementalProjection(cache: cache)
        XCTAssertNil(state.project(for: detail(items), sessionId: "other", visibleMessageLimit: 100))
        XCTAssertNil(state.project(for: detail(items), sessionId: "session", visibleMessageLimit: 200))
        XCTAssertNil(state.project(for: detail(items), sessionId: "session", visibleMessageLimit: 100,
                                   requestedRestorationAnchorRowID: "message:user"))
    }

    func testLateMutationOfOldTailWhileAppendingNewTurnFallsBack() throws {
        let previous = [item("user", "old", "userMessage"), item("step", "old", "reasoning")]
        var next = previous
        next[1] = item("step", "old", "reasoning", text: "Completed execution")
        next.append(item("user2", "new", "userMessage"))
        try assertEquivalent(previous: previous, next: next, incremental: false)
    }

    func testLongContinuousHistoryProjectionWithinFrameBudget() throws {
        var previous: [CodexThreadItem] = []
        for index in 0..<1000 {
            previous += [item("u-\(index)", "t-\(index)", "userMessage"), item("s-\(index)", "t-\(index)", "reasoning")]
        }
        let next = detail(previous + [item("last-step", "t-999", "reasoning")])
        let cache = makeDetailDisplayCache(for: detail(previous), sessionId: "session", visibleMessageLimit: 100)
        let state = DetailIncrementalProjection(cache: cache)
        var samples: [Double] = []
        for iteration in 0..<60 {
            let start = ProcessInfo.processInfo.systemUptime
            let result = state.project(for: next, sessionId: "session", visibleMessageLimit: 100)
            let elapsed = (ProcessInfo.processInfo.systemUptime - start) * 1000
            XCTAssertNotNil(result)
            if iteration >= 10 { samples.append(elapsed) }
        }
        samples.sort()
        let p95 = samples[Int(Double(samples.count - 1) * 0.95)]
        print("INCREMENTAL_PROJECTION n=2001 p50_ms=\(samples[25]) p95_ms=\(p95)")
        XCTAssertLessThan(p95, 16)
    }

    private func assertEquivalent(previous: [CodexThreadItem], next: [CodexThreadItem], incremental: Bool,
                                  file: StaticString = #filePath, line: UInt = #line) throws {
        let cache = makeDetailDisplayCache(for: detail(previous), sessionId: "session", visibleMessageLimit: 100)
        let full = makeDetailDisplayCache(for: detail(next), sessionId: "session", visibleMessageLimit: 100)
        let result = DetailIncrementalProjection(cache: cache).project(for: detail(next), sessionId: "session", visibleMessageLimit: 100)
        XCTAssertEqual(result != nil, incremental, file: file, line: line)
        let entries = result?.visibleEntries ?? full.displayEntries
        XCTAssertEqual(entries.map(\.id), full.displayEntries.map(\.id), file: file, line: line)
        XCTAssertEqual(result?.totalCount ?? full.totalDisplayEntryCount, full.totalDisplayEntryCount, file: file, line: line)
        for (a, b) in zip(entries, full.displayEntries) {
            switch (a.kind, b.kind) {
            case (.message(let x), .message(let y)): XCTAssertEqual(x, y, file: file, line: line)
            case (.process(let x, let a), .process(let y, let b)):
                XCTAssertEqual(x, y, file: file, line: line)
                XCTAssertEqual(a, b, file: file, line: line)
            default: XCTFail("Projection kind mismatch", file: file, line: line)
            }
        }
    }

    @MainActor
    func testNativeTimelineKeepsProcessingBodyAcrossInterleavingAndCompletion() throws {
        _ = NSApplication.shared
        let table = AppKitChatTimelineView.makeTableView()
        let scroll = AppKitChatTimelineView.makeScrollView(tableView: table)
        let coordinator = AppKitChatTimelineView.Coordinator(followsLatest: .constant(true), onToggleExpansion: { _ in })
        coordinator.attach(tableView: table, scrollView: scroll)
        let window = NSWindow(contentRect: .init(x: 0, y: 0, width: 480, height: 700),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = scroll
        defer { window.orderOut(nil) }
        let builder = ConversationNativeRowBuilder(sessionTitle: "Session", workingDirectory: nil,
                                                   allowsFork: false, forkUnavailableReason: nil, imageURL: { _ in nil })
        var source = [item("old-user", "old", "userMessage"), item("user", "new", "userMessage")]
        source[1].userMessageStatus = "queued"
        var cache = makeDetailDisplayCache(for: detail(source), sessionId: "session", visibleMessageLimit: 100)
        let updates = [source,
                       source + [item("late", "old", "reasoning"), item("step", "new", "reasoning")],
                       source + [item("late", "old", "reasoning"), item("step", "new", "reasoning"),
                                 item("step2", "new", "commandExecution")]]
        for (index, update) in (updates + [updates.last!]).enumerated() {
            var next = update
            next[1].userMessageStatus = index == 0 ? "queued" : (index == 3 ? "consumed" : "processing")
            let full = makeDetailDisplayCache(for: detail(next), sessionId: "session", visibleMessageLimit: 100)
            let incremental = DetailIncrementalProjection(cache: cache).project(for: detail(next), sessionId: "session", visibleMessageLimit: 100)
            let entries = incremental?.visibleEntries ?? full.displayEntries
            coordinator.apply(rows: entries.map { builder.nativeAppKitRow($0, expandedTurnIds: []) })
            window.contentView?.layoutSubtreeIfNeeded()
            let userIndex = try XCTUnwrap(entries.firstIndex { $0.id == "message:user" })
            let cell = try XCTUnwrap(table.view(atColumn: 0, row: userIndex, makeIfNecessary: true) as? AppKitSharedMessageTextCell)
            cell.layoutSubtreeIfNeeded()
            XCTAssertFalse(cell.isHiddenOrHasHiddenAncestor)
            XCTAssertGreaterThan(table.rect(ofRow: userIndex).height, 20)
            func textViews(_ view: NSView) -> [NativeTimelineTextView] {
                (view as? NativeTimelineTextView).map { [$0] } ?? view.subviews.flatMap(textViews)
            }
            XCTAssertTrue(textViews(cell).contains { $0.string == "user" },
                          "The visible hosting tree must keep the actual selectable body")
            cell.copyRepresentedMessage()
            XCTAssertEqual(NSPasteboard.general.string(forType: .string), "user")
            cache = full
        }
    }

    private func item(_ id: String, _ turn: String, _ type: String, text: String? = nil) -> CodexThreadItem {
        CodexThreadItem(id: id, turnId: turn, turnStatus: "inProgress", type: type,
                        title: type, text: text ?? id, options: nil, status: "processing", createdAt: nil)
    }

    private func detail(_ items: [CodexThreadItem]) -> CodexThreadDetail {
        CodexThreadDetail(id: "thread", title: "Session", status: .running, source: nil,
                         connectionStatus: nil, currentModel: nil, currentReasoningLevel: nil,
                         activityStatus: nil, cwd: "/tmp", createdAt: "now", updatedAt: "now",
                         canSend: true, sendUnavailableReason: nil, capabilities: nil,
                         turnCount: 2, items: items)
    }
}
