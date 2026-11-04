import AppKit
import Observation
import CorptieConversation
import SwiftUI
import XCTest
@testable import CorptieMac

@MainActor
final class ConsoleWorkOutlineDisclosureTests: XCTestCase {
    @MainActor private final class BodyCounts {
        var root = 0
    }

    private final class State: ObservableObject {
        @Published var expanded = false
        @Published var showsAll = false
        @Published var taskExpanded = false
        @Published var allowsCollapse = true
        var mounted: Set<String> = []
        var childReads = 0
    }

    private struct NativeSurface: View {
        @ObservedObject var state: State
        let tasks: [CorptieTask]
        let session: TaskSession
        var nested = false

        var body: some View {
            ConsoleNativeOutline(groups: {
                [ConsoleNativeOutlineGroup(id: "work", header: AnyView(Text("Work")),
                    rows: nested ? Array(tasks.prefix(1)) : (state.showsAll ? tasks : Array(tasks.prefix(5))),
                    isExpanded: state.expanded, allowsCollapse: state.allowsCollapse, showsDisclosureIndicator: false, expansionChanged: { state.expanded = $0 },
                    childRows: { task in
                        state.childReads += 1
                        return nested && task.id == tasks.first?.id ? Array(tasks.dropFirst()) : []
                    },
                    rowIsExpanded: { _ in state.taskExpanded },
                    rowExpansionChanged: { _, expanded in state.taskExpanded = expanded },
                    rowIsExpandable: { task in nested && task.id == tasks.first?.id }),
                 ConsoleNativeOutlineGroup(id: "next", header: AnyView(Text("Next Work")), isSection: true)]
            }) { task in
                ConsoleTaskRowContent(task: task, sessionActivity: .idle,
                    session: session, isSelected: false, isUnread: true, onOpen: {})
                    .onAppear { state.mounted.insert(task.id) }
            }
        }
    }

