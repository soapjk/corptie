import SwiftUI
import XCTest
import CorptieClientCore
@testable import CorptieMac

@MainActor
final class ProcessCardMigrationTests: XCTestCase {
    func testInPlaceProcessExpansionRekeysTheCachedCell() throws {
        _ = NSApplication.shared
        let table = AppKitChatTimelineView.makeTableView()
        let scroll = AppKitChatTimelineView.makeScrollView(tableView: table)
        let coordinator = AppKitChatTimelineView.Coordinator(followsLatest: .constant(false),
            useSharedProcessCards: true, onToggleExpansion: { _ in })
        coordinator.attach(tableView: table, scrollView: scroll)
        let window = NSWindow(contentRect: .init(x: 0, y: 0, width: 480, height: 600),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = scroll
        defer { window.orderOut(nil) }
        coordinator.apply(rows: [row(expanded: false)])
        window.contentView?.layoutSubtreeIfNeeded()
        for revision in [1, 0, 1, 0, 1] {
            let current = try XCTUnwrap(table.view(atColumn: 0, row: 0, makeIfNecessary: true) as? AppKitSharedMessageTextCell)
            let model = row(expanded: revision == 1, revision: revision, stepCount: 40)
            coordinator.apply(rows: [model])
            let count = current.contentConfigurationCount
            let cached = try XCTUnwrap(coordinator.tableView(table, viewFor: table.tableColumns[0], row: 0) as? AppKitSharedMessageTextCell)
            XCTAssertTrue(cached === current, "In-place changes must move the cache key, not create a second cell")
            XCTAssertEqual(cached.contentConfigurationCount, count, "A valid cache hit must not reconfigure content")
            XCTAssertTrue(cached.updateLayoutIfContentUnchanged(model, availableWidth: table.tableColumns[0].width))
            XCTAssertEqual(coordinator.tableView(table, heightOfRow: 0),
                NativeTimelineLayoutCache.shared.layout(for: model, columnWidth: table.tableColumns[0].width).rowHeight,
                accuracy: 0.5)
        }
    }

    func testStaleCachedProcessContentIsRepairedBeforeReturningCell() throws {
        _ = NSApplication.shared
        let table = AppKitChatTimelineView.makeTableView()
        let scroll = AppKitChatTimelineView.makeScrollView(tableView: table)
        var toggled: String?
        let coordinator = AppKitChatTimelineView.Coordinator(followsLatest: .constant(false),
            useSharedProcessCards: true, onToggleExpansion: { toggled = $0 })
        coordinator.attach(tableView: table, scrollView: scroll)
        let expected = row(expanded: false, revision: 0)
        coordinator.apply(rows: [expected])
        let cell = try XCTUnwrap(coordinator.tableView(table, viewFor: table.tableColumns[0], row: 0) as? AppKitSharedMessageTextCell)
        // Simulate an AppKit reuse/in-place mutation after the cache entry was installed.
        cell.setContent(row(expanded: true, revision: 1, turn: "other"), availableWidth: 480, onToggleExpansion: { _ in })
        let repaired = try XCTUnwrap(coordinator.tableView(table, viewFor: table.tableColumns[0], row: 0) as? AppKitSharedMessageTextCell)
        XCTAssertTrue(repaired.updateLayoutIfContentUnchanged(expected, availableWidth: table.tableColumns[0].width))
        repaired.toggleRepresentedProcess()
        XCTAssertEqual(toggled, "turn")
    }

    func testSharedUserMessageCardRetainsProcessingStatus() throws {
        let queued = try XCTUnwrap(UserMessageStatusPresentation(
            authoritativeStatus: "queued", legacyStatus: nil, queuePosition: 2
        ))
        let row = AppKitChatTimelineRow(
            id: "user-status", contentRevision: 1, nativeText: "Hello", copyText: "Hello",
            nativeStyle: .user, title: "", metadata: "", expandableTurnId: nil,
            isExpanded: false, showsHeader: false, messageStatus: queued
        )
        XCTAssertTrue(MacSharedMessageTextCard.supports(row))
        let layout = NativeTimelineLayoutCache.shared.layout(for: row, columnWidth: 400)
        let card = MacSharedMessageTextCard(row: row, layout: layout)
        XCTAssertEqual(card.presentedMessageStatus, queued)
        XCTAssertTrue(row.showsMessageStatusBar)
    }

    func testSharedProcessCellUpdatesElapsedTextWithoutRemeasuring() {
        _ = NSApplication.shared
        let start = Date(timeIntervalSince1970: 1_000)
        let process = AppKitChatTimelineRow(
            id: "shared-clock", contentRevision: 1, nativeText: "", copyText: "",
            nativeStyle: .process, title: "", metadata: "", expandableTurnId: "turn",
            isExpanded: false, processCount: 1, processDuration: "4.0s",
            processStartedAt: start, processState: .running
        )
        let cell = AppKitSharedMessageTextCell(identifier: .init("shared-clock"))
        cell.setContent(process, availableWidth: 320, onToggleExpansion: { _ in })
        let configurations = cell.contentConfigurationCount
        let widthUpdates = cell.widthLayoutUpdateCount
        let hostUpdates = cell.hostUpdateCount
        cell.refreshProcessElapsed(now: start.addingTimeInterval(5))
        XCTAssertEqual(cell.displayedProcessSummary, "Working for 5.00s · 1 step")
        cell.refreshProcessElapsed(now: start.addingTimeInterval(6))
        XCTAssertEqual(cell.displayedProcessSummary, "Working for 6.00s · 1 step")
        XCTAssertEqual(cell.contentConfigurationCount, configurations)
        XCTAssertEqual(cell.widthLayoutUpdateCount, widthUpdates)
        let tickStart = ProcessInfo.processInfo.systemUptime
        for tick in 0..<1000 {
            cell.refreshProcessElapsed(now: start.addingTimeInterval(6 + Double(tick) * ConversationProcessPresentation.elapsedRefreshInterval))
        }
        XCTAssertEqual(cell.hostUpdateCount, hostUpdates, "Clock ticks only invalidate the summary text leaf")
        XCTAssertEqual(cell.widthLayoutUpdateCount, widthUpdates)
        print("PROCESS_CLOCK 1000 localized ticks ms=\((ProcessInfo.processInfo.systemUptime - tickStart) * 1000)")
    }

    func testThousandProcessRowsReuseAndScrollWithinNativeBudget() throws {
        guard ProcessInfo.processInfo.environment["CORPTIE_PROCESS_AB"] == "1" else {
            throw XCTSkip("Opt-in real-list performance gate")
        }
        _ = NSApplication.shared
        let rows = (0..<1000).map { row(expanded: $0.isMultiple(of: 4), turn: "turn-\($0)") }
        func harness(shared: Bool) -> (NSWindow, NSTableView, AppKitChatTimelineView.Coordinator) {
            let table = AppKitChatTimelineView.makeTableView()
            let scroll = AppKitChatTimelineView.makeScrollView(tableView: table)
            let coordinator = AppKitChatTimelineView.Coordinator(followsLatest: .constant(false),
                useSharedProcessCards: shared, onToggleExpansion: { _ in })
            coordinator.attach(tableView: table, scrollView: scroll)
            let window = NSWindow(contentRect: .init(x: 0, y: 0, width: 480, height: 600),
                styleMask: [.borderless], backing: .buffered, defer: false)
            window.contentView = scroll
            window.layoutIfNeeded()
            coordinator.apply(rows: rows)
            window.contentView?.layoutSubtreeIfNeeded()
            return (window, table, coordinator)
        }
        let native = harness(shared: false), shared = harness(shared: true)
        var nativeTimes: [Double] = [], sharedTimes: [Double] = []
        var sharedCells = Set<ObjectIdentifier>()
        for iteration in 0..<80 {
            let index = iteration * 37 % 1000
            func measure(_ target: (NSWindow, NSTableView, AppKitChatTimelineView.Coordinator)) -> Double {
                let start = ProcessInfo.processInfo.systemUptime
                target.1.scrollRowToVisible(index)
                target.0.contentView?.layoutSubtreeIfNeeded()
                return (ProcessInfo.processInfo.systemUptime - start) * 1_000
            }
            let a: Double, b: Double
            if iteration.isMultiple(of: 2) { a = measure(native); b = measure(shared) }
            else { b = measure(shared); a = measure(native) }
            if iteration >= 20 { nativeTimes.append(a); sharedTimes.append(b) }
            let visible = shared.1.rows(in: shared.1.visibleRect)
            XCTAssertNotEqual(visible.location, NSNotFound)
            for index in visible.location..<(visible.location + visible.length) where rows.indices.contains(index) {
                let cell = try XCTUnwrap(shared.1.view(atColumn: 0, row: index, makeIfNecessary: false) as? AppKitSharedMessageTextCell)
                sharedCells.insert(ObjectIdentifier(cell))
            }
            RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.001))
        }
        nativeTimes.sort(); sharedTimes.sort()
        print("PROCESS_LIST n=60 native_p50=\(nativeTimes[30]) native_p95=\(nativeTimes[57]) shared_p50=\(sharedTimes[30]) shared_p95=\(sharedTimes[57]) observed_shared_cells=\(sharedCells.count)")
        XCTAssertLessThan(sharedCells.count, 150, "Do not materialize all 1000 rows")
        XCTAssertLessThanOrEqual(sharedTimes[57], nativeTimes[57] * 1.5 + 1)
        native.0.orderOut(nil); shared.0.orderOut(nil)
    }
    private func row(expanded: Bool, revision: Int = 0, turn: String = "turn", raw: Bool = true, stepCount: Int = 1) -> AppKitChatTimelineRow {
        AppKitChatTimelineRow(id: "process:\(turn)", contentRevision: revision,
            nativeText: "Read source\nresult \(revision)", rawStatusText: raw ? String(repeating: "item_status: completed \(revision)\n", count: 50) : "",
            copyText: "", nativeStyle: .process, title: "", metadata: "",
            expandableTurnId: turn, isExpanded: expanded, processCount: stepCount,
            processDuration: "4.2s", processState: .running,
            processSteps: (0..<stepCount).map { .init(id: "step-\($0)", kind: .action, state: .running, title: "Read source", detail: "source.swift · result \(revision)") },
            processCurrentStepTitle: "Read source \(revision)", showsHeader: false)
    }

    private func descendants<T: NSView>(_ view: NSView, as type: T.Type) -> [T] {
        (view as? T).map { [$0] } ?? view.subviews.flatMap { descendants($0, as: type) }
    }

    func testRealCoordinatorExpandsSharedProcessAndRetainsBoundedSelectableRawStatus() throws {
        _ = NSApplication.shared
        let table = AppKitChatTimelineView.makeTableView()
        let scroll = AppKitChatTimelineView.makeScrollView(tableView: table)
        var toggled: [String] = []
        let coordinator = AppKitChatTimelineView.Coordinator(followsLatest: .constant(false),
            onToggleExpansion: { toggled.append($0) })
        coordinator.attach(tableView: table, scrollView: scroll)
        let window = NSWindow(contentRect: .init(x: 0, y: 0, width: 480, height: 600),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = scroll
        coordinator.apply(rows: [row(expanded: false)])
        window.contentView?.layoutSubtreeIfNeeded()
        let collapsed = try XCTUnwrap(table.view(atColumn: 0, row: 0, makeIfNecessary: true) as? AppKitSharedMessageTextCell)
        collapsed.toggleRepresentedProcess()
        XCTAssertEqual(toggled, ["turn"])
        XCTAssertTrue(descendants(collapsed, as: NativeTimelineTextView.self).isEmpty)
        coordinator.apply(rows: [row(expanded: true, revision: 1)])
        window.contentView?.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.02))
        let expanded = try XCTUnwrap(table.view(atColumn: 0, row: 0, makeIfNecessary: true) as? AppKitSharedMessageTextCell)
        XCTAssertEqual(descendants(expanded, as: NativeTimelineTextView.self).count, 1)
        let raw = try XCTUnwrap(descendants(expanded, as: NSTextView.self).first { $0.identifier?.rawValue == "chat.timeline.raw-status" })
        XCTAssertTrue(raw.isSelectable)
        XCTAssertFalse(raw.isEditable)
        XCTAssertEqual(raw.string, row(expanded: true, revision: 1).rawStatusText)
        let rawScroll = try XCTUnwrap(raw.enclosingScrollView)
        XCTAssertLessThanOrEqual(rawScroll.bounds.height, 160)
        XCTAssertGreaterThan(rawScroll.bounds.height, 0)
        expanded.setContent(row(expanded: true, revision: 2, turn: "other"), availableWidth: 480,
            onToggleExpansion: { toggled.append($0) })
        expanded.toggleRepresentedProcess()
        XCTAssertEqual(toggled.last, "other")
        window.orderOut(nil)
    }

    func testNativeVersusSharedProcessRenderingPerformanceAndSnapshots() throws {
        guard ProcessInfo.processInfo.environment["CORPTIE_PROCESS_AB"] == "1" else {
            throw XCTSkip("Opt-in process card rendering/visual comparison")
        }
        _ = NSApplication.shared
        let native = AppKitChatNativeTextCell(identifier: .init("native-process"))
        let shared = AppKitSharedMessageTextCell(identifier: .init("shared-process"))
        let nativeWindow = NSWindow(contentRect: .init(x: 0, y: 0, width: 480, height: 600),
            styleMask: [.borderless], backing: .buffered, defer: false)
        let sharedWindow = NSWindow(contentRect: nativeWindow.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        nativeWindow.contentView = NSView(frame: nativeWindow.contentView!.bounds)
        sharedWindow.contentView = NSView(frame: sharedWindow.contentView!.bounds)
        nativeWindow.contentView!.addSubview(native)
        sharedWindow.contentView!.addSubview(shared)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("corptie-process-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        for expanded in [false, true] {
            var oldTimes: [Double] = [], newTimes: [Double] = []
            for index in 0..<80 {
                let model = row(expanded: expanded, revision: index)
                let layout = NativeTimelineLayoutCache.shared.layout(for: model, columnWidth: 480)
                func measure(_ cell: NSTableCellView & AppKitChatRowRendering) -> Double {
                    let start = ProcessInfo.processInfo.systemUptime
                    cell.frame = .init(x: 0, y: 0, width: 480, height: layout.rowHeight)
                    cell.setContent(model, availableWidth: 480, baseDirectory: nil,
                        onToggleExpansion: { _ in }, onAction: { _ in })
                    cell.layoutSubtreeIfNeeded()
                    return (ProcessInfo.processInfo.systemUptime - start) * 1_000
                }
                let times = index.isMultiple(of: 2) ? (measure(native), measure(shared)) : {
                    let s = measure(shared); return (measure(native), s)
                }()
                if index >= 20 { oldTimes.append(times.0); newTimes.append(times.1) }
            }
            oldTimes.sort(); newTimes.sort()
            print("PROCESS_AB expanded=\(expanded) native_p95=\(oldTimes[57]) shared_p95=\(newTimes[57])")
            XCTAssertLessThanOrEqual(newTimes[57], oldTimes[57] * 1.5 + 0.5)
            for (name, cell) in [("native", native as NSTableCellView), ("shared", shared as NSTableCellView)] {
                let bitmap = try XCTUnwrap(cell.bitmapImageRepForCachingDisplay(in: cell.bounds))
                cell.cacheDisplay(in: cell.bounds, to: bitmap)
                let path = directory.appendingPathComponent("\(name)-\(expanded).png")
                try XCTUnwrap(bitmap.representation(using: .png, properties: [:])).write(to: path)
                print("PROCESS_SNAPSHOT \(path.path)")
            }
        }
        nativeWindow.orderOut(nil); sharedWindow.orderOut(nil)
    }
}
