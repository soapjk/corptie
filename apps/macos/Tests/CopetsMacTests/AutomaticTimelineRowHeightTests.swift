import AppKit
import CorptieClientCore
import CorptieConversation
import SwiftUI
import XCTest
@testable import CorptieMac

/// Isolated migration gate. This does not enable automatic heights in the app.
@MainActor
final class AutomaticTimelineRowHeightTests: XCTestCase {
    func testSDKMixedHistoryJumpAndPrependAtOneAndFiveThousandRows() async throws {
        _ = NSApplication.shared
        let plan = try JSONDecoder().decode(ConversationExecutionPlan.self, from: Data(#"{"schemaVersion":1,"planId":"history","revision":1,"lifecycle":"active","steps":[],"updatedAt":"2026-11-05"}"#.utf8))
        let text = [1, 3, 8].map { count in
            NativeMarkdownTextCache.shared.value(text: String(repeating:
                "Mixed history **Markdown** with 中文 and long paragraphs that reflow naturally.\n\n", count: count), style: .agent)
        }
        for count in [1_000, 5_000] {
            let rows = (0..<count).map { index in
                SDKProbeMessageRow(kind: index.isMultiple(of: 7) ? .process : index.isMultiple(of: 5) ? .plan : .message,
                    text: text[index % text.count], plan: plan, stableID: "history-\(index)")
            }
            let harness = SDKRowHeightHarness(rows: rows, skin: .classic)
            defer { harness.window.contentView = nil }
            await harness.settle()
            let target = count - 7
            await harness.jump(to: target)
            let visible = harness.table.rows(in: harness.scroll.contentView.bounds)
            XCTAssertTrue(NSLocationInRange(target, visible), "A large SDK jump must realize the destination, count=\(count)")
            XCTAssertLessThan(harness.createdCells, 150, "Do not instantiate the whole history")
            let before = try XCTUnwrap(harness.reading())
            let inserted = (0..<30).map { index in
                SDKProbeMessageRow(kind: .message, text: text[index % text.count], plan: plan,
                    stableID: "prepended-\(index)")
            }
            await harness.prepend(inserted, preserving: before)
            let after = try XCTUnwrap(harness.reading())
            XCTAssertEqual(after.id, before.id)
            XCTAssertEqual(after.offset, before.offset, accuracy: 3)
            print("SDK_HISTORY rows=\(count) cells=\(harness.createdCells) before=\(before) after=\(after)")
            let last = harness.rows.count - 1
            await harness.jump(to: last)
            var tail = harness.rows[last]
            tail.kind = .message
            for revision in 1...5 {
                tail.text = NativeMarkdownTextCache.shared.value(text: String(repeating:
                    "Streaming revision \(revision), 中文 and a wrapping paragraph.\n", count: revision * 4), style: .agent)
                await harness.replaceRow(at: last, with: tail, followsLatest: true)
                XCTAssertEqual(harness.bottomGap, 0, accuracy: 3, "Streaming must retain the displayed tail")
            }
            tail.kind = .process
            tail.expanded = true
            await harness.replaceRow(at: last, with: tail, followsLatest: true)
            let expanded = harness.table.rect(ofRow: last).height
            tail.expanded = false
            await harness.replaceRow(at: last, with: tail, followsLatest: true)
            XCTAssertLessThan(harness.table.rect(ofRow: last).height, expanded)
            XCTAssertEqual(harness.bottomGap, 0, accuracy: 3, "Collapse must not leave a blank lower viewport")
            tail.kind = .images
            tail.text = text[0]
            tail.imageSize = .init(width: 220, height: 80)
            await harness.replaceRow(at: last, with: tail, followsLatest: true)
            let placeholder = harness.table.rect(ofRow: last).height
            tail.imageSize = .init(width: 220, height: 180)
            await harness.replaceRow(at: last, with: tail, followsLatest: true)
            XCTAssertGreaterThan(harness.table.rect(ofRow: last).height, placeholder)
            XCTAssertEqual(harness.bottomGap, 0, accuracy: 3, "Late image geometry must retain the tail")
            XCTAssertLessThan(harness.createdCells, 150)
        }
    }

    func testUserLimitImagesTablesChartsAndQuestionsHaveSDKVerticalChains() async throws {
        _ = NSApplication.shared
        let plan = try JSONDecoder().decode(ConversationExecutionPlan.self, from: Data(#"{"schemaVersion":1,"planId":"empty","revision":1,"lifecycle":"active","steps":[],"updatedAt":"2026-11-05"}"#.utf8))
        let question = try JSONDecoder().decode(ConversationUserInput.self, from: Data(#"{"schemaVersion":1,"isBlocking":true,"questions":[{"id":"route","header":"Route","question":"Choose the route and preserve this independent question card when the window gets narrower","isOther":false,"isSecret":false,"selectionMode":"single","options":[{"label":"A","description":"Fast route"},{"label":"B","description":"Safe route"}]}]}"#.utf8))
        let table = try XCTUnwrap(ConversationMarkdownTables.parse("| Name | Details |\n| --- | --- |\n| A | A long detail that should wrap to the current message width |\n| B | 中文 and mixed text |\n").compactMap { block -> ConversationMarkdownTable? in
            if case .table(let table) = block.content { return table }; return nil
        }.first)
        let chart = try XCTUnwrap(ConversationChartBlocks.parse("```corptie-chart\n{\"version\":1,\"type\":\"bar\",\"title\":\"Comparison\",\"data\":[{\"label\":\"A\",\"value\":2},{\"label\":\"B\",\"value\":3}]}\n```").compactMap { block -> ConversationChartSpec? in
            if case .chart(let spec, _) = block { return spec }; return nil
        }.first)
        for skin in ConversationSkin.allCases {
            let typography = skin.typography(for: .assistant)
            let text = NativeMarkdownTextCache.shared.value(text: String(repeating: "Long user message 中文 with wrapping content.\n", count: 80), style: .user, typography: typography)
            let details = NativeMarkdownTextCache.shared.value(text: "事件类型：创建\n创建时间：2026-11-05\n执行计划：每天\n过期时间：未设置", style: .agent)
            let route = NativeCollaborationRoutePresentation(destinationKind: .existingSession,
                routeLabel: "会话协作", sourceLabel: "来源", sourceSession: "Source", sourceWork: "Work",
                targetLabel: "目标", targetName: "Target", targetWork: "Work")
            let kinds: [SDKProbeMessageRow.Kind] = [.user, .images,
                .table(table, .measured(table, width: 620, typography: typography)), .chart(chart), .question(question),
                .scheduled(details), .collaboration(route)]
            for (index, kind) in kinds.enumerated() {
                let harness = SDKRowHeightHarness(rows: [.init(kind: kind, text: text, plan: plan)], skin: skin)
                defer { harness.window.contentView = nil }
                await harness.settle()
                let wide = harness.table.rect(ofRow: 0).height
                XCTAssertGreaterThan(wide, 20, "kind=\(index), skin=\(skin)")
                harness.resize(width: 340)
                await harness.settle()
                let narrow = harness.table.rect(ofRow: 0).height
                XCTAssertTrue(narrow.isFinite && narrow > 20)
                if index < 2 { XCTAssertEqual(narrow, 368, accuracy: 1, "The actual user card retains its 360pt cap plus row insets") }
                print("SDK_ROW_KIND skin=\(skin) kind=\(index) wide=\(wide) narrow=\(narrow)")
            }
        }
    }

    func testSDKOwnsNaturalHeightsOfRealMessageProcessAndPlanComponents() async throws {
        _ = NSApplication.shared
        let planData = Data(#"{"schemaVersion":1,"planId":"sdk-plan","revision":1,"lifecycle":"active","steps":[{"stepId":"one","ordinal":0,"text":"Inspect the complete source and preserve the current selection and anchors","status":"completed"},{"stepId":"two","ordinal":1,"text":"Verify a complex checklist can wrap naturally within a narrow window","status":"inProgress"}],"updatedAt":"2026-11-05T00:00:00Z"}"#.utf8)
        let plan = try JSONDecoder().decode(ConversationExecutionPlan.self, from: planData)
        for skin in ConversationSkin.allCases {
            let typography = skin.typography(for: .assistant)
            let short = NativeMarkdownTextCache.shared.value(text: "A **short** reply", style: .agent, typography: typography)
            let long = NativeMarkdownTextCache.shared.value(text: String(repeating:
                "A **long** paragraph with 中文, a [link](https://example.com), and naturally wrapping content.\n\n", count: 8),
                style: .agent, typography: typography)
            let harness = SDKRowHeightHarness(rows: [
                .init(kind: .message, text: short, plan: plan),
                .init(kind: .message, text: long, plan: plan),
                .init(kind: .process, text: long, plan: plan),
                .init(kind: .plan, text: short, plan: plan)
            ], skin: skin)
            defer { harness.window.contentView = nil }
            await harness.settle()
            let initial = (0..<4).map { harness.table.rect(ofRow: $0).height }
            XCTAssertTrue(initial.allSatisfy { $0.isFinite && $0 > 20 })
            XCTAssertGreaterThan(initial[1], initial[0] + 100, "SDK height must reflect actual complex content")
            XCTAssertGreaterThan(initial[2], initial[1], "Expanded process chrome participates in the vertical chain")
            XCTAssertGreaterThan(initial[3], 50)
            let cell = try XCTUnwrap(harness.table.view(atColumn: 0, row: 1, makeIfNecessary: true))
            let text = try XCTUnwrap(findText(in: cell))
            text.setSelectedRange(.init(location: 2, length: 5))
            var linkRange: NSRange?
            text.textStorage?.enumerateAttribute(.link, in: NSRange(location: 0, length: text.string.utf16.count)) { value, range, stop in
                if value != nil { linkRange = range; stop.pointee = true }
            }
            XCTAssertNotNil(linkRange, "The native storage retains actual Markdown link attributes")
            harness.resize(width: 340)
            await harness.settle()
            XCTAssertGreaterThan(harness.table.rect(ofRow: 1).height, initial[1])
            let current = try XCTUnwrap(harness.table.view(atColumn: 0, row: 1, makeIfNecessary: true))
            XCTAssertTrue(findText(in: current) === text)
            XCTAssertEqual(text.selectedRange(), NSRange(location: 2, length: 5))
            print("SDK_ROW_HEIGHT skin=\(skin) initial=\(initial) narrow=\((0..<4).map { harness.table.rect(ofRow: $0).height })")
        }
    }

    private func findText(in view: NSView) -> NativeTimelineTextView? {
        if let text = view as? NativeTimelineTextView { return text }
        return view.subviews.lazy.compactMap { self.findText(in: $0) }.first
    }
}

@MainActor
private struct SDKProbeMessageRow: View {
    enum Kind {
        case message, process, plan, user, images
        case table(ConversationMarkdownTable, ConversationMarkdownTableLayout)
        case chart(ConversationChartSpec)
        case question(ConversationUserInput)
        case scheduled(NSAttributedString)
        case collaboration(NativeCollaborationRoutePresentation)
    }
    var kind: Kind
    var text: NSAttributedString
    let plan: ConversationExecutionPlan
    var stableID = "sdk-row"
    var expanded = true
    var imageSize = CGSize(width: 220, height: 160)
    var body: some View {
        Group {
            switch kind {
            case .scheduled(let details):
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text("计划任务标题").font(.system(size: 13, weight: .bold)).lineLimit(1)
                        Spacer(minLength: 0)
                        Text("创建").font(.system(size: 10, weight: .semibold))
                    }
                    MeasuredMessageText(text: details)
                    Text("触发消息").font(.system(size: 11, weight: .bold))
                    MeasuredMessageText(text: text, maximumLines: 3)
                    Button("展开消息") {}.buttonStyle(.plain).font(.system(size: 11, weight: .semibold))
                }
                .padding(10)
                .frame(maxWidth: 480, alignment: .leading)
                .modifier(ConversationContentSurface(cornerRadius: 14,
                    tint: Color(nsColor: MessageTextCardPalette.agentNativeBackground),
                    fallback: Color(nsColor: MessageTextCardPalette.agentNativeBackground), isMessage: true, role: .interaction))
            case .collaboration(let route):
                VStack(alignment: .leading, spacing: 8) {
                    Label("会话协作通知", systemImage: "arrow.triangle.branch").font(.system(size: 13, weight: .bold))
                    SDKProbeCollaborationSummary(route: route)
                    MeasuredMessageText(text: text)
                }
                .padding(10)
                .frame(maxWidth: 480, alignment: .leading)
                .modifier(ConversationContentSurface(cornerRadius: 14,
                    tint: Color(nsColor: MessageTextCardPalette.collaborationNativeBackground),
                    fallback: Color(nsColor: MessageTextCardPalette.collaborationNativeBackground), isMessage: true, role: .interaction))
            case .user, .images:
                MessageTextCard(messageID: stableID, role: .user, timestamp: "", showsActions: false,
                    actionsAlwaysVisible: false, rendersStatusGlow: false, copy: {}) {
                    VStack(alignment: .leading, spacing: 8) {
                        if case .images = kind {
                            MessageImageThumbnail(state: .loaded(Image(systemName: "photo")), index: 0,
                                size: imageSize, fits: true)
                        }
                        MeasuredMessageText(text: text)
                    }
                }
            case .table(let table, let layout):
                ConversationMarkdownTableView(table: table, layout: layout)
            case .chart(let chart):
                ConversationChartView(spec: chart)
            case .question(let request):
                ConversationInlineUserInput(request: request, status: "pending") { _, _ in }
                    .padding(14)
            case .message:
                MessageTextCard(messageID: stableID, role: .agent, timestamp: "", showsActions: false,
                    actionsAlwaysVisible: false, copy: {}) {
                    MeasuredMessageText(text: text)
                }
            case .process:
                ProcessCard(summary: "Working · 12 steps", symbol: "gear", tint: .blue,
                    expanded: expanded, toggle: {}) {
                    VStack(alignment: .leading, spacing: 8) {
                        ExecutionPlanChecklist(plan: plan)
                        MeasuredMessageText(text: text)
                    }
                }
            case .plan:
                ExecutionPlanChecklist(plan: plan).padding(14)
                    .modifier(ConversationSkinSurface(role: .plan, radius: 14,
                        legacyFill: Color.secondary.opacity(0.06), legacyBorder: Color.secondary.opacity(0.2)))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
        .padding(.vertical, 4)
    }
}

@MainActor
private struct SDKProbeCollaborationSummary: NSViewRepresentable {
    let route: NativeCollaborationRoutePresentation
    func makeNSView(context: Context) -> NativeCollaborationRouteSummaryView { NativeCollaborationRouteSummaryView() }
    func updateNSView(_ view: NativeCollaborationRouteSummaryView, context: Context) { view.configure(route) }
    func sizeThatFits(_ proposal: ProposedViewSize, nsView: NativeCollaborationRouteSummaryView, context: Context) -> CGSize? {
        .init(width: proposal.width ?? 480, height: NativeCollaborationRouteSummaryView.height)
    }
}

@MainActor
private final class SDKRowHeightHarness: NSObject, NSTableViewDataSource, NSTableViewDelegate {
    let table = NSTableView()
    let scroll = NSScrollView()
    let window: NSWindow
    var rows: [SDKProbeMessageRow]
    let skin: ConversationSkin
    private(set) var createdCells = 0
    init(rows: [SDKProbeMessageRow], skin: ConversationSkin) {
        self.rows = rows; self.skin = skin
        window = NSWindow(contentRect: .init(x: 0, y: 0, width: 620, height: 700),
            styleMask: [.borderless], backing: .buffered, defer: false)
        super.init()
        window.isReleasedWhenClosed = false
        let column = NSTableColumn(identifier: .init("sdk"))
        column.width = 620; column.minWidth = 100
        table.addTableColumn(column)
        table.headerView = nil
        table.usesAutomaticRowHeights = true
        table.rowHeight = 100
        table.intercellSpacing = .zero
        table.columnAutoresizingStyle = .uniformColumnAutoresizingStyle
        table.dataSource = self; table.delegate = self
        table.frame = .init(x: 0, y: 0, width: 620, height: 700)
        scroll.documentView = table
        scroll.autoresizingMask = [.width, .height]
        scroll.hasVerticalScroller = true
        scroll.scrollerStyle = .overlay
        window.contentView = scroll
        table.reloadData()
    }
    func numberOfRows(in tableView: NSTableView) -> Int { rows.count }
    func tableView(_ tableView: NSTableView, heightOfRow row: Int) -> CGFloat { -1 }
    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        createdCells += 1
        return SDKProbeHostingCell(row: rows[row], skin: skin, width: table.tableColumns[0].width)
    }
    struct Reading { let id: String; let offset: CGFloat }
    var bottomGap: CGFloat {
        guard !rows.isEmpty else { return 0 }
        return table.rect(ofRow: rows.count - 1).maxY - scroll.contentView.bounds.maxY
    }
    func replaceRow(at index: Int, with row: SDKProbeMessageRow, followsLatest: Bool) async {
        let reader = followsLatest ? nil : reading()
        rows[index] = row
        if let cell = table.view(atColumn: 0, row: index, makeIfNecessary: false) as? SDKProbeHostingCell {
            cell.setRow(row)
        }
        table.noteHeightOfRows(withIndexesChanged: IndexSet(integer: index))
        await settle()
        if followsLatest {
            await jump(to: rows.count - 1)
            let y = max(0, table.rect(ofRow: rows.count - 1).maxY - scroll.contentView.bounds.height)
            scroll.contentView.scroll(to: .init(x: 0, y: y))
            scroll.reflectScrolledClipView(scroll.contentView)
            await settle()
        } else if let reader, let rowIndex = rows.firstIndex(where: { $0.stableID == reader.id }) {
            await jump(to: rowIndex)
            scroll.contentView.scroll(to: .init(x: 0, y: table.rect(ofRow: rowIndex).minY - reader.offset))
            scroll.reflectScrolledClipView(scroll.contentView)
            await settle()
        }
    }
    func jump(to index: Int) async {
        // Prepare only the destination. SDK estimates for newly realized
        // neighbours may still settle during the first layout transaction.
        _ = table.rowView(atRow: index, makeIfNecessary: true)
        table.noteHeightOfRows(withIndexesChanged: IndexSet(integer: index))
        table.scrollRowToVisible(index)
        await settle()
        if !NSLocationInRange(index, table.rows(in: scroll.contentView.bounds)) {
            // At most one correction for this explicit navigation intent.
            table.scrollRowToVisible(index)
            await settle()
        }
    }
    func reading() -> Reading? {
        let y = scroll.contentView.bounds.minY
        let index = table.row(at: .init(x: 1, y: y + 1))
        guard rows.indices.contains(index) else { return nil }
        return .init(id: rows[index].stableID, offset: table.rect(ofRow: index).minY - y)
    }
    func prepend(_ earlier: [SDKProbeMessageRow], preserving reading: Reading) async {
        table.beginUpdates()
        rows.insert(contentsOf: earlier, at: 0)
        table.insertRows(at: IndexSet(integersIn: 0..<earlier.count), withAnimation: [])
        table.endUpdates()
        await settle()
        guard let index = rows.firstIndex(where: { $0.stableID == reading.id }) else { return }
        // Reuse the existing semantic intent, deriving coordinates only from
        // the SDK's current row rect. No parallel exact-height truth is kept.
        table.scrollRowToVisible(index)
        await settle()
        let y = table.rect(ofRow: index).minY - reading.offset
        scroll.contentView.scroll(to: .init(x: 0, y: y))
        scroll.reflectScrolledClipView(scroll.contentView)
        await settle()
    }
    func resize(width: CGFloat) {
        window.setContentSize(.init(width: width, height: 700))
        table.tableColumns[0].width = width
        table.setFrameSize(.init(width: width, height: table.frame.height))
        for index in rows.indices {
            (table.view(atColumn: 0, row: index, makeIfNecessary: false) as? SDKProbeHostingCell)?.updateWidth(width)
        }
        // Invalidate the SDK's estimates; no exact heights are supplied.
        table.noteHeightOfRows(withIndexesChanged: IndexSet(integersIn: rows.indices))
    }
    func settle() async {
        window.layoutIfNeeded(); scroll.layoutSubtreeIfNeeded()
        try? await Task.sleep(for: .milliseconds(80))
        window.layoutIfNeeded(); scroll.layoutSubtreeIfNeeded()
    }
}

@MainActor
private struct SDKProbeRowShell: View {
    let row: SDKProbeMessageRow
    let skin: ConversationSkin
    let width: CGFloat
    var body: some View {
        row.frame(width: width).environment(\.conversationSkin, skin)
    }
}

@MainActor
private final class SDKProbeHostingCell: NSTableCellView {
    private let host: NSHostingView<SDKProbeRowShell>
    init(row: SDKProbeMessageRow, skin: ConversationSkin, width: CGFloat) {
        host = NSHostingView(rootView: SDKProbeRowShell(row: row, skin: skin, width: width))
        super.init(frame: .zero)
        host.sizingOptions = [.intrinsicContentSize]
        host.setContentHuggingPriority(.required, for: .vertical)
        host.setContentCompressionResistancePriority(.required, for: .vertical)
        host.translatesAutoresizingMaskIntoConstraints = false
        addSubview(host)
        NSLayoutConstraint.activate([
            host.leadingAnchor.constraint(equalTo: leadingAnchor),
            host.trailingAnchor.constraint(equalTo: trailingAnchor),
            host.topAnchor.constraint(equalTo: topAnchor),
            host.bottomAnchor.constraint(equalTo: bottomAnchor)
        ])
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    func setRow(_ row: SDKProbeMessageRow) {
        let previous = host.rootView
        host.rootView = .init(row: row, skin: previous.skin, width: previous.width)
        host.needsLayout = true
        host.layoutSubtreeIfNeeded()
        host.invalidateIntrinsicContentSize()
    }
    func updateWidth(_ width: CGFloat) {
        let previous = host.rootView
        guard previous.width != width else { return }
        var row = previous.row
        if case .table(let table, _) = row.kind {
            // Reuse the production table content cache once per width change,
            // never an outer message-height calculation in a View body.
            row.kind = .table(table, .measured(table, width: width,
                typography: previous.skin.typography(for: .assistant)))
        }
        // A width constraint supplies the SDK's fitting proposal. It is not a
        // second height calculation or a content-height feedback callback.
        host.rootView = .init(row: row, skin: previous.skin, width: width)
        host.needsLayout = true
        host.layoutSubtreeIfNeeded()
        host.invalidateIntrinsicContentSize()
        print("SDK_HOST_WIDTH width=\(width) intrinsic=\(host.intrinsicContentSize) fitting=\(host.fittingSize)")
    }
}
