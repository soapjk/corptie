import SwiftUI
import CorptieConversation
import CorptieClientCore

/// Production adapter. It deliberately keeps the
/// existing attributed-text cache, measured sizes and custom TextKit view.
struct MacSharedMessageTextCard: View {
    let row: AppKitChatTimelineRow
    let layout: NativeTimelineLayoutCache.Layout
    var processSummaryOverride: ProcessCardSummary? = nil
    var baseDirectory: String?
    var copy: () -> Void = {}
    var toggle: () -> Void = {}
    var performAction: (AppKitChatTimelineRow.Action) -> Void = { _ in }
    var selectText: () -> Void = {}
    var contextMenu: NSMenu? = nil

    var presentedMessageStatus: UserMessageStatusPresentation? {
        row.nativeStyle == .user ? row.messageStatus : nil
    }

    static func supports(_ row: AppKitChatTimelineRow) -> Bool {
        row.userInput != nil || row.executionPlan != nil || supportsProcess(row) || (row.nativeStyle != .process && !row.showsHeader && !row.isCollaboration
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
        VStack(spacing: 0) {
            if let timeSeparatorText = row.timeSeparatorText {
                Text(timeSeparatorText)
                    .font(.system(size: 10.5, weight: .medium))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 28, maxHeight: 28)
                    .accessibilityLabel(L10nFormat("Time: %@", timeSeparatorText))
                    .accessibilityIdentifier("chat.timeline.time-separator")
            }
            Group {
                if let input = row.userInput { userInputCard(input) }
                else if let plan = row.executionPlan { executionPlanCard(plan) }
                else if row.nativeStyle == .process { processCard }
                else { messageCard }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity,
                alignment: row.nativeStyle == .user ? .topTrailing : .topLeading)
            .padding(.horizontal, 2)
            .padding(.top, 1)
        }
    }

    private func userInputCard(_ request: ConversationUserInput) -> some View {
        ConversationInlineUserInput(request: request, status: row.userInputStatus) { answers, action in
            guard let sessionID = row.sessionID else {
                throw BackendError.message("会话不可用，无法提交答案。")
            }
            guard let itemID = row.userInputItemID else {
                throw BackendError.message("问题标识不可用，无法提交答案。")
            }
            try await BackendClient.shared.respondToUserInput(
                sessionID: sessionID, itemID: itemID, answers: answers, action: action)
        }
        .accessibilityActions {
            Button(L10n("Copy Message"), action: copy)
        }
        .padding(14)
        .frame(width: layout.cardWidth, alignment: .topLeading)
        .background(Color.orange.opacity(row.userInputStatus == "pending" ? 0.06 : 0.025),
                    in: RoundedRectangle(cornerRadius: 14))
        .overlay {
            RoundedRectangle(cornerRadius: 14)
                .strokeBorder(Color.orange.opacity(row.userInputStatus == "pending" ? 0.38 : 0.16), lineWidth: 1)
        }
    }

