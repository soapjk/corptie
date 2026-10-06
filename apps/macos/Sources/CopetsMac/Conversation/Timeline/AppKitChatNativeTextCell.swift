import AppKit
import SwiftUI
import CorptieConversation
import CorptieClientCore

@MainActor
final class AppKitChatNativeTextCell: NSTableCellView, AppKitChatRowRendering {
    private let cardView = NSView()
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
    private var forkUnavailableReason: String?
    private let messageActionBar = NSStackView()
    private let actionStack = NSStackView()
    private let collaborationSentStatus = NSStackView()
    private let collaborationSentStatusIcon = NSImageView()
    // This footer acknowledges confirmation, not transport delivery.
    private let collaborationSentStatusLabel = NSTextField(labelWithString: L10n("已确认 · 不代表消息已送达"))
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
    private var representedContentRevision: Int?
    private var representedProcessRow: AppKitChatTimelineRow?
    private var representedImages: [ChatTimelineImage] = []
    private(set) var contentConfigurationCount = 0
    private(set) var widthLayoutUpdateCount = 0

    init(identifier: NSUserInterfaceItemIdentifier) {
        super.init(frame: .zero)
        self.identifier = identifier
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
        messageActionBar.addArrangedSubview(messageStatusButton)
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
        labelTopToImagesConstraint = label.topAnchor.constraint(equalTo: imageStack.bottomAnchor, constant: 7)
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

    func setContent(
        _ row: AppKitChatTimelineRow,
        availableWidth: CGFloat,
        baseDirectory: String? = nil,
        onToggleExpansion: @escaping (String) -> Void,
        onAction: @escaping (AppKitChatTimelineRow.Action) -> Void = { _ in }
    ) {
        let layout = NativeTimelineLayoutCache.shared.layout(for: row, columnWidth: availableWidth)
        label.endTextSelection()
        representedRowID = row.id
        representedContentRevision = row.contentRevision
        representedProcessRow = row.nativeStyle == .process ? row : nil
        contentConfigurationCount += 1
        updateLinkContext(baseDirectory: baseDirectory)
        label.textStorage?.setAttributedString(layout.attributedText)
        rawStatusTextView.string = row.rawStatusText
        apply(layout: layout)
        titleLabel.stringValue = row.title
        titleLabel.font = .systemFont(ofSize: 11, weight: .bold)
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
        configureImages(row.images, rowID: row.id)
        copiedText = row.copyText
        contextTimestamp = row.contextTimestamp
        forkItemID = row.forkItemID
        queuedMessageTaskID = row.queuedMessageTaskID
        forkUnavailableReason = row.forkUnavailableReason
        configureContextMenu()
        configureMessageStatus(row.messageStatus)
        let showsMessageStatus = row.showsMessageStatusBar
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
        cardTopConstraint.constant = row.timeSeparatorText == nil ? 1 : 29
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
            cardView.layer?.borderWidth = 1
            let tint = NSColor.systemOrange
            cardView.layer?.backgroundColor = tint.withAlphaComponent(0.065).cgColor
            cardView.layer?.borderColor = tint.withAlphaComponent(0.36).cgColor
            titleLabel.textColor = tint
        } else if row.isCollaboration {
            cardView.layer?.borderWidth = 1
            cardView.layer?.backgroundColor = NSColor(
                calibratedRed: 0.945,
                green: 0.955,
                blue: 0.995,
                alpha: 1
            ).cgColor
            cardView.layer?.borderColor = NSColor(
                calibratedRed: 0.42,
                green: 0.47,
                blue: 0.78,
                alpha: 0.24
            ).cgColor
        } else {
            switch row.nativeStyle {
            case .user:
                cardView.layer?.borderWidth = 0
                cardView.layer?.backgroundColor = NativeTimelineCardPalette.userBackground.cgColor
                cardView.layer?.borderColor = NativeTimelineCardPalette.userBorder.cgColor
            case .agent:
                cardView.layer?.borderWidth = 0
                cardView.layer?.backgroundColor = (row.isCommentary
                    ? MessageTextCardPalette.commentaryNativeBackground
                    : NativeTimelineCardPalette.agentBackground).cgColor
                cardView.layer?.borderColor = NSColor.black.withAlphaComponent(0.08).cgColor
            case .process:
                cardView.layer?.borderWidth = 0
                let tint = row.processState.color
                cardView.layer?.backgroundColor = tint.withAlphaComponent(row.isExpanded ? 0.055 : 0.035).cgColor
                cardView.layer?.borderColor = tint.withAlphaComponent(0.16).cgColor
                cardView.layer?.cornerRadius = row.isExpanded ? 12 : 10
            }
        }
        if row.nativeStyle != .process { cardView.layer?.cornerRadius = 14 }
        processSeparator.layer?.backgroundColor = NSColor.black.withAlphaComponent(0.045).cgColor
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
        paragraph.lineBreakMode = .byWordWrapping
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
              representedContentRevision == row.contentRevision else { return false }
        let layout = NativeTimelineLayoutCache.shared.layout(for: row, columnWidth: availableWidth)
        apply(layout: layout)
        widthLayoutUpdateCount += 1
        ChatPerformanceRecorder.shared.increment(.appKitRowWidthUpdates)
        return true
    }

