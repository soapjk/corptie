import AppKit
import SwiftUI
import XCTest
@testable import CorptieMac

@MainActor
final class AppKitChatTimelineControlTests: XCTestCase {
    func testLiveResizeReflowsOnlyVisibleRowsThenExactReflowCoversAllRows() {
        let visible = NSRange(location: 40, length: 12)

        XCTAssertEqual(
            LiveResizeRowReflowPolicy.indexes(
                rowCount: 500,
                visibleRows: visible,
                isLiveResize: true
            ),
            IndexSet(integersIn: 40..<52)
        )
        XCTAssertEqual(
            LiveResizeRowReflowPolicy.indexes(
                rowCount: 500,
                visibleRows: visible,
                isLiveResize: false
            ),
            IndexSet(integersIn: 0..<500)
        )
    }

    func testLiveResizeMeasurementWidthUsesStableBucketsAndExactWidthAfterResize() {
        XCTAssertEqual(
            LiveResizeWidthPolicy.measurementWidth(403, isLiveResize: true),
            400
        )
        XCTAssertEqual(
            LiveResizeWidthPolicy.measurementWidth(404, isLiveResize: true),
            408
        )
        XCTAssertEqual(
            LiveResizeWidthPolicy.measurementWidth(403.25, isLiveResize: false),
            403.25
        )
        XCTAssertFalse(LiveResizeWidthPolicy.requiresReflow(previous: 400, next: 400))
        XCTAssertTrue(LiveResizeWidthPolicy.requiresReflow(previous: 400, next: 408))
        XCTAssertTrue(LiveResizeWidthPolicy.requiresReflow(previous: nil, next: 400))
    }

    func testWidthOnlyCellUpdateDoesNotRepeatContentConfiguration() {
        let cell = AppKitChatNativeTextCell(
            identifier: NSUserInterfaceItemIdentifier("width-update-test")
        )
        let original = row(id: "row", revision: 1, text: "A wrapped timeline message")
        cell.setContent(original, availableWidth: 400, onToggleExpansion: { _ in })

        XCTAssertEqual(cell.contentConfigurationCount, 1)
        XCTAssertTrue(cell.updateLayoutIfContentUnchanged(original, availableWidth: 408))
        XCTAssertEqual(cell.contentConfigurationCount, 1)
        XCTAssertEqual(cell.widthLayoutUpdateCount, 1)

        let revised = row(id: "row", revision: 2, text: "Changed")
        XCTAssertFalse(cell.updateLayoutIfContentUnchanged(revised, availableWidth: 408))
        XCTAssertEqual(cell.contentConfigurationCount, 1)
    }

    func testDuplicateRowsAreCollapsedBeforeBuildingRevisionIndex() {
        let rows = [
            row(id: "same", revision: 1, text: "old"),
            row(id: "other", revision: 1, text: "other"),
            row(id: "same", revision: 2, text: "new")
        ]

        let unique = AppKitChatTimelineView.Coordinator.uniquedRows(rows)

        XCTAssertEqual(unique.map(\.id), ["same", "other"])
        XCTAssertEqual(unique.first?.contentRevision, 2)
        XCTAssertEqual(unique.first?.nativeText, "new")
    }

    private final class FollowState {
        var value: Bool

        init(_ value: Bool) {
            self.value = value
        }
    }

