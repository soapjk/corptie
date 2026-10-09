import AppKit
import SwiftUI
import CorptieConversation
import CorptieClientCore

struct AppKitChatTimelineRow: Identifiable {
    var forkItemID: String? = nil
    var queuedMessageTaskID: String? = nil
    var deletableMessageID: String? = nil
    var scheduledMessageSource: String? = nil
    var forkUnavailableReason: String? = nil
    var timeSeparatorText: String? = nil
    var isWorkspaceCard = false
    var isCommentary = false
    var userInput: ConversationUserInput? = nil
    var userInputItemID: String? = nil
    var userInputStatus: String? = nil
    var executionPlan: ConversationExecutionPlan? = nil
    var sessionID: String? = nil
    typealias ProcessState = ConversationProcessState

    struct Action: Identifiable {
        enum Kind {
            case cancelQueuedMessage(taskID: String)
            case deleteUnreceivedMessage(messageID: String)
            case forkMessage(itemID: String)
            case codexApproval(CodexApprovalOption)
            case ptyChoice(CodexApprovalOption, choiceID: String)
            case sendMessage(String)
            case collaborationConfirmation(id: String, approve: Bool)
            case reviewChanges(turnID: String)
            case undoChanges(turnID: String)
        }

        let id: String
        let label: String
        let isDestructive: Bool
        let kind: Kind
    }

    let id: String
    var contentRevision: Int
    let nativeText: String
    let rawStatusText: String
    let copyText: String
    let nativeStyle: NativeStyle
    let title: String
    let metadata: String
    let isCollaboration: Bool
    let collaborationRoute: NativeCollaborationRoutePresentation?
    let expandableTurnId: String?
    let isExpanded: Bool
    let processCount: Int?
    let processDuration: String?
    let processStartedAt: Date?
    let processState: ProcessState
    let processSteps: [NativeExecutionTimelineStep]
    let processPlan: ConversationExecutionPlan?
    let processCurrentStepTitle: String?
    let showsHeader: Bool
    let contextTimestamp: String
    let messageDate: Date?
    let actions: [Action]
    let isPendingInteraction: Bool
    let showsCollaborationSentStatus: Bool
    let messageStatus: UserMessageStatusPresentation?
    let images: [ChatTimelineImage]

    var showsMessageStatusBar: Bool {
        !showsHeader
            && messageStatus != nil
            && (nativeStyle == .user || nativeStyle == .agent)
    }

    var timeSeparatorHeight: CGFloat { timeSeparatorText == nil ? 0 : 28 }

    init(
        id: String,
        contentRevision: Int,
        nativeText: String,
        rawStatusText: String = "",
        copyText: String,
        nativeStyle: NativeStyle,
        title: String,
        metadata: String,
        isCollaboration: Bool = false,
        collaborationRoute: NativeCollaborationRoutePresentation? = nil,
        expandableTurnId: String?,
        isExpanded: Bool,
        processCount: Int? = nil,
        processDuration: String? = nil,
        processStartedAt: Date? = nil,
        processState: ProcessState = .completed,
        processSteps: [NativeExecutionTimelineStep] = [],
        processPlan: ConversationExecutionPlan? = nil,
        processCurrentStepTitle: String? = nil,
        showsHeader: Bool = true,
        contextTimestamp: String = "",
        messageDate: Date? = nil,
        actions: [Action] = [],
        isPendingInteraction: Bool = false,
        showsCollaborationSentStatus: Bool = false,
        messageStatus: UserMessageStatusPresentation? = nil,
        images: [ChatTimelineImage] = []
    ) {
        self.id = id
        self.contentRevision = contentRevision
        self.nativeText = nativeText
        self.rawStatusText = rawStatusText
        self.copyText = copyText
        self.nativeStyle = nativeStyle
        self.title = title
        self.metadata = metadata
        self.isCollaboration = isCollaboration
        self.collaborationRoute = collaborationRoute
        self.expandableTurnId = expandableTurnId
        self.isExpanded = isExpanded
        self.processCount = processCount
        self.processDuration = processDuration
        self.processStartedAt = processStartedAt
        self.processState = processState
        self.processSteps = processSteps
        self.processPlan = processPlan
        self.processCurrentStepTitle = processCurrentStepTitle
        self.showsHeader = showsHeader
        self.contextTimestamp = contextTimestamp
        self.messageDate = messageDate
        self.actions = actions
        self.isPendingInteraction = isPendingInteraction
        self.showsCollaborationSentStatus = showsCollaborationSentStatus
        self.messageStatus = messageStatus
        self.images = images
    }