    private func executionPlanCard(_ plan: ConversationExecutionPlan) -> some View {
        ExecutionPlanChecklist(plan: plan)
            .accessibilityActions {
                Button(L10n("Copy Message"), action: copy)
            }
            .padding(14)
            .frame(width: layout.cardWidth, alignment: .topLeading)
            .background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 14))
            .overlay {
                RoundedRectangle(cornerRadius: 14)
                    .strokeBorder(Color.secondary.opacity(0.2), lineWidth: 1)
            }
    }

    private var processCard: some View {
        ProcessCard(summary: row.processPrimarySummary, summaryOverride: processSummaryOverride, secondary: row.processCurrentStepTitle,
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
        MessageTextCard(messageID: row.id, role: row.nativeStyle == .user ? .user : (row.isCommentary ? .commentary : .agent),
            timestamp: "", showsActions: false,
            actionsAlwaysVisible: false, cardWidth: layout.cardWidth,
            cardHeight: layout.rowHeight - row.timeSeparatorHeight - (row.showsMessageStatusBar ? 28 : 2),
            status: presentedMessageStatus, copy: copy) {
            VStack(alignment: .leading, spacing: 0) {
                if row.nativeStyle == .user && !row.images.isEmpty {
                    attachmentStrip.padding(.bottom, 8)
                }
                if layout.richBlocks.isEmpty {
                    MeasuredMessageText(text: layout.attributedText,
                        size: CGSize(width: layout.cardWidth - 20, height: layout.textHeight),
                        baseDirectory: baseDirectory, contextMenu: contextMenu)
                        .frame(width: layout.cardWidth - 20, height: layout.textHeight)
                } else {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(layout.richBlocks, id: \.id) { block in
                            switch block {
                            case .markdown(_, let text, let height):
                                MeasuredMessageText(text: text,
                                    size: CGSize(width: layout.cardWidth - 20, height: height),
                                    baseDirectory: baseDirectory, contextMenu: contextMenu)
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
        .accessibilityActions {
            if !row.copyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Button(L10n("Copy Message"), action: copy)
            }
            if let itemID = row.forkItemID {
                Button(L10n("Create Branch")) {
                    performAction(.init(id: "fork:\(itemID)", label: L10n("Create Branch"),
                                        isDestructive: false, kind: .forkMessage(itemID: itemID)))
                }
            }
            Button(L10n("Select Text"), action: selectText)
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
                if block.textHeight >= 300 {
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
    func refreshProcessElapsed(now: Date)
}

/// One hosting tree per reusable native row; no duplicate legacy view tree.
final class AppKitSharedMessageTextCell: NSTableCellView, AppKitChatRowRendering {
    private var host: NSHostingView<MacSharedMessageTextCard>?
    private var row: AppKitChatTimelineRow?
    private var measuredLayout: NativeTimelineLayoutCache.Layout?
    private var baseDirectory: String?
    private var measuredWidth: CGFloat?
    private let elapsedSummary = ProcessCardSummary()
    var displayedProcessSummary: String? { elapsedSummary.text }
    private var onToggleExpansion: (String) -> Void = { _ in }
    private var onAction: (AppKitChatTimelineRow.Action) -> Void = { _ in }
    private(set) var contentConfigurationCount = 0
    private(set) var widthLayoutUpdateCount = 0
    private(set) var hostUpdateCount = 0

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
        elapsedSummary.text = nil
        self.onToggleExpansion = onToggleExpansion
        self.onAction = onAction
        measuredLayout = NativeTimelineLayoutCache.shared.layout(for: row, columnWidth: availableWidth)
        measuredWidth = availableWidth
        contentConfigurationCount += 1
        configureContextMenu(for: row)
        updateHost(resetTextSelection: true)
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

    private func updateHost(needsLayout: Bool = true, resetTextSelection: Bool = false) {
        guard let row, let measuredLayout else { return }
        hostUpdateCount += 1
        let root = MacSharedMessageTextCard(row: row, layout: measuredLayout,
            processSummaryOverride: elapsedSummary, baseDirectory: baseDirectory,
            copy: { [weak self] in self?.copyRepresentedMessage() },
            toggle: { [weak self] in self?.toggleRepresentedProcess() },
            performAction: { [weak self] action in self?.onAction(action) },
            selectText: { [weak self] in self?.beginTextSelection() }, contextMenu: menu)
        if let host { host.rootView = root }
        else {
            let host = NSHostingView(rootView: root)
            host.sizingOptions = [] // The cached native row height owns sizing.
            host.frame = bounds
            host.autoresizingMask = [.width, .height]
            addSubview(host)
            self.host = host
        }
        self.host?.menu = menu
        configureHostedTextViews(resetTextSelection: resetTextSelection)
        DispatchQueue.main.async { [weak self] in
            self?.configureHostedTextViews(resetTextSelection: resetTextSelection)
        }
        if needsLayout { self.needsLayout = true }
    }

    func refreshProcessElapsed(now: Date) {
        guard let row, row.nativeStyle == .process, row.processState == .running,
              row.processStartedAt != nil else { return }
        let summary = row.processSummaryText(now: now, advancing: true, includesCurrentStep: false)
        guard elapsedSummary.text != summary else { return }
        elapsedSummary.text = summary
    }

    override func layout() {
        if host?.frame != bounds { host?.frame = bounds }
        super.layout()
    }

    @objc func copyRepresentedMessage() {
        guard let text = row?.copyText else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    @objc private func forkRepresentedMessage() {
        guard let itemID = row?.forkItemID else { return }
        onAction(.init(id: "fork:\(itemID)", label: L10n("Create Branch"),
                       isDestructive: false, kind: .forkMessage(itemID: itemID)))
    }

    @objc private func beginTextSelection() {
        guard row?.nativeStyle != .process else { return }
        guard let host else { return }
        func firstTextView(in view: NSView) -> NativeTimelineTextView? {
            if let textView = view as? NativeTimelineTextView { return textView }
            return view.subviews.lazy.compactMap(firstTextView).first
        }
        firstTextView(in: host)?.beginTextSelection()
    }

    private func configureHostedTextViews(resetTextSelection: Bool = false) {
        guard let host else { return }
        func textViews(in view: NSView) -> [NativeTimelineTextView] {
            (view as? NativeTimelineTextView).map { [$0] }
                ?? view.subviews.flatMap(textViews)
        }
        for textView in textViews(in: host) {
            textView.cardContextMenu = menu
            if resetTextSelection { textView.endTextSelection() }
        }
    }

    private func configureContextMenu(for row: AppKitChatTimelineRow) {
        guard row.nativeStyle != .process else {
            menu = nil
            setAccessibilityCustomActions([])
            return
        }
        let menu = NSMenu()
        if !row.contextTimestamp.isEmpty {
            let timestamp = NSMenuItem(title: L10nFormat("Time: %@", row.contextTimestamp), action: nil, keyEquivalent: "")
            timestamp.image = NSImage(systemSymbolName: "clock", accessibilityDescription: nil)
            timestamp.isEnabled = false
            timestamp.identifier = NSUserInterfaceItemIdentifier("chat.timeline.context.timestamp")
            menu.addItem(timestamp)
        }
        let hasCopy = !row.copyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        if !menu.items.isEmpty { menu.addItem(.separator()) }
        if hasCopy {
            let copy = NSMenuItem(title: L10n("Copy Message"), action: #selector(copyRepresentedMessage), keyEquivalent: "")
            copy.target = self
            copy.image = NSImage(systemSymbolName: "doc.on.doc", accessibilityDescription: nil)
            copy.identifier = NSUserInterfaceItemIdentifier("chat.timeline.context.copy")
            menu.addItem(copy)
        }
        if row.forkItemID != nil {
            let fork = NSMenuItem(title: L10n("Create Branch"), action: #selector(forkRepresentedMessage), keyEquivalent: "")
            fork.target = self
            fork.image = NSImage(systemSymbolName: "arrow.triangle.branch", accessibilityDescription: nil)
            fork.identifier = NSUserInterfaceItemIdentifier("chat.timeline.context.fork")
            menu.addItem(fork)
        } else if let reason = row.forkUnavailableReason {
            let fork = NSMenuItem(title: L10n("Create Branch"), action: nil, keyEquivalent: "")
            fork.image = NSImage(systemSymbolName: "arrow.triangle.branch", accessibilityDescription: nil)
            fork.isEnabled = false
            fork.identifier = NSUserInterfaceItemIdentifier("chat.timeline.context.fork")
            menu.addItem(fork)
            let reasonItem = NSMenuItem(title: reason, action: nil, keyEquivalent: "")
            reasonItem.isEnabled = false
            reasonItem.indentationLevel = 1
            reasonItem.identifier = NSUserInterfaceItemIdentifier("chat.timeline.context.fork-reason")
            menu.addItem(reasonItem)
        }
        self.menu = menu
        var actions: [NSAccessibilityCustomAction] = row.userInput == nil ? [
            NSAccessibilityCustomAction(name: L10n("Select Text"), target: self,
                                        selector: #selector(beginTextSelection))
        ] : []
        if hasCopy {
            actions.insert(NSAccessibilityCustomAction(
                name: L10n("Copy Message"), target: self, selector: #selector(copyRepresentedMessage)
            ), at: 0)
        }
        if row.forkItemID != nil {
            actions.append(NSAccessibilityCustomAction(
                name: L10n("Create Branch"), target: self, selector: #selector(forkRepresentedMessage)
            ))
        }
        setAccessibilityCustomActions(actions)
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
    var contextMenu: NSMenu? = nil
    final class Coordinator { var text: NSAttributedString? }
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeNSView(context: Context) -> NativeTimelineTextView { NativeTimelineTextView() }
    func updateNSView(_ view: NativeTimelineTextView, context: Context) {
        view.linkBaseDirectory = baseDirectory
        view.cardContextMenu = contextMenu
        if context.coordinator.text !== text {
            view.textStorage?.setAttributedString(text)
            context.coordinator.text = text
        }
    }
    func sizeThatFits(_ proposal: ProposedViewSize, nsView: NativeTimelineTextView, context: Context) -> CGSize? { size }
}
