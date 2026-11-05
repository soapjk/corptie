import AppKit
import CorptieClientCore
import CorptieConversation
import XCTest
@testable import CorptieMac

/// Production components in an isolated SDK-owned table. The app's table is
/// deliberately unchanged until the remaining migration gates have passed.
@MainActor
final class SDKProductionCardTests: XCTestCase {
    func testProductionProseIdentityActionsAndSelectionUseSDKHeight() async throws {
        for skin in ConversationSkin.allCases {
            var row = message(String(repeating: "A **paragraph** with 中文 and a [link](https://example.com), followed by a long visible explanation that must wrap differently when the actual message column becomes narrow.\n\n", count: 12))
            row.replyIdentity = .init(roleID: "role", name: "Agent", avatarPath: nil)
            row.showsReplyActions = true
            row.forkItemID = "reply"
            let harness = ProductionSDKHarness(row: row, skin: skin)
            defer { harness.window.contentView = nil }
            await harness.settle()
            let wide = harness.height
            let text = try XCTUnwrap(harness.descendants.compactMap { $0 as? NativeTimelineTextView }.first)
            text.setSelectedRange(.init(location: 2, length: 5))
            XCTAssertNotNil(harness.descendants.compactMap { $0 as? ReplyActionBar }.first)
            XCTAssertTrue(harness.cell.menu?.items.contains { $0.identifier?.rawValue == "chat.timeline.context.fork" } == true)
            await harness.resize(width: 340)
            XCTAssertGreaterThan(harness.height, wide)
            XCTAssertTrue(harness.descendants.contains { $0 === text })
            XCTAssertEqual(text.selectedRange(), NSRange(location: 2, length: 5))
            let content = NativeTimelineLayoutCache.shared.intrinsicContent(for: row, columnWidth: 340, skin: skin)
            XCTAssertEqual(content.rowHeight, 0)
            XCTAssertEqual(content.cardHeight, 0, "No parallel exact card-height truth")
            XCTAssertEqual(content.textHeight, 0)
            XCTAssertGreaterThan(content.attributedText.length, 0)
        }
    }

    func testProductionScheduledTriggerAndProcessExpandNaturally() async throws {
        for skin in ConversationSkin.allCases {
            var row = message("事件类型：创建\n创建时间：2026-11-05\n执行计划：每天\n过期时间：未设置")
            let trigger = String(repeating: "Long trigger message 中文 content that wraps naturally.\n", count: 15)
            row.scheduledTrigger = .init(text: trigger, isExpanded: false, expansionID: "trigger")
            let harness = ProductionSDKHarness(row: row, skin: skin)
            defer { harness.window.contentView = nil }
            await harness.settle()
            let preview = harness.height
            row.scheduledTrigger = .init(text: trigger, isExpanded: true, expansionID: "trigger")
            row.contentRevision += 1
            await harness.replace(row)
            XCTAssertGreaterThan(harness.height, preview + 100)

            let process = AppKitChatTimelineRow(id: "process", contentRevision: 0,
                nativeText: String(repeating: "Execution detail that wraps with the window.\n", count: 12),
                rawStatusText: "Raw diagnostic state", copyText: "detail", nativeStyle: .process,
                title: "Process", metadata: "", expandableTurnId: "turn", isExpanded: true,
                processCount: 3, processStartedAt: Date(), processState: .running, showsHeader: false)
            await harness.replace(process)
            let expanded = harness.height
            let hostUpdates = harness.cell.hostUpdateCount
            for second in 0..<100 { harness.cell.refreshProcessElapsed(now: Date().addingTimeInterval(Double(second))) }
            XCTAssertEqual(harness.cell.hostUpdateCount, hostUpdates)
            var collapsed = process; collapsed.isExpanded = false; collapsed.contentRevision += 1
            await harness.replace(collapsed)
            XCTAssertLessThan(harness.height, expanded)
            XCTAssertGreaterThan(harness.height, 20)
        }
    }