    func testNativeSubtaskDisclosureAnimatesAndKeepsLongChildrenVirtualized() throws {
        _ = NSApplication.shared
        let state = State(), session = try motionSession()
        state.expanded = true
        let window = NSWindow(contentRect: .init(x: 0, y: 0, width: 300, height: 600),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let host = NSHostingView(rootView: NativeSurface(state: state,
            tasks: motionTasks(count: 1_001, session: session), session: session, nested: true))
        window.contentView = host
        window.orderBack(nil)
        defer { window.orderOut(nil); window.contentView = nil }
        settle(0.15)
        let outline = try XCTUnwrap(findTable(in: host) as? NSOutlineView)
        XCTAssertEqual(outline.numberOfRows, 3)
        let next = try XCTUnwrap(outline.rowView(atRow: 2, makeIfNecessary: true))
        let initialY = next.frame.minY
        let parent = try XCTUnwrap(outline.item(atRow: 1))
        outline.animator().expandItem(parent)
        XCTAssertGreaterThan(motionPositions(next).count, 2)
        XCTAssertTrue(state.taskExpanded)
        XCTAssertEqual(outline.numberOfRows, 1_003)
        let reads = state.childReads
        XCTAssertLessThan(state.mounted.count, 100)
        outline.animator().collapseItem(parent)
        XCTAssertGreaterThan(motionPositions(next).count, 2)
        XCTAssertFalse(state.taskExpanded)
        XCTAssertEqual(state.childReads, reads, "Disclosure must reuse prepared children, not reread them")
        XCTAssertEqual(next.frame.minY, initialY, accuracy: 1)
        XCTAssertEqual(outline.numberOfRows, 3)
    }

    func testNativeListLimitsPreviewVirtualizesFullListAndRestoresAfterRapidToggles() throws {
        _ = NSApplication.shared
        let state = State(), session = try motionSession()
        let window = NSWindow(contentRect: .init(x: 0, y: 0, width: 300, height: 600),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let host = NSHostingView(rootView: NativeSurface(state: state,
            tasks: motionTasks(count: 1_000, session: session), session: session))
        window.contentView = host
        window.orderBack(nil)
        defer { window.orderOut(nil); window.contentView = nil }
        settle(0.15)
        let table = try XCTUnwrap(findTable(in: host))
        let nativeOutline = try XCTUnwrap(table as? NSOutlineView)
        XCTAssertTrue(nativeOutline.frameOfOutlineCell(atRow: 0).isEmpty)
        XCTAssertEqual(table.numberOfRows, 2)
        let nextRow = try XCTUnwrap(table.rowView(atRow: 1, makeIfNecessary: true))
        let collapsedY = nextRow.frame.minY
        state.expanded = true
        let expanding = motionPositions(nextRow)
        XCTAssertGreaterThan(expanding.count, 2, "Expansion must visibly interpolate, not jump in one update")
        XCTAssertGreaterThan(nextRow.frame.minY, collapsedY + 100)
        XCTAssertEqual(table.numberOfRows, 7, "Only the five preview tasks enter the native list")
        XCTAssertLessThanOrEqual(state.mounted.count, 5)
        state.expanded = false
        let collapsing = motionPositions(nextRow)
        XCTAssertGreaterThan(collapsing.count, 2, "Collapse must move following rows continuously")
        XCTAssertEqual(nextRow.frame.minY, collapsedY, accuracy: 1)
        state.expanded = true
        settle(0.35)
        state.showsAll = true
        settle(0.2)
        XCTAssertEqual(table.numberOfRows, 1_002)
        XCTAssertLessThan(state.mounted.count, 100, "The native list must mount a viewport, not all 1,000 task rows")
        table.scrollRowToVisible(1_000)
        settle(0.15)
        XCTAssertNotNil(table.rowView(atRow: 1_000, makeIfNecessary: false))
        XCTAssertTrue(state.mounted.contains("task:999"), "A reused native cell must display the new task identity")
        for _ in 0..<7 {
            state.expanded.toggle()
            settle(0.025)
        }
        settle(0.35)
        XCTAssertFalse(state.expanded)
        XCTAssertEqual(table.numberOfRows, 2)
        XCTAssertLessThanOrEqual(table.enclosingScrollView?.contentView.bounds.minY ?? 0, 1,
            "Collapsing a long scrolled group must clamp the scroll position")
        state.allowsCollapse = false
        state.expanded = true
        settle(0.35)
        let outline = try XCTUnwrap(table as? NSOutlineView)
        let item = try XCTUnwrap(outline.item(atRow: 0))
        outline.collapseItem(item)
        XCTAssertTrue(outline.isItemExpanded(item), "Search-forced expansion must also apply to native disclosure controls")
    }

    private func motionPositions(_ view: NSView) -> [CGFloat] {
        var positions: [CGFloat] = []
        let end = Date().addingTimeInterval(0.4)
        while Date() < end {
            settle(0.005)
            let y = view.layer?.presentation()?.frame.minY ?? view.frame.minY
            if positions.last.map({ abs($0 - y) > 0.1 }) ?? true { positions.append(y) }
        }
        return positions
    }

    private func findTable(in view: NSView) -> NSTableView? {
        if let table = view as? NSTableView { return table }
        return view.subviews.lazy.compactMap { self.findTable(in: $0) }.first
    }

    private func settle(_ duration: TimeInterval) {
        RunLoop.main.run(until: Date().addingTimeInterval(duration))
    }

    private func motionSession() throws -> TaskSession {
        try JSONDecoder().decode(TaskSession.self, from: Data("""
        {"id":"session:motion","title":"会话","agent":"codex","agentId":"role:motion",
         "status":"running","progress":0,"summary":"","updatedAt":"2026-10-31T00:00:00Z","accent":"cyan",
         "external":{"provider":"codex-app-server","currentModel":"model-v1"}}
        """.utf8))
    }

    private func motionTasks(count: Int, session: TaskSession) -> [CorptieTask] {
        (0..<count).map { index in
            CorptieTask(id: "task:\(index)", workId: "work:motion", title: "Task \(index) with a long title",
                description: "", acceptanceCriteria: "", priority: "medium", lifecycleState: "in_progress",
                mainRoleId: "role:motion", currentSessionId: session.id, executionStatus: "idle",
                acceptanceAssessment: nil, completionSuggestion: nil, createdAt: "", updatedAt: "")
        }
    }

    func testDefaultPreviewUsesPreparedFiveRootsAcrossRepeatedWorkToggles() async throws {
        let suite = "ConsoleWorkOutlineDisclosureTests.preview.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let preferences = ConsoleOutlineExpansionPreferences(defaults: defaults)
        let session = try motionSession(), store = ConsoleOutlineProjectionStore()
        let key = ConsoleOutlineProjectionKey(entityRevision: 1, sessionRevision: 1, search: "", sort: .standard,
            expandedTaskIDs: ["task:0"])
        var tasks = motionTasks(count: 1_000, session: session)
        var child = tasks.removeLast()
        child.parentTaskId = tasks[0].id
        tasks.insert(child, at: 1)
        await store.prepare(key: key, tasks: tasks, works: [], sessions: [])
        for _ in 0..<20 {
            preferences.toggleWork(workID: "work:motion")
            await store.prepare(key: key, tasks: tasks, works: [], sessions: [])
            let rows = try XCTUnwrap(store.prepared.workRowsByWorkID["work:motion"])
            XCTAssertEqual(rows.rootCount, 999)
            XCTAssertEqual(rows.rows(showsAll: false).map(\.id), ["task:0", "task:999", "task:1", "task:2", "task:3", "task:4"])
            XCTAssertEqual(rows.rows(showsAll: true).count, 1_000)
        }
        XCTAssertEqual(store.computationCount, 1)
        XCTAssertFalse(store.lastComputationUsedMainThread)
    }

    func testBackgroundPreparationReusesOtherWorksAndDiscardsSupersededRequests() async throws {
        let session = try motionSession(), store = ConsoleOutlineProjectionStore()
        var tasks = motionTasks(count: 300, session: session)
        var other = motionTasks(count: 1, session: session)[0]
        other.workId = "work:other"
        // Different IDs across the two Works are required by the inventory contract.
        other = CorptieTask(id: "task:other", workId: other.workId, title: "Other", description: "",
            acceptanceCriteria: "", priority: "medium", lifecycleState: "todo", mainRoleId: nil,
            currentSessionId: nil, executionStatus: nil, createdAt: "", updatedAt: "")
        tasks.append(other)
        func key(_ revision: UInt64, sort: WorkOutlineSort = .standard) -> ConsoleOutlineProjectionKey {
            .init(entityRevision: revision, sessionRevision: 0, search: "", sort: sort)
        }
        await store.prepare(key: key(1), tasks: tasks, works: [], sessions: [])
        XCTAssertFalse(store.lastComputationUsedMainThread)
        let structureRevision = store.prepared.workRowsByWorkID["work:motion"]?.structureRevision
        tasks[0].description = "An unrelated description patch"
        await store.prepare(key: key(2), tasks: tasks, works: [], sessions: [])
        XCTAssertTrue(store.rebuiltWorkIDs.isEmpty)
        XCTAssertEqual(store.prepared.workRowsByWorkID["work:motion"]?.structureRevision, structureRevision)
        XCTAssertEqual(store.prepared.workRowsByWorkID["work:motion"]?.allRows.first?.description, tasks[0].description)
        await store.prepare(key: key(3, sort: .name), tasks: tasks, works: [], sessions: [])
        tasks[0].title = "ZZZ"
        await store.prepare(key: key(4, sort: .name), tasks: tasks, works: [], sessions: [])
        XCTAssertEqual(store.rebuiltWorkIDs, ["work:motion"])
        let large = motionTasks(count: 10_000, session: session)
        let pending = Task { await store.prepare(key: key(5), tasks: large, works: [], sessions: []) }
        for _ in 0..<1_000 {
            if store.requestedKey == key(5) { break }
            await Task.yield()
        }
        XCTAssertEqual(store.requestedKey, key(5))
        await store.prepare(key: key(4, sort: .name), tasks: tasks, works: [], sessions: [])
        await pending.value
        XCTAssertEqual(store.preparedKey, key(4, sort: .name), "Returning to an already prepared view must cancel a pending replacement")
        XCTAssertEqual(store.prepared.workRowsByWorkID["work:motion"]?.allRows.count, 300)
    }

    func testChangingOneWorkDoesNotInvalidateOtherWorkOrChatObservers() throws {
        let suite = "ConsoleWorkOutlineDisclosureTests.isolation.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let preferences = ConsoleOutlineExpansionPreferences(defaults: defaults)
        let selected = BodyCounts(), sibling = BodyCounts(), chat = BodyCounts()
        withObservationTracking { _ = preferences.isWorkExpanded("work:a") }
            onChange: { MainActor.assumeIsolated { selected.root += 1 } }
        withObservationTracking { _ = preferences.isWorkExpanded("work:b") }
            onChange: { MainActor.assumeIsolated { sibling.root += 1 } }
        withObservationTracking { _ = preferences.isAssistantCollapsed }
            onChange: { MainActor.assumeIsolated { chat.root += 1 } }
        preferences.setWorkExpanded(true, workID: "work:a")
        XCTAssertEqual(selected.root, 1)
        XCTAssertEqual(sibling.root, 0)
        XCTAssertEqual(chat.root, 0)
        XCTAssertTrue(preferences.isWorkExpanded("work:a"))
        XCTAssertFalse(preferences.isWorkExpanded("work:b"))
        let restored = ConsoleOutlineExpansionPreferences(defaults: defaults)
        XCTAssertTrue(restored.isWorkExpanded("work:a"))
        preferences.removeWork("work:a")
        XCTAssertFalse(preferences.isWorkExpanded("work:a"))
    }
}
