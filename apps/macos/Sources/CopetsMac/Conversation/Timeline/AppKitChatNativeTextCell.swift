import AppKit
import SwiftUI
import CorptieConversation
import CorptieClientCore

@MainActor
final class AppKitChatNativeTextCell: NSTableCellView, AppKitChatRowRendering {
    var onImageGeometryChanged: (() -> Void)?
    private var representedImageGeometries: [MessageImageGeometry?] = []
    private var representedImageLayout = MessageImageGalleryLayout.layout(geometries: [], width: 0)
    private let cardView = NativeContentCardSurface(frame: .zero)
    private var skin = ConversationSkin.classic
    private var renderedRow: AppKitChatTimelineRow?
    private var renderedWidth: CGFloat = 0
    private var measuredTypography = ConversationTypography.classic
    private var surfaceRole = ConversationSurfaceRole.structured
    private var messageGlow: NativeMessageStatusGlow?
    private let timeSeparatorLabel = NSTextField(labelWithString: "")
    private let titleLabel = NSTextField(labelWithString: "")
    private let metadataLabel = NSTextField(labelWithString: "")
    private let messageStatusButton = NSButton()
    private let label = NativeTimelineTextView()
    private let imageStack = NSStackView()
    private let rawStatusScrollView = NSScrollView()
    private let rawStatusTextView = NSTextView()
    private let disclosureButton = NSButton()
    private var forkItemID: String?
    private var queuedMessageTaskID: String?
    private var deletableMessageID: String?
    private var forkUnavailableReason: String?
    private let messageActionBar = ReplyActionBar(frame: .zero)
    private let actionStack = NSStackView()
    private let collaborationSentStatus = NSStackView()
    private let collaborationSentStatusIcon = NSImageView()
    // This footer acknowledges confirmation, not transport delivery.
    private let collaborationSentStatusLabel = NSTextField(labelWithString: L10n("已发送"))
    private let processSeparator = NSView()
    private let processButton = NSButton()
    private var processSeparatorHeight: NSLayoutConstraint!
    private var processButtonHeight: NSLayoutConstraint!
    private var processButtonTopConstraint: NSLayoutConstraint!
    private var processButtonBottomConstraint: NSLayoutConstraint!
    private var actionStackHeight: NSLayoutConstraint!
    private var collaborationSentStatusHeight: NSLayoutConstraint!
    private var cardWidthConstraint: NSLayoutConstraint!
    private var cardLeadingConstraint: NSLayoutConstraint!
    private var cardTrailingConstraint: NSLayoutConstraint!
    private var cardTopConstraint: NSLayoutConstraint!
    private var cardBottomStandardConstraint: NSLayoutConstraint!
    private var cardBottomWithMessageActionsConstraint: NSLayoutConstraint!
    private var messageActionBarLeadingConstraint: NSLayoutConstraint!
    private var messageActionBarTrailingConstraint: NSLayoutConstraint!
    private var labelTopToTitleConstraint: NSLayoutConstraint!
    private var labelTopToCardConstraint: NSLayoutConstraint!
    private var imageTopToTitleConstraint: NSLayoutConstraint!
    private var imageTopToCardConstraint: NSLayoutConstraint!
    private var labelTopToImagesConstraint: NSLayoutConstraint!
    private var imageStackHeightConstraint: NSLayoutConstraint!
    private var labelBottomToProcessConstraint: NSLayoutConstraint!
    private var labelBottomToActionsConstraint: NSLayoutConstraint!
    private var labelBottomToSentStatusConstraint: NSLayoutConstraint!
    private var labelTopToProcessButtonConstraint: NSLayoutConstraint!
    private var labelBottomToCardConstraint: NSLayoutConstraint!
    private var labelHeightConstraint: NSLayoutConstraint!
    private var rawStatusTopConstraint: NSLayoutConstraint!
    private var rawStatusBottomConstraint: NSLayoutConstraint!
    private var rawStatusHeightConstraint: NSLayoutConstraint!
    private var collaborationSummaryView: NativeCollaborationRouteSummaryView?
    private var collaborationSummaryTopToTitleConstraint: NSLayoutConstraint?
    private var collaborationSummaryTopToCardConstraint: NSLayoutConstraint?
    private var labelTopToCollaborationSummaryConstraint: NSLayoutConstraint?
    private var expandableTurnId: String?
    private var onToggleExpansion: ((String) -> Void)?
    private var timelineActions: [AppKitChatTimelineRow.Action] = []
    private var onAction: ((AppKitChatTimelineRow.Action) -> Void)?
    private var copiedText = ""
    private var contextTimestamp = ""
    private var hasVisibleMessageStatus = false
    private var messageStatusDetail = ""
    private var representedRowID: String?
    private var replyHeader: NSHostingView<MacReplyIdentityHeader>?
    private var representedReplyIdentity: ConversationReplyIdentity?
    private var representedContentRevision: Int?
    private var representedProcessRow: AppKitChatTimelineRow?
    private var representedImages: [ChatTimelineImage] = []
    private var failedImageIndices: Set<Int> = []
    private(set) var contentConfigurationCount = 0
    private(set) var widthLayoutUpdateCount = 0

