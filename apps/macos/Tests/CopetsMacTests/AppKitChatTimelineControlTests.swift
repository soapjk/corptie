import AppKit
import SwiftUI
import XCTest
@testable import CorptieMac

@MainActor
final class AppKitChatTimelineControlTests: XCTestCase {
    func testTimelineOwnsVerticalButNotHorizontalCodeBlockWheelGestures() {
        XCTAssertTrue(ChatTimelineScrollView.shouldOwnVerticalWheel(deltaX: 0, deltaY: 12))
        XCTAssertTrue(ChatTimelineScrollView.shouldOwnVerticalWheel(deltaX: 4, deltaY: 12))
        XCTAssertFalse(ChatTimelineScrollView.shouldOwnVerticalWheel(deltaX: 12, deltaY: 4))
        XCTAssertFalse(ChatTimelineScrollView.shouldOwnVerticalWheel(deltaX: 12, deltaY: 0))
        XCTAssertFalse(ChatTimelineScrollView.shouldOwnVerticalWheel(deltaX: 0, deltaY: 0.001))
    }

    private final class FollowState {
        var value: Bool

        init(_ value: Bool) {
            self.value = value
        }
    }

    func testConfiguresNativeAndHostedRowsWithDynamicHeights() {
        let harness = makeHarness(followsLatest: true)
        let short = row(id: "short", text: "short")
        let long = row(id: "long", text: String(repeating: "long wrapped content ", count: 80))
        let hosted = row(id: "hosted", content: AnyView(Text("Hosted approval")))

        harness.coordinator.apply(rows: [short, long, hosted])
        harness.tableView.layoutSubtreeIfNeeded()

        XCTAssertEqual(harness.tableView.numberOfRows, 3)
        XCTAssertLessThan(
            harness.coordinator.tableView(harness.tableView, heightOfRow: 0),
            harness.coordinator.tableView(harness.tableView, heightOfRow: 1)
        )
        XCTAssertTrue(
            harness.coordinator.tableView(harness.tableView, viewFor: harness.tableView.tableColumns[0], row: 0)
                is AppKitChatNativeTextCell
        )
        XCTAssertTrue(
            harness.coordinator.tableView(harness.tableView, viewFor: harness.tableView.tableColumns[0], row: 2)
                is AppKitChatHostingCell
        )
    }

    func testHostedRowUsesAutomaticLayoutAsItsSingleHeightAuthority() async {
        let harness = makeHarness(followsLatest: false, height: 520)
        harness.coordinator.apply(rows: [
            row(id: "hosted-height", content: AnyView(Color.clear.frame(height: 236)))
        ])
        harness.window.contentView?.layoutSubtreeIfNeeded()
        await settleMainQueue()
        harness.window.contentView?.layoutSubtreeIfNeeded()

        XCTAssertEqual(harness.coordinator.tableView(harness.tableView, heightOfRow: 0), -1)
        XCTAssertEqual(
            harness.tableView.rect(ofRow: 0).height,
            236 + harness.tableView.intercellSpacing.height,
            accuracy: 1
        )
    }

    func testTableAdoptsMeasuredHostedHeightAndExpansionRevision() async {
        let harness = makeHarness(followsLatest: false, height: 520)
        let collapsed = row(
            id: "hosted-turn",
            revision: 0,
            content: AnyView(Color.clear.frame(height: 74))
        )
        harness.coordinator.apply(rows: [collapsed])
        harness.tableView.reloadData()
        harness.window.contentView?.layoutSubtreeIfNeeded()
        await settleMainQueue()
        harness.window.contentView?.layoutSubtreeIfNeeded()

        XCTAssertEqual(harness.coordinator.tableView(harness.tableView, heightOfRow: 0), -1)
        XCTAssertEqual(
            harness.tableView.rect(ofRow: 0).height,
            74 + harness.tableView.intercellSpacing.height,
            accuracy: 1
        )

        let expanded = row(
            id: "hosted-turn",
            revision: 1,
            content: AnyView(Color.clear.frame(height: 521))
        )
        harness.coordinator.apply(rows: [expanded])
        harness.window.contentView?.layoutSubtreeIfNeeded()
        await settleMainQueue()
        harness.window.contentView?.layoutSubtreeIfNeeded()

        XCTAssertEqual(harness.coordinator.tableView(harness.tableView, heightOfRow: 0), -1)
        XCTAssertEqual(
            harness.tableView.rect(ofRow: 0).height,
            521 + harness.tableView.intercellSpacing.height,
            accuracy: 1
        )
    }

