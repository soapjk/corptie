import SwiftUI
import XCTest
import CorptieClientCore
import CorptieConversation
@testable import CorptieMac

@MainActor
final class MessageTextCardMigrationTests: XCTestCase {
    private func row(_ text: String, revision: Int = 0, header: Bool = false, id: String = "shared-text") -> AppKitChatTimelineRow {
        AppKitChatTimelineRow(id: id, contentRevision: revision, nativeText: text,
            copyText: text, nativeStyle: .agent, title: "Corptie", metadata: "",
            expandableTurnId: nil, isExpanded: false,
            showsHeader: header, contextTimestamp: "12:34")
    }

    func testEligibilityDoesNotDropUnmigratedContent() {
        XCTAssertTrue(MacSharedMessageTextCard.supports(row("hello")))
        XCTAssertFalse(MacSharedMessageTextCard.supports(row("hello", header: true)))
        let process = AppKitChatTimelineRow(id: "process", contentRevision: 0, nativeText: "tool",
            copyText: "tool", nativeStyle: .process, title: "", metadata: "",
            expandableTurnId: nil, isExpanded: false, showsHeader: false)
        XCTAssertFalse(MacSharedMessageTextCard.supports(process))
    }

    func testShortMessageFooterCanBeWiderThanItsBubble() throws {
        _ = NSApplication.shared
        let status = try XCTUnwrap(UserMessageStatusPresentation(
            authoritativeStatus: "processing", legacyStatus: nil
        ))
        let card = MessageTextCard(messageID: "short-user", role: .user,
            timestamp: "", showsActions: true, actionsAlwaysVisible: true,
            cardWidth: 40, status: status, copy: {}) {
                Text("好")
            }
        let host = NSHostingView(rootView: card)
        XCTAssertGreaterThan(host.fittingSize.width, 70,
            "The status footer must not be constrained to the 40-point text bubble")
    }

    func testRealCoordinatorUsesSharedRowsAndSwitchesRendererOnContentChanges() throws {
        _ = NSApplication.shared
        let table = AppKitChatTimelineView.makeTableView()
        let scroll = AppKitChatTimelineView.makeScrollView(tableView: table)
        let coordinator = AppKitChatTimelineView.Coordinator(followsLatest: .constant(false), useSharedTextCards: true, onToggleExpansion: { _ in })
        coordinator.attach(tableView: table, scrollView: scroll)
        let window = NSWindow(contentRect: .init(x: 0, y: 0, width: 480, height: 320),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = scroll
        window.layoutIfNeeded()
        coordinator.apply(rows: [row("First message")])
        window.contentView?.layoutSubtreeIfNeeded()
        let first = try XCTUnwrap(table.view(atColumn: 0, row: 0, makeIfNecessary: true) as? AppKitSharedMessageTextCell)
        let again = coordinator.tableView(table, viewFor: table.tableColumns[0], row: 0)
        XCTAssertTrue(first === again)
        let configurations = first.contentConfigurationCount
        XCTAssertTrue(first.updateLayoutIfContentUnchanged(row("First message"), availableWidth: 360))
        XCTAssertEqual(first.contentConfigurationCount, configurations)
        XCTAssertEqual(first.widthLayoutUpdateCount, 1)
        first.copyRepresentedMessage()
        XCTAssertEqual(NSPasteboard.general.string(forType: .string), "First message")

        coordinator.apply(rows: [row("Header message", revision: 1, header: true)])
        window.contentView?.layoutSubtreeIfNeeded()
        XCTAssertTrue(table.view(atColumn: 0, row: 0, makeIfNecessary: true) is AppKitChatNativeTextCell)
        coordinator.apply(rows: [row("Final message", revision: 2)])
        window.contentView?.layoutSubtreeIfNeeded()
        let final = try XCTUnwrap(table.view(atColumn: 0, row: 0, makeIfNecessary: true) as? AppKitSharedMessageTextCell)
        final.copyRepresentedMessage()
        XCTAssertEqual(NSPasteboard.general.string(forType: .string), "Final message")
        XCTAssertEqual(table.numberOfRows, 1)
        window.orderOut(nil)
    }

    func testSharedCellOwnsOnlyOneHostingTreeAndReleasesIt() {
        _ = NSApplication.shared
        weak var weakCell: AppKitSharedMessageTextCell?
        autoreleasepool {
            let cell = AppKitSharedMessageTextCell(identifier: .init("reuse"))
            weakCell = cell
            cell.frame = .init(x: 0, y: 0, width: 480, height: 100)
            for revision in 0..<100 {
                cell.setContent(row("text \(revision)", revision: revision), availableWidth: 480, onToggleExpansion: { _ in })
                cell.layoutSubtreeIfNeeded()
            }
            XCTAssertEqual(cell.subviews.count, 1)
            XCTAssertEqual(cell.contentConfigurationCount, 100)
        }
        XCTAssertNil(weakCell, "Hosting copy callback must not retain its cell")
    }

    func testSharedBodyRetainsActualTextKitLeafAndLinkContext() {
        _ = NSApplication.shared
        let model = row("**Bold** and [local file](file:///tmp/example.swift)")
        let layout = NativeTimelineLayoutCache.shared.layout(for: model, columnWidth: 480)
        let host = NSHostingView(rootView: MacSharedMessageTextCard(row: model, layout: layout, baseDirectory: "/tmp"))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 480, height: layout.rowHeight),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = host
        host.layoutSubtreeIfNeeded()
        func leaves(_ view: NSView) -> [NativeTimelineTextView] {
            (view as? NativeTimelineTextView).map { [$0] } ?? view.subviews.flatMap(leaves)
        }
        let texts = leaves(host)
        XCTAssertEqual(texts.count, 1)
        XCTAssertEqual(texts.first?.string, layout.attributedText.string)
        XCTAssertEqual(texts.first?.linkBaseDirectory, "/tmp")
        XCTAssertEqual(texts.first?.isSelectable, true)
        XCTAssertEqual(texts.first?.bounds.width ?? 0, layout.cardWidth - 20, accuracy: 1)
        window.orderOut(nil)
    }