    func testConfiguresNativeRowsWithDeterministicDynamicHeights() {
        let harness = makeHarness(followsLatest: true)
        let short = row(id: "short", text: "short")
        let long = row(id: "long", text: String(repeating: "long wrapped content ", count: 80))

        harness.coordinator.apply(rows: [short, long])
        harness.tableView.layoutSubtreeIfNeeded()

        XCTAssertEqual(harness.tableView.numberOfRows, 2)
        XCTAssertLessThan(
            harness.coordinator.tableView(harness.tableView, heightOfRow: 0),
            harness.coordinator.tableView(harness.tableView, heightOfRow: 1)
        )
        XCTAssertTrue(
            harness.coordinator.tableView(harness.tableView, viewFor: harness.tableView.tableColumns[0], row: 0)
                is AppKitChatNativeTextCell
        )
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

    func testNativeTextViewRoutesLocalLinkThroughInjectedClickHandler() throws {
        let textView = NativeTimelineTextView()
        textView.linkBaseDirectory = "/tmp/session workspace"
        var capturedURL: URL?
        var capturedBaseDirectory: String?
        textView.linkHandler = { url, baseDirectory in
            capturedURL = url
            capturedBaseDirectory = baseDirectory
            return true
        }
        let link = try XCTUnwrap(URL(string: "/tmp/session%20workspace/File.swift:12"))

        let handled = textView.textView(textView, clickedOnLink: link, at: 0)

        XCTAssertTrue(handled)
        XCTAssertEqual(capturedURL, link)
        XCTAssertEqual(capturedBaseDirectory, "/tmp/session workspace")
    }

    func testUpdatingLinkWorkspaceDoesNotReconfigureCachedRowContent() throws {
        let harness = makeHarness(followsLatest: true)
        harness.coordinator.apply(rows: [row(id: "link", text: "[file](/tmp/file.swift)")])
        let cell = try XCTUnwrap(
            harness.coordinator.tableView(
                harness.tableView,
                viewFor: harness.tableView.tableColumns[0],
                row: 0
            ) as? AppKitChatNativeTextCell
        )
        let body = try XCTUnwrap(textView(in: cell, identifier: "chat.timeline.body"))
        let configurationsBeforeUpdate = cell.contentConfigurationCount

        harness.coordinator.updateBaseDirectory(" /tmp/new-workspace ")

        XCTAssertEqual(body.linkBaseDirectory, "/tmp/new-workspace")
        XCTAssertEqual(cell.contentConfigurationCount, configurationsBeforeUpdate)
    }

    func testNativeCardUsesCommunityStyleCompactExecutionSummary() throws {
        let harness = makeHarness(followsLatest: true)
        let message = row(id: "message", text: "Ready")
        let process = AppKitChatTimelineRow(
            id: "process",
            contentRevision: 0,
            nativeText: "",
            copyText: "command",
            nativeStyle: .process,
            title: "",
            metadata: "",
            expandableTurnId: "turn",
            isExpanded: false,
            processCount: 3,
            processDuration: "1.2s",
            processState: .completed
        )
        harness.coordinator.apply(rows: [message, process])

        let messageCell = try XCTUnwrap(
            harness.coordinator.tableView(harness.tableView, viewFor: harness.tableView.tableColumns[0], row: 0)
                as? AppKitChatNativeTextCell
        )
        let card = try XCTUnwrap(messageCell.subviews.first)
        XCTAssertEqual(card.layer?.cornerRadius, 14)
        XCTAssertEqual(card.layer?.borderWidth, 1)
        let messageActions = try XCTUnwrap(view(in: messageCell, identifier: "chat.timeline.message-actions"))
        XCTAssertTrue(messageActions.isHidden)

        XCTAssertEqual(
            harness.coordinator.tableView(harness.tableView, heightOfRow: 1),
            32
        )
        let processCell = try XCTUnwrap(
            harness.coordinator.tableView(harness.tableView, viewFor: harness.tableView.tableColumns[0], row: 1)
                as? AppKitChatNativeTextCell
        )
        let processButton = try XCTUnwrap(button(in: processCell, identifier: "chat.timeline.process"))
        XCTAssertTrue(processButton.attributedTitle.string.contains("Worked for 1.2s"))
        XCTAssertTrue(processButton.attributedTitle.string.contains("3 steps"))
        XCTAssertLessThan(processCell.subviews[0].frame.width, harness.tableView.tableColumns[0].width)
    }

    func testCollaborationCardShowsHeaderMetadataAndDistinctVisualTreatment() throws {
        let harness = makeHarness(followsLatest: true)
        let collaboration = AppKitChatTimelineRow(
            id: "collaboration",
            contentRevision: 1,
            nativeText: "**Message**\nPlease review this change.",
            copyText: "Please review this change.",
            nativeStyle: .agent,
            title: "Cross-session collaboration · Change request",
            metadata: "Processing · 08/20, 14:30",
            isCollaboration: true,
            collaborationRoute: NativeCollaborationRoutePresentation(
                destinationKind: .newCorptieTask,
                routeLabel: "A new CorptieTask will be created",
                sourceLabel: "Source",
                sourceSession: "Session · Platform planning",
                sourceObjective: "Objective · Platform",
                targetLabel: "Target",
                targetName: "CorptieTask · Review API",
                targetObjective: "Objective · macOS"
            ),
            expandableTurnId: nil,
            isExpanded: false,
            showsHeader: true
        )
        harness.coordinator.apply(rows: [collaboration])
        harness.window.contentView?.layoutSubtreeIfNeeded()

        let cell = try XCTUnwrap(
            harness.tableView.view(atColumn: 0, row: 0, makeIfNecessary: true) as? AppKitChatNativeTextCell
        )
        cell.layoutSubtreeIfNeeded()
        let title = try XCTUnwrap(textField(in: cell, identifier: "chat.timeline.title"))
        let metadata = try XCTUnwrap(textField(in: cell, identifier: "chat.timeline.metadata"))
        let card = try XCTUnwrap(cell.subviews.first)

        XCTAssertFalse(title.isHidden)
        XCTAssertEqual(title.stringValue, "Cross-session collaboration · Change request")
        XCTAssertEqual(metadata.stringValue, "Processing · 08/20, 14:30")
        let route = try XCTUnwrap(view(in: cell, identifier: "chat.timeline.collaboration-route"))
        XCTAssertFalse(route.isHidden)
        XCTAssertEqual(route.frame.height, NativeCollaborationRouteSummaryView.height)
        XCTAssertNotEqual(card.layer?.backgroundColor, NSColor.white.cgColor)
        XCTAssertLessThanOrEqual(card.frame.midX, cell.bounds.midX)
        XCTAssertGreaterThan(harness.coordinator.tableView(harness.tableView, heightOfRow: 0), 130)
    }

    func testRunningExecutionSummaryIncludesElapsedDurationWhenAvailable() throws {
        let harness = makeHarness(followsLatest: true)
        let process = AppKitChatTimelineRow(
            id: "running-process",
            contentRevision: 0,
            nativeText: "",
            copyText: "command",
            nativeStyle: .process,
            title: "",
            metadata: "",
            expandableTurnId: "turn",
            isExpanded: false,
            processCount: 2,
            processDuration: "1m 12s",
            processState: .running
        )
        harness.coordinator.apply(rows: [process])

        let cell = try XCTUnwrap(
            harness.tableView.view(atColumn: 0, row: 0, makeIfNecessary: true) as? AppKitChatNativeTextCell
        )
        let processButton = try XCTUnwrap(button(in: cell, identifier: "chat.timeline.process"))

        XCTAssertTrue(processButton.attributedTitle.string.contains("Working for 1m 12s"))
        XCTAssertTrue(processButton.attributedTitle.string.contains("2 steps"))
    }

    func testTerminalExecutionSummariesKeepElapsedDurationAcrossOutcomes() {
        let failed = AppKitChatTimelineRow(
            id: "failed",
            contentRevision: 0,
            nativeText: "",
            copyText: "",
            nativeStyle: .process,
            title: "",
            metadata: "",
            expandableTurnId: "failed-turn",
            isExpanded: false,
            processCount: 1,
            processDuration: "17s",
            processState: .failed
        )
        let cancelled = AppKitChatTimelineRow(
            id: "cancelled",
            contentRevision: 0,
            nativeText: "",
            copyText: "",
            nativeStyle: .process,
            title: "",
            metadata: "",
            expandableTurnId: "cancelled-turn",
            isExpanded: false,
            processCount: 3,
            processDuration: "1m 4s",
            processState: .cancelled
        )

        XCTAssertEqual(failed.processSummary, "Execution failed after 17s · 1 step")
        XCTAssertEqual(cancelled.processSummary, "Execution stopped after 1m 4s · 3 steps")
    }

    func testExpandedExecutionPlacesSummaryBeforeStepDetails() throws {
        let harness = makeHarness(followsLatest: true)
        let process = AppKitChatTimelineRow(
            id: "process",
            contentRevision: 1,
            nativeText: "⌘  **Ran tests**\n    swift test",
            copyText: "swift test",
            nativeStyle: .process,
            title: "",
            metadata: "",
            expandableTurnId: "turn",
            isExpanded: true,
            processCount: 1,
            processDuration: "4.2s",
            processState: .running,
            showsHeader: false
        )
        harness.coordinator.apply(rows: [process])
        harness.window.contentView?.layoutSubtreeIfNeeded()

        let cell = try XCTUnwrap(
            harness.coordinator.tableView(harness.tableView, viewFor: harness.tableView.tableColumns[0], row: 0)
                as? AppKitChatNativeTextCell
        )
        cell.layoutSubtreeIfNeeded()
        let summary = try XCTUnwrap(button(in: cell, identifier: "chat.timeline.process"))
        let body = try XCTUnwrap(textView(in: cell, identifier: "chat.timeline.body"))

        XCTAssertTrue(summary.attributedTitle.string.contains("Working for 4.2s"))
        XCTAssertGreaterThan(summary.frame.minY, body.frame.maxY)
        XCTAssertGreaterThan(harness.coordinator.tableView(harness.tableView, heightOfRow: 0), 54)
    }

    func testExpandedExecutionShowsRawStatusInBoundedScrollableArea() throws {
        let harness = makeHarness(followsLatest: true, height: 520)
        let rawStatus = "Raw status\n" + String(repeating: "{\"event\":\"tool\",\"status\":\"running\"}\n", count: 80)
        let process = AppKitChatTimelineRow(
            id: "process-with-raw-status",
            contentRevision: 1,
            nativeText: "⌘  Running command",
            rawStatusText: rawStatus,
            copyText: "Running command\n\n\(rawStatus)",
            nativeStyle: .process,
            title: "",
            metadata: "",
            expandableTurnId: "turn",
            isExpanded: true,
            processCount: 1,
            processState: .running,
            showsHeader: false
        )
        harness.coordinator.apply(rows: [process])
        harness.window.contentView?.layoutSubtreeIfNeeded()

        let cell = try XCTUnwrap(
            harness.tableView.view(atColumn: 0, row: 0, makeIfNecessary: true) as? AppKitChatNativeTextCell
        )
        cell.layoutSubtreeIfNeeded()
        let rawArea = try XCTUnwrap(
            view(in: cell, identifier: "chat.timeline.raw-status") as? NSScrollView
        )
        let rawTextView = try XCTUnwrap(rawArea.documentView as? NSTextView)

        XCTAssertFalse(rawArea.isHidden)
        XCTAssertTrue(rawArea.hasVerticalScroller)
        XCTAssertEqual(
            NativeTimelineLayoutCache.shared.layout(
                for: process,
                columnWidth: harness.tableView.tableColumns[0].width
            ).rawStatusHeight,
            160
        )
        XCTAssertLessThanOrEqual(rawArea.frame.height, 164)
        XCTAssertEqual(rawTextView.string, rawStatus)
        XCTAssertTrue(rawTextView.font.map { NSFontManager.shared.traits(of: $0).contains(.fixedPitchFontMask) } == true)
    }

    func testOrdinaryNativeMessagePlacesHoverTimestampBesideCopyAction() throws {
        let harness = makeHarness(followsLatest: true)
        let message = row(
            id: "ordinary-message",
            text: "Ready",
            showsHeader: false,
            hoverTimestamp: "08/17 20:30"
        )
        harness.coordinator.apply(rows: [message])
        harness.window.contentView?.layoutSubtreeIfNeeded()

        let cell = try XCTUnwrap(
            harness.coordinator.tableView(harness.tableView, viewFor: harness.tableView.tableColumns[0], row: 0)
                as? AppKitChatNativeTextCell
        )
        cell.layoutSubtreeIfNeeded()
        let title = try XCTUnwrap(textField(in: cell, identifier: "chat.timeline.title"))
        let metadata = try XCTUnwrap(textField(in: cell, identifier: "chat.timeline.metadata"))
        let hoverTimestamp = try XCTUnwrap(textField(in: cell, identifier: "chat.timeline.hover-timestamp"))
        let messageActions = try XCTUnwrap(view(in: cell, identifier: "chat.timeline.message-actions"))
        let copy = try XCTUnwrap(button(in: cell, identifier: "chat.timeline.copy"))
        messageActions.layoutSubtreeIfNeeded()

        XCTAssertTrue(title.isHidden)
        XCTAssertTrue(metadata.isHidden)
        XCTAssertFalse(hoverTimestamp.isHidden)
        XCTAssertEqual(hoverTimestamp.stringValue, "08/17 20:30")
        XCTAssertEqual(hoverTimestamp.alphaValue, 1)
        XCTAssertTrue(hoverTimestamp.isDescendant(of: messageActions))
        XCTAssertTrue(copy.isDescendant(of: messageActions))
        XCTAssertLessThanOrEqual(hoverTimestamp.frame.maxX, copy.frame.minX)
        XCTAssertLessThanOrEqual(copy.frame.minX - hoverTimestamp.frame.maxX, 6.5)
        XCTAssertLessThan(
            harness.coordinator.tableView(harness.tableView, heightOfRow: 0),
            65
        )
    }

    func testOrdinaryMessageActionsAreOutsideCardAndExcludedFromExecutionRows() throws {
        let harness = makeHarness(followsLatest: true)
        let agent = row(
            id: "agent-message",
            text: "First line\nSecond line",
            copyText: "First line\nSecond line",
            showsHeader: false,
            hoverTimestamp: "08/17 20:30"
        )
        let user = row(
            id: "user-message",
            text: "Question",
            nativeStyle: .user,
            showsHeader: false,
            hoverTimestamp: "08/17 20:31"
        )
        let process = AppKitChatTimelineRow(
            id: "process",
            contentRevision: 0,
            nativeText: "swift test",
            copyText: "swift test",
            nativeStyle: .process,
            title: "",
            metadata: "",
            expandableTurnId: "turn",
            isExpanded: true,
            processCount: 1,
            processDuration: "2s",
            processState: .completed,
            showsHeader: false
        )
        harness.coordinator.apply(rows: [agent, user, process])
        harness.window.contentView?.layoutSubtreeIfNeeded()

        let agentCell = try XCTUnwrap(
            harness.tableView.view(atColumn: 0, row: 0, makeIfNecessary: true) as? AppKitChatNativeTextCell
        )
        agentCell.layoutSubtreeIfNeeded()
        let agentCard = try XCTUnwrap(agentCell.subviews.first)
        let agentActions = try XCTUnwrap(view(in: agentCell, identifier: "chat.timeline.message-actions"))
        let copy = try XCTUnwrap(button(in: agentCell, identifier: "chat.timeline.copy"))
        let agentTimestamp = try XCTUnwrap(textField(in: agentCell, identifier: "chat.timeline.hover-timestamp"))
        XCTAssertFalse(agentActions.isHidden)
        XCTAssertEqual(agentActions.alphaValue, 0)
        XCTAssertFalse(copy.isDescendant(of: agentCard))
        XCTAssertTrue(agentTimestamp.isDescendant(of: agentActions))
        XCTAssertEqual(copy.toolTip, "复制消息")
        XCTAssertNil(button(in: agentCell, identifier: "chat.timeline.quote"))
        XCTAssertEqual(agentActions.frame.minX, agentCard.frame.minX + 2, accuracy: 1)

        copy.performClick(nil)
        XCTAssertEqual(NSPasteboard.general.string(forType: .string), "First line\nSecond line")

        let userCell = try XCTUnwrap(
            harness.tableView.view(atColumn: 0, row: 1, makeIfNecessary: true) as? AppKitChatNativeTextCell
        )
        userCell.layoutSubtreeIfNeeded()
        let userCard = try XCTUnwrap(userCell.subviews.first)
        let userActions = try XCTUnwrap(view(in: userCell, identifier: "chat.timeline.message-actions"))
        let userTimestamp = try XCTUnwrap(textField(in: userCell, identifier: "chat.timeline.hover-timestamp"))
        XCTAssertFalse(userActions.isHidden)
        XCTAssertEqual(userActions.frame.maxX, userCard.frame.maxX - 2, accuracy: 1)
        XCTAssertTrue(userTimestamp.isDescendant(of: userActions))
        XCTAssertFalse(
            try XCTUnwrap(NSColor(cgColor: userCard.layer?.backgroundColor ?? CGColor.clear))
                .isEqual(try XCTUnwrap(NSColor(cgColor: agentCard.layer?.backgroundColor ?? CGColor.clear)))
        )

        let processCell = try XCTUnwrap(
            harness.tableView.view(atColumn: 0, row: 2, makeIfNecessary: true) as? AppKitChatNativeTextCell
        )
        let processActions = try XCTUnwrap(view(in: processCell, identifier: "chat.timeline.message-actions"))
        XCTAssertTrue(processActions.isHidden)
    }

    func testSingleColumnReservesAStableScrollerGutter() async {
        let harness = makeHarness(followsLatest: true)
        harness.coordinator.apply(rows: [row(id: "message", text: "Ready")])
        harness.window.setContentSize(NSSize(width: 620, height: 320))
        harness.window.layoutIfNeeded()
        NotificationCenter.default.post(
            name: NSView.frameDidChangeNotification,
            object: harness.scrollView
        )
        await settleMainQueue()

        let expectedWidth = harness.scrollView.bounds.width - NSScroller.scrollerWidth(
            for: .regular,
            scrollerStyle: .legacy
        )
        XCTAssertEqual(harness.tableView.tableColumns[0].width, expectedWidth, accuracy: 1)
        XCTAssertLessThan(harness.tableView.tableColumns[0].width, harness.scrollView.bounds.width)
        XCTAssertEqual(harness.tableView.style, .plain)
        XCTAssertEqual(harness.tableView.rect(ofColumn: 0).minX, 0, accuracy: 0.5)
    }

    func testUnbrokenModelTextWrapsInsideTheCardBoundary() throws {
        let harness = makeHarness(followsLatest: false, height: 320)
        let token = String(repeating: "https://example.com/very-long-path-without-breaks-0123456789", count: 12)
        harness.coordinator.apply(rows: [row(id: "long-token", text: token, showsHeader: false)])
        harness.window.contentView?.layoutSubtreeIfNeeded()

        let cell = try XCTUnwrap(
            harness.tableView.view(atColumn: 0, row: 0, makeIfNecessary: true) as? AppKitChatNativeTextCell
        )
        cell.layoutSubtreeIfNeeded()
        let card = try XCTUnwrap(cell.subviews.first)
        let body = try XCTUnwrap(textView(in: cell, identifier: "chat.timeline.body"))
        let bodyFrame = body.convert(body.bounds, to: cell)
        let cardFrame = card.convert(card.bounds, to: cell)

        XCTAssertLessThanOrEqual(bodyFrame.maxX, cardFrame.maxX + 1)
        XCTAssertLessThanOrEqual(bodyFrame.maxY, cardFrame.maxY + 1)
        XCTAssertEqual(body.laidOutCharacterRange, NSRange(location: 0, length: body.string.utf16.count))
        XCTAssertGreaterThan(body.textContainer?.containerSize.height ?? 0, body.bounds.height)
        XCTAssertTrue(hasVisiblePixels(in: body), "The message body must draw visible text pixels")
        XCTAssertGreaterThan(harness.tableView.rect(ofRow: 0).height, 60)
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

    func testTransientEmptyProjectionPreservesReaderAcrossStreamedRowReturn() async {
        let harness = makeHarness(followsLatest: false, height: 180)
        let original = (0..<40).map { row(id: "transient-\($0)", text: "Original row \($0)") }
        harness.coordinator.apply(rows: original)
        harness.tableView.layoutSubtreeIfNeeded()
        harness.tableView.scrollRowToVisible(18)
        await settleMainQueue()
        let before = visibleAnchor(in: harness.tableView, rows: original)

        // Reproduce an async display projection replacing the current cache:
        // one empty publication is followed by the same semantic rows with a
        // streamed tail revision.
        harness.coordinator.apply(rows: [])
        let streamed = Array(original.dropLast()) + [
            row(id: "transient-39", revision: 1, text: "Streamed tail update")
        ]
        harness.coordinator.apply(rows: streamed)
        await settleMainQueue()
        let after = visibleAnchor(in: harness.tableView, rows: streamed)

        XCTAssertEqual(after.id, before.id)
        XCTAssertEqual(after.offset, before.offset, accuracy: 4)
        XCTAssertFalse(harness.followState.value)
        XCTAssertNotEqual(after.id, streamed.first?.id)
    }

    func testTransientEmptyProjectionPreservesLatestFollowMode() async {
        let harness = makeHarness(followsLatest: true, height: 180)
        let original = (0..<40).map { row(id: "empty-follow-\($0)", text: "Row \($0)") }
        harness.coordinator.apply(rows: original)
        await settleMainQueue()
        XCTAssertTrue(isNearBottom(harness))

        harness.coordinator.apply(rows: [])
        harness.coordinator.apply(rows: original + [row(id: "empty-follow-40", text: "New message")])
        await settleMainQueue()

        XCTAssertTrue(isNearBottom(harness))
        XCTAssertTrue(harness.followState.value)
    }

    func testTransientEmptyProjectionWithReplacedWindowDegradesToLatestNotOldest() async {
        let harness = makeHarness(followsLatest: false, height: 180)
        let original = (0..<40).map { row(id: "removed-\($0)", text: "Old row \($0)") }
        harness.coordinator.apply(rows: original)
        harness.tableView.scrollRowToVisible(18)
        await settleMainQueue()

        harness.coordinator.apply(rows: [])
        let replacement = (0..<40).map { row(id: "replacement-\($0)", text: "New row \($0)") }
        harness.coordinator.apply(rows: replacement)
        await settleMainQueue()

        XCTAssertTrue(isNearBottom(harness))
        XCTAssertTrue(harness.followState.value)
        XCTAssertGreaterThan(harness.scrollView.contentView.bounds.minY, 8)
    }

    func testExplicitJumpToLatestWinsDuringTransientEmptyProjection() async {
        let harness = makeHarness(followsLatest: false, height: 180)
        let original = (0..<40).map { row(id: "empty-jump-\($0)", text: "Row \($0)") }
        harness.coordinator.apply(rows: original)
        harness.tableView.scrollRowToVisible(18)
        await settleMainQueue()

        harness.coordinator.apply(rows: [])
        harness.coordinator.scrollToBottom()
        harness.coordinator.apply(rows: original + [row(id: "empty-jump-40", text: "Newest")])
        await settleMainQueue()

        XCTAssertTrue(isNearBottom(harness))
        XCTAssertTrue(harness.followState.value)
    }

    func testDirectScrollbarJumpMaterializesTheLastMessageWithoutIntermediatePrewarming() async throws {
        let harness = makeHarness(followsLatest: false, height: 180)
        let rows = (0..<40).map { index in
            row(
                id: "direct-jump-\(index)",
                text: index == 39
                    ? String(repeating: "Final message remains visible. ", count: 18)
                    : "Message \(index)"
            )
        }
        harness.coordinator.apply(rows: rows)
        XCTAssertFalse(harness.tableView.usesAutomaticRowHeights)

        harness.coordinator.scrollToBottom()
        await settleMainQueue()
        harness.window.contentView?.layoutSubtreeIfNeeded()

        let lastIndex = rows.count - 1
        let lastRect = harness.tableView.rect(ofRow: lastIndex)
        XCTAssertTrue(harness.tableView.visibleRect.intersects(lastRect))
        XCTAssertNotNil(
            harness.tableView.view(atColumn: 0, row: lastIndex, makeIfNecessary: false),
            "A direct scrollbar jump must materialize the destination cell"
        )
        XCTAssertLessThanOrEqual(
            max(0, harness.tableView.visibleRect.maxY - lastRect.maxY),
            harness.tableView.intercellSpacing.height + 2
        )
    }

    func testExplicitTurnJumpIsAnAuthoritativeProgrammaticScroll() async {
        let harness = makeHarness(followsLatest: true, height: 180)
        let rows = (0..<40).map { index in
            row(
                id: "turn-jump-row-\(index)",
                text: "Message \(index)",
                expandableTurnId: "turn-\(index)"
            )
        }
        harness.coordinator.apply(rows: rows)
        harness.coordinator.scrollToTurn("turn-18")
        await settleMainQueue()

        XCTAssertTrue(harness.tableView.visibleRect.intersects(harness.tableView.rect(ofRow: 18)))
        XCTAssertFalse(harness.followState.value)
    }

    func testDocumentAndScrollerShareTheLastMessageAsTheirNaturalBottom() async throws {
        let harness = makeHarness(followsLatest: false, height: 180)
        let rows = (0..<20).map { row(id: "bounded-scroll-\($0)", text: "Message \($0)") }
        harness.coordinator.apply(rows: rows)
        harness.window.contentView?.layoutSubtreeIfNeeded()

        let lastRowRect = harness.tableView.rect(ofRow: rows.count - 1)
        harness.coordinator.scrollToBottom()
        await settleMainQueue()

        XCTAssertEqual(harness.tableView.frame.height, lastRowRect.maxY, accuracy: 1)
        XCTAssertEqual(harness.scrollView.documentVisibleRect.maxY, lastRowRect.maxY, accuracy: 2)
        XCTAssertEqual(
            harness.scrollView.contentView.bounds.maxY,
            lastRowRect.maxY,
            accuracy: 2
        )
        XCTAssertTrue(harness.tableView.visibleRect.intersects(lastRowRect))
        let scroller = try XCTUnwrap(harness.scrollView.verticalScroller)
        XCTAssertEqual(scroller.floatValue, 1, accuracy: 0.01)
    }

    func testFollowBindingTracksWhetherViewportIsAtBottom() async {
        let harness = makeHarness(followsLatest: true, height: 180)
        let rows = (0..<24).map { row(id: "follow-state-\($0)", text: "Message \($0)") }
        harness.coordinator.apply(rows: rows)
        await settleMainQueue()

        XCTAssertTrue(harness.followState.value)

        harness.scrollView.contentView.scroll(to: .zero)
        harness.scrollView.reflectScrolledClipView(harness.scrollView.contentView)
        await settleMainQueue()

        XCTAssertFalse(harness.followState.value)

        harness.coordinator.scrollToBottom()
        await settleMainQueue()

        XCTAssertTrue(harness.followState.value)
    }

    func testSavedSessionPositionRestoresMessageAnchorAndFollowMode() async {
        let harness = makeHarness(followsLatest: true, height: 180)
        let rows = (0..<30).map { row(id: "session-row-\($0)", text: "Row \($0)") }
        harness.coordinator.apply(rows: rows)
        harness.tableView.layoutSubtreeIfNeeded()

        harness.coordinator.restore(position: AppKitChatTimelinePosition(
            rowID: "session-row-12",
            offset: 6,
            absoluteScrollY: 0,
            followsLatest: false
        ))
        await settleMainQueue()

        let anchor = visibleAnchor(in: harness.tableView, rows: rows)
        XCTAssertEqual(anchor.id, "session-row-12")
        XCTAssertEqual(anchor.offset, 6, accuracy: 4)
        XCTAssertFalse(harness.followState.value)
    }

    func testMissingSemanticAnchorIgnoresStaleAbsoluteYAndDegradesToLatest() async {
        let harness = makeHarness(followsLatest: true, height: 180)
        let rows = (0..<30).map { row(id: "fallback-row-\($0)", text: "Row \($0)") }
        harness.coordinator.apply(rows: rows)
        harness.tableView.layoutSubtreeIfNeeded()

        harness.coordinator.restore(position: AppKitChatTimelinePosition(
            rowID: "message-no-longer-loaded",
            offset: 6,
            absoluteScrollY: 240,
            followsLatest: false
        ))
        await settleMainQueue()

        XCTAssertTrue(isNearBottom(harness))
        XCTAssertNotEqual(harness.scrollView.contentView.bounds.minY, 240, accuracy: 2)
        XCTAssertTrue(harness.followState.value)
    }

    func testPendingSessionRestoreSurvivesAProjectionChangeBeforeLayoutCompletes() async {
        let harness = makeHarness(followsLatest: true, height: 180)
        let rows = (0..<30).map { row(id: "pending-row-\($0)", text: "Row \($0)") }
        harness.coordinator.apply(rows: rows)
        harness.tableView.layoutSubtreeIfNeeded()

        harness.coordinator.restore(position: AppKitChatTimelinePosition(
            rowID: "pending-row-12",
            offset: 5,
            absoluteScrollY: 0,
            followsLatest: false
        ))
        let prepended = [row(id: "pending-history", text: "Earlier history")] + rows
        harness.coordinator.apply(rows: prepended)
        await settleMainQueue()

        let anchor = visibleAnchor(in: harness.tableView, rows: prepended)
        XCTAssertEqual(anchor.id, "pending-row-12")
        XCTAssertEqual(anchor.offset, 5, accuracy: 4)
        XCTAssertFalse(harness.followState.value)
    }

    func testInitialSessionPositionIsRestoredInsideTheFirstLayoutPass() {
        let harness = makeHarness(followsLatest: true, height: 180)
        let rows = (0..<30).map { row(id: "first-frame-row-\($0)", text: "Row \($0)") }
        harness.coordinator.prepareInitialPosition(AppKitChatTimelinePosition(
            rowID: "first-frame-row-12",
            offset: 4,
            absoluteScrollY: 0,
            followsLatest: false
        ))
        harness.coordinator.apply(rows: rows)

        harness.window.layoutIfNeeded()
        harness.scrollView.layoutSubtreeIfNeeded()

        let anchor = visibleAnchor(in: harness.tableView, rows: rows)
        XCTAssertEqual(anchor.id, "first-frame-row-12")
        XCTAssertEqual(anchor.offset, 4, accuracy: 4)
        XCTAssertFalse(harness.followState.value)
    }

    func testInitialLatestPositionIsAtBottomInsideTheFirstLayoutPass() {
        let harness = makeHarness(followsLatest: false, height: 180)
        let rows = (0..<30).map { row(id: "first-bottom-row-\($0)", text: "Row \($0)") }
        harness.coordinator.prepareInitialScrollToBottom()
        harness.coordinator.apply(rows: rows)

        harness.window.layoutIfNeeded()
        harness.scrollView.layoutSubtreeIfNeeded()

        XCTAssertTrue(isNearBottom(harness))
        XCTAssertTrue(harness.followState.value)
    }

    func testFirstOpenOfSessionWithoutSavedPositionDefaultsToLatestMessage() async {
        let harness = makeHarness(followsLatest: false, height: 180)
        let rows = (0..<80).map { row(id: "unseen-row-\($0)", text: "Row \($0)") }

        harness.coordinator.switchSessionIfNeeded(
            to: "never-opened-session",
            initialPosition: nil
        )
        harness.coordinator.apply(rows: rows)
        harness.window.layoutIfNeeded()
        harness.scrollView.layoutSubtreeIfNeeded()
        await settleMainQueue()

        XCTAssertTrue(isNearBottom(harness))
        XCTAssertTrue(harness.followState.value)
        XCTAssertGreaterThan(harness.scrollView.contentView.bounds.minY, 8)
    }

    func testLatestSavedPositionCannotRestoreItsStaleRowAnchor() async {
        let harness = makeHarness(followsLatest: false, height: 180)
        let rows = (0..<80).map { row(id: "latest-row-\($0)", text: "Row \($0)") }
        let latestPosition = AppKitChatTimelinePosition(
            rowID: "latest-row-5",
            offset: 3,
            absoluteScrollY: 0,
            followsLatest: true
        )

        harness.coordinator.switchSessionIfNeeded(
            to: "latest-session",
            initialPosition: latestPosition
        )
        harness.coordinator.apply(rows: rows)
        // Mirrors the position feedback that updateNSView applies after the
        // Session switch and must not reinterpret the stale row as history.
        harness.coordinator.restoreIfNeeded(position: latestPosition)
        harness.window.layoutIfNeeded()
        harness.scrollView.layoutSubtreeIfNeeded()
        await settleMainQueue()

        XCTAssertTrue(isNearBottom(harness))
        XCTAssertTrue(harness.followState.value)
        XCTAssertGreaterThan(harness.scrollView.contentView.bounds.minY, 8)
    }

    func testImmediatePositionPublishFlushesTheLastViewportBeforeSessionUnmount() async throws {
        var savedPosition: AppKitChatTimelinePosition?
        let harness = makeHarness(
            followsLatest: false,
            height: 180,
            onPositionChange: { savedPosition = $0 }
        )
        let rows = (0..<30).map { row(id: "flush-row-\($0)", text: "Row \($0)") }
        harness.coordinator.apply(rows: rows)
        harness.tableView.layoutSubtreeIfNeeded()
        let targetY: CGFloat = 260
        harness.scrollView.contentView.scroll(to: NSPoint(x: 0, y: targetY))
        harness.scrollView.reflectScrolledClipView(harness.scrollView.contentView)

        harness.coordinator.publishPositionImmediately()

        let position = try XCTUnwrap(savedPosition)
        XCTAssertEqual(position.absoluteScrollY, Double(targetY), accuracy: 2)
        XCTAssertFalse(position.followsLatest)
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

    func testClampedWheelAtBottomKeepsFollowingForUserMessageAppend() async {
        let harness = makeHarness(followsLatest: true, height: 180)
        let rows = (0..<30).map { row(id: "send-follow-\($0)", text: "Message \($0)") }
        harness.coordinator.apply(rows: rows)
        await settleMainQueue()
        XCTAssertTrue(isNearBottom(harness))

        // At the lower boundary AppKit may clamp the entire gesture and emit
        // no bounds-change notification between willBegin/didEnd.
        harness.coordinator.userScrollEventWillBegin()
        harness.coordinator.userScrollEventDidEnd()
        XCTAssertTrue(harness.followState.value)

        let appended = rows + [row(id: "send-follow-user", text: "New user message")]
        harness.coordinator.apply(rows: appended)
        await settleMainQueue()

        XCTAssertTrue(isNearBottom(harness))
        XCTAssertTrue(harness.followState.value)
        let visibleRows = harness.tableView.rows(in: harness.tableView.visibleRect)
        XCTAssertTrue(visibleRows.contains(appended.count - 1))
    }

    func testCompletedWheelAwayFromBottomPreservesReaderAnchorOnAppend() async {
        let harness = makeHarness(followsLatest: true, height: 180)
        let rows = (0..<30).map { row(id: "history-follow-\($0)", text: "Message \($0)") }
        harness.coordinator.apply(rows: rows)
        await settleMainQueue()

        harness.scrollView.contentView.scroll(to: NSPoint(x: 0, y: 260))
        harness.scrollView.reflectScrolledClipView(harness.scrollView.contentView)
        harness.coordinator.userScrollEventWillBegin()
        harness.coordinator.userScrollEventDidEnd()
        let anchorBefore = visibleAnchor(in: harness.tableView, rows: rows)
        XCTAssertFalse(harness.followState.value)

        let appended = rows + [row(id: "history-follow-user", text: "New user message")]
        harness.coordinator.apply(rows: appended)
        await settleMainQueue()

        let anchorAfter = visibleAnchor(in: harness.tableView, rows: appended)
        XCTAssertEqual(anchorAfter.id, anchorBefore.id)
        XCTAssertEqual(anchorAfter.offset, anchorBefore.offset, accuracy: 1)
        XCTAssertFalse(harness.followState.value)
    }

    func testGoalTailRefreshUsesViewportGeometryInsteadOfStaleFollowInput() async {
        let harness = makeHarness(followsLatest: true, height: 180)
        let rows = (0..<30).map { row(id: "goal-row-\($0)", revision: 0, text: "Goal row \($0)") }
        harness.coordinator.apply(rows: rows)
        await settleMainQueue()

        harness.scrollView.contentView.scroll(to: .zero)
        harness.scrollView.reflectScrolledClipView(harness.scrollView.contentView)
        await settleMainQueue()
        XCTAssertFalse(harness.followState.value)

        // Reproduce SwiftUI feeding the coordinator the previous frame's
        // value while Goal progress keeps revising the final card.
        harness.coordinator.followsLatest = true
        let refreshed = Array(rows.dropLast()) + [
            row(id: "goal-row-29", revision: 1, text: "Goal progress streamed again")
        ]
        harness.coordinator.apply(rows: refreshed)
        await settleMainQueue()

        XCTAssertEqual(harness.scrollView.contentView.bounds.minY, 0, accuracy: 1)
        XCTAssertFalse(isNearBottom(harness))
    }

    func testGoalMessageAppendPreservesReaderAnchorWithStaleFollowInput() async {
        let harness = makeHarness(followsLatest: true, height: 180)
        let rows = (0..<30).map { row(id: "goal-message-\($0)", text: "Goal message \($0)") }
        harness.coordinator.apply(rows: rows)
        await settleMainQueue()

        harness.scrollView.contentView.scroll(to: NSPoint(x: 0, y: 240))
        harness.scrollView.reflectScrolledClipView(harness.scrollView.contentView)
        await settleMainQueue()
        let before = visibleAnchor(in: harness.tableView, rows: rows)

        harness.coordinator.followsLatest = true
        let appended = rows + [row(id: "goal-message-30", text: "New user message")]
        harness.coordinator.apply(rows: appended)
        await settleMainQueue()
        let after = visibleAnchor(in: harness.tableView, rows: appended)

        XCTAssertEqual(after.id, before.id)
        XCTAssertEqual(after.offset, before.offset, accuracy: 4)
        XCTAssertFalse(isNearBottom(harness))
    }

    func testUserScrollAwayCancelsQueuedGoalFollowCommand() async {
        let harness = makeHarness(followsLatest: true, height: 180)
        let rows = (0..<30).map { row(id: "queued-goal-row-\($0)", revision: 0, text: "Goal row \($0)") }
        harness.coordinator.apply(rows: rows)
        await settleMainQueue()

        let refreshed = Array(rows.dropLast()) + [
            row(id: "queued-goal-row-29", revision: 1, text: "A taller streamed Goal update\n\nwith more content")
        ]
        harness.coordinator.apply(rows: refreshed)
        harness.scrollView.contentView.scroll(to: .zero)
        harness.scrollView.reflectScrolledClipView(harness.scrollView.contentView)
        await settleMainQueue()

        XCTAssertEqual(harness.scrollView.contentView.bounds.minY, 0, accuracy: 1)
        XCTAssertFalse(harness.followState.value)
        XCTAssertFalse(isNearBottom(harness))
    }

    func testUserGestureCancelsQueuedProgrammaticScrollBeforeItRuns() async {
        let harness = makeHarness(followsLatest: false, height: 180)
        let rows = (0..<30).map { row(id: "gesture-authority-\($0)", text: "Row \($0)") }
        harness.coordinator.apply(rows: rows)
        harness.scrollView.contentView.scroll(to: .zero)
        harness.coordinator.scrollToBottom()
        harness.coordinator.userDidBeginScrolling()
        await settleMainQueue()

        XCTAssertEqual(harness.scrollView.contentView.bounds.minY, 0, accuracy: 1)
        XCTAssertFalse(harness.followState.value)
    }

    func testUserGestureRejectsLaterSwiftUIPositionFeedback() async {
        let harness = makeHarness(followsLatest: false, height: 180)
        let rows = (0..<40).map { row(id: "feedback-row-\($0)", text: "Row \($0)") }
        harness.coordinator.apply(rows: rows)
        harness.coordinator.restore(position: .init(
            rowID: "feedback-row-20",
            offset: 4,
            absoluteScrollY: 0,
            followsLatest: false
        ))
        await settleMainQueue()

        harness.scrollView.contentView.scroll(to: .zero)
        harness.coordinator.userDidBeginScrolling()
        harness.coordinator.restoreIfNeeded(position: .init(
            rowID: "feedback-row-25",
            offset: 6,
            absoluteScrollY: 0,
            followsLatest: false
        ))
        await settleMainQueue()

        XCTAssertEqual(harness.scrollView.contentView.bounds.minY, 0, accuracy: 1)
        XCTAssertFalse(harness.followState.value)
    }

    func testRowReflowCannotQueueAnchorRestoreInsideWheelEvent() async {
        let harness = makeHarness(followsLatest: false, height: 180)
        var rows = (0..<50).map { row(id: "wheel-reflow-\($0)", text: "Row \($0)") }
        harness.coordinator.apply(rows: rows)
        await settleMainQueue()
        harness.scrollView.contentView.scroll(to: NSPoint(x: 0, y: 420))

        // The Binding update caused by wheel ownership can synchronously
        // re-enter updateNSView before NSScrollView applies the wheel delta.
        // A row reflow in that window must not enqueue a later anchor restore.
        harness.coordinator.userScrollEventWillBegin()
        rows[0] = row(
            id: "wheel-reflow-0",
            revision: 1,
            text: String(repeating: "A much taller row above the viewport. ", count: 80)
        )
        harness.coordinator.apply(rows: rows)
        harness.scrollView.contentView.scroll(to: NSPoint(x: 0, y: 360))
        harness.coordinator.userScrollEventDidEnd()
        await settleMainQueue()

        XCTAssertEqual(harness.scrollView.contentView.bounds.minY, 360, accuracy: 1)
        XCTAssertFalse(harness.followState.value)
    }

    func testHistoryLoadingRequiresAnActiveUserScrollEvent() async {
        var historyRequests = 0
        let harness = makeHarness(
            followsLatest: false,
            height: 180,
            onNearTop: { historyRequests += 1 }
        )
        let rows = (0..<40).map { row(id: "history-gate-\($0)", text: "Row \($0)") }
        harness.coordinator.apply(rows: rows)
        await settleMainQueue()

        // A layout/restore bounds notification at y=0 is not user intent.
        harness.scrollView.contentView.scroll(to: .zero)
        harness.scrollView.reflectScrolledClipView(harness.scrollView.contentView)
        XCTAssertEqual(historyRequests, 0)

        harness.scrollView.contentView.scroll(to: NSPoint(x: 0, y: 120))
        harness.coordinator.userScrollEventWillBegin()
        harness.scrollView.contentView.scroll(to: .zero)
        harness.scrollView.reflectScrolledClipView(harness.scrollView.contentView)
        harness.coordinator.userScrollEventDidEnd()
        XCTAssertEqual(historyRequests, 1)
    }

    func testUnderfilledViewportRequestsHistoryWithoutUserGestureWhenHistoryExists() async {
        var historyRequests = 0
        let harness = makeHarness(
            followsLatest: true,
            height: 520,
            hasMoreHistory: true,
            onUnderfilledHistory: { historyRequests += 1 }
        )

        harness.coordinator.apply(rows: [
            row(id: "underfilled-user", text: "Question"),
            row(id: "underfilled-process", text: "Collapsed execution")
        ])
        await settleMainQueue()

        XCTAssertEqual(historyRequests, 1)
        harness.coordinator.apply(rows: [
            row(id: "underfilled-user", text: "Question"),
            row(id: "underfilled-process", text: "Collapsed execution")
        ])
        await settleMainQueue()
        XCTAssertEqual(historyRequests, 1, "The same underfilled projection must not loop")
    }

    func testUnderfilledViewportDoesNotRequestWhenHistoryIsExhausted() async {
        var historyRequests = 0
        let harness = makeHarness(
            followsLatest: true,
            height: 520,
            hasMoreHistory: false,
            onUnderfilledHistory: { historyRequests += 1 }
        )
        harness.coordinator.apply(rows: [row(id: "only-row", text: "Latest")])
        await settleMainQueue()

        XCTAssertEqual(historyRequests, 0)
    }

    func testScrollableViewportDoesNotUseUnderfilledHistoryPath() async {
        var historyRequests = 0
        let harness = makeHarness(
            followsLatest: true,
            height: 180,
            hasMoreHistory: true,
            onUnderfilledHistory: { historyRequests += 1 }
        )
        harness.coordinator.apply(rows: (0..<40).map { row(id: "scrollable-\($0)", text: "Row \($0)") })
        await settleMainQueue()

        XCTAssertEqual(historyRequests, 0)
    }

    func testDirectScrollbarDragToTopRequestsHistory() async {
        var historyRequests = 0
        let harness = makeHarness(
            followsLatest: false,
            height: 180,
            onNearTop: { historyRequests += 1 }
        )
        let rows = (0..<40).map { row(id: "scrollbar-history-\($0)", text: "Row \($0)") }
        harness.coordinator.apply(rows: rows)
        await settleMainQueue()

        harness.scrollView.contentView.scroll(to: NSPoint(x: 0, y: 120))
        harness.scrollView.contentView.scroll(to: .zero)
        harness.scrollView.reflectScrolledClipView(harness.scrollView.contentView)
        XCTAssertEqual(historyRequests, 0, "Programmatic bounds changes remain suppressed")

        harness.coordinator.viewportDidScroll(userInitiated: true)
        XCTAssertEqual(historyRequests, 1, "A scrollbar drag is explicit user intent")
    }

    func testFailedHistoryRequestCanBeRearmedWhileViewportRemainsAtTop() async {
        var historyRequests = 0
        let harness = makeHarness(
            followsLatest: false,
            height: 180,
            onNearTop: { historyRequests += 1 }
        )
        let rows = (0..<40).map { row(id: "retry-history-\($0)", text: "Row \($0)") }
        harness.coordinator.apply(rows: rows)
        await settleMainQueue()
        harness.scrollView.contentView.scroll(to: .zero)

        harness.coordinator.viewportDidScroll(userInitiated: true)
        harness.coordinator.viewportDidScroll(userInitiated: true)
        XCTAssertEqual(historyRequests, 1, "Repeated bounds notifications are coalesced")

        harness.coordinator.rearmHistoryRequest()
        harness.coordinator.userScrollEventWillBegin()
        harness.coordinator.userScrollEventDidEnd()
        XCTAssertEqual(historyRequests, 2, "Retry does not require leaving the clamped top edge")
    }

    func testSmallWheelMoveNearLatestCannotJumpToOldestDuringTailAppend() async {
        var historyRequests = 0
        let harness = makeHarness(
            followsLatest: true,
            height: 180,
            onNearTop: { historyRequests += 1 }
        )
        let rows = (0..<60).map { row(id: "small-wheel-\($0)", text: "Row \($0)") }
        harness.coordinator.apply(rows: rows)
        await settleMainQueue()
        let bottomY = harness.scrollView.contentView.bounds.minY

        harness.coordinator.userScrollEventWillBegin()
        harness.scrollView.contentView.scroll(to: NSPoint(x: 0, y: max(0, bottomY - 4)))
        harness.scrollView.reflectScrolledClipView(harness.scrollView.contentView)
        harness.coordinator.userScrollEventDidEnd()

        let appended = rows + [row(id: "small-wheel-60", text: "Completed reply")]
        harness.coordinator.apply(rows: appended)
        await settleMainQueue()
        let after = visibleAnchor(in: harness.tableView, rows: appended)

        XCTAssertTrue(
            Set(appended.suffix(5).map(\.id)).contains(after.id),
            "A small gesture in the latest region may resume bottom following, but must not jump into history"
        )
        XCTAssertNotEqual(after.id, appended.first?.id)
        XCTAssertEqual(historyRequests, 0)
    }

    func testExplicitTurnJumpCancelsQueuedInitialRestore() async {
        let harness = makeHarness(followsLatest: false, height: 180)
        let rows = (0..<40).map { index in
            row(
                id: "jump-cancel-row-\(index)",
                text: "Row \(index)",
                expandableTurnId: "jump-cancel-turn-\(index)"
            )
        }
        harness.coordinator.apply(rows: rows)
        harness.coordinator.restore(position: .init(
            rowID: "jump-cancel-row-30",
            offset: 4,
            absoluteScrollY: 0,
            followsLatest: false
        ))
        harness.coordinator.scrollToTurn("jump-cancel-turn-8")
        await settleMainQueue()

        XCTAssertTrue(harness.tableView.visibleRect.intersects(harness.tableView.rect(ofRow: 8)))
        XCTAssertFalse(harness.tableView.visibleRect.intersects(harness.tableView.rect(ofRow: 30)))
    }

    func testVirtualSixtySecondContinuousScrollHasZeroReverseDisplacement() async {
        let harness = makeHarness(followsLatest: false, height: 180)
        var rows = (0..<160).map { row(id: "continuous-scroll-\($0)", text: "Row \($0)") }
        harness.coordinator.apply(rows: rows)
        harness.window.layoutIfNeeded()
        harness.scrollView.contentView.scroll(to: .zero)
        var reverseDisplacement: CGFloat = 0

        // 600 deterministic 100 ms gesture ticks model one minute of continuous
        // wheel/trackpad ownership without making the test wait for wall clock.
        for tick in 0..<600 {
            let before = harness.scrollView.contentView.bounds.minY
            let maximumY = max(0, harness.tableView.bounds.height - harness.scrollView.contentView.bounds.height)
            let intendedY = min(maximumY, before + 1)
            harness.scrollView.contentView.scroll(to: NSPoint(x: 0, y: intendedY))
            harness.coordinator.scrollToBottom()
            harness.coordinator.userDidBeginScrolling()
            if tick.isMultiple(of: 20) {
                rows[rows.count - 1] = row(
                    id: "continuous-scroll-159",
                    revision: tick + 1,
                    text: "Tail status update \(tick)\n\nwithout viewport authority"
                )
                harness.coordinator.apply(rows: rows)
            }
            await settleMainQueue()
            reverseDisplacement += max(0, intendedY - harness.scrollView.contentView.bounds.minY)
        }

        XCTAssertEqual(reverseDisplacement, 0, accuracy: 0.5)
        XCTAssertFalse(harness.followState.value)
    }

    func testGoalAndRegularTimelineFollowStateRemainCoordinatorLocal() async {
        let goalHarness = makeHarness(followsLatest: true, height: 180)
        let regularHarness = makeHarness(followsLatest: true, height: 180)
        let goalRows = (0..<24).map { row(id: "goal-mode-\($0)", text: "Goal \($0)") }
        let regularRows = (0..<24).map { row(id: "regular-mode-\($0)", text: "Regular \($0)") }
        goalHarness.coordinator.apply(rows: goalRows)
        regularHarness.coordinator.apply(rows: regularRows)
        await settleMainQueue()

        goalHarness.scrollView.contentView.scroll(to: .zero)
        goalHarness.scrollView.reflectScrolledClipView(goalHarness.scrollView.contentView)
        await settleMainQueue()

        XCTAssertFalse(goalHarness.followState.value)
        XCTAssertTrue(regularHarness.followState.value)
        XCTAssertTrue(isNearBottom(regularHarness))
    }

    func testOffscreenRenderingProducesVisibleTimelineArtifact() throws {
        let harness = makeHarness(followsLatest: false, height: 460)
        let rows = [
            row(id: "heading", text: "# Native AppKit Timeline\n\nA paragraph with **bold**, *italic*, and [a link](https://example.com)."),
            row(id: "list", text: "- first item\n- second item\n\n> quoted explanation"),
            AppKitChatTimelineRow(
                id: "process",
                contentRevision: 0,
                nativeText: "",
                copyText: "swift test",
                nativeStyle: .process,
                title: "",
                metadata: "",
                expandableTurnId: "turn",
                isExpanded: false,
                processCount: 4,
                processDuration: "12s",
                processState: .completed,
                showsHeader: false
            ),
            row(id: "action", text: "Native AppKit action row", actions: [
                .init(
                    id: "action:continue",
                    label: "Continue",
                    isDestructive: false,
                    kind: .sendMessage("continue")
                )
            ])
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

    func testNativeActionRowDispatchesApprovalWithoutHostingSwiftUI() throws {
        let option = CodexApprovalOption(
            id: "approve",
            label: "Approve",
            role: "approve",
            index: 0,
            selected: false
        )
        var receivedActionID: String?
        let harness = makeHarness(
            followsLatest: true,
            onToggle: { _ in },
            onAction: { action in receivedActionID = action.id }
        )
        harness.coordinator.apply(rows: [row(
            id: "approval",
            text: "Allow this operation?",
            actions: [
                .init(
                    id: "approval:approve",
                    label: "Approve",
                    isDestructive: false,
                    kind: .codexApproval(option)
                )
            ]
        )])
        harness.tableView.layoutSubtreeIfNeeded()

        let cell = try XCTUnwrap(
            harness.tableView.view(atColumn: 0, row: 0, makeIfNecessary: true) as? AppKitChatNativeTextCell
        )
        let actionButton = try XCTUnwrap(button(in: cell, identifier: "chat.timeline.action.approval:approve"))
        actionButton.performClick(nil)

        XCTAssertEqual(receivedActionID, "approval:approve")
    }

    func testWarmSessionHostSwitchStaysWithinOneFrame() async {
        let rowsBySession = (0..<3).map { sessionIndex in
            (0..<40).map { index in
                row(
                    id: "switch-\(sessionIndex)-row-\(index)",
                    text: String(repeating: "Message \(sessionIndex)-\(index) ", count: 8)
                )
            }
        }
        var coldSamples: [Double] = []
        for _ in 0..<8 {
            let start = DispatchTime.now().uptimeNanoseconds
            let harness = makeHarness(followsLatest: false, height: 360)
            harness.coordinator.prepareInitialPosition(.init(
                rowID: "switch-0-row-24",
                offset: 4,
                absoluteScrollY: 0,
                followsLatest: false
            ))
            harness.coordinator.apply(rows: rowsBySession[0])
            harness.window.layoutIfNeeded()
            harness.scrollView.layoutSubtreeIfNeeded()
            coldSamples.append(Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000)
        }

        let host = makeHarness(followsLatest: false, height: 360)
        let stableScrollView = host.scrollView
        for sessionIndex in rowsBySession.indices {
            host.coordinator.switchSessionIfNeeded(
                to: "session-\(sessionIndex)",
                initialPosition: .init(
                    rowID: "switch-\(sessionIndex)-row-24",
                    offset: 4,
                    absoluteScrollY: 0,
                    followsLatest: false
                )
            )
            host.coordinator.apply(rows: rowsBySession[sessionIndex])
            host.window.layoutIfNeeded()
            host.scrollView.layoutSubtreeIfNeeded()
        }
        var warmSamples: [Double] = []
        for index in 0..<60 {
            let sessionIndex = index % rowsBySession.count
            let start = DispatchTime.now().uptimeNanoseconds
            host.coordinator.switchSessionIfNeeded(
                to: "session-\(sessionIndex)",
                initialPosition: .init(
                    rowID: "switch-\(sessionIndex)-row-24",
                    offset: 4,
                    absoluteScrollY: 0,
                    followsLatest: false
                )
            )
            host.coordinator.apply(rows: rowsBySession[sessionIndex])
            host.window.layoutIfNeeded()
            host.scrollView.layoutSubtreeIfNeeded()
            warmSamples.append(Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000)
        }
        coldSamples.sort()
        warmSamples.sort()
        let coldP50 = coldSamples[coldSamples.count / 2]
        let warmP50 = warmSamples[warmSamples.count / 2]
        let warmP95 = warmSamples[Int(Double(warmSamples.count - 1) * 0.95)]
        let warmHitches = warmSamples.filter { $0 > 16.67 }.count
        print("[perf] session switch cold-p50=\(String(format: "%.2f", coldP50))ms warm-p50=\(String(format: "%.2f", warmP50))ms warm-p95=\(String(format: "%.2f", warmP95))ms warm-hitches=\(warmHitches)/\(warmSamples.count)")

        XCTAssertLessThan(warmP95, 16)
        XCTAssertEqual(warmHitches, 0)
        XCTAssertLessThan(warmP50, coldP50)
        XCTAssertTrue(host.scrollView === stableScrollView)
    }

    func testSessionRebindPublishesOldViewportBeforeInstallingNewCallback() async throws {
        var oldPosition: AppKitChatTimelinePosition?
        var newPosition: AppKitChatTimelinePosition?
        let harness = makeHarness(
            followsLatest: false,
            height: 180,
            onPositionChange: { oldPosition = $0 }
        )
        let oldRows = (0..<30).map { row(id: "old-\($0)", text: "Old \($0)") }
        let newRows = (0..<30).map { row(id: "new-\($0)", text: "New \($0)") }
        harness.coordinator.apply(rows: oldRows)
        harness.tableView.scrollRowToVisible(12)
        await settleMainQueue()

        harness.coordinator.switchSessionIfNeeded(
            to: "new-session",
            initialPosition: .init(
                rowID: "new-8",
                offset: 5,
                absoluteScrollY: 0,
                followsLatest: false
            )
        )
        harness.coordinator.onPositionChange = { newPosition = $0 }
        harness.coordinator.apply(rows: newRows)
        await settleMainQueue()

        XCTAssertTrue(try XCTUnwrap(oldPosition).rowID.hasPrefix("old-"))
        XCTAssertTrue(newPosition.map { $0.rowID.hasPrefix("new-") } ?? true)
        let anchor = visibleAnchor(in: harness.tableView, rows: newRows)
        XCTAssertEqual(anchor.id, "new-8")
        XCTAssertEqual(anchor.offset, 5, accuracy: 4)
    }

    func testFirstWheelAfterReturningToLatestCannotCancelPendingBottomRestore() async {
        let harness = makeHarness(followsLatest: true, height: 180)
        let firstRows = (0..<40).map { row(id: "first-\($0)", text: "First \($0)") }
        let secondRows = (0..<40).map { row(id: "second-\($0)", text: "Second \($0)") }
        harness.coordinator.apply(rows: firstRows)
        harness.coordinator.scrollToBottom()
        await settleMainQueue()
        XCTAssertTrue(isNearBottom(harness))

        harness.coordinator.switchSessionIfNeeded(to: "second", initialPosition: nil)
        harness.coordinator.apply(rows: secondRows)
        await settleMainQueue()

        // Returning while the host has no usable height models the frame
        // between Session rebinding and its first SwiftUI layout pass.
        harness.scrollView.frame.size.height = 0
        harness.coordinator.switchSessionIfNeeded(
            to: "first",
            initialPosition: .init(
                rowID: "first-39",
                offset: 0,
                absoluteScrollY: 0,
                followsLatest: true
            )
        )
        harness.coordinator.apply(rows: firstRows)
        harness.coordinator.userScrollEventWillBegin()
        harness.coordinator.userScrollEventDidEnd()

        harness.scrollView.frame.size.height = 180
        harness.window.layoutIfNeeded()
        harness.scrollView.layoutSubtreeIfNeeded()
        await settleMainQueue()

        XCTAssertTrue(isNearBottom(harness))
        XCTAssertGreaterThan(harness.scrollView.contentView.bounds.minY, 8)
    }

    func testSemanticPositionRestorationSucceedsAcrossOneHundredSwitches() async {
        let harness = makeHarness(followsLatest: false, height: 180)
        let rows = (0..<160).map { row(id: "accuracy-row-\($0)", text: "Message \($0)") }
        harness.coordinator.apply(rows: rows)
        harness.tableView.layoutSubtreeIfNeeded()
        var successes = 0

        for iteration in 0..<100 {
            let targetIndex = 10 + (iteration * 37) % 130
            let targetID = "accuracy-row-\(targetIndex)"
            harness.coordinator.restore(position: .init(
                rowID: targetID,
                offset: 5,
                absoluteScrollY: 0,
                followsLatest: false
            ))
            await settleMainQueue()
            let anchor = visibleAnchor(in: harness.tableView, rows: rows)
            if anchor.id == targetID, abs(anchor.offset - 5) <= 4 {
                successes += 1
            }
        }
        print("[perf] semantic position restoration success=\(successes)/100")
        XCTAssertEqual(successes, 100)
    }

    private func makeHarness(
        followsLatest: Bool,
        height: CGFloat = 320,
        onToggle: @escaping (String) -> Void = { _ in },
        onAction: @escaping (AppKitChatTimelineRow.Action) -> Void = { _ in },
        onNearTop: @escaping () -> Void = {},
        hasMoreHistory: Bool = false,
        onUnderfilledHistory: @escaping () -> Void = {},
        onPositionChange: @escaping (AppKitChatTimelinePosition) -> Void = { _ in }
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
            followsLatest: binding,
            onToggleExpansion: onToggle,
            onAction: onAction,
            onNearTop: onNearTop,
            hasMoreHistory: hasMoreHistory,
            onUnderfilledHistory: onUnderfilledHistory,
            onPositionChange: onPositionChange
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
        nativeStyle: AppKitChatTimelineRow.NativeStyle = .agent,
        expandableTurnId: String? = nil,
        isExpanded: Bool = false,
        showsHeader: Bool = true,
        hoverTimestamp: String = "",
        actions: [AppKitChatTimelineRow.Action] = []
    ) -> AppKitChatTimelineRow {
        AppKitChatTimelineRow(
            id: id,
            contentRevision: revision,
            nativeText: text,
            copyText: copyText ?? text,
            nativeStyle: nativeStyle,
            title: "Agent",
            metadata: "10:20",
            expandableTurnId: expandableTurnId,
            isExpanded: isExpanded,
            showsHeader: showsHeader,
            hoverTimestamp: hoverTimestamp,
            actions: actions
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

    private func textView(in view: NSView, identifier: String) -> NativeTimelineTextView? {
        if let textView = view as? NativeTimelineTextView,
           textView.identifier?.rawValue == identifier { return textView }
        return view.subviews.lazy.compactMap { self.textView(in: $0, identifier: identifier) }.first
    }

    private func view(in view: NSView, identifier: String) -> NSView? {
        if view.identifier?.rawValue == identifier { return view }
        return view.subviews.lazy.compactMap { self.view(in: $0, identifier: identifier) }.first
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

    private func hasVisiblePixels(in view: NSView) -> Bool {
        guard !view.bounds.isEmpty,
              let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return false }
        view.cacheDisplay(in: view.bounds, to: bitmap)
        for y in 0..<bitmap.pixelsHigh {
            for x in 0..<bitmap.pixelsWide where (bitmap.colorAt(x: x, y: y)?.alphaComponent ?? 0) > 0.05 {
                return true
            }
        }
        return false
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