    init(identifier: NSUserInterfaceItemIdentifier) {
        super.init(frame: .zero)
        self.identifier = identifier
        clipsToBounds = false
        cardView.translatesAutoresizingMaskIntoConstraints = false
        cardView.identifier = NSUserInterfaceItemIdentifier("chat.timeline.card")
        cardView.wantsLayer = true
        cardView.layer?.cornerCurve = .continuous
        cardView.layer?.cornerRadius = 14
        cardView.layer?.borderWidth = 0
        cardView.layer?.masksToBounds = false
        cardView.layer?.shadowOpacity = 0
        timeSeparatorLabel.translatesAutoresizingMaskIntoConstraints = false
        timeSeparatorLabel.font = .systemFont(ofSize: 10.5, weight: .medium)
        timeSeparatorLabel.textColor = NativeTimelineCardPalette.mutedText
        timeSeparatorLabel.alignment = .center
        timeSeparatorLabel.maximumNumberOfLines = 1
        timeSeparatorLabel.identifier = NSUserInterfaceItemIdentifier("chat.timeline.time-separator")
        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        metadataLabel.translatesAutoresizingMaskIntoConstraints = false
        label.translatesAutoresizingMaskIntoConstraints = false
        imageStack.translatesAutoresizingMaskIntoConstraints = false
        imageStack.orientation = .horizontal
        imageStack.alignment = .centerY
        imageStack.spacing = 7
        rawStatusScrollView.translatesAutoresizingMaskIntoConstraints = false
        disclosureButton.translatesAutoresizingMaskIntoConstraints = false
        messageActionBar.translatesAutoresizingMaskIntoConstraints = false
        messageActionBar.orientation = .horizontal
        messageActionBar.alignment = .centerY
        messageActionBar.spacing = 6
        actionStack.translatesAutoresizingMaskIntoConstraints = false
        actionStack.orientation = .horizontal
        actionStack.alignment = .centerY
        actionStack.spacing = 8
        collaborationSentStatus.translatesAutoresizingMaskIntoConstraints = false
        collaborationSentStatus.orientation = .horizontal
        collaborationSentStatus.alignment = .centerY
        collaborationSentStatus.spacing = 5
        collaborationSentStatusIcon.image = NSImage(
            systemSymbolName: "checkmark.circle.fill",
            accessibilityDescription: L10n("已确认")
        )
        collaborationSentStatusIcon.contentTintColor = .systemGreen
        collaborationSentStatusIcon.identifier = NSUserInterfaceItemIdentifier("chat.timeline.collaboration-sent-icon")
        collaborationSentStatusLabel.font = .systemFont(ofSize: 10, weight: .semibold)
        collaborationSentStatusLabel.textColor = .systemGreen
        collaborationSentStatusLabel.identifier = NSUserInterfaceItemIdentifier("chat.timeline.collaboration-sent-label")
        collaborationSentStatus.addArrangedSubview(collaborationSentStatusIcon)
        collaborationSentStatus.addArrangedSubview(collaborationSentStatusLabel)
        collaborationSentStatus.identifier = NSUserInterfaceItemIdentifier("chat.timeline.collaboration-sent")
        processSeparator.translatesAutoresizingMaskIntoConstraints = false
        processSeparator.wantsLayer = true
        processButton.translatesAutoresizingMaskIntoConstraints = false
        label.isSelectable = true
        rawStatusScrollView.identifier = NSUserInterfaceItemIdentifier("chat.timeline.raw-status")
        rawStatusScrollView.drawsBackground = true
        rawStatusScrollView.backgroundColor = NSColor.black.withAlphaComponent(0.035)
        rawStatusScrollView.borderType = .noBorder
        rawStatusScrollView.hasVerticalScroller = true
        rawStatusScrollView.autohidesScrollers = true
        rawStatusScrollView.scrollerStyle = .overlay
        rawStatusScrollView.wantsLayer = true
        rawStatusScrollView.layer?.cornerRadius = 6
        rawStatusTextView.isEditable = false
        rawStatusTextView.isSelectable = true
        rawStatusTextView.isRichText = false
        rawStatusTextView.drawsBackground = false
        rawStatusTextView.font = .monospacedSystemFont(ofSize: 9.5, weight: .regular)
        rawStatusTextView.textColor = NativeTimelineCardPalette.mutedText
        rawStatusTextView.textContainerInset = NSSize(width: 4, height: 4)
        rawStatusTextView.isHorizontallyResizable = false
        rawStatusTextView.isVerticallyResizable = true
        rawStatusTextView.autoresizingMask = [.width]
        rawStatusTextView.textContainer?.widthTracksTextView = true
        rawStatusTextView.textContainer?.containerSize = NSSize(
            width: 0,
            height: CGFloat.greatestFiniteMagnitude
        )
        rawStatusScrollView.documentView = rawStatusTextView
        disclosureButton.isBordered = false
        disclosureButton.identifier = NSUserInterfaceItemIdentifier("chat.timeline.disclosure")
        disclosureButton.imagePosition = .imageOnly
        disclosureButton.target = self
        disclosureButton.action = #selector(toggleDisclosure)
        disclosureButton.isHidden = true
        messageStatusButton.isBordered = false
        messageStatusButton.imagePosition = .imageLeading
        messageStatusButton.imageHugsTitle = true
        messageStatusButton.font = .systemFont(ofSize: 10, weight: .medium)
        messageStatusButton.target = self
        messageStatusButton.action = #selector(showMessageStatusDetail)
        messageStatusButton.identifier = NSUserInterfaceItemIdentifier("chat.timeline.message-status")
        messageActionBar.identifier = NSUserInterfaceItemIdentifier("chat.timeline.message-actions")
        processButton.isBordered = false
        processButton.alignment = .left
        processButton.imagePosition = .imageLeading
        processButton.imageHugsTitle = true
        processButton.cell?.usesSingleLineMode = false
        processButton.cell?.wraps = true
        processButton.cell?.lineBreakMode = .byWordWrapping
        processButton.target = self
        processButton.action = #selector(toggleDisclosure)
        processButton.identifier = NSUserInterfaceItemIdentifier("chat.timeline.process")
        titleLabel.identifier = NSUserInterfaceItemIdentifier("chat.timeline.title")
        metadataLabel.identifier = NSUserInterfaceItemIdentifier("chat.timeline.metadata")
        addSubview(timeSeparatorLabel)
        addSubview(cardView)
        addSubview(messageActionBar)
        [
            titleLabel,
            metadataLabel,
            imageStack,
            label,
            rawStatusScrollView,
            disclosureButton,
            actionStack,
            collaborationSentStatus,
            processSeparator,
            processButton
        ].forEach(cardView.addSubview)
        processSeparatorHeight = processSeparator.heightAnchor.constraint(equalToConstant: 0)
        processButtonHeight = processButton.heightAnchor.constraint(equalToConstant: 0)
        processButtonTopConstraint = processButton.topAnchor.constraint(equalTo: cardView.topAnchor, constant: 3)
        processButtonBottomConstraint = processButton.bottomAnchor.constraint(equalTo: cardView.bottomAnchor, constant: -3)
        actionStackHeight = actionStack.heightAnchor.constraint(equalToConstant: 0)
        collaborationSentStatusHeight = collaborationSentStatus.heightAnchor.constraint(equalToConstant: 0)
        cardWidthConstraint = cardView.widthAnchor.constraint(equalToConstant: ChatBubbleWidthPolicy.maximumWidth)
        cardLeadingConstraint = cardView.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 2)
        cardTrailingConstraint = cardView.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -2)
        cardTopConstraint = cardView.topAnchor.constraint(equalTo: topAnchor, constant: 1)
        cardBottomStandardConstraint = cardView.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -1)
        cardBottomWithMessageActionsConstraint = cardView.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -27)
        messageActionBarLeadingConstraint = messageActionBar.leadingAnchor.constraint(equalTo: cardView.leadingAnchor, constant: 2)
        messageActionBarTrailingConstraint = messageActionBar.trailingAnchor.constraint(equalTo: cardView.trailingAnchor, constant: -2)
        labelTopToTitleConstraint = label.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: 6)
        labelTopToCardConstraint = label.topAnchor.constraint(equalTo: cardView.topAnchor, constant: 10)
        imageTopToTitleConstraint = imageStack.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: 7)
        imageTopToCardConstraint = imageStack.topAnchor.constraint(equalTo: cardView.topAnchor, constant: 10)
        labelTopToImagesConstraint = label.topAnchor.constraint(equalTo: imageStack.bottomAnchor, constant: MessageCardMetrics.contentSpacing)
        imageStackHeightConstraint = imageStack.heightAnchor.constraint(equalToConstant: 0)
        labelBottomToProcessConstraint = label.bottomAnchor.constraint(lessThanOrEqualTo: processSeparator.topAnchor, constant: -5)
        labelBottomToActionsConstraint = label.bottomAnchor.constraint(lessThanOrEqualTo: actionStack.topAnchor, constant: -4)
        labelBottomToSentStatusConstraint = label.bottomAnchor.constraint(
            lessThanOrEqualTo: collaborationSentStatus.topAnchor,
            constant: -4
        )
        labelTopToProcessButtonConstraint = label.topAnchor.constraint(equalTo: processButton.bottomAnchor, constant: 8)
        labelBottomToCardConstraint = label.bottomAnchor.constraint(lessThanOrEqualTo: cardView.bottomAnchor, constant: -10)
        labelHeightConstraint = label.heightAnchor.constraint(equalToConstant: 0)
        rawStatusTopConstraint = rawStatusScrollView.topAnchor.constraint(equalTo: label.bottomAnchor, constant: 8)
        rawStatusBottomConstraint = rawStatusScrollView.bottomAnchor.constraint(equalTo: cardView.bottomAnchor, constant: -10)
        rawStatusHeightConstraint = rawStatusScrollView.heightAnchor.constraint(equalToConstant: 0)
        NSLayoutConstraint.activate([
            cardWidthConstraint,
            cardLeadingConstraint,
            cardTopConstraint,
            cardBottomStandardConstraint,
            timeSeparatorLabel.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            timeSeparatorLabel.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
            timeSeparatorLabel.topAnchor.constraint(equalTo: topAnchor, constant: 3),
            timeSeparatorLabel.heightAnchor.constraint(equalToConstant: 18),
            disclosureButton.leadingAnchor.constraint(equalTo: cardView.leadingAnchor, constant: 10),
            disclosureButton.topAnchor.constraint(equalTo: cardView.topAnchor, constant: 8),
            disclosureButton.widthAnchor.constraint(equalToConstant: 16),
            disclosureButton.heightAnchor.constraint(equalToConstant: 16),
            titleLabel.leadingAnchor.constraint(equalTo: cardView.leadingAnchor, constant: 10),
            titleLabel.topAnchor.constraint(equalTo: cardView.topAnchor, constant: 9),
            metadataLabel.trailingAnchor.constraint(equalTo: cardView.trailingAnchor, constant: -10),
            metadataLabel.centerYAnchor.constraint(equalTo: titleLabel.centerYAnchor),
            messageActionBar.topAnchor.constraint(equalTo: cardView.bottomAnchor, constant: 2),
            messageActionBar.heightAnchor.constraint(equalToConstant: 22),
            label.leadingAnchor.constraint(equalTo: cardView.leadingAnchor, constant: 10),
            label.trailingAnchor.constraint(equalTo: cardView.trailingAnchor, constant: -10),
            imageStack.leadingAnchor.constraint(equalTo: cardView.leadingAnchor, constant: 10),
            imageStack.trailingAnchor.constraint(lessThanOrEqualTo: cardView.trailingAnchor, constant: -10),
            imageStackHeightConstraint,
            labelHeightConstraint,
            rawStatusScrollView.leadingAnchor.constraint(equalTo: cardView.leadingAnchor, constant: 10),
            rawStatusScrollView.trailingAnchor.constraint(equalTo: cardView.trailingAnchor, constant: -10),
            rawStatusHeightConstraint,
            labelTopToTitleConstraint,
            labelBottomToProcessConstraint,
            actionStack.leadingAnchor.constraint(equalTo: cardView.leadingAnchor, constant: 10),
            actionStack.trailingAnchor.constraint(lessThanOrEqualTo: cardView.trailingAnchor, constant: -10),
            actionStack.bottomAnchor.constraint(equalTo: processSeparator.topAnchor, constant: -4),
            actionStackHeight,
            collaborationSentStatus.leadingAnchor.constraint(equalTo: cardView.leadingAnchor, constant: 10),
            collaborationSentStatus.bottomAnchor.constraint(equalTo: processSeparator.topAnchor, constant: -4),
            collaborationSentStatusHeight,
            processSeparator.leadingAnchor.constraint(equalTo: cardView.leadingAnchor, constant: 10),
            processSeparator.trailingAnchor.constraint(equalTo: cardView.trailingAnchor, constant: -10),
            processSeparator.bottomAnchor.constraint(equalTo: processButton.topAnchor),
            processSeparatorHeight,
            processButton.leadingAnchor.constraint(equalTo: cardView.leadingAnchor, constant: 10),
            processButton.trailingAnchor.constraint(equalTo: cardView.trailingAnchor, constant: -10),
            processButtonBottomConstraint,
            processButtonHeight
        ])
        updateTrackingAreas()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func updateCallbacks(
        onToggleExpansion: @escaping (String) -> Void,
        onAction: @escaping (AppKitChatTimelineRow.Action) -> Void
    ) {
        self.onToggleExpansion = onToggleExpansion
        self.onAction = onAction
    }

    func updateAppearance(skin: ConversationSkin) {
        guard self.skin != skin else { return }
        self.skin = skin
        cardView.updateSkin(skin, role: surfaceRole)
        if let row = renderedRow { _ = updateLayoutIfContentUnchanged(row, availableWidth: renderedWidth) }
    }

    func setContent(
        _ row: AppKitChatTimelineRow,
        availableWidth: CGFloat,
        baseDirectory: String? = nil,
        onToggleExpansion: @escaping (String) -> Void,
        onAction: @escaping (AppKitChatTimelineRow.Action) -> Void = { _ in }
    ) {
        let layout = NativeTimelineLayoutCache.shared.layout(for: row, columnWidth: availableWidth, typography: skin.typography(for: row.nativeStyle == .user ? .user : .assistant))
        // Retire the old topology before resizing a reused image canvas. Leaving
        // its fixed width/height attached while shrinking the bubble generates
        // intermediate Auto Layout conflicts before the new topology is installed.
        NSLayoutConstraint.deactivate([
            labelTopToTitleConstraint, labelTopToCardConstraint, imageTopToTitleConstraint,
            imageTopToCardConstraint, labelTopToImagesConstraint, labelTopToProcessButtonConstraint,
            labelBottomToCardConstraint, rawStatusTopConstraint, rawStatusBottomConstraint,
            processButtonTopConstraint, processButtonBottomConstraint
        ])
        imageStack.arrangedSubviews.forEach { imageStack.removeArrangedSubview($0); $0.removeFromSuperview() }
        label.endTextSelection()
        renderedRow = row
        renderedWidth = availableWidth
        measuredTypography = layout.typography
        representedRowID = row.id
        representedReplyIdentity = row.replyIdentity
        if let identity = row.replyIdentity {
            if let replyHeader { replyHeader.rootView = MacReplyIdentityHeader(identity: identity) }
            else {
                let header = NSHostingView(rootView: MacReplyIdentityHeader(identity: identity))
                header.sizingOptions = []
                header.translatesAutoresizingMaskIntoConstraints = false
                addSubview(header)
                NSLayoutConstraint.activate([
                    header.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
                    header.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
                    header.bottomAnchor.constraint(equalTo: cardView.topAnchor, constant: -ReplyIdentityLayout.bottomSpacing),
                    header.heightAnchor.constraint(equalToConstant: ReplyIdentityLayout.headerHeight)
                ])
                replyHeader = header
            }
        } else {
            replyHeader?.removeFromSuperview()
            replyHeader = nil
        }
        representedContentRevision = row.contentRevision
        representedProcessRow = row.nativeStyle == .process ? row : nil
        contentConfigurationCount += 1
        updateLinkContext(baseDirectory: baseDirectory)
        label.textStorage?.setAttributedString(layout.attributedText)
        rawStatusTextView.string = row.rawStatusText
        apply(layout: layout)
        titleLabel.stringValue = row.title
        titleLabel.font = .systemFont(ofSize: 13, weight: .bold)
        metadataLabel.stringValue = row.metadata
        metadataLabel.font = .systemFont(ofSize: 10, weight: .semibold)
        metadataLabel.textColor = NativeTimelineCardPalette.mutedText
        titleLabel.textColor = row.isCollaboration
            ? NativeTimelineCardPalette.collaborationText
            : (row.nativeStyle == .user
                ? NativeTimelineCardPalette.userText
                : NativeTimelineCardPalette.agentText)
        disclosureButton.isHidden = true
        disclosureButton.image = NSImage(
            systemSymbolName: row.isExpanded ? "chevron.down" : "chevron.right",
            accessibilityDescription: row.isExpanded ? "Collapse process" : "Expand process"
        )
        expandableTurnId = row.expandableTurnId
        self.onToggleExpansion = onToggleExpansion
        self.onAction = onAction
        configureActions(row.actions)
        configureCollaborationSentStatus(row.showsCollaborationSentStatus)
        configureImages(row.images, rowID: row.id, galleryLayout: layout.imageLayout)
        labelTopToImagesConstraint.constant = row.nativeText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0 : 7
        copiedText = row.copyText
        contextTimestamp = row.contextTimestamp
        forkItemID = row.forkItemID
        queuedMessageTaskID = row.queuedMessageTaskID
        deletableMessageID = row.deletableMessageID
        forkUnavailableReason = row.forkUnavailableReason
        configureContextMenu()
        configureMessageStatus(row.messageStatus)
        messageActionBar.configure(row, copy: { [weak self] in self?.copyText() },
            fork: { [weak self] in self?.forkMessage() })
        let showsMessageStatus = row.showsReplyActions
        NSLayoutConstraint.deactivate([
            cardBottomStandardConstraint,
            cardBottomWithMessageActionsConstraint,
            messageActionBarLeadingConstraint,
            messageActionBarTrailingConstraint
        ])
        if showsMessageStatus {
            cardBottomWithMessageActionsConstraint.isActive = true
            if row.nativeStyle == .user {
                messageActionBarTrailingConstraint.isActive = true
            } else {
                messageActionBarLeadingConstraint.isActive = true
            }
        } else {
            cardBottomStandardConstraint.isActive = true
        }
        messageActionBar.isHidden = !showsMessageStatus
        messageActionBar.alphaValue = 1
        timeSeparatorLabel.stringValue = row.timeSeparatorText ?? ""
        timeSeparatorLabel.isHidden = row.timeSeparatorText == nil
        cardTopConstraint.constant = row.timeSeparatorHeight + row.replyIdentityHeight + layout.typography.rowInset
        cardLeadingConstraint.isActive = row.nativeStyle != .user
        cardTrailingConstraint.isActive = row.nativeStyle == .user
        let hasProcess = row.processCount != nil
        let isStandaloneProcess = row.nativeStyle == .process
        let showsHeader = row.showsHeader && !isStandaloneProcess
        titleLabel.isHidden = !showsHeader
        metadataLabel.isHidden = !showsHeader
        NSLayoutConstraint.deactivate([
            labelTopToTitleConstraint,
            labelTopToCardConstraint,
            imageTopToTitleConstraint,
            imageTopToCardConstraint,
            labelTopToImagesConstraint,
            labelTopToProcessButtonConstraint,
            labelBottomToCardConstraint,
            rawStatusTopConstraint,
            rawStatusBottomConstraint,
            processButtonTopConstraint,
            processButtonBottomConstraint
        ])
        collaborationSummaryTopToTitleConstraint?.isActive = false
        collaborationSummaryTopToCardConstraint?.isActive = false
        labelTopToCollaborationSummaryConstraint?.isActive = false
        if let route = row.collaborationRoute {
            let summary = ensureCollaborationSummaryView()
            summary.configure(route)
            summary.isHidden = false
            if showsHeader {
                collaborationSummaryTopToTitleConstraint?.isActive = true
            } else {
                collaborationSummaryTopToCardConstraint?.isActive = true
            }
            labelTopToCollaborationSummaryConstraint?.isActive = true
        } else {
            collaborationSummaryView?.isHidden = true
        }
        if isStandaloneProcess {
            NSLayoutConstraint.deactivate([labelBottomToProcessConstraint, labelBottomToActionsConstraint])
            processButtonTopConstraint.isActive = true
            if row.isExpanded {
                labelTopToProcessButtonConstraint.isActive = true
                if layout.rawStatusHeight > 0 {
                    rawStatusTopConstraint.isActive = true
                    rawStatusBottomConstraint.isActive = true
                } else {
                    labelBottomToCardConstraint.isActive = true
                }
            }
        } else {
            if row.collaborationRoute == nil {
                if row.images.isEmpty {
                    (showsHeader ? labelTopToTitleConstraint : labelTopToCardConstraint).isActive = true
                } else {
                    (showsHeader ? imageTopToTitleConstraint : imageTopToCardConstraint).isActive = true
                    labelTopToImagesConstraint.isActive = true
                }
            }
            processButtonBottomConstraint.isActive = true
        }
        label.isHidden = isStandaloneProcess && !row.isExpanded
        processSeparator.isHidden = !hasProcess || isStandaloneProcess
        processButton.isHidden = !hasProcess
        processButton.cell?.wraps = row.isExpanded
        processButton.cell?.lineBreakMode = row.isExpanded ? .byWordWrapping : .byClipping
        processSeparatorHeight.constant = hasProcess && !isStandaloneProcess ? 1 : 0
        processButtonHeight.constant = hasProcess ? 22 + NativeTimelineLayoutCache.processSummaryExtraHeight(
            for: row, cardWidth: layout.cardWidth, includesCurrentStep: true) : 0
        if row.processCount != nil {
            processButton.image = NSImage(
                systemSymbolName: row.processState.symbolName,
                accessibilityDescription: row.processSummary
            )
            processButton.contentTintColor = row.processState.color
            processButton.toolTip = row.isExpanded ? "Collapse execution details" : "Expand execution details"
            setProcessSummary(row.processSummary, expanded: row.isExpanded)
        }
        if row.isPendingInteraction {
            let tint = NSColor.systemOrange
            cardView.configure(tint: tint, opacity: 0.065)
            titleLabel.textColor = tint
        } else if row.isCollaboration {
            cardView.configure(tint: MessageTextCardPalette.collaborationNativeBackground)
        } else {
            switch row.nativeStyle {
            case .user:
                cardView.configure(tint: NativeTimelineCardPalette.userBackground)
            case .agent:
                cardView.configure(tint: row.isCommentary
                    ? MessageTextCardPalette.adaptiveCommentaryNativeBackground
                    : MessageTextCardPalette.agentNativeBackground)
            case .process:
                let tint = row.processState.color
                cardView.configure(tint: tint, opacity: row.isExpanded ? 0.08 : 0.06,
                    radius: row.isExpanded ? 12 : 10, isMessage: false)
            }
        }
        surfaceRole = row.contentSurfaceRole
        cardView.updateSkin(skin, role: surfaceRole)
        processSeparator.layer?.backgroundColor = NSColor.separatorColor.cgColor
        needsLayout = true
    }

    func refreshProcessElapsed(now: Date) {
        guard let row = representedProcessRow, row.processState == .running,
              row.processStartedAt != nil else { return }
        let summary = row.processSummaryText(now: now, advancing: true)
        guard processButton.accessibilityLabel() != summary else { return }
        setProcessSummary(summary, expanded: row.isExpanded)
    }

    private func setProcessSummary(_ summary: String, expanded: Bool) {
        processButton.setAccessibilityLabel(summary)
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = expanded ? .byWordWrapping : .byClipping
        processButton.attributedTitle = NSAttributedString(
            string: "  \(summary)    \(expanded ? "⌄" : "›")",
            attributes: [
                .font: NSFont.monospacedDigitSystemFont(ofSize: 10.5, weight: .medium),
                .foregroundColor: NativeTimelineCardPalette.secondaryText,
                .paragraphStyle: paragraph
            ]
        )
    }

    func updateLinkContext(baseDirectory: String?) {
        label.linkBaseDirectory = baseDirectory
    }

    private func ensureCollaborationSummaryView() -> NativeCollaborationRouteSummaryView {
        if let collaborationSummaryView { return collaborationSummaryView }
        let summary = NativeCollaborationRouteSummaryView()
        summary.translatesAutoresizingMaskIntoConstraints = false
        summary.identifier = NSUserInterfaceItemIdentifier("chat.timeline.collaboration-route")
        cardView.addSubview(summary)
        collaborationSummaryTopToTitleConstraint = summary.topAnchor.constraint(
            equalTo: titleLabel.bottomAnchor,
            constant: 8
        )
        collaborationSummaryTopToCardConstraint = summary.topAnchor.constraint(
            equalTo: cardView.topAnchor,
            constant: 10
        )
        labelTopToCollaborationSummaryConstraint = label.topAnchor.constraint(
            equalTo: summary.bottomAnchor,
            constant: 10
        )
        NSLayoutConstraint.activate([
            summary.leadingAnchor.constraint(equalTo: cardView.leadingAnchor, constant: 10),
            summary.trailingAnchor.constraint(equalTo: cardView.trailingAnchor, constant: -10),
            summary.heightAnchor.constraint(equalToConstant: NativeCollaborationRouteSummaryView.height)
        ])
        collaborationSummaryView = summary
        return summary
    }

    /// Width-only resize updates keep the existing attributed content, action
    /// buttons, and constraint topology. TextKit still receives the quantized
    /// width-derived height, while expensive content configuration is reserved
    /// for an actual row/revision change.
    @discardableResult
    func updateLayoutIfContentUnchanged(
        _ row: AppKitChatTimelineRow,
        availableWidth: CGFloat
    ) -> Bool {
        guard representedRowID == row.id,
              representedContentRevision == row.contentRevision,
              representedReplyIdentity == row.replyIdentity,
              representedImageGeometries == row.imageGeometries else { return false }
        let layout = NativeTimelineLayoutCache.shared.layout(for: row, columnWidth: availableWidth, typography: skin.typography(for: row.nativeStyle == .user ? .user : .assistant))
        renderedWidth = availableWidth
        if measuredTypography != layout.typography {
            let selection = label.selectedRanges
            label.textStorage?.setAttributedString(layout.attributedText)
            label.selectedRanges = selection
            measuredTypography = layout.typography
        }
        if layout.imageLayout.size.width < representedImageLayout.size.width { resizeImages(layout.imageLayout) }
        apply(layout: layout)
        if representedImageLayout != layout.imageLayout { resizeImages(layout.imageLayout) }
        widthLayoutUpdateCount += 1
        ChatPerformanceRecorder.shared.increment(.appKitRowWidthUpdates)
        return true
    }

    private func apply(layout: NativeTimelineLayoutCache.Layout) {
        cardTopConstraint.constant = (renderedRow?.timeSeparatorHeight ?? 0) + layout.typography.rowInset
        cardBottomStandardConstraint.constant = -layout.typography.rowInset
        cardBottomWithMessageActionsConstraint.constant = -26 - layout.typography.rowInset
        labelHeightConstraint.constant = layout.textHeight
        labelTopToImagesConstraint.constant = layout.textHeight > 0 ? MessageCardMetrics.contentSpacing : 0
        rawStatusHeightConstraint.constant = layout.rawStatusHeight
        rawStatusScrollView.isHidden = layout.rawStatusHeight == 0
        cardWidthConstraint.constant = layout.cardWidth
        needsLayout = true
    }

    private func configureActions(_ actions: [AppKitChatTimelineRow.Action]) {
        timelineActions = actions
        actionStack.arrangedSubviews.forEach {
            actionStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
        NSLayoutConstraint.deactivate([labelBottomToProcessConstraint, labelBottomToActionsConstraint])
        if actions.isEmpty {
            actionStackHeight.constant = 0
            actionStack.isHidden = true
            labelBottomToProcessConstraint.isActive = true
            return
        }
        actionStack.isHidden = false
        actionStackHeight.constant = 28
        labelBottomToActionsConstraint.isActive = true
        for (index, action) in actions.enumerated() {
            let button = NSButton(title: action.label, target: self, action: #selector(performTimelineAction(_:)))
            button.tag = index
            button.identifier = NSUserInterfaceItemIdentifier("chat.timeline.action.\(action.id)")
            button.bezelStyle = .rounded
            button.controlSize = .small
            button.contentTintColor = action.isDestructive ? .systemRed : .controlAccentColor
            button.toolTip = action.label
            actionStack.addArrangedSubview(button)
        }
    }

    private func configureCollaborationSentStatus(_ isVisible: Bool) {
        collaborationSentStatus.isHidden = !isVisible
        collaborationSentStatusHeight.constant = isVisible ? 22 : 0
        labelBottomToSentStatusConstraint.isActive = isVisible
        if isVisible {
            labelBottomToProcessConstraint.isActive = false
        }
    }

    private func configureImages(_ images: [ChatTimelineImage], rowID: String, galleryLayout: MessageImageGalleryLayout.Layout) {
        representedImages = images
        failedImageIndices = []
        imageStack.arrangedSubviews.forEach {
            imageStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
        let visible = Array(images.prefix(4))
        representedImageGeometries = images.map(\.resolvedGeometry)
        representedImageLayout = galleryLayout
        let frames = galleryLayout.frames
        imageStack.isHidden = visible.isEmpty
        imageStackHeightConstraint.constant = frames.map(\.maxY).max() ?? 0
        let gallery = NativeImageGalleryCanvas(frame: CGRect(x: 0, y: 0,
            width: frames.map(\.maxX).max() ?? 0, height: imageStackHeightConstraint.constant))
        gallery.translatesAutoresizingMaskIntoConstraints = false
        gallery.widthAnchor.constraint(equalToConstant: gallery.frame.width).isActive = true
        gallery.heightAnchor.constraint(equalToConstant: gallery.frame.height).isActive = true
        if !visible.isEmpty { imageStack.addArrangedSubview(gallery) }
        for (index, attachment) in visible.enumerated() {
            let button = NSButton(frame: frames[index])
            button.isBordered = false
            button.imagePosition = .imageOnly
            button.imageScaling = .scaleProportionallyUpOrDown
            button.wantsLayer = true
            button.layer?.cornerRadius = 9
            button.layer?.masksToBounds = true
            button.tag = index
            button.target = self
            button.action = #selector(openImage(_:))
            button.toolTip = "Open image gallery"
            button.setAccessibilityLabel("Attached image \(index + 1)")
            button.image = NSImage(systemSymbolName: "photo", accessibilityDescription: nil)
            gallery.addSubview(button)
            if index == 3, images.count > 4 {
                button.imagePosition = .imageOverlaps
                button.attributedTitle = NSAttributedString(string: "+\(images.count - 4)", attributes: [
                    .font: NSFont.systemFont(ofSize: 22, weight: .bold), .foregroundColor: NSColor.white,
                    .backgroundColor: NSColor.black.withAlphaComponent(0.55)
                ])
            }
            guard let url = attachment.displayURL else { continue }
            ChatTimelineImageLoader.shared.load(url) { [weak self, weak button] image in
                guard let self, self.representedRowID == rowID,
                      self.representedImages == images else { return }
                if image == nil { self.failedImageIndices.insert(index) }
                button?.image = image ?? NSImage(
                    systemSymbolName: "exclamationmark.triangle",
                    accessibilityDescription: "Image is missing"
                )
                if self.representedImageGeometries != images.map(\.resolvedGeometry) { self.onImageGeometryChanged?() }
            }
        }
    }

    private func resizeImages(_ layout: MessageImageGalleryLayout.Layout) {
        representedImageLayout = layout
        imageStackHeightConstraint.constant = layout.size.height
        guard let canvas = imageStack.arrangedSubviews.first else { return }
        for constraint in canvas.constraints {
            if constraint.firstAttribute == .width { constraint.constant = layout.size.width }
            if constraint.firstAttribute == .height { constraint.constant = layout.size.height }
        }
        for case let button as NSButton in canvas.subviews where layout.frames.indices.contains(button.tag) {
            button.frame = layout.frames[button.tag]
            for badge in button.subviews { badge.setFrameSize(CGSize(width: button.frame.width, height: badge.frame.height)) }
        }
    }

    @objc private func openImage(_ sender: NSButton) {
        // The represented row is reconfigured atomically, so the visible button
        // index always maps to the current row's attachment.
        guard sender.tag < representedImages.count else { return }
        ChatImageGalleryViewer.shared.show(representedImages, selected: sender.tag)
        return
    }

    override func viewDidMoveToSuperview() {
        super.viewDidMoveToSuperview()
        messageGlow?.allowRowOverflow()
    }

    private func configureMessageStatus(_ status: UserMessageStatusPresentation?) {
        hasVisibleMessageStatus = false
        messageStatusButton.isHidden = true
        guard let status else {
            messageGlow?.removeFromSuperview()
            messageGlow = nil
            cardView.toolTip = nil
            messageStatusDetail = ""
            return
        }
        if let messageGlow {
            messageGlow.configure(status)
        } else {
            let glow = NativeMessageStatusGlow(frame: .zero)
            glow.configure(status)
            glow.translatesAutoresizingMaskIntoConstraints = false
            addSubview(glow, positioned: .below, relativeTo: cardView)
            NSLayoutConstraint.activate([
                glow.leadingAnchor.constraint(equalTo: cardView.leadingAnchor),
                glow.trailingAnchor.constraint(equalTo: cardView.trailingAnchor),
                glow.topAnchor.constraint(equalTo: cardView.topAnchor),
                glow.bottomAnchor.constraint(equalTo: cardView.bottomAnchor)
            ])
            messageGlow = glow
        }
        let language = Locale.current.language.languageCode?.identifier ?? "en"
        messageStatusDetail = status.detail(languageCode: language)
        cardView.toolTip = messageStatusDetail
        messageStatusButton.title = status.shortLabel(languageCode: language)
        messageStatusButton.image = NSImage(
            systemSymbolName: status.symbolName,
            accessibilityDescription: messageStatusDetail
        )
        messageStatusButton.contentTintColor = switch status.tone {
        case .neutral: NativeTimelineCardPalette.secondaryText
        case .amber: NSColor.systemOrange
        case .green: NSColor.systemGreen
        case .red: NSColor.systemRed
        }
        messageStatusButton.toolTip = messageStatusDetail
        messageStatusButton.setAccessibilityLabel(messageStatusDetail)
    }

    @objc private func showMessageStatusDetail() {
        guard !messageStatusDetail.isEmpty else { return }
        let popover = NSPopover()
        popover.behavior = .transient
        let controller = NSViewController()
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 300, height: 90))
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.drawsBackground = false
        let detail = NSTextView(frame: scroll.bounds)
        detail.string = messageStatusDetail
        detail.font = .systemFont(ofSize: 12)
        detail.isEditable = false
        detail.isSelectable = true
        detail.drawsBackground = false
        detail.textContainerInset = NSSize(width: 10, height: 10)
        detail.isHorizontallyResizable = false
        detail.autoresizingMask = [.width]
        detail.textContainer?.widthTracksTextView = true
        scroll.documentView = detail
        controller.view = scroll
        popover.contentViewController = controller
        popover.contentSize = NSSize(width: 300, height: 90)
        popover.show(relativeTo: messageStatusButton.bounds, of: messageStatusButton, preferredEdge: .maxY)
    }

    @objc private func forkMessage() {
        guard let forkItemID else { return }
        onAction?(.init(id: "fork:\(forkItemID)", label: L10n("Create Branch"), isDestructive: false,
                        kind: .forkMessage(itemID: forkItemID)))
    }

    @objc private func deleteUnreceivedMessage() {
        guard let id = deletableMessageID else { return }
        onAction?(.init(id: "delete:\(id)", label: "删除", isDestructive: true,
            kind: .deleteUnreceivedMessage(messageID: id)))
    }

    @objc private func cancelQueuedMessage() {
        guard let taskID = queuedMessageTaskID else { return }
        onAction?(.init(id: "cancel-queued:\(taskID)", label: L10n("Cancel"),
                        isDestructive: true, kind: .cancelQueuedMessage(taskID: taskID)))
    }

    private func configureContextMenu() {
        guard representedProcessRow == nil else {
            self.menu = nil
            cardView.menu = nil
            label.cardContextMenu = nil
            label.endTextSelection()
            setAccessibilityCustomActions([])
            return
        }
        let menu = NSMenu()
        if deletableMessageID != nil {
            let deletion = NSMenuItem(title: "删除", action: #selector(deleteUnreceivedMessage), keyEquivalent: "")
            deletion.target = self
            deletion.image = NSImage(systemSymbolName: "trash", accessibilityDescription: nil)
            menu.addItem(deletion)
        }
        if !contextTimestamp.isEmpty {
            let timestamp = NSMenuItem(title: L10nFormat("Time: %@", contextTimestamp), action: nil, keyEquivalent: "")
            timestamp.image = NSImage(systemSymbolName: "clock", accessibilityDescription: nil)
            timestamp.isEnabled = false
            timestamp.identifier = NSUserInterfaceItemIdentifier("chat.timeline.context.timestamp")
            menu.addItem(timestamp)
        }
        let hasCopy = !copiedText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        if !menu.items.isEmpty { menu.addItem(.separator()) }
        if hasCopy {
            let copy = NSMenuItem(title: L10n("Copy Message"), action: #selector(copyText), keyEquivalent: "")
            copy.target = self
            copy.image = NSImage(systemSymbolName: "doc.on.doc", accessibilityDescription: nil)
            copy.identifier = NSUserInterfaceItemIdentifier("chat.timeline.context.copy")
            menu.addItem(copy)
        }
        if queuedMessageTaskID != nil {
            let cancel = NSMenuItem(title: L10n("Cancel"), action: #selector(cancelQueuedMessage), keyEquivalent: "")
            cancel.target = self
            cancel.image = NSImage(systemSymbolName: "xmark.circle", accessibilityDescription: nil)
            cancel.identifier = NSUserInterfaceItemIdentifier("chat.timeline.context.cancel-queued")
            menu.addItem(cancel)
        }
        if forkItemID != nil {
            let fork = NSMenuItem(title: L10n("Create Branch"), action: #selector(forkMessage), keyEquivalent: "")
            fork.target = self
            fork.image = NSImage(systemSymbolName: "arrow.triangle.branch", accessibilityDescription: nil)
            fork.identifier = NSUserInterfaceItemIdentifier("chat.timeline.context.fork")
            menu.addItem(fork)
        } else if let forkUnavailableReason {
            let fork = NSMenuItem(title: L10n("Create Branch"), action: nil, keyEquivalent: "")
            fork.image = NSImage(systemSymbolName: "arrow.triangle.branch", accessibilityDescription: nil)
            fork.isEnabled = false
            fork.identifier = NSUserInterfaceItemIdentifier("chat.timeline.context.fork")
            menu.addItem(fork)
            let reason = NSMenuItem(title: forkUnavailableReason, action: nil, keyEquivalent: "")
            reason.isEnabled = false
            reason.indentationLevel = 1
            reason.identifier = NSUserInterfaceItemIdentifier("chat.timeline.context.fork-reason")
            menu.addItem(reason)
        }
        self.menu = menu.items.isEmpty ? nil : menu
        cardView.menu = self.menu
        label.cardContextMenu = self.menu
        var accessibilityActions: [NSAccessibilityCustomAction] = []
        if hasCopy {
            accessibilityActions.append(NSAccessibilityCustomAction(
                name: L10n("Copy Message"), target: self, selector: #selector(copyText)
            ))
        }
        accessibilityActions.append(NSAccessibilityCustomAction(
            name: L10n("Select Text"), target: self, selector: #selector(selectText)
        ))
        if forkItemID != nil {
            accessibilityActions.append(NSAccessibilityCustomAction(
                name: L10n("Create Branch"), target: self, selector: #selector(forkMessage)
            ))
        }
        if queuedMessageTaskID != nil {
            accessibilityActions.append(NSAccessibilityCustomAction(
                name: L10n("Cancel"), target: self, selector: #selector(cancelQueuedMessage)
            ))
        }
        setAccessibilityCustomActions(accessibilityActions)
    }

    @objc private func selectText() {
        label.beginTextSelection()
    }

    @objc private func toggleDisclosure() {
        guard let expandableTurnId else { return }
        onToggleExpansion?(expandableTurnId)
    }

    @objc private func copyText() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(copiedText, forType: .string)
    }

    @objc private func performTimelineAction(_ sender: NSButton) {
        guard timelineActions.indices.contains(sender.tag) else { return }
        onAction?(timelineActions[sender.tag])
    }
}

private final class NativeImageGalleryCanvas: NSView {
    override var isFlipped: Bool { true }
}

private enum NativeTimelineCardPalette {
    static let secondaryText = NSColor.labelColor
    static let mutedText = NSColor.secondaryLabelColor
    static let userText = MessageTextCardPalette.userNativeForeground
    static let agentText = NSColor.labelColor
    static let collaborationText = NSColor.labelColor
    static let userBackground = MessageTextCardPalette.userNativeBackground
    static let agentBackground = NSColor(calibratedRed: 0.952, green: 0.961, blue: 0.941, alpha: 1)
    static let userBorder = NSColor(calibratedRed: 0.45, green: 0.58, blue: 0.76, alpha: 0.22)
}
