import SwiftUI
import CorptieConversation
import CorptieClientCore

/// Production adapter. It deliberately keeps the
/// existing attributed-text cache, measured sizes and custom TextKit view.
struct MacSharedMessageTextCard: View {
    let row: AppKitChatTimelineRow
    let layout: NativeTimelineLayoutCache.Layout
    var baseDirectory: String?
    var copy: () -> Void = {}
    var toggle: () -> Void = {}
    var performAction: (AppKitChatTimelineRow.Action) -> Void = { _ in }

    static func supports(_ row: AppKitChatTimelineRow) -> Bool {
        supportsProcess(row) || (row.nativeStyle != .process && !row.showsHeader && !row.isCollaboration
            && row.collaborationRoute == nil && row.processCount == nil && row.expandableTurnId == nil
            && (row.actions.isEmpty || (row.nativeStyle == .agent
                && row.nativeText.contains("```corptie-chart")))
            && !row.showsCollaborationSentStatus
            && (row.images.isEmpty || (row.nativeStyle == .agent
                && row.nativeText.contains("```corptie-chart")))
            && row.rawStatusText.isEmpty)
    }

    static func supportsProcess(_ row: AppKitChatTimelineRow) -> Bool {
        row.nativeStyle == .process && row.processCount != nil && row.expandableTurnId != nil
            && !row.isCollaboration && row.collaborationRoute == nil
            && row.actions.isEmpty && row.images.isEmpty && !row.showsCollaborationSentStatus
    }

    var body: some View {
        Group {
            if row.nativeStyle == .process { processCard }
            else { messageCard }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity,
            alignment: row.nativeStyle == .user ? .topTrailing : .topLeading)
        .padding(.horizontal, 2)
        .padding(.top, 1)
    }

    private var processCard: some View {
        ProcessCard(summary: row.processPrimarySummary, secondary: row.processCurrentStepTitle,
                    symbol: row.processState.symbolName,
                    tint: Color(nsColor: row.processState.color), expanded: row.isExpanded,
                    progress: row.processPlanProgress, progressLabel: row.processPlanProgressLabel,
                    toggle: toggle) {
            VStack(alignment: .leading, spacing: 8) {
                if layout.processBlocks.isEmpty {
                    MeasuredMessageText(text: layout.attributedText,
                        size: CGSize(width: layout.cardWidth - 20, height: layout.textHeight),
                        baseDirectory: baseDirectory)
                        .frame(width: layout.cardWidth - 20, height: layout.textHeight)
                } else {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(layout.processBlocks.indices, id: \.self) { index in
                            let block = layout.processBlocks[index]
                            MacProcessBlockView(block: block, cardWidth: layout.cardWidth,
                                                baseDirectory: baseDirectory)
                        }
                    }
                    .frame(width: layout.cardWidth - 20, height: layout.textHeight,
                           alignment: .topLeading)
                }
                if layout.rawStatusHeight > 0 {
                    ProcessRawStatusText(text: row.rawStatusText)
                        .frame(width: layout.cardWidth - 20, height: layout.rawStatusHeight)
                }
            }
        }
        .frame(width: layout.cardWidth, height: layout.rowHeight - 2, alignment: .topLeading)
    }

    private var messageCard: some View {
        MessageTextCard(messageID: row.id, role: row.nativeStyle == .user ? .user : .agent,
            timestamp: row.hoverTimestamp, showsActions: row.showsMessageActionBar,
            actionsAlwaysVisible: false, cardWidth: layout.cardWidth,
            cardHeight: layout.rowHeight - (row.showsMessageActionBar ? 28 : 2), copy: copy) {
            VStack(alignment: .leading, spacing: 0) {
                if row.nativeStyle == .user && !row.images.isEmpty {
                    attachmentStrip.padding(.bottom, 8)
                }
                if layout.richBlocks.isEmpty {
                    MeasuredMessageText(text: layout.attributedText,
                        size: CGSize(width: layout.cardWidth - 20, height: layout.textHeight),
                        baseDirectory: baseDirectory)
                        .frame(width: layout.cardWidth - 20, height: layout.textHeight)
                } else {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(layout.richBlocks, id: \.id) { block in
                            switch block {
                            case .markdown(_, let text, let height):
                                MeasuredMessageText(text: text,
                                    size: CGSize(width: layout.cardWidth - 20, height: height),
                                    baseDirectory: baseDirectory)
                                    .frame(width: layout.cardWidth - 20, height: height)
                            case .chart(_, let spec, let height):
                                ConversationChartView(spec: spec)
                                    .frame(width: layout.cardWidth - 20,
                                           height: height)
                            }
                        }
                    }
                    .frame(width: layout.cardWidth - 20, height: layout.textHeight,
                           alignment: .topLeading)
                }
                if row.nativeStyle != .user && !row.images.isEmpty {
                    attachmentStrip.padding(.top, 8)
                }
                if !row.actions.isEmpty {
                    ScrollView(.horizontal) {
                        HStack(spacing: 6) {
                            ForEach(row.actions, id: \.id) { action in
                                Button(action.label) { performAction(action) }
                                    .buttonStyle(.bordered)
                                    .controlSize(.small)
                                    .tint(action.isDestructive ? .red : .accentColor)
                                    .accessibilityIdentifier("chat.timeline.action.\(action.id)")
                            }
                        }
                    }
                    .scrollIndicators(.hidden)
                    .frame(width: layout.cardWidth - 20, height: 30, alignment: .leading)
                    .padding(.top, 4)
                }
            }
        }
    }

    private var attachmentStrip: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 7) {
                ForEach(Array(row.images.prefix(4).enumerated()), id: \.offset) { index, attachment in
                    MacMessageImageThumbnail(attachment: attachment, index: index)
                }
            }
        }
        .scrollIndicators(.hidden)
        .frame(width: layout.cardWidth - 20, height: 88, alignment: .leading)
    }
}

