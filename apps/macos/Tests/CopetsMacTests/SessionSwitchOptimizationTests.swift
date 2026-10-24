import Combine
import AppKit
import SwiftUI
import CorptieClientCore
import CorptieConversation
import XCTest
@testable import CorptieMac

@MainActor
final class SessionSwitchOptimizationTests: XCTestCase {
    func testNativeHostingInvalidatesOnlySelectionConsumers() {
        _ = NSApplication.shared
        let client = BackendClient()
        let selected = SelectionRenderCounter()
        let unrelated = SelectionRenderCounter()
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 100),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: HStack {
            SelectionRenderProbe(client: client, counter: selected, readsSelection: true)
            SelectionRenderProbe(client: client, counter: unrelated, readsSelection: false)
        })
        window.orderBack(nil)
        defer { window.close() }
        window.contentView?.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.15))
        let selectedBefore = selected.count
        let unrelatedBefore = unrelated.count
        XCTAssertGreaterThan(selectedBefore, 0)
        XCTAssertGreaterThan(unrelatedBefore, 0)
        client.sessionSelectionController.select("session:render-probe")
        let deadline = Date().addingTimeInterval(1)
        while selected.count == selectedBefore && Date() < deadline {
            window.contentView?.layoutSubtreeIfNeeded()
            RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        }
        XCTAssertGreaterThan(selected.count, selectedBefore)
        XCTAssertEqual(unrelated.count, unrelatedBefore)
    }

    private func task(_ id: String = "task:one", current: String? = nil) -> CorptieTask {
        CorptieTask(id: id, workId: "work:one", title: id, description: "", acceptanceCriteria: "",
            priority: "medium", lifecycleState: "todo", mainAgentId: nil, currentSessionId: current,
            executionStatus: "idle", createdAt: "2026-09-01", updatedAt: "2026-09-01")
    }

    private func session(_ id: String, taskID: String? = "task:one", archived: Bool = false,
                         updatedAt: String = "2026-09-01", status: TaskStatus = .complete) -> TaskSession {
        TaskSession(id: id, title: id, agent: "Fixture", agentId: nil, sessionKind: .worker,
            workId: "work:one", taskId: taskID, status: status, progress: 0, summary: "",
            suggestedOptions: nil, suggestedPrompt: nil, activityStatus: nil, updatedAt: updatedAt,
            accent: .cyan, archived: archived, pinned: false, sortOrder: 0, capabilities: nil, external: nil)
    }

    func testIndexedPoliciesMatchExistingBindingFallbackAndArchiveSemantics() {
        let sessions = [session("old"), session("latest", updatedAt: "2026-09-03", status: .running),
            session("archived", archived: true), session("foreign", taskID: "task:other")]
        let lookup = TaskSessionLookup(sessions: sessions)
        for current in [nil, "old", "latest", "archived", "foreign", "missing", " latest ", ""] as [String?] {
            let task = task(current: current)
            XCTAssertEqual(lookup.session(for: task), ConsoleTaskSelectionPolicy.session(for: task, in: sessions))
            XCTAssertEqual(lookup.activity(for: task), TaskSessionActivity.resolve(task: task, sessions: sessions))
        }
    }

    func testIndexRefreshesForContentRebindingDeletionAndReorder() {
        let store = SessionIndexStore()
        let first = [session("one"), session("two", taskID: "task:two")]
        store.replaceAll(with: first)
        XCTAssertEqual(store.taskSessionLookup.session(for: task())?.id, "one")
        let rebound = [session("two", taskID: "task:one", status: .running)]
        store.replaceAll(with: rebound)
        XCTAssertEqual(store.taskSessionLookup.session(for: task())?.id, "two")
        XCTAssertEqual(store.taskSessionLookup.activity(for: task()), .processing)
        store.beginReorder()
        store.replaceAll(with: [session("two", taskID: "task:other")])
        XCTAssertNil(store.taskSessionLookup.session(for: task()))
        store.endReorder(authoritativeSessions: [])
        XCTAssertNil(store.taskSessionLookup.session(for: task()))
    }

    func testRepeatedSelectionDoesNotPruneCollectionsAndArchivePinsAreReleased() {
        let client = BackendClient()
        client.retainResidentSessionCaches(activeSessionIDs: ["active"])
        let before = client.residentCachePruneCount
        for index in 0..<100 {
            client.sessionSelectionController.select("archive-\(index)")
            client.retainResidentSessionCaches()
        }
        XCTAssertEqual(client.residentCachePruneCount, before)
        client.sessionSelectionController.clear()
        client.retainResidentSessionCaches()
        client.retainResidentSessionCaches(activeSessionIDs: ["replacement"])
        XCTAssertEqual(client.residentCachePruneCount, before + 1)
    }

    func testPinHandoffPreservesDestinationAndReturnsToBoundedStorage() {
        var cache = ResidentSessionCache<Int>(capacity: 1)
        cache.pin(["one"])
        cache.store(1, for: "one")
        cache.setPinned(true, for: "two")
        cache.store(2, for: "two")
        cache.setPinned(false, for: "one")
        XCTAssertNil(cache.peek("one"))
        XCTAssertEqual(cache.peek("two"), 2)
    }

    func testOutlineProjectionIgnoresSelectionAndInvalidatesEachInput() {
        let store = ConsoleOutlineProjectionStore()
        let base = ConsoleOutlineProjectionKey(entityRevision: 1, sessionRevision: 1, search: "", sort: .standard)
        var builds = 0
        func make() -> ConsoleOutlineProjection {
            builds += 1
            return ConsoleOutlineProjection(tasksByWorkID: ["work:one": [task()]], works: [], processingWorkIDs: [])
        }
        for _ in 0..<100 { XCTAssertEqual(store.value(for: base, make: make).tasksByWorkID["work:one"]?.count, 1) }
        XCTAssertEqual(builds, 1)
        for key in [
            ConsoleOutlineProjectionKey(entityRevision: 2, sessionRevision: 1, search: "", sort: .standard),
            ConsoleOutlineProjectionKey(entityRevision: 2, sessionRevision: 2, search: "", sort: .standard),
            ConsoleOutlineProjectionKey(entityRevision: 2, sessionRevision: 2, search: "query", sort: .standard),
            ConsoleOutlineProjectionKey(entityRevision: 2, sessionRevision: 2, search: "query", sort: .updated)
        ] { _ = store.value(for: key, make: make) }
        XCTAssertEqual(builds, 5)
    }

    func testTaskLookupBenchmarkReportsEquivalentResults() {
        let sessions = (0..<1000).map { session("session:\($0)", taskID: "task:\($0)") }
        let tasks = (0..<1000).map { task("task:\($0)") }
        let start = ContinuousClock.now
        let scanned = tasks.map { ConsoleTaskSelectionPolicy.session(for: $0, in: sessions)?.id }
        let scanDuration = start.duration(to: .now)
        let indexedStart = ContinuousClock.now
        let lookup = TaskSessionLookup(sessions: sessions)
        let indexed = tasks.map { lookup.session(for: $0)?.id }
        let indexedDuration = indexedStart.duration(to: .now)
        XCTAssertEqual(scanned, indexed)
        print("[perf] task binding 1000x1000 scan=\(scanDuration) index-build-and-lookup=\(indexedDuration)")
    }
}

@MainActor
private final class SelectionRenderCounter {
    var count = 0
}

private struct SelectionRenderProbe: View {
    @ObservedObject var client: BackendClient
    let counter: SelectionRenderCounter
    let readsSelection: Bool

    var body: some View {
        counter.count += 1
        return Text(readsSelection ? (client.selectedSession?.id ?? "none") : (client.isOnline ? "online" : "offline"))
    }
}
