import SwiftUI
import CorptieConversation
import CorptieClientCore

/// Value-only identity; timeline rows never subscribe to the global Agent store.
struct MacReplyIdentityHeader: View {
    let identity: ConversationReplyIdentity
    var body: some View {
        HStack(spacing: 8) {
            Group {
                if let path = identity.avatarPath, !path.isEmpty {
                    AnimatedAvatarImage(path: path, animates: false)
                } else {
                    DefaultInitialAvatarView(familySeed: identity.name, variationSeed: identity.agentID,
                        initials: DefaultAvatarInitials.make(from: identity.name), size: ReplyIdentityLayout.avatarSize)
                }
            }
            .frame(width: ReplyIdentityLayout.avatarSize, height: ReplyIdentityLayout.avatarSize)
            .clipShape(Circle())
            .accessibilityHidden(true)
            Text(identity.name).font(.system(size: 12, weight: .semibold)).lineLimit(1)
        }
        .frame(maxWidth: .infinity, minHeight: ReplyIdentityLayout.headerHeight, maxHeight: ReplyIdentityLayout.headerHeight, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("chat.timeline.reply-identity")
    }
}

/// Fixed native controls shared by both timeline renderers; no hover observation.
final class ReplyActionBar: NSStackView {
    private let copyButton = NSButton()
    private let timeButton = NSButton()
    private let branchButton = NSButton()
    private var copyMessage: () -> Void = {}
    private var branch: () -> Void = {}
    private var timestamp = ""

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        orientation = .horizontal
        alignment = .centerY
        spacing = 6
        identifier = .init("chat.timeline.reply-actions")
        for (button, symbol, name, selector) in [
            (copyButton, "doc.on.doc", "copy", #selector(copyReply)),
            (timeButton, "clock", "timestamp", #selector(copyTimestamp)),
            (branchButton, "arrow.triangle.branch", "fork", #selector(createBranch))
        ] {
            button.isBordered = false
            button.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)
            button.imagePosition = .imageOnly
            button.symbolConfiguration = .init(pointSize: 12, weight: .regular)
            button.contentTintColor = .secondaryLabelColor
            button.identifier = .init("chat.timeline.reply-actions." + name)
            button.target = self
            button.action = selector
            addArrangedSubview(button)
            button.widthAnchor.constraint(equalToConstant: 22).isActive = true
            button.heightAnchor.constraint(equalToConstant: 22).isActive = true
        }
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func configure(_ row: AppKitChatTimelineRow, copy: @escaping () -> Void, fork: @escaping () -> Void) {
        copyMessage = copy
        branch = fork
        timestamp = row.contextTimestamp
        copyButton.isEnabled = !row.copyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        copyButton.toolTip = L10n("Copy Message")
        timeButton.isHidden = timestamp.isEmpty
        timeButton.toolTip = L10nFormat("Time: %@", timestamp) + " · " + L10n("Copy")
        branchButton.isHidden = row.forkItemID == nil && row.forkUnavailableReason == nil
        branchButton.isEnabled = row.forkItemID != nil
        branchButton.toolTip = row.forkUnavailableReason ?? L10n("Create Branch")
        for button in [copyButton, timeButton, branchButton] { button.setAccessibilityLabel(button.toolTip) }
    }
    @objc private func copyReply() { copyMessage() }
    @objc private func copyTimestamp() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(timestamp, forType: .string)
    }
    @objc private func createBranch() { branch() }
}

private struct ReplyActions: NSViewRepresentable {
    let row: AppKitChatTimelineRow
    let copy: () -> Void
    let performAction: (AppKitChatTimelineRow.Action) -> Void
    func makeNSView(context: Context) -> ReplyActionBar { ReplyActionBar(frame: .zero) }
    func updateNSView(_ view: ReplyActionBar, context: Context) {
        view.configure(row, copy: copy, fork: {
            guard let itemID = row.forkItemID else { return }
            performAction(.init(id: "fork:" + itemID, label: L10n("Create Branch"),
                isDestructive: false, kind: .forkMessage(itemID: itemID)))
        })
    }
}

/// Production adapter. It deliberately keeps the
/// existing attributed-text cache, measured sizes and custom TextKit view.
struct MacSharedMessageTextCard: View {
    var skin: ConversationSkin = .classic
    let row: AppKitChatTimelineRow
    let layout: NativeTimelineLayoutCache.Layout
    var processSummaryOverride: ProcessCardSummary? = nil
    var baseDirectory: String?
    var copy: () -> Void = {}
    var toggle: () -> Void = {}
    var performAction: (AppKitChatTimelineRow.Action) -> Void = { _ in }
    var selectText: () -> Void = {}
    var contextMenu: NSMenu? = nil
    var onImageGeometryChanged: () -> Void = {}