    enum NativeStyle: Hashable {
        case user
        case agent
        case process
    }

    var processLanguageCode: String?

    func processSummaryText(now: Date = Date(), advancing: Bool = false, includesCurrentStep: Bool = true,
                            languageCode: String? = nil) -> String {
        let duration = advancing && processState == .running
            ? processStartedAt.flatMap { ConversationProcessPresentation.durationText(
                startedAt: $0, endingAt: now, showSeconds: true) }
                ?? processDuration
            : processDuration
        return ConversationProcessPresentation(state: processState, count: processCount ?? 0,
            duration: duration, currentStepTitle: includesCurrentStep ? processCurrentStepTitle : nil)
            .summary(languageCode: languageCode ?? processLanguageCode ?? "en")
    }

    var processSummary: String { processSummaryText() }

    var processPrimarySummary: String {
        processSummaryText(includesCurrentStep: false)
    }

    var processPlanProgressLabel: String? {
        guard let processPlan, processPlan.completionFraction != nil else { return nil }
        return "计划 \(processPlan.steps.filter { $0.status == "completed" }.count)/\(processPlan.steps.count)"
    }

    var processPlanProgress: Double? {
        processPlan?.completionFraction
    }
}

struct ChatTimelineImage: Hashable {
    let managedPath: String
    let displayURL: URL?
    let originalPath: String?
}

struct AppKitChatRowReuseIdentity: Equatable {
    let id: String
    let contentRevision: Int
}

@MainActor
enum ConversationTimeSeparatorPolicy {
    static func applying(
        to rows: [AppKitChatTimelineRow],
        now: Date = Date(),
        calendar: Calendar = .current,
        locale: Locale = .current
    ) -> [AppKitChatTimelineRow] {
        var previousMessageDate: Date?
        return rows.map { row in
            var decorated = row
            decorated.timeSeparatorText = nil
            guard let date = row.messageDate else { return decorated }
            defer { previousMessageDate = date }
            guard let text = ConversationTimeSeparatorText.label(
                for: date, after: previousMessageDate, now: now,
                calendar: calendar, locale: locale
            ) else { return decorated }
            decorated.timeSeparatorText = text
            var hasher = Hasher()
            hasher.combine(row.contentRevision)
            hasher.combine(text)
            decorated.contentRevision = hasher.finalize()
            return decorated
        }
    }
}

enum AppKitChatRowReusePolicy {
    static func commonPrefixCount(
        previous: [AppKitChatRowReuseIdentity],
        next: [AppKitChatRowReuseIdentity]
    ) -> Int {
        zip(previous, next).prefix(while: ==).count
    }
}

/// Deterministic width contract for native AppKit timeline rows.
@MainActor
/// AppKit measurement on top of the shared `MessageBubbleWidthPolicy` clamp.
enum ChatBubbleWidthPolicy {
    static let maximumWidth = MessageBubbleWidthPolicy.maximumWidth
    static let minimumWidth = MessageBubbleWidthPolicy.minimumWidth
    static let horizontalPadding = MessageBubbleWidthPolicy.horizontalPadding
    static let collapsedProcessWidth = MessageBubbleWidthPolicy.collapsedProcessWidth

