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
                    isExpanded: state.expanded, allowsCollapse: state.allowsCollapse, showsDisclosureIndicator: false, showsRowDisclosureIndicator: false, expansionChanged: { state.expanded = $0 },
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

    private struct RefreshProbeRow: Identifiable { let id: String }
    private final class RefreshProbe { var configurations = 0 }

    func testPeerChatAndProjectHeadingsHaveTheSameNativeLeadingEdge() throws {
        _ = NSApplication.shared
        let groups: [ConsoleNativeOutlineGroup<RefreshProbeRow>] = [
            .init(id: "assistant", header: AnyView(ConsolePrimarySectionHeading(title: "聊天")),
                rows: [.init(id: "chat-row")], isExpanded: true, usesSectionStyle: true,
                allowsCollapse: false, showsDisclosureIndicator: false),
            .init(id: "projects-heading", header: AnyView(ConsolePrimarySectionHeading(title: "项目")),
                isSection: true, showsDisclosureIndicator: false)
        ]
        let host = NSHostingView(rootView: ConsoleNativeOutline(groups: { groups }) { Text($0.id) })
        let window = NSWindow(contentRect: .init(x: 0, y: 0, width: 300, height: 300),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        defer { window.contentView = nil; window.orderOut(nil) }
        settle(0.1)
        let outline = try XCTUnwrap(findTable(in: host) as? NSOutlineView)
        XCTAssertEqual(outline.numberOfRows, 3, "Section styling must keep the chat child visible")
        XCTAssertTrue(outline.frameOfOutlineCell(atRow: 0).isEmpty)
        XCTAssertTrue(outline.frameOfOutlineCell(atRow: 2).isEmpty)
        let chat = try XCTUnwrap(outline.view(atColumn: 0, row: 0, makeIfNecessary: true))
        let projects = try XCTUnwrap(outline.view(atColumn: 0, row: 2, makeIfNecessary: true))
        outline.layoutSubtreeIfNeeded()
        XCTAssertEqual(outline.convert(chat.bounds, from: chat).minX,
            outline.convert(projects.bounds, from: projects).minX, accuracy: 0.5)
    }

    func testLayoutOnlyPresentationDoesNotReconfigureWorkRows() throws {
        _ = NSApplication.shared
        let probe = RefreshProbe()
        func root(_ revision: UInt64, showsAll: Bool = false) -> ConsoleNativeOutline<RefreshProbeRow, Text> {
            ConsoleNativeOutline(groups: {
                [ConsoleNativeOutlineGroup(id: "work", header: AnyView(Text("Work")),
                    rows: (showsAll ? ["session", "older"] : ["session"]).map { RefreshProbeRow(id: $0) }, isExpanded: true)]
            }, presentation: .init(entityRevision: revision, sessionRevision: 1, archiveRevision: 1,
                projectionCount: 1, projectionKey: nil, selectedSessionID: nil, selectedTaskID: nil,
                selectedWorkID: nil, online: true, language: "en", search: "",
                fullyExpandedWorkIDs: showsAll ? ["work"] : [])) { row in
                probe.configurations += 1
                return Text(row.id)
            }
        }
        let host = NSHostingView(rootView: root(1))
        let window = NSWindow(contentRect: .init(x: 0, y: 0, width: 300, height: 400),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        defer { window.contentView = nil; window.orderOut(nil) }
        settle(0.1)
        let outline = try XCTUnwrap(findTable(in: host))
        _ = outline.view(atColumn: 0, row: 1, makeIfNecessary: true)
        let initial = probe.configurations
        XCTAssertGreaterThan(initial, 0)
        window.setContentSize(.init(width: 360, height: 500))
        host.rootView = root(1)
        settle(0.1)
        XCTAssertEqual(probe.configurations, initial)
        host.rootView = root(2)
        settle(0.1)
        XCTAssertGreaterThan(probe.configurations, initial, "Real data publications must still refresh mounted rows")
        host.rootView = root(2, showsAll: true)
        settle(0.1)
        XCTAssertEqual(outline.numberOfRows, 3, "Show more changes must not be mistaken for layout-only updates")
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
        XCTAssertTrue(outline.frameOfOutlineCell(atRow: 1).isEmpty, "The left disclosure is hidden when a row supplies its trailing toggle")
        state.taskExpanded = true
        XCTAssertGreaterThan(motionPositions(next).count, 2)
        XCTAssertTrue(state.taskExpanded)
        XCTAssertEqual(outline.numberOfRows, 1_003)
        let reads = state.childReads
        XCTAssertLessThan(state.mounted.count, 100)
        state.taskExpanded = false
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
                  priority: "medium", lifecycleState: "in_progress",
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

    func testWorkChatEntryOpensWithoutHoverAndTitleIdentifiesItsWork() throws {
        _ = NSApplication.shared
        var session = try motionSession()
        session.sessionKind = .workChat; session.taskId = nil; session.workId = "work:motion"
        let row = SessionRowModel(session: session)
        var opens = 0
        let host = NSHostingView(rootView: ConsoleWorkChatRowContent(row: row, isSelected: false) { opens += 1 })
        let window = NSWindow(contentRect: .init(x: 0, y: 0, width: 280, height: 30),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host; window.orderBack(nil)
        defer { window.orderOut(nil); window.contentView = nil }
        settle(0.05)
        let point = CGPoint(x: 90, y: 15)
        for kind in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            let event = try XCTUnwrap(NSEvent.mouseEvent(with: kind, location: point, modifierFlags: [],
                timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                context: nil, eventNumber: 1, clickCount: 1, pressure: kind == .leftMouseDown ? 1 : 0))
            window.sendEvent(event)
        }
        settle(0.05)
        XCTAssertEqual(opens, 1)
        XCTAssertEqual(SessionConversationHeaderSurface.displayTitle(session: session, workName: "Project A"), "Project A · Work Chat")
        XCTAssertEqual(SessionConversationHeaderSurface.displayTitle(session: session, workName: nil), "Work Chat")
        session.sessionKind = .worker
        XCTAssertEqual(SessionConversationHeaderSurface.displayTitle(session: session, workName: "Project A"), session.title)
    }

    func testManualWorkOrderRestoresAfterRecreatingStoreAndInitialEmptyInventory() async throws {
        let suite = "ConsoleWorkOutlineDisclosureTests.workOrder.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        func work(_ id: String) -> Work {
            Work(id: id, workspaceId: "workspace:test", name: id, description: "", status: "active",
                profile: "", tags: [], contributorRoleIds: [], createdAt: "", updatedAt: "")
        }
        let works = [work("work:a"), work("work:b"), work("work:c")]
        let store = ConsoleOutlineProjectionStore(defaults: defaults)
        await store.prepare(key: .init(entityRevision: 1, sessionRevision: 0, search: "", sort: .standard),
            tasks: [], works: works, sessions: [])
        XCTAssertTrue(store.moveWork("work:c", relativeTo: "work:a", after: false))
        let restored = ConsoleOutlineProjectionStore(defaults: try XCTUnwrap(UserDefaults(suiteName: suite)))
        await restored.prepare(key: .init(entityRevision: 0, sessionRevision: 0, search: "", sort: .standard),
            tasks: [], works: [], sessions: [])
        await restored.prepare(key: .init(entityRevision: 1, sessionRevision: 0, search: "", sort: .name),
            tasks: [], works: works, sessions: [])
        XCTAssertEqual(restored.prepared.works.map(\.id), ["work:c", "work:a", "work:b"])
        await restored.prepare(key: .init(entityRevision: 2, sessionRevision: 0, search: "", sort: .updated),
            tasks: [], works: [work("work:new"), works[1], works[0]], sessions: [])
        XCTAssertEqual(restored.prepared.works.map(\.id), ["work:a", "work:b", "work:new"])
        XCTAssertTrue(restored.moveWork("work:new", relativeTo: "work:a", after: false))
        let again = ConsoleOutlineProjectionStore(defaults: defaults)
        await again.prepare(key: .init(entityRevision: 3, sessionRevision: 0, search: "", sort: .standard),
            tasks: [], works: [works[0], works[1], work("work:new")], sessions: [])
        XCTAssertEqual(again.prepared.works.map(\.id), ["work:new", "work:a", "work:b"])
    }

    func testManualWorkOrderSurvivesRefreshAndInFlightPreparationWithoutRebuildingTasks() async throws {
        let session = try motionSession(), store = ConsoleOutlineProjectionStore()
        func work(_ id: String) -> Work {
            Work(id: id, workspaceId: "workspace:test", name: id, description: "", status: "active",
                profile: "", tags: [], contributorRoleIds: [], createdAt: "", updatedAt: "")
        }
        let works = [work("work:motion"), work("work:b"), work("work:c")]
        let tasks = motionTasks(count: 1_000, session: session)
        func key(_ revision: UInt64) -> ConsoleOutlineProjectionKey {
            .init(entityRevision: revision, sessionRevision: 0, search: "", sort: .name)
        }
        await store.prepare(key: key(1), tasks: tasks, works: works, sessions: [])
        let count = store.computationCount
        let revision = store.prepared.workRowsByWorkID[works[0].id]?.structureRevision
        XCTAssertTrue(store.moveWork(works[2].id, relativeTo: works[0].id, after: false))
        XCTAssertEqual(store.prepared.works.map(\.id), [works[2].id, works[0].id, works[1].id])
        XCTAssertEqual(store.computationCount, count)
        XCTAssertEqual(store.prepared.workRowsByWorkID[works[0].id]?.structureRevision, revision)
        XCTAssertFalse(store.moveWork("missing", relativeTo: works[0].id, after: false))
        XCTAssertFalse(store.moveWork(works[0].id, relativeTo: works[0].id, after: false))
        let pending = Task { await store.prepare(key: key(2), tasks: tasks, works: works.reversed(), sessions: []) }
        while store.requestedKey != key(2) { await Task.yield() }
        XCTAssertTrue(store.moveWork(works[2].id, relativeTo: works[1].id, after: true))
        await pending.value
        XCTAssertEqual(store.prepared.works.map(\.id), works.map(\.id))
        XCTAssertEqual(store.prepared.workRowsByWorkID[works[0].id]?.structureRevision, revision)
        await store.prepare(key: key(3), tasks: tasks, works: works.reversed(), sessions: [])
        XCTAssertEqual(store.prepared.works.map(\.id), works.map(\.id))
    }

    func testSortModesAndActivityKeepWorkPositionsWhileOrderingTasks() async throws {
        let session = try motionSession(), store = ConsoleOutlineProjectionStore()
        func work(_ id: String, _ name: String) -> Work {
            Work(id: id, workspaceId: "workspace:test", name: name, description: "", status: "active",
                profile: "", tags: [], contributorRoleIds: [], createdAt: "2026-01-01", updatedAt: "2026-01-01")
        }
        let first = work("work:motion", "Zulu"), second = work("work:other", "Alpha")
        let added = work("work:new", "Aardvark")
        let base = motionTasks(count: 2, session: session)
        var tasks = base
        tasks[0].title = "Zulu"; tasks[1].title = "Alpha"
        tasks[0].updatedAt = "2026-01-02"; tasks[1].updatedAt = "2026-01-01"
        func prepare(_ revision: UInt64, _ sort: WorkOutlineSort, _ works: [Work], sessions: [TaskSession] = []) async {
            await store.prepare(key: .init(entityRevision: revision, sessionRevision: revision, search: "", sort: sort),
                tasks: tasks, works: works, sessions: sessions)
        }
        await prepare(1, .standard, [first, second])
        XCTAssertEqual(store.prepared.works.map(\.id), [first.id, second.id])
        await prepare(2, .name, [second, first])
        XCTAssertEqual(store.prepared.works.map(\.id), [first.id, second.id])
        XCTAssertEqual(store.prepared.workRowsByWorkID[first.id]?.allRows.map(\.id), [tasks[1].id, tasks[0].id])
        var active = session
        active.taskId = tasks[1].id; active.workId = second.id
        active.lastMessageAt = "2026-12-01"
        await prepare(3, .updated, [second, first], sessions: [active])
        XCTAssertEqual(store.prepared.works.map(\.id), [first.id, second.id])
        XCTAssertEqual(store.prepared.workRowsByWorkID[first.id]?.allRows.map(\.id), [tasks[1].id, tasks[0].id])
        await prepare(4, .name, [added, second, first])
        XCTAssertEqual(store.prepared.works.map(\.id), [first.id, second.id, added.id])
        await prepare(5, .updated, [added, second])
        XCTAssertEqual(store.prepared.works.map(\.id), [second.id, added.id])
    }

    func testBackgroundPreparationReusesOtherWorksAndDiscardsSupersededRequests() async throws {
        let session = try motionSession(), store = ConsoleOutlineProjectionStore()
        var tasks = motionTasks(count: 300, session: session)
        var other = motionTasks(count: 1, session: session)[0]
        other.workId = "work:other"
        // Different IDs across the two Works are required by the inventory contract.
        other = CorptieTask(id: "task:other", workId: other.workId, title: "Other",
             priority: "medium", lifecycleState: "todo", mainRoleId: nil,
            currentSessionId: nil, executionStatus: nil, createdAt: "", updatedAt: "")
        tasks.append(other)
        func key(_ revision: UInt64, sort: WorkOutlineSort = .standard) -> ConsoleOutlineProjectionKey {
            .init(entityRevision: revision, sessionRevision: 0, search: "", sort: sort)
        }
        await store.prepare(key: key(1), tasks: tasks, works: [], sessions: [])
        XCTAssertFalse(store.lastComputationUsedMainThread)
        let structureRevision = store.prepared.workRowsByWorkID["work:motion"]?.structureRevision
        tasks[0].priority = "urgent"
        await store.prepare(key: key(2), tasks: tasks, works: [], sessions: [])
        XCTAssertTrue(store.rebuiltWorkIDs.isEmpty)
        XCTAssertEqual(store.prepared.workRowsByWorkID["work:motion"]?.structureRevision, structureRevision)
        XCTAssertEqual(store.prepared.workRowsByWorkID["work:motion"]?.allRows.first?.priority, tasks[0].priority)
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
