import AppKit
import QuartzCore
import SwiftUI
import XCTest
import CorptieClientCore
import CorptieConversation
@testable import CorptieMac

@MainActor
final class ProcessCollapseGeometryTests: XCTestCase {
    @MainActor private final class Harness {
        let table = AppKitChatTimelineView.makeTableView()
        let scroll: NSScrollView
        let coordinator: AppKitChatTimelineCoordinator
        let window: NSWindow
        let builder = ConversationNativeRowBuilder(sessionTitle: "Probe", workingDirectory: nil,
            allowsFork: false, forkUnavailableReason: nil, imageURL: { _ in nil })
        var expanded = true
        var toggles = 0
        var bodyRevision = 0
        var trailingHistory = false
        let entry = ChatDisplayEntry(kind: .process(turnId: "provider-turn", items: (0..<12).map {
            CodexThreadItem(id: "step:\($0)", turnId: "provider-turn", turnStatus: "inProgress",
                type: "commandExecution", title: "Command \($0)",
                text: String(repeating: "Execution detail \($0)\n", count: 4),
                options: nil, status: "completed", createdAt: nil)
        }), processReplyState: .running, processRowIdentity: "input:stable")

        init(height: CGFloat) {
            _ = NSApplication.shared
            scroll = AppKitChatTimelineView.makeScrollView(tableView: table)
            coordinator = AppKitChatTimelineCoordinator(followsLatest: .constant(true),
                useSharedTextCards: true, useSharedProcessCards: true, onToggleExpansion: { _ in })
            coordinator.attach(tableView: table, scrollView: scroll)
            window = NSWindow(contentRect: .init(x: -10000, y: -10000, width: 760, height: height),
                styleMask: [.borderless], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.contentView = scroll
            window.orderBack(nil)
            window.layoutIfNeeded()
            coordinator.onToggleExpansion = { [weak self] id in
                guard let self else { return }
                XCTAssertEqual(id, self.entry.processDisclosureID)
                self.expanded.toggle(); self.toggles += 1
                self.apply()
            }
        }

        func close() { window.orderOut(nil); window.contentView = nil; window.close() }
        func text(_ id: String, _ value: String) -> AppKitChatTimelineRow {
            .init(id: id, contentRevision: 0, nativeText: value, copyText: value,
                nativeStyle: .agent, title: "", metadata: "", expandableTurnId: nil,
                isExpanded: false, showsHeader: false)
        }
        func apply() {
            let history = (0..<10).map { text("history:\($0)", "Earlier \($0)\nSecond line") }
            let process = builder.nativeAppKitRow(entry,
                expandedTurnIds: expanded ? [entry.processDisclosureID] : [])
            var body = text("body", "我先查看实际消息和执行记录，确认连续输入卡在受理、执行还是回复展示。\n第二行正文边界探针。")
            body.contentRevision = bodyRevision
            body.followsReplyProcess = true
            let tail = trailingHistory ? (0..<20).map { text("tail:\($0)", "Later message \($0)") } : []
            coordinator.apply(rows: history + [process, body] + tail)
        }
    }

    static func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }

    static func clickDisclosure(in cell: NSView) throws {
        let window = try XCTUnwrap(cell.window)
        let point = cell.convert(NSPoint(x: 60,
            y: cell.isFlipped ? 12 : cell.bounds.height - 12), to: nil)
        for (number, type) in [NSEvent.EventType.leftMouseDown, .leftMouseUp].enumerated() {
            let event = try XCTUnwrap(NSEvent.mouseEvent(with: type, location: point, modifierFlags: [],
                timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                context: nil, eventNumber: number, clickCount: 1,
                pressure: type == .leftMouseDown ? 1 : 0))
            window.sendEvent(event)
        }
    }

    private func settle(_ milliseconds: Int = 100) async {
        for _ in 0..<5 { await Task.yield() }
        try? await Task.sleep(for: .milliseconds(milliseconds))
    }