    func testHostedHeightIsRemeasuredAfterViewportWidthChanges() async {
        let harness = makeHarness(followsLatest: false, height: 420)
        harness.window.setContentSize(NSSize(width: 520, height: 420))
        harness.window.layoutIfNeeded()
        harness.coordinator.apply(rows: [
            row(id: "hosted-resize", content: AnyView(Color.clear.frame(height: 74)))
        ])
        harness.tableView.reloadData()
        await settleMainQueue()
        XCTAssertEqual(harness.coordinator.tableView(harness.tableView, heightOfRow: 0), -1)

        harness.window.setContentSize(NSSize(width: 420, height: 420))
        harness.window.layoutIfNeeded()
        NotificationCenter.default.post(
            name: NSView.frameDidChangeNotification,
            object: harness.scrollView
        )
        await settleMainQueue()
        harness.window.contentView?.layoutSubtreeIfNeeded()

        XCTAssertEqual(harness.coordinator.tableView(harness.tableView, heightOfRow: 0), -1)
        XCTAssertEqual(
            harness.tableView.rect(ofRow: 0).height,
            74 + harness.tableView.intercellSpacing.height,
            accuracy: 1
        )
    }

    func testHostedCollapsedProcessUsesNativeClickTarget() throws {
        var toggledTurnId: String?
        let cell = AppKitChatHostingCell(identifier: .init("hosted-process-click-test"))
        cell.frame = NSRect(x: 0, y: 0, width: 420, height: 60)
        cell.setContent(
            AnyView(Color.clear.frame(height: 60)),
            width: 420,
            expandableTurnId: "turn-42",
            isExpanded: false,
            onToggleExpansion: { toggledTurnId = $0 }
        )

        let button = try XCTUnwrap(button(in: cell, identifier: "chat.timeline.hosted-process-hit-target"))
        XCTAssertFalse(button.isHidden)
        button.performClick(self)
        XCTAssertEqual(toggledTurnId, "turn-42")

        cell.setContent(
            AnyView(Color.clear.frame(height: 180)),
            width: 420,
            expandableTurnId: "turn-42",
            isExpanded: true,
            onToggleExpansion: { toggledTurnId = $0 }
        )
        XCTAssertTrue(button.isHidden)
    }

    func testHostedProcessClickAppliesExpandedContentInTheSameUpdate() async throws {
        let state = FollowState(false)
        let tableView = AppKitChatTimelineView.makeTableView()
        let scrollView = AppKitChatTimelineView.makeScrollView(tableView: tableView)
        var coordinator: AppKitChatTimelineView.Coordinator!
        coordinator = AppKitChatTimelineView.Coordinator(
            usesNativeText: true,
            followsLatest: Binding(get: { state.value }, set: { state.value = $0 }),
            onToggleExpansion: { turnID in
                XCTAssertEqual(turnID, "turn-42")
                coordinator.apply(rows: [
                    self.row(
                        id: "hosted-turn",
                        revision: 1,
                        content: AnyView(Color.clear.frame(height: 236)),
                        expandableTurnId: turnID,
                        isExpanded: true
                    )
                ], animated: true)
            }
        )
        coordinator.followsLatest = false
        coordinator.attach(tableView: tableView, scrollView: scrollView)
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 420, height: 320),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.contentView = scrollView
        coordinator.apply(rows: [
            row(
                id: "hosted-turn",
                revision: 0,
                content: AnyView(Color.clear.frame(height: 60)),
                expandableTurnId: "turn-42"
            )
        ])
        tableView.reloadData()
        await settleMainQueue()

        let collapsedCell = try XCTUnwrap(
            tableView.view(atColumn: 0, row: 0, makeIfNecessary: true) as? AppKitChatHostingCell
        )
        let disclosure = try XCTUnwrap(
            button(in: collapsedCell, identifier: "chat.timeline.hosted-process-hit-target")
        )
        disclosure.performClick(self)
        await settleMainQueue()
        window.contentView?.layoutSubtreeIfNeeded()

