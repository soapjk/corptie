import SwiftUI
import CorptieConversation
import CorptieClientCore

/// Value-only identity; timeline rows never subscribe to the global Agent store.
struct MacReplyIdentityHeader: View {
    let identity: ConversationReplyIdentity
    var skin: ConversationSkin = .classic
    var body: some View {
        HStack(spacing: 8) {
            Group {
                if let path = identity.avatarPath, !path.isEmpty {
                    AnimatedAvatarImage(path: path, animates: false)
                } else {
                    DefaultInitialAvatarView(familySeed: identity.name, variationSeed: identity.roleID,
                        initials: DefaultAvatarInitials.make(from: identity.name), size: ReplyIdentityLayout.avatarSize)
                }
            }
            .frame(width: ReplyIdentityLayout.avatarSize, height: ReplyIdentityLayout.avatarSize)
            .clipShape(Circle())
            .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(identity.name).font(WorkbenchTypography.font(for: .conversationMetadata))
                    .foregroundStyle(skin == .codexFlat ? Color.secondary : Color.primary).lineLimit(1)
                if let label = identity.providerLabel, !label.isEmpty {
                    ProviderBrandLabel(iconAsset: identity.providerIconAsset, label: label,
                        iconSize: 11, foreground: Color.secondary, showsLabel: false)
                        .accessibilityIdentifier("chat.timeline.reply-provider")
                }
            }
        }
        .frame(maxWidth: .infinity, minHeight: ReplyIdentityLayout.headerHeight, maxHeight: ReplyIdentityLayout.headerHeight, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("chat.timeline.reply-identity")
    }
}

/// Local pointer tracking redraws only the hovered native button.
final class ReplyActionIconButton: NSButton {
    private var pointerArea: NSTrackingArea?
    private var pointerInside = false
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let pointerArea { removeTrackingArea(pointerArea) }
        let area = NSTrackingArea(rect: .zero,
            options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self)
        addTrackingArea(area)
        pointerArea = area
    }
    override func mouseEntered(with event: NSEvent) {
        guard isEnabled else { return }
        pointerInside = true
        contentTintColor = .labelColor
        needsDisplay = true
    }
    override func mouseExited(with event: NSEvent) { clearHover() }
    override var isEnabled: Bool {
        didSet { if !isEnabled { clearHover() } }
    }
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil { clearHover() }
    }
    override func draw(_ dirtyRect: NSRect) {
        if pointerInside && isEnabled {
            NSColor.labelColor.withAlphaComponent(0.12).setFill()
            NSBezierPath(roundedRect: bounds.insetBy(dx: 2, dy: 2), xRadius: 4, yRadius: 4).fill()
        }
        super.draw(dirtyRect)
    }
    private func clearHover() {
        pointerInside = false
        contentTintColor = .secondaryLabelColor
        needsDisplay = true
    }
}

/// Fixed native controls shared by both timeline renderers; no hover observation.
final class ReplyActionBar: NSStackView {
    private let copyButton = ReplyActionIconButton()
    private let timeButton = NSButton()
    private let branchButton = ReplyActionIconButton()
    private var copyMessage: () -> Void = {}
    private var branch: () -> Void = {}
    private var timestamp = ""

    /// Measure once with exactly the configuration used by the real copy button.
    static let leadingImageInset: CGFloat = {
        let button = ReplyActionIconButton(frame: NSRect(x: 0, y: 0, width: 22, height: 22))
        configureIcon(button, symbol: "doc.on.doc")
        return button.cell?.imageRect(forBounds: button.bounds).minX ?? 0
    }()