    var presentedMessageStatus: UserMessageStatusPresentation? {
        row.nativeStyle == .user ? row.messageStatus : nil
    }

    static func supports(_ row: AppKitChatTimelineRow) -> Bool {
        row.scheduledTrigger != nil || row.userInput != nil || row.executionPlan != nil || supportsProcess(row) || (row.nativeStyle != .process && (!row.showsHeader || row.scheduledMessageSource != nil) && !row.isCollaboration
            && row.collaborationRoute == nil && row.processCount == nil && row.expandableTurnId == nil
            && (row.actions.isEmpty || (row.nativeStyle == .agent
                && (row.nativeText.contains("```corptie-chart") || row.nativeText.contains("|"))))
            && !row.showsCollaborationSentStatus
            && (row.images.isEmpty || (row.nativeStyle == .user) || (row.nativeStyle == .agent
                && (row.nativeText.contains("```corptie-chart") || row.nativeText.contains("|"))))
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
            if let identity = row.replyIdentity {
                MacReplyIdentityHeader(identity: identity)
                    .padding(.horizontal, 12).padding(.bottom, ReplyIdentityLayout.bottomSpacing)
            }
            Group {
                if let trigger = row.scheduledTrigger { scheduledTaskCard(trigger) }
                else if let input = row.userInput { userInputCard(input) }
                else if let plan = row.executionPlan { executionPlanCard(plan) }
                else if row.nativeStyle == .process { processCard }
                else { messageCard }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity,
                alignment: row.nativeStyle == .user ? .topTrailing : .topLeading)
            .padding(.horizontal, 2)
            .padding(.vertical, layout.typography.rowInset)
            if row.showsReplyActions {
                ReplyActions(row: row, copy: copy, performAction: performAction)
                    .frame(width: 78, height: 22)
                    .frame(maxWidth: .infinity, minHeight: 26, maxHeight: 26, alignment: .topLeading)
                    .padding(.leading, 4)
            }
        }
        .environment(\.conversationSkin, skin)
    }