    func testBothCollapseControlsKeepPresentedReplyAtBottomWithoutRowPositionAnimation() async throws {
        for floating in [true, false] {
            let h = Harness(height: floating ? 400 : 1100)
            defer { h.close() }
            h.apply(); h.coordinator.jumpToLatest(); await settle(350)
            let body = try XCTUnwrap(h.table.view(atColumn: 0, row: h.table.numberOfRows - 1, makeIfNecessary: true))
            let text = try XCTUnwrap(Self.descendants(body).compactMap { $0 as? NSTextView }
                .first { $0.string.contains("正文边界探针") })
            text.setSelectedRange(.init(location: 1, length: 3))
            let before = body.convert(body.bounds, to: h.scroll.contentView).maxY - h.scroll.contentView.bounds.minY
            let started = ProcessInfo.processInfo.systemUptime
            if floating {
                let button = try XCTUnwrap(Self.descendants(h.scroll).compactMap { $0 as? NSButton }
                    .first { $0.identifier?.rawValue == "chat.timeline.process-follow-collapse" })
                XCTAssertFalse(button.isHidden)
                button.performClick(nil)
            } else {
                let header = try XCTUnwrap(h.table.view(atColumn: 0, row: 10, makeIfNecessary: true))
                try Self.clickDisclosure(in: header)
            }
            let inputMilliseconds = (ProcessInfo.processInfo.systemUptime - started) * 1000
            XCTAssertEqual(h.toggles, 1)
            XCTAssertFalse(h.expanded)
            XCTAssertEqual(h.table.numberOfRows, 12)
            let settledBottom = body.convert(body.bounds, to: h.scroll.contentView).maxY
                - h.scroll.contentView.bounds.minY
            if floating { XCTAssertEqual(settledBottom, before, accuracy: 0.5) }
            // A tall viewport becomes underfilled after collapse. Its content
            // legitimately moves up to the natural top origin, then stays put.
            XCTAssertLessThanOrEqual(settledBottom, before + 0.5)
            // Read the presentation tree, not only NSTableView's final rect.
            // The old code's model rect was correct while this layer moved
            // below the viewport for 0.2 seconds after the clip had jumped.
            for _ in 0..<24 {
                try await Task.sleep(for: .milliseconds(12))
                let rowView = try XCTUnwrap(body.superview)
                let layer = try XCTUnwrap(rowView.layer)
                XCTAssertFalse((layer.animationKeys() ?? []).contains("position"))
                let painted = try XCTUnwrap(layer.presentation())
                let clip = try XCTUnwrap(h.scroll.contentView.layer?.presentation())
                let rect = painted.convert(painted.bounds, to: clip)
                    .offsetBy(dx: -clip.bounds.minX, dy: -clip.bounds.minY)
                XCTAssertLessThanOrEqual(rect.maxY, clip.bounds.height + 0.5)
                XCTAssertEqual(body.convert(body.bounds, to: h.scroll.contentView).maxY
                    - h.scroll.contentView.bounds.minY, settledBottom, accuracy: 0.5)
            }
            XCTAssertEqual(text.selectedRange(), NSRange(location: 1, length: 3))
            XCTAssertTrue(h.coordinator.followsLatest)
            let syncs = h.coordinator.documentHeightSyncCount, resets = h.coordinator.sdkRowResetCount
            let clip = h.scroll.contentView.bounds
            for _ in 0..<16 {
                h.scroll.needsLayout = true; h.scroll.layoutSubtreeIfNeeded()
                await Task.yield()
            }
            await settle()
            XCTAssertEqual(h.coordinator.documentHeightSyncCount, syncs)
            XCTAssertEqual(h.coordinator.sdkRowResetCount, resets)
            XCTAssertEqual(h.scroll.contentView.bounds, clip)
            print("PROCESS_COLLAPSE floating=\(floating) inputMs=\(inputMilliseconds) stableSyncs=\(syncs) resets=\(resets)")
        }
    }

    func testHeaderCollapsePreservesReadingAnchorAndWheelCancelsLaterCorrection() async throws {
        let h = Harness(height: 400)
        defer { h.close() }
        h.trailingHistory = true
        h.apply(); await settle()
        h.coordinator.scrollToTurn(h.entry.processDisclosureID); await settle()
        XCTAssertFalse(h.coordinator.followsLatest)
        let offset = h.table.rect(ofRow: 10).minY - h.scroll.contentView.bounds.minY
        for _ in 0..<3 {
            let header = try XCTUnwrap(h.table.view(atColumn: 0, row: 10, makeIfNecessary: true))
            try Self.clickDisclosure(in: header)
            await settle()
            XCTAssertEqual(h.table.rect(ofRow: 10).minY - h.scroll.contentView.bounds.minY, offset, accuracy: 1)
            XCTAssertFalse(h.coordinator.followsLatest)
        }
        let event = try XCTUnwrap(NSEvent(cgEvent: try XCTUnwrap(CGEvent(scrollWheelEvent2Source: nil,
            units: .pixel, wheelCount: 1, wheel1: 80, wheel2: 0, wheel3: 0))))
        h.scroll.scrollWheel(with: event)
        let afterWheel = h.scroll.contentView.bounds.minY
        h.bodyRevision += 1; h.apply()
        await settle()
        XCTAssertFalse(h.coordinator.followsLatest)
        XCTAssertEqual(h.scroll.contentView.bounds.minY, afterWheel, accuracy: 1)
    }
}