    private static func configureIcon(_ button: NSButton, symbol: String) {
        button.isBordered = false
        button.image = symbol.isEmpty ? nil : NSImage(systemSymbolName: symbol, accessibilityDescription: nil)
        button.imagePosition = .imageOnly
        button.symbolConfiguration = .init(pointSize: 12, weight: .regular)
        button.contentTintColor = .secondaryLabelColor
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        orientation = .horizontal
        alignment = .centerY
        spacing = 6
        identifier = .init("chat.timeline.reply-actions")
        for (button, symbol, name, selector) in [
            (copyButton, "doc.on.doc", "copy", #selector(copyReply)),
            (branchButton, "arrow.triangle.branch", "fork", #selector(createBranch)),
            (timeButton, "", "timestamp", #selector(copyTimestamp))
        ] {
            Self.configureIcon(button, symbol: symbol)
            button.identifier = .init("chat.timeline.reply-actions." + name)
            button.target = self
            button.action = selector
            addArrangedSubview(button)
            if button !== timeButton { button.widthAnchor.constraint(equalToConstant: 22).isActive = true }
            button.heightAnchor.constraint(equalToConstant: 22).isActive = true
        }
        timeButton.imagePosition = .noImage
        timeButton.font = .systemFont(ofSize: 10.5)
        timeButton.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        timeButton.cell?.lineBreakMode = .byTruncatingTail
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    static func width(for row: AppKitChatTimelineRow) -> CGFloat {
        let timestampWidth = ceil((row.contextTimestamp as NSString).size(withAttributes: [
            .font: NSFont.systemFont(ofSize: 10.5)
        ]).width) + 8
        return 56 + (row.contextTimestamp.isEmpty ? 0 : timestampWidth)
    }

    func configure(_ row: AppKitChatTimelineRow, copy: @escaping () -> Void, fork: @escaping () -> Void) {
        copyMessage = copy
        branch = fork
        timestamp = row.contextTimestamp
        timeButton.title = timestamp
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

/// Production adapter: cached attributed content and the existing TextKit
/// selection/link view, with SDK-owned intrinsic card and row heights.
private struct MessageTextSelectionIdentity: Equatable {
    let sessionID: String?
    let rowID: String
    let revision: Int
}
private struct MessageTextSelectionKey: EnvironmentKey {
    static let defaultValue: MessageTextSelectionIdentity? = nil
}
private struct MessageTextMenuKey: EnvironmentKey {
    static var defaultValue: NSMenu? { nil }
}
private extension EnvironmentValues {
    var messageTextContextMenu: NSMenu? {
        get { self[MessageTextMenuKey.self] }
        set { self[MessageTextMenuKey.self] = newValue }
    }
    var messageTextSelectionIdentity: MessageTextSelectionIdentity? {
        get { self[MessageTextSelectionKey.self] }
        set { self[MessageTextSelectionKey.self] = newValue }
    }
}

struct MacSharedMessageTextCard: View {
    var skin: ConversationSkin = .classic
    let row: AppKitChatTimelineRow
    let layout: NativeTimelineLayoutCache.Layout
    var mountedLayout: MountedMessageLayout? = nil
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
        row.processStep != nil || row.coordinationProgress != nil || row.scheduledTrigger != nil || row.userInput != nil || row.executionPlan != nil || supportsProcess(row) || (row.nativeStyle != .process && (!row.showsHeader || row.scheduledMessageSource != nil) && !row.isCollaboration
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
        let layout = mountedLayout?.value ?? self.layout
        VStack(spacing: 0) {
            if layout.timeSeparatorHeight > 0, let timeSeparatorText = row.timeSeparatorText {
                Text(timeSeparatorText)
                    .font(.system(size: 10.5, weight: .medium))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 28, maxHeight: 28)
                    .accessibilityLabel(L10nFormat("Time: %@", timeSeparatorText))
                    .accessibilityIdentifier("chat.timeline.time-separator")
            }
            if let identity = row.replyIdentity {
                MacReplyIdentityHeader(identity: identity, skin: skin)
                    .padding(.horizontal, ReplyLeadingLayout.contentLeading).padding(.bottom, ReplyIdentityLayout.bottomSpacing)
            }
            Group {
                if row.processStep != nil, let block = layout.processBlocks.first {
                    MacProcessBlockView(block: block, cardWidth: layout.cardWidth, baseDirectory: baseDirectory)
                }
                else if let progress = row.coordinationProgress {
                    MacCoordinationProgressCard(progress: progress)
                }
                else if let trigger = row.scheduledTrigger {
                    MacScheduledTriggerCard(trigger: trigger, title: row.title, metadata: row.metadata,
                        cardWidth: layout.cardWidth,
                        text: layout.attributedText,
                        triggerText: layout.triggerText,
                        triggerCanExpand: layout.triggerCanExpand, baseDirectory: baseDirectory, toggle: toggle)
                }
                else if let input = row.userInput {
                    MacUserInputCard(request: input, status: row.userInputStatus, sessionID: row.sessionID,
                        itemID: row.userInputItemID, cardWidth: layout.cardWidth, copy: copy)
                }
                else if let plan = row.executionPlan {
                    MacExecutionPlanCard(plan: plan, cardWidth: layout.cardWidth,
                        expanded: row.isExpanded, toggle: toggle, copy: copy)
                }
                else if row.nativeStyle == .process {
                    MacProcessCardRegion(summary: row.processPrimarySummary, summaryOverride: processSummaryOverride,
                        secondary: row.processCurrentStepTitle, state: row.processState, expanded: row.isExpanded,
                        progress: row.processPlanProgress, progressLabel: row.processPlanProgressLabel,
                        blocks: layout.processBlocks, text: layout.attributedText,
                        rawStatusText: layout.rawStatusText,
                        cardWidth: layout.cardWidth,
                        baseDirectory: baseDirectory, toggle: toggle, hasVirtualChildren: row.hasVirtualProcessChildren)
                }
                else {
                    MacOrdinaryMessageCardRegion(messageID: row.id, style: row.nativeStyle,
                        isCommentary: row.isCommentary, surfaceRole: row.contentSurfaceRole,
                        cardWidth: layout.cardWidth, text: layout.attributedText, blocks: layout.richBlocks,
                        imageLayout: layout.imageLayout, images: row.images, actions: row.actions,
                        source: row.scheduledMessageSource,
                        canCopy: row.copyText.unicodeScalars.contains { !CharacterSet.whitespacesAndNewlines.contains($0) },
                        forkItemID: row.forkItemID, scrollsUserContent: layout.scrollsUserContent,
                        presentedMessageStatus: presentedMessageStatus, baseDirectory: baseDirectory,
                        copy: copy, performAction: performAction, selectText: selectText,
                        contextMenu: contextMenu, onImageGeometryChanged: onImageGeometryChanged)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: nil,
                alignment: row.nativeStyle == .user ? .topTrailing : .topLeading)
            .padding(.leading, ReplyLeadingLayout.cardLeading(for: row, skin: skin))
            .padding(.trailing, row.nativeStyle == .user ? ChatBubbleWidthPolicy.userTrailingInset : 2)
            .padding(.vertical, layout.typography.rowInset)
            if row.showsReplyActions {
                ReplyActions(row: row, copy: copy, performAction: performAction)
                    .frame(width: min(ReplyActionBar.width(for: row), layout.cardWidth - 4), height: 22)
                    .frame(maxWidth: .infinity, minHeight: 26, maxHeight: 26, alignment: .topLeading)
                    .padding(.leading, ReplyLeadingLayout.cardLeading(for: row, skin: skin) + MessageCardMetrics.contentInset - ReplyActionBar.leadingImageInset)
            }
        }
        .environment(\.conversationSkin, skin)
        .environment(\.messageTextSelectionIdentity, MessageTextSelectionIdentity(
            sessionID: row.sessionID, rowID: row.id, revision: row.contentRevision))
        .environment(\.messageTextContextMenu, contextMenu)
    }

}

private struct MacOrdinaryMessageCardRegion: View {
    let messageID: String
    let style: AppKitChatTimelineRow.NativeStyle
    let isCommentary: Bool
    let surfaceRole: ConversationSurfaceRole
    let cardWidth: CGFloat
    let text: NSAttributedString
    let blocks: [NativeTimelineLayoutCache.Layout.RichBlock]
    let imageLayout: MessageImageGalleryLayout.Layout
    let images: [ChatTimelineImage]
    let actions: [AppKitChatTimelineRow.Action]
    let source: String?
    let canCopy: Bool
    let forkItemID: String?
    let scrollsUserContent: Bool
    let presentedMessageStatus: UserMessageStatusPresentation?
    let baseDirectory: String?
    let copy: () -> Void
    let performAction: (AppKitChatTimelineRow.Action) -> Void
    let selectText: () -> Void
    let contextMenu: NSMenu?
    let onImageGeometryChanged: () -> Void

    var body: some View {
        MessageTextCard(messageID: messageID, role: style == .user ? .user : (isCommentary ? .commentary : .agent),
            timestamp: "", showsActions: false,
            actionsAlwaysVisible: false, cardWidth: cardWidth,
            cardHeight: nil,
            status: presentedMessageStatus, rendersStatusGlow: false,
            surfaceRole: surfaceRole, scrollsContent: scrollsUserContent, copy: copy) {
            VStack(alignment: .leading, spacing: 0) {
                if let source = source {
                    Label(source, systemImage: "clock").font(.system(size: 10, weight: .medium))
                        .foregroundStyle(.secondary).lineLimit(1)
                        .frame(height: 19, alignment: .topLeading)
                }
                if style == .user && !images.isEmpty {
                    MacMessageAttachmentStrip(images: images, layout: imageLayout,
                        geometryChanged: onImageGeometryChanged).padding(.bottom, (text.length > 0 || !blocks.isEmpty) ? MessageCardMetrics.contentSpacing : 0)
                }
                MacMessageProseRegion(text: text, blocks: blocks,
                    width: cardWidth - 20,
                    baseDirectory: baseDirectory, contextMenu: contextMenu)
                if style != .user && !images.isEmpty {
                    MacMessageAttachmentStrip(images: images, layout: imageLayout,
                        geometryChanged: onImageGeometryChanged).padding(.top, (text.length > 0 || !blocks.isEmpty) ? MessageCardMetrics.contentSpacing : 0)
                }
                if !actions.isEmpty {
                    ScrollView(.horizontal) {
                        HStack(spacing: 6) {
                            ForEach(actions, id: \.id) { action in
                                Button(action.label) { performAction(action) }
                                    .buttonStyle(.bordered)
                                    .controlSize(.small)
                                    .tint(action.isDestructive ? .red : .accentColor)
                                    .accessibilityIdentifier("chat.timeline.action.\(action.id)")
                            }
                        }
                    }
                    .scrollIndicators(.hidden)
                    .frame(width: cardWidth - 20, height: 30, alignment: .leading)
                    .padding(.top, 4)
                }
            }
            .background {
                if style == .user {
                    ConsoleOverlayScroller()
                }
            }
        }
        .accessibilityActions {
            if canCopy {
                Button(L10n("Copy Message"), action: copy)
            }
            if let itemID = forkItemID {
                Button(L10n("Create Branch")) {
                    performAction(.init(id: "fork:\(itemID)", label: L10n("Create Branch"),
                                        isDestructive: false, kind: .forkMessage(itemID: itemID)))
                }
            }
            Button(L10n("Select Text"), action: selectText)
        }
    }
}

private struct MacMessageAttachmentStrip: View {
    let images: [ChatTimelineImage]
    let layout: MessageImageGalleryLayout.Layout
    let geometryChanged: () -> Void

    var body: some View {
        ZStack(alignment: .topLeading) {
            ForEach(Array(layout.frames.enumerated()), id: \.offset) { index, frame in
                MacMessageImageThumbnail(displayURL: images[index].displayURL,
                    initialGeometry: images[index].geometry, index: index,
                    size: frame.size, fits: true,
                    extraCount: index == 3 ? max(0, images.count - 4) : 0,
                    open: { ChatImageGalleryViewer.shared.show(images, selected: index) },
                    geometryChanged: geometryChanged)
                    .offset(x: frame.minX, y: frame.minY)
            }
        }
        .frame(width: layout.size.width, height: layout.size.height, alignment: .topLeading)
    }
}

private struct MacScheduledTriggerCard: View {
    let trigger: ScheduledTriggerPresentation
    let title: String
    let metadata: String
    let cardWidth: CGFloat
    let text: NSAttributedString
    let triggerText: NSAttributedString?
    let triggerCanExpand: Bool
    let baseDirectory: String?
    let toggle: () -> Void

    var body: some View {
        let width = cardWidth - 20
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(title).font(.system(size: 13, weight: .bold)).lineLimit(1).layoutPriority(1)
                Spacer(minLength: 0)
                Text(metadata).font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary).lineLimit(1)
            }
            .frame(height: 16)
            if text.length > 0 {
                MeasuredMessageText(text: text,
                    size: nil, baseDirectory: baseDirectory)
                    .frame(width: width, height: nil)
            }
            if !trigger.text.isEmpty, let message = triggerText {
                Text(L10n("触发消息")).font(.system(size: 11, weight: .bold)).frame(minHeight: 14)
                MeasuredMessageText(text: message, size: nil,
                    baseDirectory: baseDirectory, maximumLines: trigger.isExpanded ? 0 : 3)
                    .frame(width: width, height: nil)
                if triggerCanExpand {
                    Button(L10n(trigger.isExpanded ? "收起消息" : "展开消息"), action: toggle)
                    .buttonStyle(.plain).font(.system(size: 11, weight: .semibold)).foregroundStyle(.tint)
                    .frame(height: 20)
                    .accessibilityIdentifier("chat.timeline.scheduled-trigger-toggle")
                }
            }
        }
        .frame(width: width, alignment: .leading)
        .padding(10)
        .frame(width: cardWidth, height: nil, alignment: .topLeading)
        .modifier(ConversationContentSurface(cornerRadius: 14,
            tint: Color(nsColor: MessageTextCardPalette.agentNativeBackground),
            fallback: Color(nsColor: MessageTextCardPalette.agentNativeBackground),
            isMessage: true, role: .interaction))
        .accessibilityIdentifier("chat.timeline.scheduled-task")
    }
}

private struct MacUserInputCard: View {
    let request: ConversationUserInput
    let status: String?
    let sessionID: String?
    let itemID: String?
    let cardWidth: CGFloat
    let copy: () -> Void

    var body: some View {
        ConversationInlineUserInput(request: request, status: status) { answers, action in
            guard let sessionID = sessionID else {
                throw BackendError.message("会话不可用，无法提交答案。")
            }
            guard let itemID = itemID else {
                throw BackendError.message("问题标识不可用，无法提交答案。")
            }
            try await BackendClient.shared.respondToUserInput(
                sessionID: sessionID, itemID: itemID, answers: answers, action: action)
        }
        .accessibilityActions {
            Button(L10n("Copy Message"), action: copy)
        }
        .padding(14)
        .frame(width: cardWidth, alignment: .topLeading)
        .modifier(ConversationContentSurface(cornerRadius: 14, tint: .orange,
            tintOpacity: status == "pending" ? 0.06 : 0.025, isMessage: true, role: .interaction))
        .overlay {
            RoundedRectangle(cornerRadius: 14)
                .strokeBorder(Color.orange.opacity(status == "pending" ? 0.38 : 0.16), lineWidth: 1)
        }
    }
}

private struct MacExecutionPlanCard: View {
    let plan: ConversationExecutionPlan
    let cardWidth: CGFloat
    let expanded: Bool
    let toggle: () -> Void
    let copy: () -> Void

    var body: some View {
        Group {
            if let taskID = plan.taskId {
                DesktopExecutionChecklistContent(plan: plan, taskID: taskID, width: cardWidth - 28, canEdit: plan.closed != true,
                    isExpanded: expanded, onToggleExpansion: toggle, observesAssignments: plan.closed != true)
            } else {
                IntrinsicCappedContent(maximumHeight: 300, content: ExecutionPlanChecklist(plan: plan))
            }
        }
            .accessibilityActions {
                Button(L10n("Copy Message"), action: copy)
            }
            .padding(14)
            .frame(width: cardWidth, alignment: .topLeading)
            .modifier(ConversationSkinSurface(role: .plan, radius: 14,
                legacyFill: Color.secondary.opacity(0.06), legacyBorder: Color.secondary.opacity(0.2)))
    }
}

private struct MacProcessCardRegion: View {
    let summary: String
    let summaryOverride: ProcessCardSummary?
    let secondary: String?
    let state: ConversationProcessState
    let expanded: Bool
    let progress: Double?
    let progressLabel: String?
    let blocks: [NativeTimelineLayoutCache.Layout.ProcessBlock]
    let text: NSAttributedString
    let rawStatusText: NSAttributedString?
    let cardWidth: CGFloat
    let baseDirectory: String?
    let toggle: () -> Void
    var hasVirtualChildren = false

    var body: some View {
        ProcessCard(summary: summary, summaryOverride: summaryOverride, secondary: secondary,
                    symbol: state.symbolName,
                    tint: Color(nsColor: state.color), expanded: expanded,
                    progress: progress, progressLabel: progressLabel,
                    toggle: toggle) {
            if !hasVirtualChildren {
                VStack(alignment: .leading, spacing: 8) {
                    if blocks.isEmpty {
                        MeasuredMessageText(text: text,
                            size: nil,
                            baseDirectory: baseDirectory)
                            .frame(width: cardWidth - 20, height: nil)
                    } else {
                        VStack(alignment: .leading, spacing: 6) {
                            ForEach(blocks, id: \.step.id) { block in
                                MacProcessBlockView(block: block, cardWidth: cardWidth,
                                                    baseDirectory: baseDirectory)
                            }
                        }
                        .frame(width: cardWidth - 20, height: nil,
                               alignment: .topLeading)
                    }
                    if let rawStatusText, rawStatusText.length > 0 {
                        IntrinsicCappedContent(maximumHeight: 160, content:
                            MeasuredMessageText(text: rawStatusText, identifier: .init("chat.timeline.raw-status"))
                                .padding(4))
                            .frame(width: cardWidth - 20).frame(minHeight: 48)
                            .background(Color.black.opacity(0.035), in: RoundedRectangle(cornerRadius: 6))
                    }
                }
            }
        }
        .frame(width: cardWidth, height: nil, alignment: .topLeading)
    }
}

/// Receives cached rendering inputs only; it never parses Markdown or measures text.
private struct MacMessageProseRegion: View {
    let text: NSAttributedString
    let blocks: [NativeTimelineLayoutCache.Layout.RichBlock]
    let width: CGFloat
    let baseDirectory: String?
    let contextMenu: NSMenu?
    var body: some View {
        if blocks.isEmpty && (text.length > 0) {
            MeasuredMessageText(text: text,
                size: nil,
                baseDirectory: baseDirectory, contextMenu: contextMenu)
                .frame(width: width, height: nil)
        } else if !blocks.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(blocks, id: \.id) { block in
                    switch block {
                    case .markdown(_, let text, _):
                        MeasuredMessageText(text: text,
                            size: nil,
                            baseDirectory: baseDirectory, contextMenu: contextMenu)
                            .frame(width: width, height: nil)
                    case .chart(_, let spec, _):
                        ConversationChartView(spec: spec)
                            .frame(width: width,
                                   height: nil)
                    case .table(_, let table, let tableLayout):
                        ConversationMarkdownTableView(table: table, layout: tableLayout,
                            openLink: { _ = MessageLinkOpener.handle($0, baseDirectory: baseDirectory) })
                    }
                }
            }
            .frame(width: width, height: nil,
                   alignment: .topLeading)
        }
    }
}

private struct MessageImageLoadKey: Equatable {
    let url: URL?
    let retry: Int
}

private struct MacMessageImageThumbnail: View {
    let displayURL: URL?
    let initialGeometry: MessageImageGeometry?
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
        .task(id: MessageImageLoadKey(url: displayURL, retry: retry)) {
            let request = UUID()
            requestID = request
            let oldGeometry = displayURL.flatMap { ChatTimelineImageLoader.shared.geometry(for: $0) } ?? initialGeometry
            loadedImage = nil
            loadFailed = false
            guard let url = displayURL else {
                loadFailed = true
                return
            }
            ChatTimelineImageLoader.shared.load(url) { image in
                guard requestID == request else { return }
                loadedImage = image
                loadFailed = image == nil
                if oldGeometry != (ChatTimelineImageLoader.shared.geometry(for: url) ?? initialGeometry) { geometryChanged() }
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
                IntrinsicCappedContent(maximumHeight: 300, content:
                    ExecutionPlanChecklist(plan: plan).frame(width: cardWidth - 36, alignment: .leading))
            } else if block.step.tool != nil || block.step.changeSet != nil {
                ExecutionStructuredStepView(presentation: .init(step: block.step))
                    .frame(width: cardWidth - 36, height: nil,
                           alignment: .topLeading)
            } else {
                MeasuredMessageText(text: block.attributedText,
                    size: nil,
                    baseDirectory: baseDirectory)
                    .frame(width: cardWidth - 36, height: nil)
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
        .frame(width: cardWidth - 20, height: nil)
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
    /// Drop the SwiftUI hosting tree and the row-bound callbacks of a cell
    /// that has left both the reuse cache and the view hierarchy. Evicted
    /// offscreen cells otherwise keep an NSHostingView, its constraints, its
    /// KVO dependencies and an AttributeGraph subgraph reachable forever.
    func releaseRenderingResources()
}

extension AppKitChatRowRendering {
    func releaseRenderingResources() {}
}

@Observable @MainActor
final class MountedMessageLayout {
    var value: NativeTimelineLayoutCache.Layout?
}

/// One hosting tree per reusable native row; no duplicate legacy view tree.
final class AppKitSharedMessageTextCell: NSTableCellView, AppKitChatRowRendering {
    var onImageGeometryChanged: (() -> Void)?
    private var representedImageGeometries: [MessageImageGeometry?] = []
    private var host: NSHostingView<MacSharedMessageTextCard>?
    private var hostConstraints: [NSLayoutConstraint] = []
    private var skin = ConversationSkin.classic
    private var row: AppKitChatTimelineRow?
    private var measuredLayout: NativeTimelineLayoutCache.Layout?
    private var baseDirectory: String?
    private var measuredWidth: CGFloat?
    private let mountedLayout = MountedMessageLayout()
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

    func releaseRenderingResources() {
        // A cell still owned by AppKit may be returned by the table without
        // another delegate call; only fully detached offscreen cells can be
        // stripped without risking a blank row.
        guard window == nil, superview == nil else { return }
        NSLayoutConstraint.deactivate(hostConstraints)
        hostConstraints.removeAll(keepingCapacity: true)
        host?.removeFromSuperview()
        host = nil
        menu = nil
        menuIdentity = nil
        row = nil
        measuredLayout = nil
        measuredWidth = nil
        representedImageGeometries.removeAll(keepingCapacity: true)
        elapsedSummary.text = nil
        mountedLayout.value = nil
        onToggleExpansion = { _ in }
        onAction = { _ in }
        onImageGeometryChanged = nil
    }

    func updateAppearance(skin: ConversationSkin) {
        guard self.skin != skin else { return }
        self.skin = skin
        guard let row, let measuredWidth else { return }
        let typography = row.readingTypography(skin.typography(for: row.nativeStyle == .user ? .user : .assistant))
        if measuredLayout?.typography != typography || measuredLayout?.timeSeparatorHeight != (skin.showsTimelineTimeSeparators ? row.timeSeparatorHeight : 0) {
            measuredLayout = NativeTimelineLayoutCache.shared.intrinsicContent(for: row, columnWidth: measuredWidth, skin: skin)
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
        // An identity-only update retains the same cached prose. Do not clear
        // its selection as if the cell had been rebound to another message.
        self.row = row; self.baseDirectory = baseDirectory
        representedImageGeometries = row.imageGeometries
        elapsedSummary.text = nil
        self.onToggleExpansion = onToggleExpansion
        self.onAction = onAction
        measuredLayout = NativeTimelineLayoutCache.shared.intrinsicContent(for: row, columnWidth: availableWidth, skin: skin)
        measuredWidth = availableWidth
        contentConfigurationCount += 1
        configureContextMenu(for: row)
        updateHost()
    }

    @discardableResult
    func updateLayoutIfContentUnchanged(_ row: AppKitChatTimelineRow, availableWidth: CGFloat) -> Bool {
        guard self.row?.id == row.id, self.row?.contentRevision == row.contentRevision,
              self.row?.replyIdentity == row.replyIdentity,
              representedImageGeometries == row.imageGeometries else { return false }
        guard measuredWidth != availableWidth || measuredLayout?.typography != row.readingTypography(skin.typography(for: row.nativeStyle == .user ? .user : .assistant))
            || measuredLayout?.timeSeparatorHeight != (skin.showsTimelineTimeSeparators ? row.timeSeparatorHeight : 0) else { return true }
        measuredWidth = availableWidth
        measuredLayout = NativeTimelineLayoutCache.shared.intrinsicContent(for: row, columnWidth: availableWidth, skin: skin, reusing: measuredLayout)
        widthLayoutUpdateCount += 1
        ChatPerformanceRecorder.shared.increment(.appKitRowWidthUpdates)
        mountedLayout.value = measuredLayout
        return true
    }

    private func updateHost(needsLayout: Bool = true) {
        guard let row, let measuredLayout else { return }
        let trace = SessionSwitchTrace.shared.start(.cardHost, sessionID: row.sessionID)
        defer { SessionSwitchTrace.shared.finish(trace) }
        hostUpdateCount += 1
        mountedLayout.value = measuredLayout
        let root = MacSharedMessageTextCard(skin: skin, row: row, layout: measuredLayout, mountedLayout: mountedLayout,
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
            host.sizingOptions = [.intrinsicContentSize]
            host.translatesAutoresizingMaskIntoConstraints = false
            host.setContentHuggingPriority(.required, for: .vertical)
            host.setContentCompressionResistancePriority(.required, for: .vertical)
            addSubview(host)
            let constraints = [
                host.leadingAnchor.constraint(equalTo: leadingAnchor),
                host.trailingAnchor.constraint(equalTo: trailingAnchor),
                host.topAnchor.constraint(equalTo: topAnchor),
                host.bottomAnchor.constraint(equalTo: bottomAnchor)
            ]
            NSLayoutConstraint.activate(constraints)
            hostConstraints = constraints
            self.host = host
        }
        self.host?.menu = menu
        // Reconcile the new width/content proposal before NSTableView asks
        // its SDK-owned row height. Invalidate the host, not a second height
        // cache; only a mounted cell's tree participates in this transaction.
        if needsLayout {
            host?.needsLayout = true
            host?.invalidateIntrinsicContentSize()
            invalidateIntrinsicContentSize()
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

    private struct MenuIdentity: Equatable {
        let isProcess: Bool
        let deletion: String?
        let queuedTask: String?
        let fork: String?
        let forkReason: String?
        let timestamp: String
        let hasCopy: Bool
        let hasInput: Bool
        let language: String
    }
    private var menuIdentity: MenuIdentity?

    private func configureContextMenu(for row: AppKitChatTimelineRow) {
        let hasCopy = row.copyText.unicodeScalars.contains { !CharacterSet.whitespacesAndNewlines.contains($0) }
        let identity = MenuIdentity(isProcess: row.nativeStyle == .process,
            deletion: row.deletableMessageID, queuedTask: row.queuedMessageTaskID,
            fork: row.forkItemID, forkReason: row.forkUnavailableReason,
            timestamp: row.contextTimestamp, hasCopy: hasCopy, hasInput: row.userInput != nil,
            language: AppLanguageController.shared.languageCode)
        guard menuIdentity != identity else { return }
        menuIdentity = identity
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

private struct IntrinsicCappedContent<Content: View>: View {
    let maximumHeight: CGFloat
    let content: Content
    var body: some View {
        ViewThatFits(in: .vertical) {
            content.fixedSize(horizontal: false, vertical: true)
            ScrollView { content.frame(maxWidth: .infinity, alignment: .leading) }
        }
        .frame(maxHeight: maximumHeight)
    }
}

/// TextKit consumes the SDK width proposal and supplies the native text height.
struct MeasuredMessageText: NSViewRepresentable {
    @Environment(\.messageTextSelectionIdentity) private var selectionIdentity
    @Environment(\.messageTextContextMenu) private var inheritedMenu
    let text: NSAttributedString
    var size: CGSize? = nil
    var baseDirectory: String? = nil
    var contextMenu: NSMenu? = nil
    var maximumLines = 0
    var identifier = NSUserInterfaceItemIdentifier("chat.timeline.body")
    final class Coordinator {
        var text: NSAttributedString?
        fileprivate var selectionIdentity: MessageTextSelectionIdentity?
    }
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeNSView(context: Context) -> NativeTimelineTextView { NativeTimelineTextView() }
    func updateNSView(_ view: NativeTimelineTextView, context: Context) {
        view.identifier = identifier
        view.linkBaseDirectory = baseDirectory
        view.cardContextMenu = contextMenu ?? inheritedMenu
        if view.textContainer?.maximumNumberOfLines != maximumLines { view.textContainer?.maximumNumberOfLines = maximumLines }
        let mode: NSLineBreakMode = maximumLines > 0 ? .byTruncatingTail : .byWordWrapping
        if view.textContainer?.lineBreakMode != mode { view.textContainer?.lineBreakMode = mode }
        if context.coordinator.text !== text {
            let selection = view.selectedRanges
            let sameText = view.string == text.string
            view.textStorage?.setAttributedString(text)
            if sameText { view.selectedRanges = selection }
            context.coordinator.text = text
        }
        if context.coordinator.selectionIdentity != selectionIdentity {
            view.endTextSelection()
            context.coordinator.selectionIdentity = selectionIdentity
        }
    }
    func sizeThatFits(_ proposal: ProposedViewSize, nsView: NativeTimelineTextView, context: Context) -> CGSize? {
        if let size { return size }
        guard let container = nsView.textContainer, let manager = nsView.layoutManager else { return nil }
        let width = proposal.width.flatMap { $0.isFinite && $0 > 0 ? $0 : nil }
        // The SDK also asks for a natural size with an unspecified proposal.
        // Returning nil would collapse NSTextView's non-intrinsic height.
        container.widthTracksTextView = false
        let previousWidth = container.containerSize.width
        let naturalWidth = previousWidth > 0 && previousWidth < .greatestFiniteMagnitude
            ? previousWidth : nsView.bounds.width
        guard width != nil || naturalWidth > 0 else { return nil }
        let proposedSize = NSSize(width: width ?? naturalWidth, height: CGFloat.greatestFiniteMagnitude)
        if container.containerSize != proposedSize { container.containerSize = proposedSize }
        manager.ensureLayout(for: container)
        let used = manager.usedRect(for: container)
        return .init(width: width ?? ceil(used.width), height: ceil(used.height))
    }
}

private struct MacCoordinationProgressCard: View {
    let progress: ClientCoordinationProgress
    @ObservedObject private var language = AppLanguageController.shared
    var body: some View {
        CoordinationProgressCard(progress: progress, api: {
            ClientDetailAPI(transport: try BackendTransport(endpoint: BackendEndpoint(CorptieAppEnvironment.backendBaseURL)), route: .desktop)
        }, openSession: { AppTabRouter.shared.openSession($0, source: .userSelection) })
        .environment(\.locale, language.locale)
    }
}