    static func preferredWidth(
        text: String,
        style: AppKitChatTimelineRow.NativeStyle,
        title: String,
        metadata: String,
        processWidth: CGFloat = 0,
        availableWidth: CGFloat = maximumWidth
    ) -> CGFloat {
        let bodyWidth: CGFloat
        if MessageBubbleWidthPolicy.requiresFullWidthLayout(text) {
            bodyWidth = MessageBubbleWidthPolicy.fullWidthBody
        } else {
            let attributed = NativeMarkdownTextCache.shared.value(text: text, style: style)
            bodyWidth = ceil(attributed.boundingRect(
                with: NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude),
                options: [.usesLineFragmentOrigin, .usesFontLeading]
            ).width)
        }
        let titleWidth = ceil((title as NSString).size(withAttributes: [
            .font: NSFont.systemFont(ofSize: 11, weight: .bold)
        ]).width)
        let metadataWidth = ceil((metadata as NSString).size(withAttributes: [
            .font: NSFont.systemFont(ofSize: 10, weight: .semibold)
        ]).width)
        let headerWidth = titleWidth + metadataWidth + 12
        return MessageBubbleWidthPolicy.preferredWidth(bodyWidth: bodyWidth, headerWidth: headerWidth,
            processWidth: processWidth, availableWidth: availableWidth)
    }

    static func cardWidth(for row: AppKitChatTimelineRow, availableWidth: CGFloat) -> CGFloat {
        if row.isWorkspaceCard {
            return WorkspaceMessageCardLayout.cardWidth(in: availableWidth)
        }
        let fullAvailableWidth = MessageBubbleWidthPolicy.fullAvailableWidth(laneWidth: availableWidth)
        if row.nativeStyle == .process {
            let summaryWidth = ceil((row.processPrimarySummary as NSString).size(withAttributes: [
                .font: NSFont.monospacedDigitSystemFont(ofSize: 10.5, weight: .medium)
            ]).width)
            let secondaryWidth = row.processCurrentStepTitle.map {
                ceil(($0 as NSString).size(withAttributes: [
                    .font: NSFont.systemFont(ofSize: 9.5)
                ]).width)
            } ?? 0
            let progressWidth = row.processPlanProgressLabel.map {
                ceil(($0 as NSString).size(withAttributes: [
                    .font: NSFont.systemFont(ofSize: 9, weight: .semibold)
                ]).width)
            } ?? 0
            if !row.isExpanded {
                // Match ProcessCard's monospaced digits and allow its complete
                // single-line heading to determine the collapsed card width.
                // Do not apply the expanded body/viewport ceiling to this label.
                return max(MessageBubbleWidthPolicy.minimumWidth,
                    summaryWidth + (progressWidth > 0 ? progressWidth + 8 : 0) + 66,
                    secondaryWidth > 0 ? secondaryWidth + 40 : 0)
            }
            return MessageBubbleWidthPolicy.processCardWidth(
                summaryWidth: summaryWidth,
                secondaryWidth: secondaryWidth,
                progressLabelWidth: progressWidth,
                expanded: row.isExpanded,
                laneWidth: availableWidth
            )
        }
        if row.collaborationRoute != nil {
            return min(fullAvailableWidth, maximumWidth)
        }
        let preferred = preferredWidth(
            text: row.nativeText,
            style: row.nativeStyle,
            title: row.showsHeader ? row.title : "",
            metadata: row.showsHeader ? row.metadata : "",
            processWidth: row.processCount == nil ? 0 : collapsedProcessWidth,
            availableWidth: fullAvailableWidth
        )
        return row.images.isEmpty ? preferred
            : min(fullAvailableWidth, max(MessageBubbleWidthPolicy.attachmentMinimumWidth, preferred))
    }
}

struct NativeCollaborationRoutePresentation: Hashable {
    enum DestinationKind: Hashable {
        case existingSession
        case newCorptieTask
    }

    let destinationKind: DestinationKind
    let routeLabel: String
    let sourceLabel: String
    let sourceSession: String
    let sourceWork: String
    let targetLabel: String
    let targetName: String
    let targetWork: String
}

typealias AppKitChatTimelinePosition = ConversationViewportPosition

enum LiveResizeRowReflowPolicy {
    static func indexes(
        rowCount: Int,
        visibleRows: NSRange,
        isLiveResize: Bool
    ) -> IndexSet {
        guard rowCount > 0 else { return [] }
        guard isLiveResize else { return IndexSet(integersIn: 0..<rowCount) }
        guard visibleRows.location != NSNotFound else { return [] }
        let lowerBound = min(rowCount, visibleRows.location)
        let upperBound = min(rowCount, visibleRows.location + visibleRows.length)
        return IndexSet(integersIn: lowerBound..<upperBound)
    }
}

enum LiveResizeWidthPolicy {
    static let bucketSize: CGFloat = 8

    static func measurementWidth(_ width: CGFloat, isLiveResize: Bool) -> CGFloat {
        let normalized = max(120, width)
        guard isLiveResize else { return normalized }
        return max(bucketSize, (normalized / bucketSize).rounded() * bucketSize)
    }

    static func requiresReflow(previous: CGFloat?, next: CGFloat) -> Bool {
        guard let previous else { return true }
        return abs(previous - next) >= 0.5
    }
}