        XCTAssertEqual(coordinator.tableView(tableView, heightOfRow: 0), -1)
        let expandedCell = try XCTUnwrap(
            tableView.view(atColumn: 0, row: 0, makeIfNecessary: true) as? AppKitChatHostingCell
        )
        let updatedDisclosure = try XCTUnwrap(
            button(in: expandedCell, identifier: "chat.timeline.hosted-process-hit-target")
        )
        XCTAssertTrue(updatedDisclosure.isHidden)
        XCTAssertTrue(expandedCell === collapsedCell)
    }

    func testHostedLongMarkdownMeasuresBeyondTheVisibleViewport() async throws {
        let harness = makeHarness(followsLatest: false, height: 520)
        let paragraphs = (0..<40).map { index in
            "## Section \(index)\n\nThis is a long wrapped paragraph with **bold text**, a [link](https://example.com), and enough content to require multiple lines."
        }.joined(separator: "\n\n")
        harness.coordinator.apply(rows: [
            row(
                id: "hosted-long-markdown",
                content: AnyView(MarkdownMessageView(text: paragraphs, allowsSelection: true))
            ),
            row(id: "following-row", text: "This row must remain below the long reply.")
        ])
        harness.window.contentView?.layoutSubtreeIfNeeded()
        await settleMainQueue()
        harness.window.contentView?.layoutSubtreeIfNeeded()

        let longRect = harness.tableView.rect(ofRow: 0)
        let followingRect = harness.tableView.rect(ofRow: 1)
        XCTAssertGreaterThan(longRect.height, 1_500)
        XCTAssertGreaterThanOrEqual(followingRect.minY, longRect.maxY)
    }

    func testHostedLongMarkdownIsMeasuredAtTheActualColumnWidth() async throws {
        let harness = makeHarness(followsLatest: false, height: 520)
        let unbreakable = String(repeating: "veryLongUnbrokenToken", count: 90)
        let paragraphs = (0..<16).map { index in
            "Section \(index) \(unbreakable)\n\nA wrapped paragraph that must be measured using the 420 point table column."
        }.joined(separator: "\n\n")
        harness.coordinator.apply(rows: [
            row(
                id: "width-sensitive-hosted-markdown",
                content: AnyView(MarkdownMessageView(text: paragraphs, allowsSelection: true))
            )
        ])
        harness.window.contentView?.layoutSubtreeIfNeeded()
        await settleMainQueue()
        harness.window.contentView?.layoutSubtreeIfNeeded()

        let cell = try XCTUnwrap(
            harness.tableView.view(atColumn: 0, row: 0, makeIfNecessary: true) as? AppKitChatHostingCell
        )
        let hosting = try XCTUnwrap(cell.subviews.first { String(describing: type(of: $0)).contains("FirstMouseTimelineHostingView") })
        XCTAssertEqual(hosting.intrinsicContentSize.width, harness.tableView.tableColumns[0].width, accuracy: 1)
        XCTAssertEqual(hosting.frame.height, hosting.intrinsicContentSize.height, accuracy: 1)
        assertDescendantsStayInsideVerticalBounds(of: hosting)
    }

    func testHostedRowsNeverOverlapAfterRepeatedExpansionAndReuse() async {
        let harness = makeHarness(followsLatest: false, height: 460)
        for revision in 0..<12 {
            let expanded = revision.isMultiple(of: 2)
            harness.coordinator.apply(rows: [
                row(id: "before", text: "Before"),
                row(
                    id: "changing-hosted-row",
                    revision: revision,
                    content: AnyView(Color.clear.frame(height: expanded ? 860 : 62)),
                    expandableTurnId: "turn",
                    isExpanded: expanded
                ),
                row(id: "after", text: "After")
            ], animated: true)
            harness.window.contentView?.layoutSubtreeIfNeeded()
            await settleMainQueue()
            harness.window.contentView?.layoutSubtreeIfNeeded()

            for row in 1..<harness.tableView.numberOfRows {
                XCTAssertGreaterThanOrEqual(
                    harness.tableView.rect(ofRow: row).minY,
                    harness.tableView.rect(ofRow: row - 1).maxY,
                    "Rows overlapped after revision \(revision)"
                )
            }
        }
    }

    func testDisclosureCallbackAndCopyUseOriginalUnmodifiedText() throws {
        var toggledTurnID: String?
        let harness = makeHarness(followsLatest: true) { toggledTurnID = $0 }
        let source = "Open docs/file.swift"
        let rendered = "Open [docs/file.swift](<file:///tmp/docs/file.swift>)"
        let item = row(
            id: "expandable",
            text: rendered,
            copyText: source,
            expandableTurnId: "turn-42"
        )
        harness.coordinator.apply(rows: [item])

        let cell = try XCTUnwrap(
            harness.coordinator.tableView(harness.tableView, viewFor: harness.tableView.tableColumns[0], row: 0)
                as? AppKitChatNativeTextCell
        )
        let disclosure = try XCTUnwrap(button(in: cell, identifier: "chat.timeline.disclosure"))
        let copy = try XCTUnwrap(button(in: cell, identifier: "chat.timeline.copy"))

        disclosure.performClick(self)
        copy.performClick(self)

        XCTAssertEqual(toggledTurnID, "turn-42")
        XCTAssertEqual(NSPasteboard.general.string(forType: .string), source)
    }

    func testNativeCardPreservesLegacyVisualContractAndProcessUsesCompactFooter() throws {
        let harness = makeHarness(followsLatest: true)
        let message = row(id: "message", text: "Ready")
        let process = AppKitChatTimelineRow(
            id: "process",
            contentRevision: 0,
            content: nil,
            nativeText: "",
            copyText: "command",
            nativeStyle: .process,
            title: "",
            metadata: "",
            expandableTurnId: "turn",
            isExpanded: false,
            processCount: 3,
            processDuration: "· 1.2s"
        )
        harness.coordinator.apply(rows: [message, process])

        let messageCell = try XCTUnwrap(
            harness.coordinator.tableView(harness.tableView, viewFor: harness.tableView.tableColumns[0], row: 0)
                as? AppKitChatNativeTextCell
        )
        let card = try XCTUnwrap(messageCell.subviews.first)
        XCTAssertEqual(card.layer?.cornerRadius, 14)
        XCTAssertEqual(card.layer?.borderWidth, 1)
        let copy = try XCTUnwrap(button(in: messageCell, identifier: "chat.timeline.copy"))
        XCTAssertEqual(copy.alphaValue, 0)

        XCTAssertEqual(
            harness.coordinator.tableView(harness.tableView, heightOfRow: 1),
            28
        )
        let processCell = try XCTUnwrap(
            harness.coordinator.tableView(harness.tableView, viewFor: harness.tableView.tableColumns[0], row: 1)
                as? AppKitChatNativeTextCell
        )
        let processButton = try XCTUnwrap(button(in: processCell, identifier: "chat.timeline.process"))
        XCTAssertTrue(processButton.attributedTitle.string.contains("Execution process"))
        XCTAssertTrue(processButton.attributedTitle.string.contains("3"))
    }

    func testOrdinaryNativeMessageHidesInternalHeaderAndKeepsHoverTimestampOutsideCard() throws {
        let harness = makeHarness(followsLatest: true)
        let message = row(
            id: "ordinary-message",
            text: "Ready",
            showsHeader: false,
            hoverTimestamp: "08/17 20:30"
        )
        harness.coordinator.apply(rows: [message])

        let cell = try XCTUnwrap(
            harness.coordinator.tableView(harness.tableView, viewFor: harness.tableView.tableColumns[0], row: 0)
                as? AppKitChatNativeTextCell
        )
        let title = try XCTUnwrap(textField(in: cell, identifier: "chat.timeline.title"))
        let metadata = try XCTUnwrap(textField(in: cell, identifier: "chat.timeline.metadata"))
        let hoverTimestamp = try XCTUnwrap(textField(in: cell, identifier: "chat.timeline.hover-timestamp"))

        XCTAssertTrue(title.isHidden)
        XCTAssertTrue(metadata.isHidden)
        XCTAssertFalse(hoverTimestamp.isHidden)
        XCTAssertEqual(hoverTimestamp.stringValue, "08/17 20:30")
        XCTAssertEqual(hoverTimestamp.alphaValue, 0)
        XCTAssertLessThan(
            harness.coordinator.tableView(harness.tableView, heightOfRow: 0),
            38
        )
    }

    func testSingleColumnTracksTheFullScrollViewportWidth() async {
        let harness = makeHarness(followsLatest: true)
        harness.coordinator.apply(rows: [row(id: "message", text: "Ready")])
        harness.window.setContentSize(NSSize(width: 620, height: 320))
        harness.window.layoutIfNeeded()
        NotificationCenter.default.post(
            name: NSView.frameDidChangeNotification,
            object: harness.scrollView
        )
        await settleMainQueue()

        let viewportWidth = harness.scrollView.contentSize.width
        XCTAssertEqual(harness.tableView.tableColumns[0].width, viewportWidth, accuracy: 1)
        XCTAssertEqual(harness.tableView.style, .plain)
        XCTAssertEqual(harness.tableView.rect(ofColumn: 0).minX, 0, accuracy: 0.5)
    }

    func testStructuralPrependRestoresStableVisibleAnchor() async {
        let harness = makeHarness(followsLatest: false, height: 180)
        let original = (0..<30).map { row(id: "old-\($0)", text: "Original row \($0)") }
        harness.coordinator.apply(rows: original)
        harness.tableView.layoutSubtreeIfNeeded()
        harness.tableView.scrollRowToVisible(14)
        await settleMainQueue()

        let before = visibleAnchor(in: harness.tableView, rows: original)
        let prepended = (0..<8).map { row(id: "new-\($0)", text: "Earlier row \($0)") } + original
        harness.coordinator.apply(rows: prepended)
        await settleMainQueue()
        let after = visibleAnchor(in: harness.tableView, rows: prepended)

        XCTAssertEqual(after.id, before.id)
        XCTAssertEqual(after.offset, before.offset, accuracy: 4)
    }

    func testTailRevisionFollowsLatestButHistoryReadingDoesNot() async {
        let followHarness = makeHarness(followsLatest: true, height: 180)
        let rows = (0..<30).map { row(id: "row-\($0)", revision: 0, text: "Row \($0)") }
        followHarness.coordinator.apply(rows: rows)
        await settleMainQueue()
        let updated = Array(rows.dropLast()) + [row(id: "row-29", revision: 1, text: "Updated tail")]
        followHarness.coordinator.apply(rows: updated)
        await settleMainQueue()
        XCTAssertTrue(isNearBottom(followHarness))

        let historyHarness = makeHarness(followsLatest: false, height: 180)
        historyHarness.coordinator.apply(rows: rows)
        historyHarness.scrollView.contentView.scroll(to: .zero)
        historyHarness.scrollView.reflectScrolledClipView(historyHarness.scrollView.contentView)
        let yBefore = historyHarness.scrollView.contentView.bounds.minY
        historyHarness.coordinator.apply(rows: updated)
        await settleMainQueue()
        XCTAssertEqual(historyHarness.scrollView.contentView.bounds.minY, yBefore, accuracy: 1)
    }

    func testOffscreenRenderingProducesVisibleTimelineArtifact() throws {
        let harness = makeHarness(followsLatest: false, height: 460)
        let rows = [
            row(id: "heading", text: "# Native AppKit Timeline\n\nA paragraph with **bold**, *italic*, and [a link](https://example.com)."),
            row(id: "list", text: "- first item\n- second item\n\n> quoted explanation"),
            row(id: "hosted", content: AnyView(
                Text("SwiftUI hosted interactive-card placeholder")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Color.orange.opacity(0.2))
            ))
        ]
        harness.coordinator.apply(rows: rows)
        harness.tableView.reloadData()
        harness.window.contentView?.layoutSubtreeIfNeeded()
        harness.tableView.layoutSubtreeIfNeeded()
        harness.scrollView.displayIfNeeded()

        let bounds = harness.scrollView.bounds
        let bitmap = try XCTUnwrap(harness.scrollView.bitmapImageRepForCachingDisplay(in: bounds))
        harness.scrollView.cacheDisplay(in: bounds, to: bitmap)
        let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
        XCTAssertGreaterThan(png.count, 4_000)

        if let path = ProcessInfo.processInfo.environment["CORPTIE_TIMELINE_SNAPSHOT_PATH"] {
            try png.write(to: URL(fileURLWithPath: path), options: .atomic)
        }
    }

    private func makeHarness(
        followsLatest: Bool,
        height: CGFloat = 320,
        onToggle: @escaping (String) -> Void = { _ in }
    ) -> (
        window: NSWindow,
        scrollView: NSScrollView,
        tableView: NSTableView,
        coordinator: AppKitChatTimelineView.Coordinator,
        followState: FollowState
    ) {
        let state = FollowState(followsLatest)
        let binding = Binding(get: { state.value }, set: { state.value = $0 })
        let tableView = AppKitChatTimelineView.makeTableView()
        let scrollView = AppKitChatTimelineView.makeScrollView(tableView: tableView)
        let coordinator = AppKitChatTimelineView.Coordinator(
            usesNativeText: true,
            followsLatest: binding,
            onToggleExpansion: onToggle
        )
        coordinator.followsLatest = followsLatest
        coordinator.attach(tableView: tableView, scrollView: scrollView)
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 420, height: height),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.contentView = scrollView
        window.layoutIfNeeded()
        return (window, scrollView, tableView, coordinator, state)
    }

    private func row(
        id: String,
        revision: Int = 0,
        text: String = "",
        copyText: String? = nil,
        content: AnyView? = nil,
        expandableTurnId: String? = nil,
        isExpanded: Bool = false,
        showsHeader: Bool = true,
        hoverTimestamp: String = ""
    ) -> AppKitChatTimelineRow {
        AppKitChatTimelineRow(
            id: id,
            contentRevision: revision,
            content: content,
            nativeText: text,
            copyText: copyText ?? text,
            nativeStyle: .agent,
            title: "Agent",
            metadata: "10:20",
            expandableTurnId: expandableTurnId,
            isExpanded: isExpanded,
            showsHeader: showsHeader,
            hoverTimestamp: hoverTimestamp
        )
    }

    private func button(in view: NSView, identifier: String) -> NSButton? {
        if let button = view as? NSButton, button.identifier?.rawValue == identifier { return button }
        return view.subviews.lazy.compactMap { self.button(in: $0, identifier: identifier) }.first
    }

    private func textField(in view: NSView, identifier: String) -> NSTextField? {
        if let textField = view as? NSTextField, textField.identifier?.rawValue == identifier { return textField }
        return view.subviews.lazy.compactMap { self.textField(in: $0, identifier: identifier) }.first
    }

    private func assertDescendantsStayInsideVerticalBounds(
        of root: NSView,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        for descendant in root.subviews {
            let rect = descendant.convert(descendant.bounds, to: root)
            XCTAssertGreaterThanOrEqual(rect.minY, -1, file: file, line: line)
            XCTAssertLessThanOrEqual(rect.maxY, root.bounds.maxY + 1, file: file, line: line)
            assertDescendantsStayInsideVerticalBounds(of: descendant, file: file, line: line)
        }
    }

    private func visibleAnchor(
        in tableView: NSTableView,
        rows: [AppKitChatTimelineRow]
    ) -> (id: String, offset: CGFloat) {
        let range = tableView.rows(in: tableView.visibleRect)
        let index = range.location
        return (rows[index].id, tableView.visibleRect.minY - tableView.rect(ofRow: index).minY)
    }

    private func isNearBottom(
        _ harness: (
            window: NSWindow,
            scrollView: NSScrollView,
            tableView: NSTableView,
            coordinator: AppKitChatTimelineView.Coordinator,
            followState: FollowState
        )
    ) -> Bool {
        harness.tableView.bounds.maxY - harness.scrollView.contentView.bounds.maxY <= 8
    }

    private func settleMainQueue() async {
        await withCheckedContinuation { continuation in
            DispatchQueue.main.async {
                DispatchQueue.main.async {
                    continuation.resume()
                }
            }
        }
    }
}