private struct MacMessageImageThumbnail: View {
    let attachment: ChatTimelineImage
    let index: Int
    @State private var loadedImage: NSImage?
    @State private var loadFailed = false

    var body: some View {
        Button(action: openImage) {
            Group {
                if let loadedImage {
                    Image(nsImage: loadedImage)
                        .resizable()
                        .scaledToFill()
                } else {
                    Image(systemName: loadFailed ? "exclamationmark.triangle" : "photo")
                        .resizable()
                        .scaledToFit()
                        .padding(22)
                }
            }
            .frame(width: 88, height: 88)
            .clipped()
            .background(Color(nsColor: .quaternaryLabelColor).opacity(0.12))
            .clipShape(RoundedRectangle(cornerRadius: 9))
        }
        .buttonStyle(.plain)
        .help(attachment.originalPath == nil ? "打开图片" : "在 Finder 中显示原始图片")
        .accessibilityLabel("附加图片 \(index + 1)")
        .task(id: attachment.displayURL) {
            loadedImage = nil
            loadFailed = false
            guard let url = attachment.displayURL else {
                loadFailed = true
                return
            }
            ChatTimelineImageLoader.shared.load(url) { image in
                guard !Task.isCancelled else { return }
                loadedImage = image
                loadFailed = image == nil
            }
        }
    }

    private func openImage() {
        if let originalPath = attachment.originalPath,
           FileManager.default.fileExists(atPath: originalPath) {
            NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: originalPath)])
        } else if attachment.originalPath != nil, let url = attachment.displayURL {
            let alert = NSAlert()
            alert.messageText = "Original image is missing"
            alert.informativeText = "Corptie kept a managed copy for this conversation."
            alert.addButton(withTitle: "View managed copy")
            alert.addButton(withTitle: "Cancel")
            if alert.runModal() == .alertFirstButtonReturn { NSWorkspace.shared.open(url) }
        } else if let url = attachment.displayURL {
            NSWorkspace.shared.open(url)
        }
    }
}

private struct MacProcessBlockView: View {
    let block: NativeTimelineLayoutCache.Layout.ProcessBlock
    let cardWidth: CGFloat
    let baseDirectory: String?
    @State private var showsFull = false