    private func scheduledTaskCard(_ trigger: ScheduledTriggerPresentation) -> some View {
        let width = layout.cardWidth - 20
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(row.title).font(.system(size: 13, weight: .bold)).lineLimit(1).layoutPriority(1)
                Spacer(minLength: 0)
                Text(row.metadata).font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary).lineLimit(1)
            }
            .frame(height: 16)
            if layout.textHeight > 0 {
                MeasuredMessageText(text: layout.attributedText,
                    size: .init(width: width, height: layout.textHeight), baseDirectory: baseDirectory)
                    .frame(width: width, height: layout.textHeight)
            }
            if !trigger.text.isEmpty, let message = layout.triggerText {
                Text(L10n("触发消息")).font(.system(size: 11, weight: .bold)).frame(height: 14)
                MeasuredMessageText(text: message, size: .init(width: width, height: layout.triggerTextHeight),
                    baseDirectory: baseDirectory, maximumLines: trigger.isExpanded ? 0 : 3)
                    .frame(width: width, height: layout.triggerTextHeight)
                if layout.triggerCanExpand {
                    Button(L10n(trigger.isExpanded ? "收起消息" : "展开消息"), action: toggle)
                    .buttonStyle(.plain).font(.system(size: 11, weight: .semibold)).foregroundStyle(.tint)
                    .frame(height: 20)
                    .accessibilityIdentifier("chat.timeline.scheduled-trigger-toggle")
                }
            }
        }
        .frame(width: width, alignment: .leading)
        .padding(10)
        .frame(width: layout.cardWidth, height: layout.cardHeight, alignment: .topLeading)
        .modifier(ConversationContentSurface(cornerRadius: 14,
            tint: Color(nsColor: MessageTextCardPalette.agentNativeBackground),
            fallback: Color(nsColor: MessageTextCardPalette.agentNativeBackground),
            isMessage: true, role: .interaction))
        .accessibilityIdentifier("chat.timeline.scheduled-task")
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
        .modifier(ConversationContentSurface(cornerRadius: 14, tint: .orange,
            tintOpacity: row.userInputStatus == "pending" ? 0.06 : 0.025, isMessage: true, role: .interaction))
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
            .modifier(ConversationSkinSurface(role: .plan, radius: 14,
                legacyFill: Color.secondary.opacity(0.06), legacyBorder: Color.secondary.opacity(0.2)))
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
        .frame(width: layout.cardWidth, height: layout.rowHeight - row.replyIdentityHeight - 2, alignment: .topLeading)
    }

    private var messageCard: some View {
        MessageTextCard(messageID: row.id, role: row.nativeStyle == .user ? .user : (row.isCommentary ? .commentary : .agent),
            timestamp: "", showsActions: false,
            actionsAlwaysVisible: false, cardWidth: layout.cardWidth,
            cardHeight: layout.cardHeight,
            status: presentedMessageStatus, rendersStatusGlow: false,
            surfaceRole: row.contentSurfaceRole, scrollsContent: layout.scrollsUserContent, copy: copy) {
            VStack(alignment: .leading, spacing: 0) {
                if let source = row.scheduledMessageSource {
                    Label(source, systemImage: "clock").font(.system(size: 10, weight: .medium))
                        .foregroundStyle(.secondary).lineLimit(1)
                        .frame(height: 19, alignment: .topLeading)
                }
                if row.nativeStyle == .user && !row.images.isEmpty {
                    attachmentStrip.padding(.bottom, layout.textHeight > 0 ? MessageCardMetrics.contentSpacing : 0)
                }
                if layout.richBlocks.isEmpty && layout.textHeight > 0 {
                    MeasuredMessageText(text: layout.attributedText,
                        size: CGSize(width: layout.cardWidth - 20, height: layout.textHeight),
                        baseDirectory: baseDirectory, contextMenu: contextMenu)
                        .frame(width: layout.cardWidth - 20, height: layout.textHeight)
                } else if !layout.richBlocks.isEmpty {
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
                            case .table(_, let table, let tableLayout):
                                ConversationMarkdownTableView(table: table, layout: tableLayout,
                                    openLink: { _ = MessageLinkOpener.handle($0, baseDirectory: baseDirectory) })
                            }
                        }
                    }
                    .frame(width: layout.cardWidth - 20, height: layout.textHeight,
                           alignment: .topLeading)
                }
                if row.nativeStyle != .user && !row.images.isEmpty {
                    attachmentStrip.padding(.top, layout.textHeight > 0 ? MessageCardMetrics.contentSpacing : 0)
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
        let frames = layout.imageLayout.frames
        return ZStack(alignment: .topLeading) {
            ForEach(Array(frames.enumerated()), id: \.offset) { index, frame in
                MacMessageImageThumbnail(attachment: row.images[index], index: index,
                    size: frame.size, fits: true,
                    extraCount: index == 3 ? max(0, row.images.count - 4) : 0,
                    open: { ChatImageGalleryViewer.shared.show(row.images, selected: index) },
                    geometryChanged: onImageGeometryChanged)
                    .offset(x: frame.minX, y: frame.minY)
            }
        }
        .frame(width: frames.map(\.maxX).max() ?? 0, height: frames.map(\.maxY).max() ?? 0, alignment: .topLeading)
    }
}

private struct MacMessageImageThumbnail: View {
    let attachment: ChatTimelineImage
    let index: Int
    let size: CGSize
    let fits: Bool
    let extraCount: Int
    let open: () -> Void
    let geometryChanged: () -> Void
    @State private var loadedImage: NSImage?
    @State private var loadFailed = false
    @State private var retry = 0
    @State private var requestID = UUID()