    func testProductionUserCapTableAndPlanHaveFiniteIntrinsicHeights() async throws {
        let plan = try JSONDecoder().decode(ConversationExecutionPlan.self, from: Data(#"{"schemaVersion":1,"planId":"sdk-actual","revision":1,"lifecycle":"active","steps":[{"stepId":"one","ordinal":0,"text":"Verify the production checklist card wraps naturally in a narrow window","status":"completed"}],"updatedAt":"2026-11-05"}"#.utf8))
        for skin in ConversationSkin.allCases {
            let user = message(String(repeating: "Long user message 中文.\n", count: 100), style: .user)
            let harness = ProductionSDKHarness(row: user, skin: skin)
            defer { harness.window.contentView = nil }
            await harness.settle()
            XCTAssertLessThanOrEqual(harness.height, 360 + 2 * skin.typography(for: .user).rowInset + 1)
            XCTAssertGreaterThan(harness.height, 300)
            await harness.replace(message("| Name | Details |\n| --- | --- |\n| A | Long content that uses the available message width and wraps with the window |\n| B | 中文 |"))
            XCTAssertGreaterThan(harness.height, 40)
            await harness.resize(width: 340)
            XCTAssertTrue(harness.height.isFinite && harness.height > 40)
            var planned = message(""); planned.executionPlan = plan
            await harness.replace(planned)
            XCTAssertTrue(harness.height.isFinite && harness.height > 40)
        }
    }

    func testProductionNativeCollaborationCardUsesIntrinsicTextAndRetainsSelection() async throws {
        for skin in ConversationSkin.allCases {
            let text = String(repeating: "A collaboration notification with a long visible explanation of the implementation and its verification, including 中文 and a [link](https://example.com).\n\n", count: 8)
                + "| Name | Details |\n| --- | --- |\n| A | Visible table detail |\n"
            let route = NativeCollaborationRoutePresentation(destinationKind: .existingSession,
                routeLabel: "会话协作", sourceLabel: "来源", sourceSession: "Source", sourceWork: "Work",
                targetLabel: "目标", targetName: "Target", targetWork: "Work")
            let row = AppKitChatTimelineRow(id: "native-collaboration", contentRevision: 0,
                nativeText: text, copyText: text, nativeStyle: .agent, title: "Collaboration", metadata: "12:34",
                isCollaboration: true, collaborationRoute: route, expandableTurnId: nil, isExpanded: false,
                showsCollaborationSentStatus: true)
            let harness = ProductionSDKHarness(row: row, skin: skin, native: true)
            defer { harness.window.contentView = nil }
            await harness.settle()
            let wide = harness.height
            let body = try XCTUnwrap(harness.descendants.compactMap { $0 as? NativeTimelineTextView }.first)
            XCTAssertTrue(body.string.contains("Visible table detail"), "Unsupported rich cards retain their native text fallback")
            body.setSelectedRange(.init(location: 3, length: 7))
            XCTAssertTrue(harness.descendants.contains { $0 is NativeCollaborationRouteSummaryView })
            await harness.resize(width: 340)
            XCTAssertGreaterThan(harness.height, wide)
            XCTAssertTrue(harness.descendants.contains { $0 === body })
            XCTAssertEqual(body.selectedRange(), NSRange(location: 3, length: 7))
        }
    }

    func testProductionImagesChartsAndQuestionUseSDKHeight() async throws {
        let question = try JSONDecoder().decode(ConversationUserInput.self, from: Data(#"{"schemaVersion":1,"isBlocking":true,"questions":[{"id":"route","header":"Route","question":"Choose the route and preserve this question card in a narrow window","isOther":false,"isSecret":false,"selectionMode":"single","options":[{"label":"A","description":"Fast route"},{"label":"B","description":"Safe route"}]}]}"#.utf8))
        for skin in ConversationSkin.allCases {
            var image = message("", style: .user)
            image.images = [.init(managedPath: "sdk-image-placeholder", displayURL: nil, originalPath: nil,
                geometry: .init(pixelWidth: 400, pixelHeight: 250))]
            let harness = ProductionSDKHarness(row: image, skin: skin)
            defer { harness.window.contentView = nil }
            await harness.settle()
            XCTAssertTrue(harness.height.isFinite && harness.height > 50)
            var asked = message(""); asked.userInput = question; asked.userInputStatus = "pending"
            await harness.replace(asked)
            XCTAssertGreaterThan(harness.height, 50)
            let chart = message("```corptie-chart\n{\"version\":1,\"type\":\"bar\",\"title\":\"Comparison\",\"data\":[{\"label\":\"A\",\"value\":2},{\"label\":\"B\",\"value\":3}]}\n```")
            await harness.replace(chart)
            XCTAssertTrue(harness.height.isFinite && harness.height > 100)
            await harness.resize(width: 340)
            XCTAssertTrue(harness.height.isFinite && harness.height > 100)
        }
    }

    func testProductionProcessBlocksReuseOnlyAcrossStableWidthChanges() async throws {
        let plan = try JSONDecoder().decode(ConversationExecutionPlan.self, from: Data(#"{"schemaVersion":1,"planId":"process-plan","revision":1,"lifecycle":"active","steps":[{"stepId":"one","ordinal":0,"text":"Verify actual nested process plan","status":"completed"}],"updatedAt":"2026-11-05"}"#.utf8))
        func process(_ revision: Int) -> AppKitChatTimelineRow {
            .init(id: "actual-blocks", contentRevision: revision, nativeText: "fallback", copyText: "full",
                nativeStyle: .process, title: "", metadata: "", expandableTurnId: "turn", isExpanded: true,
                processCount: 2, processSteps: [
                    .init(id: "plain", kind: .result, state: .completed, title: "Result", detail: "revision-\(revision)"),
                    .init(id: "plan", kind: .action, state: .completed, title: "Plan", detail: nil, plan: plan)
                ], showsHeader: false)
        }
        for skin in ConversationSkin.allCases {
            let first = process(0)
            let content = NativeTimelineLayoutCache.shared.intrinsicContent(for: first, columnWidth: 620, skin: skin)
            let resized = NativeTimelineLayoutCache.shared.intrinsicContent(for: first, columnWidth: 340, skin: skin, reusing: content)
            XCTAssertEqual(resized.processBlocks.count, 2)
            XCTAssertTrue(resized.processBlocks[0].attributedText === content.processBlocks[0].attributedText)
            let harness = ProductionSDKHarness(row: message("Previous ordinary row"), skin: skin)
            defer { harness.window.contentView = nil }
            await harness.settle()
            await harness.replace(first)
            XCTAssertTrue(harness.descendants.compactMap { $0 as? NativeTimelineTextView }.contains { $0.string.contains("revision-0") })
            await harness.replace(process(1))
            XCTAssertTrue(harness.descendants.compactMap { $0 as? NativeTimelineTextView }.contains { $0.string.contains("revision-1") })
            XCTAssertFalse(harness.descendants.compactMap { $0 as? NativeTimelineTextView }.contains { $0.string.contains("revision-0") })
        }
    }

    func testPreparedProseAndRawStatusSurviveWidthChangesButNotNewRevisions() {
        func model(_ revision: Int, text: String, raw: String) -> AppKitChatTimelineRow {
            .init(id: "prepared-content", contentRevision: revision, nativeText: text, rawStatusText: raw,
                copyText: text, nativeStyle: .agent, title: "", metadata: "",
                expandableTurnId: nil, isExpanded: false, showsHeader: false)
        }
        for skin in ConversationSkin.allCases {
            for raw in ["", "raw_status: first"] {
                let row = model(0, text: "Intro **bold** text\n\n| Name | Content |\n| --- | --- |\n| A | A long description that wraps to the available width |", raw: raw)
                let original = NativeTimelineLayoutCache.shared.intrinsicContent(for: row, columnWidth: 620, skin: skin)
                let narrowed = NativeTimelineLayoutCache.shared.intrinsicContent(for: row, columnWidth: 340, skin: skin, reusing: original)
                XCTAssertTrue(narrowed.attributedText === original.attributedText)
                XCTAssertTrue(narrowed.rawStatusText === original.rawStatusText)
                if raw.isEmpty { XCTAssertFalse(original.richBlocks.isEmpty) }
                XCTAssertEqual(narrowed.richBlocks.count, original.richBlocks.count)
                for (old, new) in zip(original.richBlocks, narrowed.richBlocks) {
                    if case let .markdown(_, a, _) = old, case let .markdown(_, b, _) = new {
                        XCTAssertTrue(a === b)
                    }
                }
                let replacement = model(1, text: "Replacement body", raw: "raw_status: second")
                let changed = NativeTimelineLayoutCache.shared.intrinsicContent(for: replacement, columnWidth: 340, skin: skin, reusing: original)
                XCTAssertEqual(changed.attributedText.string, "Replacement body")
                XCTAssertEqual(changed.rawStatusText?.string, "raw_status: second")
                XCTAssertTrue(changed.richBlocks.isEmpty)
            }
        }
    }

    private func message(_ text: String, style: AppKitChatTimelineRow.NativeStyle = .agent) -> AppKitChatTimelineRow {
        .init(id: "actual", contentRevision: 0, nativeText: text, copyText: text,
            nativeStyle: style, title: "Scheduled task", metadata: "12:34", expandableTurnId: nil,
            isExpanded: false, showsHeader: false, contextTimestamp: "12:34")
    }
}

@MainActor
private final class ProductionSDKHarness: NSObject, NSTableViewDataSource, NSTableViewDelegate {
    let table = NSTableView()
    let window = NSWindow(contentRect: .init(x: 0, y: 0, width: 620, height: 700),
        styleMask: [.borderless], backing: .buffered, defer: false)
    let cell = AppKitSharedMessageTextCell(identifier: .init("sdk-actual"))
    private let nativeCell = AppKitChatNativeTextCell(identifier: .init("sdk-native-actual"))
    private let usesNative: Bool
    private var renderedCell: NSTableCellView & AppKitChatRowRendering { usesNative ? nativeCell : cell }
    private var row: AppKitChatTimelineRow
    init(row: AppKitChatTimelineRow, skin: ConversationSkin, native: Bool = false) {
        self.row = row; self.usesNative = native
        super.init()
        _ = NSApplication.shared
        window.isReleasedWhenClosed = false
        let column = NSTableColumn(identifier: .init("sdk-actual")); column.width = 620; column.minWidth = 100
        table.addTableColumn(column)
        table.headerView = nil; table.intercellSpacing = .zero
        table.usesAutomaticRowHeights = true; table.rowHeight = 100
        table.columnAutoresizingStyle = .noColumnAutoresizing
        table.dataSource = self; table.delegate = self
        let scroll = NSScrollView(); scroll.documentView = table
        table.frame = .init(x: 0, y: 0, width: 620, height: 700)
        window.contentView = scroll
        renderedCell.updateAppearance(skin: skin)
        configure()
        table.reloadData()
    }
    func numberOfRows(in tableView: NSTableView) -> Int { 1 }
    func tableView(_ tableView: NSTableView, heightOfRow row: Int) -> CGFloat { -1 }
    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? { renderedCell }
    var height: CGFloat { table.rect(ofRow: 0).height }
    var descendants: [NSView] {
        func collect(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(collect) }
        return collect(renderedCell)
    }
    private func configure() {
        renderedCell.setContent(row, availableWidth: table.tableColumns[0].width, baseDirectory: nil, onToggleExpansion: { _ in }, onAction: { _ in })
    }
    func settle() async {
        window.layoutIfNeeded(); window.contentView?.layoutSubtreeIfNeeded(); table.layoutSubtreeIfNeeded()
        try? await Task.sleep(for: .milliseconds(80))
        table.layoutSubtreeIfNeeded()
    }
    func resize(width: CGFloat) async {
        window.setContentSize(.init(width: width, height: 700))
        table.tableColumns[0].width = width
        table.setFrameSize(.init(width: width, height: table.frame.height))
        _ = renderedCell.updateLayoutIfContentUnchanged(row, availableWidth: width)
        renderedCell.layoutSubtreeIfNeeded()
        table.noteHeightOfRows(withIndexesChanged: [0])
        await settle()
    }
    func replace(_ row: AppKitChatTimelineRow) async {
        self.row = row; configure(); renderedCell.layoutSubtreeIfNeeded()
        table.noteHeightOfRows(withIndexesChanged: [0]); await settle()
    }
}
