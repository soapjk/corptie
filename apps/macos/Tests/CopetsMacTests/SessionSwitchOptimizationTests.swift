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

    func testWorkspaceContextUpdatesOnlyOwningSessionAndPreservesWarmHosts() throws {
        _ = NSApplication.shared
        let table = AppKitChatTimelineView.makeTableView()
        table.tableColumns[0].width = 480
        let coordinator = AppKitChatTimelineCoordinator(sessionID: "a", baseDirectory: "/tmp/a",
            followsLatest: .constant(false), onToggleExpansion: { _ in })
        func message(_ sessionID: String) -> AppKitChatTimelineRow {
            var row = AppKitChatTimelineRow(id: "message-" + sessionID, contentRevision: 1,
                nativeText: "Cached message", copyText: "Cached message", nativeStyle: .agent,
                title: "", metadata: "", expandableTurnId: nil, isExpanded: false, showsHeader: false)
            row.sessionID = sessionID
            return row
        }
        coordinator.apply(rows: [message("a")])
        let inactiveCell = try XCTUnwrap(coordinator.tableView(table,
            viewFor: table.tableColumns[0], row: 0) as? AppKitSharedMessageTextCell)
        let inactiveHostsBefore = inactiveCell.hostUpdateCount
        coordinator.switchSessionIfNeeded(to: "b", initialPosition: nil)
        coordinator.apply(rows: [message("b")])
        let activeCell = try XCTUnwrap(coordinator.tableView(table,
            viewFor: table.tableColumns[0], row: 0) as? AppKitSharedMessageTextCell)
        XCTAssertFalse(inactiveCell === activeCell)
        let activeHostsBefore = activeCell.hostUpdateCount
        coordinator.updateBaseDirectory("/tmp/b")
        let inactiveHost = try XCTUnwrap(inactiveCell.subviews.compactMap {
            $0 as? NSHostingView<MacSharedMessageTextCard>
        }.first)
        let activeHost = try XCTUnwrap(activeCell.subviews.compactMap {
            $0 as? NSHostingView<MacSharedMessageTextCard>
        }.first)
        XCTAssertEqual(inactiveCell.hostUpdateCount, inactiveHostsBefore)
        XCTAssertEqual(activeCell.hostUpdateCount, activeHostsBefore + 1)
        XCTAssertEqual(inactiveHost.rootView.baseDirectory, "/tmp/a")
        XCTAssertEqual(activeHost.rootView.baseDirectory, "/tmp/b")
        coordinator.updateBaseDirectory(" /tmp/b ")
        XCTAssertEqual(activeCell.hostUpdateCount, activeHostsBefore + 1)
        coordinator.updateBaseDirectory(nil)
        XCTAssertNil(activeHost.rootView.baseDirectory)
        XCTAssertEqual(inactiveHost.rootView.baseDirectory, "/tmp/a")
        coordinator.updateBaseDirectory("/tmp/b")
        let activeHostsAfter = activeCell.hostUpdateCount
        coordinator.switchSessionIfNeeded(to: "a", initialPosition: nil)
        coordinator.updateBaseDirectory("/tmp/a")
        coordinator.apply(rows: [message("a")])
        let returnedCell = try XCTUnwrap(coordinator.tableView(table,
            viewFor: table.tableColumns[0], row: 0) as? AppKitSharedMessageTextCell)
        XCTAssertTrue(returnedCell === inactiveCell)
        XCTAssertEqual(inactiveCell.hostUpdateCount, inactiveHostsBefore,
            "Returning to an unchanged Session must retain its existing host root")
        coordinator.updateBaseDirectory("/tmp/a-renamed")
        XCTAssertEqual(inactiveHost.rootView.baseDirectory, "/tmp/a-renamed")
        XCTAssertEqual(activeHost.rootView.baseDirectory, "/tmp/b")
        XCTAssertEqual(activeCell.hostUpdateCount, activeHostsAfter)
    }

    func testWorkHeaderEqualityRequiresActionScopeAndAllDisplayInputs() {
        let owner = NSObject(), otherOwner = NSObject()
        let work = Work(id: "work:header-equality", workspaceId: "workspace:test", name: "Work",
            description: "", status: "active", profile: "general", tags: [], contributorAgentIds: [],
            createdAt: "", updatedAt: "")
        func header(_ scope: AnyObject?) -> ConsoleWorkOutlineHeader {
            ConsoleWorkOutlineHeader(work: work, isExpanded: false, isSelected: false,
                isWorking: false, hasUnread: false, isChatSelected: false, isChatRunning: false,
                hasUnreadChat: false, toggleExpanded: {}, openChat: {}, createTask: {}, actionOwner: scope ?? NSObject())
        }
        let baseline = header(owner)
        XCTAssertEqual(baseline, header(owner))
        XCTAssertNotEqual(baseline, header(otherOwner))
        XCTAssertNotEqual(header(nil), header(nil), "Unscoped arbitrary closures cannot safely be skipped")
        let unscoped = header(nil)
        XCTAssertEqual(unscoped, unscoped, "Equality remains reflexive for an unscoped header")
        func changed(_ edit: (inout ConsoleWorkOutlineHeader) -> Void) -> ConsoleWorkOutlineHeader {
            var value = baseline; edit(&value); return value
        }
        XCTAssertNotEqual(baseline, changed { $0.isActive = false })
        var renamedWork = work; renamedWork.name = "Renamed"
        let renamed = ConsoleWorkOutlineHeader(work: renamedWork, isExpanded: false, isSelected: false,
            isWorking: false, hasUnread: false, isChatSelected: false, isChatRunning: false,
            hasUnreadChat: false, toggleExpanded: {}, openChat: {}, createTask: {}, actionOwner: owner)
        XCTAssertNotEqual(baseline, renamed)
    }

    func testNativeWorkHeaderSkipsEqualParentUpdatesAndRefreshesChangedInputs() throws {
        let trace = SessionSwitchTrace.shared
        guard trace.begin(sessionID: "fixture:header-render") != nil else {
            throw XCTSkip("Run with Development CORPTIE_SESSION_SWITCH_TRACE=1 for native body counts")
        }
        defer { trace.end(reason: "test") }
        _ = NSApplication.shared
        let owner = NSObject()
        let work = Work(id: "work:header-render", workspaceId: "workspace:test", name: "Work",
            description: "", status: "active", profile: "general", tags: [], contributorAgentIds: [],
            createdAt: "", updatedAt: "")
        func header(expanded: Bool = false, selected: Bool = false, working: Bool = false,
                    unread: Bool = false, chatSelected: Bool = false, chatRunning: Bool = false,
                    unreadChat: Bool = false) -> ConsoleWorkOutlineHeader {
            ConsoleWorkOutlineHeader(work: work, isExpanded: expanded, isSelected: selected,
                isWorking: working, hasUnread: unread, isChatSelected: chatSelected,
                isChatRunning: chatRunning, hasUnreadChat: unreadChat,
                toggleExpanded: {}, openChat: {}, createTask: {}, actionOwner: owner)
        }
        let host = NSHostingView(rootView: header().equatable())
        let window = NSWindow(contentRect: .init(x: 0, y: 0, width: 400, height: 40),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host; window.orderBack(nil)
        defer { window.close() }
        func pump() {
            host.layoutSubtreeIfNeeded()
            RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        }
        pump()
        let before = try XCTUnwrap(trace.snapshot?.workHeaders[work.id]?.count)
        XCTAssertGreaterThan(before, 0)
        host.rootView = header().equatable(); pump()
        XCTAssertEqual(trace.snapshot?.workHeaders[work.id]?.count, before)
        let changed = [header(expanded: true), header(selected: true), header(working: true),
                       header(unread: true), header(chatSelected: true), header(chatRunning: true),
                       header(unreadChat: true)]
        for value in changed {
            let previous = trace.snapshot?.workHeaders[work.id]?.count ?? 0
            host.rootView = value.equatable(); pump()
            XCTAssertGreaterThan(trace.snapshot?.workHeaders[work.id]?.count ?? 0, previous,
                "A real display input change must reach the native hosted header")
        }
    }

    private func singleInstallHarness() -> (SwitchReloadRecordingTable, NSScrollView, AppKitChatTimelineCoordinator) {
        _ = NSApplication.shared
        let table = SwitchReloadRecordingTable(frame: .init(x: 0, y: 0, width: 480, height: 240))
        let column = NSTableColumn(identifier: AppKitChatTimelineCoordinator.columnIdentifier)
        column.width = 480; table.addTableColumn(column); table.headerView = nil
        let scroll = AppKitChatTimelineView.makeScrollView(tableView: table)
        scroll.frame = .init(x: 0, y: 0, width: 480, height: 240)
        let coordinator = AppKitChatTimelineCoordinator(sessionID: "a",
            followsLatest: .constant(false), onToggleExpansion: { _ in })
        coordinator.attach(tableView: table, scrollView: scroll)
        return (table, scroll, coordinator)
    }

    private func installRow(_ id: String) -> AppKitChatTimelineRow {
        AppKitChatTimelineRow(id: id, contentRevision: 1, nativeText: "Message " + id,
            copyText: "Message " + id, nativeStyle: .agent, title: "", metadata: "",
            expandableTurnId: nil, isExpanded: false, showsHeader: false)
    }

    func testDeferredSessionReloadInstallsTargetRowsOnceWithoutEmptyIntermediate() {
        let (table, scroll, coordinator) = singleInstallHarness()
        withExtendedLifetime(scroll) {
            coordinator.apply(rows: [installRow("a")])
            table.reloadRowCounts.removeAll()
            coordinator.switchSessionIfNeeded(to: "b", initialPosition: nil, deferReloadUntilRowsArrive: true)
            XCTAssertTrue(table.reloadRowCounts.isEmpty)
            let target = [installRow("b1"), installRow("b2")]
            coordinator.apply(rows: target)
            XCTAssertEqual(table.reloadRowCounts, [2], "Only the complete target projection should reload")
            XCTAssertEqual(table.numberOfRows, 2)
            coordinator.apply(rows: target)
            XCTAssertEqual(table.reloadRowCounts, [2], "Unchanged same-Session rows should not reload")
        }
    }

    func testDeferredEmptyTargetCanSubsequentlyReceiveItsRows() {
        let (table, scroll, coordinator) = singleInstallHarness()
        withExtendedLifetime(scroll) {
            coordinator.apply(rows: [installRow("a")])
            table.reloadRowCounts.removeAll()
            coordinator.switchSessionIfNeeded(to: "empty", initialPosition: nil, deferReloadUntilRowsArrive: true)
            coordinator.apply(rows: [])
            XCTAssertEqual(table.reloadRowCounts, [0], "A genuinely empty target remains a valid projection")
            XCTAssertEqual(table.numberOfRows, 0)
            coordinator.apply(rows: [installRow("arrived")])
            XCTAssertEqual(table.numberOfRows, 1)
        }
    }

    func testDeferredSavedAnchorUsesTheInstalledTargetRows() {
        let (table, scroll, coordinator) = singleInstallHarness()
        withExtendedLifetime(scroll) {
            coordinator.apply(rows: (0..<40).map { installRow("a-\($0)") })
            let position = AppKitChatTimelinePosition(rowID: "b-18", offset: 3,
                absoluteScrollY: 0, followsLatest: false)
            coordinator.switchSessionIfNeeded(to: "b", initialPosition: position,
                deferReloadUntilRowsArrive: true)
            coordinator.apply(rows: (0..<40).map { installRow("b-\($0)") })
            scroll.layoutSubtreeIfNeeded()
            let expectedY = table.rect(ofRow: 18).minY + 3
            XCTAssertGreaterThan(expectedY, 0)
            XCTAssertEqual(scroll.contentView.bounds.minY, expectedY, accuracy: 4,
                "The first target projection must restore the saved target anchor")
        }
    }

    private func headerInputs(expanded: Bool = false, selected: Bool = false) -> SessionSwitchTrace.WorkHeaderInputs {
        .init(title: "Work", avatarPath: nil, expanded: expanded, selected: selected,
              working: false, unread: false, chatSelected: false, chatRunning: false,
              unreadChat: false, active: true)
    }

    func testHeaderCountersDistinguishUnchangedChangedAndMissingBaseline() throws {
        let trace = SessionSwitchTrace(enabled: true, clock: { 100 })
        defer { trace.end(reason: "test") }
        trace.recordWorkHeader(workID: "collapsed", inputs: headerInputs())
        XCTAssertNil(trace.snapshot)
        trace.begin(sessionID: "one")
        trace.recordWorkHeader(workID: "collapsed", inputs: headerInputs())
        trace.recordWorkHeader(workID: "collapsed", inputs: headerInputs(selected: true))
        trace.recordWorkHeader(workID: "new", inputs: headerInputs(expanded: true))
        let metric = try XCTUnwrap(trace.snapshot?.workHeaders["collapsed"])
        XCTAssertEqual(metric.count, 2)
        XCTAssertEqual(metric.unchangedInputs, 1)
        XCTAssertEqual(metric.changedInputs, 1)
        XCTAssertEqual(metric.collapsed, 2)
        XCTAssertEqual(trace.snapshot?.workHeaders["new"]?.unknownInputs, 1)
        XCTAssertEqual(trace.snapshot?.workHeaders["new"]?.collapsed, 0)
        trace.begin(sessionID: "two")
        XCTAssertTrue(trace.snapshot?.workHeaders.isEmpty == true)
        trace.recordWorkHeader(workID: "collapsed", inputs: headerInputs(selected: true))
        XCTAssertEqual(trace.snapshot?.workHeaders["collapsed"]?.unchangedInputs, 1)
    }

    func testEntityCountersAreBoundedAndRejectWrongSessionAndExpiredWork() {
        var now = 100.0
        let trace = SessionSwitchTrace(enabled: true, clock: { now })
        defer { trace.end(reason: "test") }
        trace.begin(sessionID: "one")
        trace.recordDetailPanel(sessionID: "other")
        trace.recordCell(.hostAssigned, sessionID: "other", rowID: "wrong")
        trace.recordCell(.hostAssigned, sessionID: nil, rowID: "missing-session")
        XCTAssertEqual(trace.snapshot?.detailBodies, 0)
        XCTAssertTrue(trace.snapshot?.cells.isEmpty == true)
        for index in 0..<300 {
            trace.recordCell(.miss, sessionID: "one", rowID: "row-\(index)")
        }
        for index in 0..<70 {
            trace.recordWorkHeader(workID: "work-\(index)", inputs: headerInputs())
        }
        XCTAssertEqual(trace.snapshot?.cells.count, 256)
        XCTAssertEqual(trace.snapshot?.workHeaders.count, 64)
        XCTAssertLessThanOrEqual(trace.workHeaderInputs.count, 64)
        XCTAssertEqual(trace.snapshot?.droppedEntities, 50)
        trace.recordCell(.hit, sessionID: "one", rowID: "row-0")
        trace.recordCell(.hostAssigned, sessionID: "one", rowID: "row-0")
        XCTAssertEqual(trace.snapshot?.cells["row-0"]?[.miss], 1)
        XCTAssertEqual(trace.snapshot?.cells["row-0"]?[.hit], 1)
        XCTAssertEqual(trace.snapshot?.cells["row-0"]?[.hostAssigned], 1)
        trace.recordDetailPanel(sessionID: "one")
        now += 5
        trace.recordDetailPanel(sessionID: "one")
        trace.recordCell(.hit, sessionID: "one", rowID: "row-0")
        XCTAssertEqual(trace.snapshot?.detailBodies, 1)
        XCTAssertEqual(trace.snapshot?.cells["row-0"]?[.hit], 1)
    }

    func testDisabledEntityCountersDoNotEvaluateInputsOrReadClock() {
        let trace = SessionSwitchTrace(enabled: false, clock: {
            XCTFail("Disabled counters must not read clock")
            return 0
        })
        func unexpectedInputs() -> SessionSwitchTrace.WorkHeaderInputs {
            XCTFail("Disabled counters must not evaluate input construction")
            return headerInputs()
        }
        trace.recordWorkHeader(workID: "work", inputs: unexpectedInputs())
        trace.recordDetailPanel(sessionID: "one")
        trace.recordCell(.miss, sessionID: "one", rowID: "row")
        XCTAssertTrue(trace.workHeaderInputs.isEmpty)
        XCTAssertNil(trace.snapshot)
    }

    func testSwitchTraceRejectsOldSessionAndSupersededSegments() {
        var now = 100.0
        let trace = SessionSwitchTrace(enabled: true, clock: { now })
        defer { trace.end(reason: "test") }
        let firstID = trace.begin(sessionID: "one", eventTimestamp: 99.9)
        let oldSegment = trace.start(.timelineApply, sessionID: "one")
        now = 100.02
        let secondID = trace.begin(sessionID: "two")
        XCTAssertNotEqual(firstID, secondID)
        XCTAssertNil(trace.start(.cardHost, sessionID: "one"))
        trace.mark(.viewportLayout, sessionID: "one")
        trace.finish(oldSegment)
        XCTAssertTrue(trace.snapshot?.metrics.isEmpty == true)
        trace.mark(.viewportLayout, sessionID: "two")
        now = 100.05
        trace.mark(.viewportLayout, sessionID: "two")
        XCTAssertEqual(trace.snapshot?.firstStageMilliseconds[.viewportLayout] ?? -1, 0, accuracy: 0.001)
        XCTAssertEqual(trace.snapshot?.metrics[.viewportLayout]?.count, 2)
    }

    func testSwitchTraceMeasuresNestedWorkWithoutClaimingPaint() {
        var now = 100.0
        let trace = SessionSwitchTrace(enabled: true, clock: { now })
        defer { trace.end(reason: "test") }
        let id = trace.begin(sessionID: "one", eventTimestamp: 99.95)
        XCTAssertEqual(trace.snapshot?.eventQueueMilliseconds ?? -1, 50, accuracy: 0.001)
        trace.ensureSelection(sessionID: "one")
        XCTAssertEqual(trace.snapshot?.id, id)
        let outer = trace.start(.timelineUpdate, sessionID: "one")
        now += 0.01
        let inner = trace.start(.timelineApply, sessionID: "one")
        now += 0.02
        trace.finish(inner)
        now += 0.01
        trace.finish(outer)
        XCTAssertEqual(trace.snapshot?.metrics[.timelineApply]?.totalMilliseconds ?? -1, 20, accuracy: 0.001)
        XCTAssertEqual(trace.snapshot?.metrics[.timelineUpdate]?.totalMilliseconds ?? -1, 40, accuracy: 0.001)
        XCTAssertNil(trace.snapshot?.firstStageMilliseconds[.viewportLayout])
        now += 5
        XCTAssertNil(trace.start(.cardHost))
        trace.mark(.viewportLayout)
        XCTAssertNil(trace.snapshot?.firstStageMilliseconds[.viewportLayout])
    }

    func testSwitchTraceDisabledDoesNotReadClockOrCreateState() {
        let trace = SessionSwitchTrace(enabled: false, clock: {
            XCTFail("Disabled diagnostics must not read the clock")
            return 0
        })
        XCTAssertNil(trace.begin(sessionID: "one", eventTimestamp: 1))
        trace.ensureSelection(sessionID: "one")
        trace.mark(.outlineHit)
        XCTAssertNil(trace.start(.rowMapping))
        trace.finish(nil)
        trace.end(reason: "test")
        XCTAssertNil(trace.snapshot)
    }

    func testSwitchTraceDoesNotInventQueueLatencyForMissingOrFutureEvents() {
        let trace = SessionSwitchTrace(enabled: true, clock: { 100 })
        defer { trace.end(reason: "test") }
        for timestamp in [nil, 0, 101] as [Double?] {
            trace.begin(sessionID: "one", eventTimestamp: timestamp)
            XCTAssertNil(trace.snapshot?.eventQueueMilliseconds)
        }
    }

    func testSwitchTracePreservesBlockingWorkThatOutlastsObservationWindow() {
        var now = 100.0
        let trace = SessionSwitchTrace(enabled: true, clock: { now })
        defer { trace.end(reason: "test") }
        trace.begin(sessionID: "one")
        let segment = trace.start(.timelineApply, sessionID: "one")
        now += 6
        trace.finish(segment)
        XCTAssertEqual(trace.snapshot?.metrics[.timelineApply]?.totalMilliseconds ?? -1, 6000, accuracy: 0.001)
        XCTAssertNil(trace.start(.cardHost))
    }

    func testFullConsoleWarmTaskSwitchUpdatesContentWithoutReplacingSplitRoots() throws {
        _ = NSApplication.shared
        let client = BackendClient.shared
        let store = client.appState
        let prefix = "fixture:console-switch-\(UUID().uuidString)"
        let ids = [prefix + "-one", prefix + "-two"]
        let taskIDs = ids.map { $0 + "-task" }
        let workIDs = ids.map { $0 + "-work" }
        defer {
            client.sessionSelectionController.clear()
            for id in ids { SessionTimelineRepository.shared.remove(id) }
            _ = store.apply(changeSet: .init(snapshotRequired: false, baseRevision: store.revision,
                revision: store.revision + 1,
                upserts: .init(sessions: [], tasks: [], works: [], agents: [], skills: [], repositories: [], integrationRuns: []),
                deletes: .init(sessions: ids, tasks: taskIDs, works: workIDs, agents: [], skills: [], repositories: [], integrationRuns: [])))
        }
        let fixture = ChatPerformanceFixture.make(configuration: .init(turnCount: 2, rawItemCount: 10, longMessageCharacters: 200))
        for index in ids.indices {
            let work = Work(id: workIDs[index], workspaceId: "workspace:" + workIDs[index], name: "Switch work \(index)",
                description: "", status: "active", profile: "general", tags: [], contributorAgentIds: [],
                createdAt: "2026-10-24", updatedAt: "2026-10-24")
            store.hydrate(works: [work])
            _ = store.acceptCorptieTask(CorptieTask(id: taskIDs[index], workId: workIDs[index],
                title: "Switch task \(index)", description: "", acceptanceCriteria: "", priority: "medium",
                lifecycleState: "todo", mainAgentId: nil, currentSessionId: ids[index], executionStatus: "idle",
                createdAt: "2026-10-24", updatedAt: "2026-10-24"))
            _ = store.acceptCreatedSession(TaskSession(id: ids[index], title: "Switch task \(index)", agent: "Fixture",
                agentId: nil, sessionKind: .worker, workId: workIDs[index], taskId: taskIDs[index], status: .complete,
                progress: 1, summary: "", suggestedOptions: nil, suggestedPrompt: nil, activityStatus: nil,
                updatedAt: "2026-10-24", accent: .cyan, archived: false, pinned: false, sortOrder: 0, capabilities: nil, external: nil))
            client.storeCachedDetail(fixture.detail, for: ids[index])
        }
        store.reportStateStreamConnected()
        client.sessionSelectionController.select(ids[0])
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1480, height: 900),
            styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let host = NSHostingView(rootView: UnifiedConsoleView()
            .environmentObject(AppTabRouter())
            .environmentObject(TabSidebarState(tab: .console)))
        host.sizingOptions = []
        window.contentView = host
        window.orderBack(nil)
        defer { window.close() }
        func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }
        func pump(_ seconds: TimeInterval) {
            let deadline = Date().addingTimeInterval(seconds)
            repeat {
                host.layoutSubtreeIfNeeded()
                RunLoop.main.run(until: Date().addingTimeInterval(0.02))
            } while Date() < deadline
        }
        func editor() -> NSTextView? {
            descendants(host).compactMap { $0 as? NSTextView }.first { $0.isEditable }
        }
        pump(2)
        // Console activation refreshes entities; this isolated fixture has no
        // HTTP server. After that initial refresh settles, simulate the next
        // authoritative connected-state event before testing the warm UI path.
        store.reportStateStreamConnected()
        pump(0.5)
        let split = try XCTUnwrap(descendants(host).compactMap { $0 as? ConsoleNativeSplitView }.first)
        var responder: NSResponder? = split
        var controller: (any ConsoleSplitContentUpdating)?
        while let current = responder {
            if let value = current as? any ConsoleSplitContentUpdating { controller = value; break }
            responder = current.nextResponder
        }
        let splitController = try XCTUnwrap(controller)
        let firstEditor = try XCTUnwrap(editor(),
            "Warm fixture: online=\(client.isOnline), selected=\(client.selectedSession?.id ?? "nil"), nativeTextViews=\(descendants(host).compactMap { $0 as? NSTextView }.count)")
        firstEditor.insertText("first session draft", replacementRange: NSRange(location: 0, length: firstEditor.string.utf16.count))
        pump(0.4)
        let before = splitController.contentUpdateCount
        client.sessionSelectionController.select(ids[1])
        pump(1)
        XCTAssertEqual(editor()?.string, "")
        XCTAssertEqual(splitController.contentUpdateCount, before,
            "A pure warm Task switch must update pane consumers, not replace native split roots")
        client.sessionSelectionController.select(ids[0])
        pump(1)
        XCTAssertEqual(editor()?.string, "first session draft")
        XCTAssertEqual(splitController.contentUpdateCount, before)
        XCTAssertTrue(descendants(host).contains { $0 === split })

        // Filtering defaults notifications must still propagate a real
        // preference change made by another window using the existing key.
        let defaults = CorptieAppEnvironment.userDefaults
        let sortKey = "console.workOutline.sort"
        let previousSort = defaults.string(forKey: sortKey)
        defer {
            if let previousSort { defaults.set(previousSort, forKey: sortKey) }
            else { defaults.removeObject(forKey: sortKey) }
        }
        defaults.set(previousSort == "name" ? "updated" : "name", forKey: sortKey)
        pump(0.4)
        XCTAssertGreaterThan(splitController.contentUpdateCount, before,
            "A genuine shared preference change must still reach the pane roots")
        XCTAssertEqual(editor()?.string, "first session draft")
        XCTAssertEqual(client.sessionSelectionController.selectedSessionID, ids[0])
    }

    private func rowsContext(signature: String = "one", source: String = "source",
                             locale: String = "zh_CN", expanded: Set<String> = [],
                             items: [[CodexThreadItem]] = [], allowsFork: Bool = true,
                             workspace: Bool = false) -> PreparedRowsContext {
        PreparedRowsContext(signature: signature, sourceSignature: source, entryIDs: items.flatMap { $0.map(\.id) },
            entryItems: items, expandedTurnIDs: expanded, localeID: locale, languageCode: "zh",
            isWorkspaceCard: workspace, sessionTitle: "Title", workingDirectory: nil,
            allowsFork: allowsFork, forkUnavailableReason: nil)
    }

    func testPreparedRowsEmptyHitAndRenderInputsInvalidate() throws {
        let cache = SessionPresentationCache()
        let context = rowsContext()
        cache.storePreparedRows([], for: "one", context: context, sourceItems: [])
        XCTAssertNotNil(cache.preparedRows(for: "one", context: context), "A prepared empty Session is a hit")
        for changed in [rowsContext(signature: "two"), rowsContext(source: "two"),
                        rowsContext(locale: "en_US"), rowsContext(expanded: ["turn"]),
                        rowsContext(allowsFork: false), rowsContext(workspace: true)] {
            XCTAssertNil(cache.preparedRows(for: "one", context: changed))
        }
        let items = ChatPerformanceFixture.make(configuration: .init(turnCount: 1, rawItemCount: 3,
            longMessageCharacters: 20)).detail.items
        XCTAssertNil(cache.preparedRows(for: "one", context: rowsContext(items: [items])),
            "Payload participates even when callers accidentally reuse a source signature")
    }

    func testPreparedRowsBoundedEvictionPruneAndDisplayInvalidation() {
        let cache = SessionPresentationCache(capacity: 2)
        let context = rowsContext()
        for id in ["one", "two", "three"] {
            cache.storePreparedRows([], for: id, context: context, sourceItems: [])
        }
        XCTAssertNotNil(cache.preparedRows(for: "one", context: context))
        cache.storePreparedRows([], for: "four", context: context, sourceItems: [])
        XCTAssertEqual(cache.preparedRowsCount, 3)
        XCTAssertNil(cache.preparedRows(for: "two", context: context))
        cache.prune(to: ["one", "four"])
        XCTAssertEqual(cache.preparedRowsCount, 2)
        let display = DetailDisplayCache(sessionId: "one", displayItems: [], displayEntries: [],
            totalDisplayEntryCount: 0, visibleMessageLimit: 20, signature: "new", sourceSignature: "new")
        cache.store(display)
        XCTAssertNil(cache.preparedRows(for: "one", context: context))
        cache.storePreparedRows([], for: "one", context: context, sourceItems: [])
        cache.store(display)
        XCTAssertNotNil(cache.preparedRows(for: "one", context: context), "An unchanged display store must preserve prepared rows")
        cache.invalidatePreparedRows(for: "one")
        XCTAssertNil(cache.preparedRows(for: "one", context: context))
    }

    func testPreparedRowsRejectOversizedAndRunningProjections() throws {
        let cache = SessionPresentationCache()
        let fixture = ChatPerformanceFixture.make(configuration: .init(turnCount: 1, rawItemCount: 3,
            longMessageCharacters: 20))
        let item = try XCTUnwrap(fixture.detail.items.first)
        let builder = ConversationNativeRowBuilder(sessionTitle: "Title", workingDirectory: nil,
            allowsFork: true, forkUnavailableReason: nil, imageURL: { _ in nil })
        let row = builder.nativeAppKitRow(.init(kind: .message(item)), expandedTurnIds: [])
        let context = rowsContext(items: [[item]])
        cache.storePreparedRows(Array(repeating: row, count: 257), for: "one", context: context, sourceItems: [item])
        XCTAssertNil(cache.preparedRows(for: "one", context: context))
        cache.storePreparedRows([], for: "one", context: context, sourceItems: Array(repeating: item, count: 2_001))
        XCTAssertNil(cache.preparedRows(for: "one", context: context))
        func decodedItem(text: String, running: Bool = false) throws -> CodexThreadItem {
            try JSONDecoder().decode(CodexThreadItem.self, from: JSONSerialization.data(withJSONObject: [
                "id": "same-id", "turnId": "turn", "turnStatus": running ? "running" : "completed",
                "type": running ? "commandExecution" : "agentMessage", "title": "Fixture",
                "text": text, "status": running ? "inProgress" : "completed"
            ]))
        }
        let large = try decodedItem(text: String(repeating: "x", count: 250_001))
        cache.storePreparedRows([row], for: "one", context: context, sourceItems: [large])
        XCTAssertNil(cache.preparedRows(for: "one", context: context))
        let running = try decodedItem(text: "running", running: true)
        let runningRows = [builder.nativeAppKitRow(.init(kind: .process(turnId: "turn", items: [running])), expandedTurnIds: [])]
        XCTAssertEqual(runningRows.first?.processState, .running)
        cache.storePreparedRows(runningRows, for: "one", context: context, sourceItems: [running])
        XCTAssertNil(cache.preparedRows(for: "one", context: context))
        let old = try decodedItem(text: "old content")
        let new = try decodedItem(text: "new content")
        let oldContext = rowsContext(items: [[old]])
        cache.storePreparedRows([row], for: "one", context: oldContext, sourceItems: [old])
        XCTAssertNil(cache.preparedRows(for: "one", context: rowsContext(items: [[new]])),
            "Same ID, source signature and row count must not conceal a content edit")
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

@MainActor
private final class SwitchReloadRecordingTable: NSTableView {
    var reloadRowCounts: [Int] = []
    override func reloadData() {
        reloadRowCounts.append(dataSource?.numberOfRows?(in: self) ?? -1)
        super.reloadData()
    }
}