    var body: some View {
        Button { if loadFailed { retry += 1 } else { open() } } label: {
            MessageImageThumbnail(state: loadedImage.map { .loaded(Image(nsImage: $0)) } ?? (loadFailed ? .missing : .loading),
                index: index, size: size, fits: fits, extraCount: extraCount)
        }
        .buttonStyle(.plain)
        .help("打开图片")
        .accessibilityLabel("附加图片 \(index + 1)")
        .task(id: "\(attachment.displayURL?.absoluteString ?? ""):\(retry)") {
            let request = UUID()
            requestID = request
            let oldGeometry = attachment.resolvedGeometry
            loadedImage = nil
            loadFailed = false
            guard let url = attachment.displayURL else {
                loadFailed = true
                return
            }
            ChatTimelineImageLoader.shared.load(url) { image in
                guard requestID == request else { return }
                loadedImage = image
                loadFailed = image == nil
                if oldGeometry != attachment.resolvedGeometry { geometryChanged() }
            }
        }
        .onDisappear { requestID = UUID() }
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
        .modifier(ConversationSkinSurface(role: .structured, radius: 8,
            legacyFill: tint.opacity(0.045), legacyBorder: tint.opacity(0.16)))
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
    func updateAppearance(skin: ConversationSkin)
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
    var onImageGeometryChanged: (() -> Void)?
    private var representedImageGeometries: [MessageImageGeometry?] = []
    private var messageGlow: NativeMessageStatusGlow?
    private var host: NSHostingView<MacSharedMessageTextCard>?
    private var skin = ConversationSkin.classic
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
        clipsToBounds = false
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func updateAppearance(skin: ConversationSkin) {
        guard self.skin != skin else { return }
        self.skin = skin
        guard let row, let measuredWidth else { return }
        let typography = row.readingTypography(skin.typography(for: row.nativeStyle == .user ? .user : .assistant))
        if measuredLayout?.typography != typography {
            measuredLayout = NativeTimelineLayoutCache.shared.layout(for: row, columnWidth: measuredWidth, typography: typography)
            updateHost()
        } else { updateHost(needsLayout: false) }
    }

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
        let trace = SessionSwitchTrace.shared.start(.cardContent, sessionID: row.sessionID)
        defer { SessionSwitchTrace.shared.finish(trace) }
        precondition(MacSharedMessageTextCard.supports(row))
        self.row = row; self.baseDirectory = baseDirectory
        representedImageGeometries = row.imageGeometries
        elapsedSummary.text = nil
        self.onToggleExpansion = onToggleExpansion
        self.onAction = onAction
        measuredLayout = NativeTimelineLayoutCache.shared.layout(for: row, columnWidth: availableWidth, typography: skin.typography(for: row.nativeStyle == .user ? .user : .assistant))
        measuredWidth = availableWidth
        contentConfigurationCount += 1
        configureContextMenu(for: row)
        updateHost(resetTextSelection: true)
    }

    @discardableResult
    func updateLayoutIfContentUnchanged(_ row: AppKitChatTimelineRow, availableWidth: CGFloat) -> Bool {
        guard self.row?.id == row.id, self.row?.contentRevision == row.contentRevision,
              self.row?.replyIdentity == row.replyIdentity,
              representedImageGeometries == row.imageGeometries else { return false }
        guard measuredWidth != availableWidth || measuredLayout?.typography != row.readingTypography(skin.typography(for: row.nativeStyle == .user ? .user : .assistant)) else { return true }
        measuredWidth = availableWidth
        measuredLayout = NativeTimelineLayoutCache.shared.layout(for: row, columnWidth: availableWidth, typography: skin.typography(for: row.nativeStyle == .user ? .user : .assistant))
        widthLayoutUpdateCount += 1
        ChatPerformanceRecorder.shared.increment(.appKitRowWidthUpdates)
        updateHost()
        return true
    }