    private func apply(layout: NativeTimelineLayoutCache.Layout) {
        labelHeightConstraint.constant = layout.textHeight
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

    private func configureImages(_ images: [ChatTimelineImage], rowID: String) {
        representedImages = Array(images.prefix(4))
        imageStack.arrangedSubviews.forEach {
            imageStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
        let visible = Array(images.prefix(4))
        imageStack.isHidden = visible.isEmpty
        imageStackHeightConstraint.constant = visible.isEmpty ? 0 : 88
        for (index, attachment) in visible.enumerated() {
            let button = NSButton()
            button.isBordered = false
            button.imagePosition = .imageOnly
            button.imageScaling = .scaleProportionallyUpOrDown
            button.wantsLayer = true
            button.layer?.cornerRadius = 9
            button.layer?.masksToBounds = true
            button.tag = index
            button.target = self
            button.action = #selector(openImage(_:))
            button.toolTip = attachment.originalPath == nil
                ? "Open image"
                : "Reveal original image in Finder"
            button.setAccessibilityLabel("Attached image \(index + 1)")
            button.image = NSImage(systemSymbolName: "photo", accessibilityDescription: nil)
            button.widthAnchor.constraint(equalToConstant: 88).isActive = true
            button.heightAnchor.constraint(equalToConstant: 88).isActive = true
            imageStack.addArrangedSubview(button)
            guard let url = attachment.displayURL else { continue }
            ChatTimelineImageLoader.shared.load(url) { [weak self, weak button] image in
                guard self?.representedRowID == rowID else { return }
                button?.image = image ?? NSImage(
                    systemSymbolName: "exclamationmark.triangle",
                    accessibilityDescription: "Image is missing"
                )
            }
        }
    }

    @objc private func openImage(_ sender: NSButton) {
        // The represented row is reconfigured atomically, so the visible button
        // index always maps to the current row's attachment.
        guard sender.tag < representedImages.count else { return }
        let image = representedImages[sender.tag]
        if let originalPath = image.originalPath,
           FileManager.default.fileExists(atPath: originalPath) {
            NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: originalPath)])
        } else if image.originalPath != nil, let url = image.displayURL {
            let alert = NSAlert()
            alert.messageText = "Original image is missing"
            alert.informativeText = "Corptie kept a managed copy for this conversation."
            alert.addButton(withTitle: "View managed copy")
            alert.addButton(withTitle: "Cancel")
            if alert.runModal() == .alertFirstButtonReturn {
                NSWorkspace.shared.open(url)
            }
        } else if let url = image.displayURL {
            NSWorkspace.shared.open(url)
        }
    }

    private func configureMessageStatus(_ status: UserMessageStatusPresentation?) {
        hasVisibleMessageStatus = status != nil
        guard let status else {
            messageStatusButton.isHidden = true
            messageStatusDetail = ""
            return
        }
        let language = Locale.current.language.languageCode?.identifier ?? "en"
        messageStatusDetail = status.detail(languageCode: language)
        messageStatusButton.isHidden = false
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

private enum NativeTimelineCardPalette {
    static let secondaryText = NSColor(calibratedRed: 0.24, green: 0.27, blue: 0.29, alpha: 1)
    static let mutedText = NSColor(calibratedRed: 0.38, green: 0.41, blue: 0.43, alpha: 1)
    static let userText = MessageTextCardPalette.userNativeForeground
    static let agentText = NSColor(calibratedRed: 0.18, green: 0.48, blue: 0.27, alpha: 1)
    static let collaborationText = NSColor(calibratedRed: 0.30, green: 0.34, blue: 0.68, alpha: 1)
    static let userBackground = MessageTextCardPalette.userNativeBackground
    static let agentBackground = NSColor(calibratedRed: 0.952, green: 0.961, blue: 0.941, alpha: 1)
    static let userBorder = NSColor(calibratedRed: 0.45, green: 0.58, blue: 0.76, alpha: 0.22)
}