    func testCachedRenderingPerformanceAgainstNativeCell() throws {
        guard ProcessInfo.processInfo.environment["CORPTIE_CARD_BENCHMARK"] == "1" else {
            throw XCTSkip("Opt-in local performance gate")
        }
        _ = NSApplication.shared
        let markdown = "## Heading 标题\n正文 **bold** [link](https://example.com)\n- one\n- two\n```swift\nlet x = 42\n```\n"
        for (name, text) in [("short", "Hello 你好"), ("rich-long", String(repeating: markdown, count: 70))] {
            let seed = row(text)
            let seedLayout = NativeTimelineLayoutCache.shared.layout(for: seed, columnWidth: 480)
            let native = AppKitChatNativeTextCell(identifier: .init("migration-baseline"))
            let host = NSHostingView(rootView: MacSharedMessageTextCard(row: seed, layout: seedLayout))
            let nativeWindow = NSWindow(contentRect: .init(x: 0, y: 0, width: 480, height: 700),
                styleMask: [.borderless], backing: .buffered, defer: false)
            let sharedWindow = NSWindow(contentRect: nativeWindow.frame, styleMask: [.borderless], backing: .buffered, defer: false)
            let container = NSView(frame: nativeWindow.contentView!.bounds)
            container.addSubview(native); nativeWindow.contentView = container
            sharedWindow.contentView = host
            var baseline: [Double] = [], shared: [Double] = []
            for iteration in 0..<80 {
                let model = row(text + " \(iteration)", revision: iteration)
                // Compare rendering with the same already-parsed/measured text.
                let layout = NativeTimelineLayoutCache.shared.layout(for: model, columnWidth: 480)
                func measure(_ work: () -> Void) -> Double {
                    autoreleasepool {
                        let start = ProcessInfo.processInfo.systemUptime
                        work()
                        return (ProcessInfo.processInfo.systemUptime - start) * 1_000
                    }
                }
                let nativeWork = {
                    native.setContent(model, availableWidth: 480, onToggleExpansion: { _ in })
                    native.frame = NSRect(x: 0, y: 0, width: 480, height: layout.rowHeight)
                    native.layoutSubtreeIfNeeded()
                }
                let sharedWork = {
                    host.rootView = MacSharedMessageTextCard(row: model, layout: layout)
                    host.frame = NSRect(x: 0, y: 0, width: 480, height: layout.rowHeight)
                    host.layoutSubtreeIfNeeded()
                }
                let a: Double, b: Double
                if iteration.isMultiple(of: 2) { a = measure(nativeWork); b = measure(sharedWork) }
                else { b = measure(sharedWork); a = measure(nativeWork) }
                if iteration >= 20 { baseline.append(a); shared.append(b) }
                RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.001))
            }
            baseline.sort(); shared.sort()
            let native95 = baseline[57], shared95 = shared[57]
            print("MESSAGE_TEXT_CARD \(name) n=60 native_p50=\(baseline[30]) native_p95=\(native95) shared_p50=\(shared[30]) shared_p95=\(shared95)")
            XCTAssertLessThanOrEqual(shared95, native95 * 1.5 + 0.5, "Rendering-only migration gate; not full app/frame-time acceptance")
            nativeWindow.orderOut(nil); sharedWindow.orderOut(nil)
        }
    }

    func testRealThousandRowListScrollPerformanceAndReuse() throws {
        guard ProcessInfo.processInfo.environment["CORPTIE_CARD_BENCHMARK"] == "1" else {
            throw XCTSkip("Opt-in real-list performance gate")
        }
        _ = NSApplication.shared
        let rows = (0..<1000).map { row("Message \($0) **bold** 中文 " + String(repeating: "wrapped text ", count: 12), id: "row-\($0)") }
        func harness(shared: Bool) -> (NSWindow, NSTableView, AppKitChatTimelineView.Coordinator) {
            let table = AppKitChatTimelineView.makeTableView()
            let scroll = AppKitChatTimelineView.makeScrollView(tableView: table)
            let coordinator = AppKitChatTimelineView.Coordinator(followsLatest: .constant(false),
                useSharedTextCards: shared, onToggleExpansion: { _ in })
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
        print("MESSAGE_TEXT_LIST n=60 native_p50=\(nativeTimes[30]) native_p95=\(nativeTimes[57]) shared_p50=\(sharedTimes[30]) shared_p95=\(sharedTimes[57]) observed_shared_cells=\(sharedCells.count)")
        XCTAssertLessThan(sharedCells.count, 150, "Do not materialize all 1000 rows")
        XCTAssertLessThanOrEqual(sharedTimes[57], nativeTimes[57] * 1.5 + 1)
        native.0.orderOut(nil); shared.0.orderOut(nil)
    }

    func testCaptureNativeAndSharedVisualEvidence() throws {
        guard ProcessInfo.processInfo.environment["CORPTIE_CARD_SNAPSHOTS"] == "1" else {
            throw XCTSkip("Opt-in local visual evidence")
        }
        _ = NSApplication.shared
        let model = row("## Heading 标题\n正文 **bold** 和 [link](https://example.com)\n- first item\n- second item\n```swift\nlet value = 42\n```")
        let layout = NativeTimelineLayoutCache.shared.layout(for: model, columnWidth: 480)
        let native = AppKitChatNativeTextCell(identifier: .init("snapshot-native"))
        native.setContent(model, availableWidth: 480, onToggleExpansion: { _ in })
        let shared = AppKitSharedMessageTextCell(identifier: .init("snapshot-shared"))
        shared.setContent(model, availableWidth: 480, onToggleExpansion: { _ in })
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("corptie-card-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        for (name, cell) in [("native", native as NSTableCellView), ("shared", shared as NSTableCellView)] {
            let window = NSWindow(contentRect: .init(x: 0, y: 0, width: 480, height: layout.rowHeight),
                styleMask: [.borderless], backing: .buffered, defer: false)
            let container = NSView(frame: window.contentView!.bounds)
            cell.frame = container.bounds
            container.addSubview(cell)
            window.contentView = container
            container.layoutSubtreeIfNeeded()
            RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.01))
            let bitmap = try XCTUnwrap(container.bitmapImageRepForCachingDisplay(in: container.bounds))
            container.cacheDisplay(in: container.bounds, to: bitmap)
            let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
            let path = directory.appendingPathComponent("\(name).png")
            try png.write(to: path)
            print("MESSAGE_TEXT_SNAPSHOT \(path.path)")
            window.orderOut(nil)
        }
    }
}