    private func updateHost(needsLayout: Bool = true, resetTextSelection: Bool = false) {
        guard let row, let measuredLayout else { return }
        let trace = SessionSwitchTrace.shared.start(.cardHost, sessionID: row.sessionID)
        defer { SessionSwitchTrace.shared.finish(trace) }
        hostUpdateCount += 1
        let root = MacSharedMessageTextCard(skin: skin, row: row, layout: measuredLayout,
            processSummaryOverride: elapsedSummary, baseDirectory: baseDirectory,
            copy: { [weak self] in self?.copyRepresentedMessage() },
            toggle: { [weak self] in self?.toggleRepresentedProcess() },
            performAction: { [weak self] action in self?.onAction(action) },
            selectText: { [weak self] in self?.beginTextSelection() }, contextMenu: menu,
            onImageGeometryChanged: { [weak self] in self?.onImageGeometryChanged?() })
        if let host {
            SessionSwitchTrace.shared.recordCell(.hostAssigned, sessionID: row.sessionID, rowID: row.id)
            host.rootView = root
        } else {
            SessionSwitchTrace.shared.recordCell(.hostCreated, sessionID: row.sessionID, rowID: row.id)
            let host = NSHostingView(rootView: root)
            host.sizingOptions = [] // The cached native row height owns sizing.
            host.frame = bounds
            host.autoresizingMask = [.width, .height]
            addSubview(host)
            self.host = host
        }
        self.host?.menu = menu
        if row.nativeStyle == .user, let status = row.messageStatus {
            if messageGlow == nil {
                let glow = NativeMessageStatusGlow(frame: .zero)
                addSubview(glow, positioned: .below, relativeTo: host)
                messageGlow = glow
            }
            messageGlow?.configure(status)
        } else {
            messageGlow?.removeFromSuperview()
            messageGlow = nil
        }
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
        if let measuredLayout, let row {
            let size = NSSize(width: measuredLayout.cardWidth,
                              height: measuredLayout.cardHeight)
            let topInset = row.timeSeparatorHeight + row.replyIdentityHeight + measuredLayout.typography.rowInset
            messageGlow?.frame = NSRect(x: bounds.width - size.width - 2,
                y: isFlipped ? topInset : bounds.height - topInset - size.height,
                width: size.width, height: size.height)
        }
        super.layout()
    }

    override func viewDidMoveToSuperview() {
        super.viewDidMoveToSuperview()
        messageGlow?.allowRowOverflow()
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

    @objc private func cancelRepresentedQueuedMessage() {
        guard let taskID = row?.queuedMessageTaskID else { return }
        onAction(.init(id: "cancel-queued:\(taskID)", label: L10n("Cancel"),
                       isDestructive: true, kind: .cancelQueuedMessage(taskID: taskID)))
    }
    @objc private func deleteRepresentedMessage() {
        guard let id = row?.deletableMessageID else { return }
        onAction(.init(id: "delete:\(id)", label: "删除", isDestructive: true,
            kind: .deleteUnreceivedMessage(messageID: id)))
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
        if row.deletableMessageID != nil {
            let deletion = NSMenuItem(title: "删除", action: #selector(deleteRepresentedMessage), keyEquivalent: "")
            deletion.target = self
            deletion.image = NSImage(systemSymbolName: "trash", accessibilityDescription: nil)
            menu.addItem(deletion)
        }
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
        if row.queuedMessageTaskID != nil {
            let cancel = NSMenuItem(title: L10n("Cancel"), action: #selector(cancelRepresentedQueuedMessage), keyEquivalent: "")
            cancel.target = self
            cancel.image = NSImage(systemSymbolName: "xmark.circle", accessibilityDescription: nil)
            cancel.identifier = NSUserInterfaceItemIdentifier("chat.timeline.context.cancel-queued")
            menu.addItem(cancel)
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
        if row.queuedMessageTaskID != nil {
            actions.append(NSAccessibilityCustomAction(
                name: L10n("Cancel"), target: self, selector: #selector(cancelRepresentedQueuedMessage)
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
    var maximumLines = 0
    final class Coordinator { var text: NSAttributedString? }
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeNSView(context: Context) -> NativeTimelineTextView { NativeTimelineTextView() }
    func updateNSView(_ view: NativeTimelineTextView, context: Context) {
        view.linkBaseDirectory = baseDirectory
        view.cardContextMenu = contextMenu
        view.textContainer?.maximumNumberOfLines = maximumLines
        view.textContainer?.lineBreakMode = maximumLines > 0 ? .byTruncatingTail : .byCharWrapping
        if context.coordinator.text !== text {
            let selection = view.selectedRanges
            let sameText = view.string == text.string
            view.textStorage?.setAttributedString(text)
            if sameText { view.selectedRanges = selection }
            context.coordinator.text = text
        }
    }
    func sizeThatFits(_ proposal: ProposedViewSize, nsView: NativeTimelineTextView, context: Context) -> CGSize? { size }
}