    private var tint: Color {
        switch block.step.state {
        case .running: .accentColor
        case .completed: .green
        case .failed: .red
        case .cancelled, .unknown: .secondary
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let plan = block.step.plan {
                if plan.steps.count > 8 {
                    ScrollView {
                        ExecutionPlanChecklist(plan: plan)
                            .frame(width: cardWidth - 36, alignment: .leading)
                    }
                    .scrollIndicators(.automatic)
                    .frame(width: cardWidth - 36, height: block.textHeight)
                } else {
                    ExecutionPlanChecklist(plan: plan)
                        .frame(width: cardWidth - 36, height: block.textHeight,
                               alignment: .topLeading)
                }
            } else if block.step.tool != nil || block.step.changeSet != nil {
                ExecutionStructuredStepView(presentation: .init(step: block.step))
                    .frame(width: cardWidth - 36, height: block.textHeight,
                           alignment: .topLeading)
            } else {
                MeasuredMessageText(text: block.attributedText,
                    size: CGSize(width: cardWidth - 36, height: block.textHeight),
                    baseDirectory: baseDirectory)
                    .frame(width: cardWidth - 36, height: block.textHeight)
            }
            if block.hasOverflow {
                Button("查看完整内容") { showsFull = true }
                    .font(.system(size: 9.5))
                    .buttonStyle(.plain)
                    .foregroundStyle(.tint)
                    .accessibilityIdentifier("execution-step-full-details")
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 7)
        .background(tint.opacity(0.045), in: RoundedRectangle(cornerRadius: 8))
        .overlay {
            RoundedRectangle(cornerRadius: 8)
                .strokeBorder(tint.opacity(0.16), lineWidth: 1)
        }
        .frame(width: cardWidth - 20, height: block.height)
        .popover(isPresented: $showsFull) {
            ScrollView {
                Text(ExecutionStepDetailPresentation.fullText(block.step))
                    .font(.system(size: 10.5, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
            }
            .frame(width: 420, height: 320)
        }
    }
}

@MainActor
protocol AppKitChatRowRendering: AnyObject {
    func updateCallbacks(onToggleExpansion: @escaping (String) -> Void,
                         onAction: @escaping (AppKitChatTimelineRow.Action) -> Void)
    func updateLinkContext(baseDirectory: String?)
    func setContent(_ row: AppKitChatTimelineRow, availableWidth: CGFloat, baseDirectory: String?,
                    onToggleExpansion: @escaping (String) -> Void,
                    onAction: @escaping (AppKitChatTimelineRow.Action) -> Void)
    func updateLayoutIfContentUnchanged(_ row: AppKitChatTimelineRow, availableWidth: CGFloat) -> Bool
}

/// One hosting tree per reusable native row; no duplicate legacy view tree.
final class AppKitSharedMessageTextCell: NSTableCellView, AppKitChatRowRendering {
    private var host: NSHostingView<MacSharedMessageTextCard>?
    private var row: AppKitChatTimelineRow?
    private var measuredLayout: NativeTimelineLayoutCache.Layout?
    private var baseDirectory: String?
    private var measuredWidth: CGFloat?
    private var onToggleExpansion: (String) -> Void = { _ in }
    private var onAction: (AppKitChatTimelineRow.Action) -> Void = { _ in }
    private(set) var contentConfigurationCount = 0
    private(set) var widthLayoutUpdateCount = 0

    init(identifier: NSUserInterfaceItemIdentifier) {
        super.init(frame: .zero)
        self.identifier = identifier
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func updateCallbacks(onToggleExpansion: @escaping (String) -> Void,
                         onAction: @escaping (AppKitChatTimelineRow.Action) -> Void) {
        self.onToggleExpansion = onToggleExpansion
        self.onAction = onAction
    }

    func updateLinkContext(baseDirectory: String?) {
        guard self.baseDirectory != baseDirectory else { return }
        self.baseDirectory = baseDirectory
        updateHost()
    }

    func setContent(_ row: AppKitChatTimelineRow, availableWidth: CGFloat, baseDirectory: String? = nil,
                    onToggleExpansion: @escaping (String) -> Void,
                    onAction: @escaping (AppKitChatTimelineRow.Action) -> Void = { _ in }) {
        precondition(MacSharedMessageTextCard.supports(row))
        self.row = row; self.baseDirectory = baseDirectory
        self.onToggleExpansion = onToggleExpansion
        self.onAction = onAction
        measuredLayout = NativeTimelineLayoutCache.shared.layout(for: row, columnWidth: availableWidth)
        measuredWidth = availableWidth
        contentConfigurationCount += 1
        updateHost()
    }

    @discardableResult
    func updateLayoutIfContentUnchanged(_ row: AppKitChatTimelineRow, availableWidth: CGFloat) -> Bool {
        guard self.row?.id == row.id, self.row?.contentRevision == row.contentRevision else { return false }
        guard measuredWidth != availableWidth else { return true }
        measuredWidth = availableWidth
        measuredLayout = NativeTimelineLayoutCache.shared.layout(for: row, columnWidth: availableWidth)
        widthLayoutUpdateCount += 1
        ChatPerformanceRecorder.shared.increment(.appKitRowWidthUpdates)
        updateHost()
        return true
    }

    private func updateHost() {
        guard let row, let measuredLayout else { return }
        let root = MacSharedMessageTextCard(row: row, layout: measuredLayout, baseDirectory: baseDirectory,
            copy: { [weak self] in self?.copyRepresentedMessage() },
            toggle: { [weak self] in self?.toggleRepresentedProcess() },
            performAction: { [weak self] action in self?.onAction(action) })
        if let host { host.rootView = root }
        else {
            let host = NSHostingView(rootView: root)
            host.sizingOptions = [] // The cached native row height owns sizing.
            host.frame = bounds
            host.autoresizingMask = [.width, .height]
            addSubview(host)
            self.host = host
        }
        needsLayout = true
    }

    override func layout() {
        if host?.frame != bounds { host?.frame = bounds }
        super.layout()
    }

    func copyRepresentedMessage() {
        guard let text = row?.copyText else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    func toggleRepresentedProcess() {
        guard let turnID = row?.expandableTurnId else { return }
        onToggleExpansion(turnID)
    }
}

private struct ProcessRawStatusText: NSViewRepresentable {
    let text: String
    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.scrollerStyle = .overlay
        scroll.backgroundColor = .black.withAlphaComponent(0.035)
        scroll.wantsLayer = true
        scroll.layer?.cornerRadius = 6
        let view = NSTextView()
        view.identifier = .init("chat.timeline.raw-status")
        view.isEditable = false; view.isSelectable = true; view.isRichText = false
        view.drawsBackground = false
        view.font = .monospacedSystemFont(ofSize: 9.5, weight: .regular)
        view.textColor = NSColor(calibratedRed: 0.38, green: 0.41, blue: 0.43, alpha: 1)
        view.textContainerInset = NSSize(width: 4, height: 4)
        view.isHorizontallyResizable = false; view.isVerticallyResizable = true
        view.autoresizingMask = [.width]
        view.textContainer?.widthTracksTextView = true
        view.textContainer?.containerSize = NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude)
        scroll.documentView = view
        return scroll
    }
    func updateNSView(_ view: NSScrollView, context: Context) {
        guard let document = view.documentView as? NSTextView else { return }
        if document.string != text { document.string = text }
    }
}

private struct MeasuredMessageText: NSViewRepresentable {
    let text: NSAttributedString
    let size: CGSize
    let baseDirectory: String?
    final class Coordinator { var text: NSAttributedString? }
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeNSView(context: Context) -> NativeTimelineTextView { NativeTimelineTextView() }
    func updateNSView(_ view: NativeTimelineTextView, context: Context) {
        view.linkBaseDirectory = baseDirectory
        if context.coordinator.text !== text {
            view.textStorage?.setAttributedString(text)
            context.coordinator.text = text
        }
    }
    func sizeThatFits(_ proposal: ProposedViewSize, nsView: NativeTimelineTextView, context: Context) -> CGSize? { size }
}
