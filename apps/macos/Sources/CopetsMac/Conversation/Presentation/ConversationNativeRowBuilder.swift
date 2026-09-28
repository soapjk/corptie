import AppKit
import CorptieClientCore
import CorptieConversation
import SwiftUI

/// Value-only projection context; the View retains all cache, task and viewport ownership.
@MainActor
struct ConversationNativeRowBuilder {
    let sessionTitle: String?
    let workingDirectory: String?
    let allowsFork: Bool
    let forkUnavailableReason: String?
    let imageURL: (String) -> URL?

    func nativeAppKitRow(
        _ entry: ChatDisplayEntry,
        expandedTurnIds: Set<String>
    ) -> AppKitChatTimelineRow {
        let text: String
        let rawStatusText: String
        let copyText: String
        let style: AppKitChatTimelineRow.NativeStyle
        let title: String
        let metadata: String
        let expandableTurnId: String?
        let isExpanded: Bool
        var processCount: Int?
        var processDuration: String?
        var processStartedAt: Date?
        var processState: AppKitChatTimelineRow.ProcessState = .completed
        var processSteps: [NativeExecutionTimelineStep] = []
        var processPlan: ConversationExecutionPlan?
        var processCurrentStepTitle: String?
        var showsHeader: Bool
        var contextTimestamp: String
        var messageDate: Date?
        let isCollaboration: Bool
        let collaborationRoute: NativeCollaborationRoutePresentation?
        let actions: [AppKitChatTimelineRow.Action]
        let isPendingInteraction: Bool
        let showsCollaborationSentStatus: Bool
        let messageStatus: UserMessageStatusPresentation?
        var images: [ChatTimelineImage] = []
        switch entry.kind {
        case .message(let item):
            messageStatus = item.type == "userMessage" ? UserMessageStatusPresentation(
                authoritativeStatus: item.userMessageStatus,
                legacyStatus: item.status,
                queuePosition: item.queuePosition,
                processingError: item.processingError
            ) : nil
            images = (item.images ?? []).map { image in
                ChatTimelineImage(
                    managedPath: image.managedPath,
                    displayURL: imageURL(image.managedPath),
                    originalPath: image.originalPath
                )
            }
            let collaboration = nativeCollaborationCardPresentation(
                for: item,
                currentSessionTitle: sessionTitle
            )
            let specialEvent = nativeAutomationCardPresentation(for: item)
                ?? nativeSystemEventCardPresentation(for: item)
            style = collaboration == nil && specialEvent == nil && item.type == "userMessage" ? .user : .agent
            copyText = collaboration?.messageText ?? specialEvent?.messageText
                ?? ChatTimelineRowRouting.copyText(for: item)
            let supplementalText = nativeTimelineSupplementalText(for: item)
            let displayedText = nativeTimelineText(for: item)
            let presentedText = collaboration?.bodyMarkdown ?? specialEvent?.bodyMarkdown ?? (supplementalText.isEmpty
                ? displayedText
                : "\(displayedText)\n\n\(supplementalText)")
            let existingImageURLs = Set(images.compactMap(\.displayURL))
            images.append(contentsOf: MessageMarkdownImageResolver.references(
                in: presentedText,
                baseDirectory: workingDirectory
            ).compactMap { reference in
                guard !existingImageURLs.contains(reference.url) else { return nil }
                return ChatTimelineImage(
                    managedPath: "markdown:\(reference.url.absoluteString)",
                    displayURL: reference.url,
                    originalPath: reference.url.isFileURL ? reference.url.path : nil
                )
            })
            text = ClickableMessageText.markdown(
                from: presentedText,
                baseDirectory: workingDirectory
            )
            let isOrdinaryMessage = collaboration == nil && specialEvent == nil
                && (item.type == "userMessage" || item.type == "agentMessage")
            title = collaboration?.title ?? specialEvent?.title ?? (isOrdinaryMessage ? "" : item.title)
            metadata = collaboration?.metadata ?? specialEvent?.metadata ?? (isOrdinaryMessage ? "" : nativeTimelineMetadata(for: item))
            showsHeader = !isOrdinaryMessage
            contextTimestamp = isOrdinaryMessage ? nativeTimelineMetadata(for: item) : ""
            messageDate = isOrdinaryMessage
                ? item.createdAt.flatMap(ISO8601DateFormatter.corptieThreadItemDate(from:))
                : nil
            expandableTurnId = nil
            isExpanded = false
            processCount = nil
            processDuration = nil
            processStartedAt = nil
            actions = nativeTimelineActions(for: item)
            isPendingInteraction = (item.type == "approval" || item.type == "choice" || item.type == "userInput")
                && item.status == "pending"
            showsCollaborationSentStatus = collaboration != nil
                && (item.collaborationConfirmationStatus ?? item.status ?? "").lowercased() == "confirmed"
            rawStatusText = ""
            isCollaboration = collaboration != nil
            collaborationRoute = collaboration?.route
        case .process(let turnId, let items):
            messageStatus = nil
            processPlan = items.compactMap(\.executionPlan).last(where: { $0.schemaVersion == 1 })
            images = items.flatMap { item in
                (item.images ?? []).map { image in
                    ChatTimelineImage(
                        managedPath: image.managedPath,
                        displayURL: imageURL(image.managedPath),
                        originalPath: image.originalPath
                    )
                }
            }
            let expanded = expandedTurnIds.contains(turnId)
            if expanded {
                processSteps = NativeExecutionTimelineProjection.steps(for: items)
                let processStepsText = NativeExecutionTimelineProjection.plainText(for: processSteps)
                // Provider metadata is diagnostic data, not conversation content.
                // Keep the visible and copied process text on the same semantic projection.
                rawStatusText = ""
                copyText = processStepsText
                text = processStepsText
            } else {
                rawStatusText = ""
                copyText = ""
                text = ""
            }
            style = .process
            title = ""
            metadata = ""
            expandableTurnId = turnId
            isExpanded = expanded
            processCount = items.count
            processDuration = executionProcessDurationText(for: items)
            processStartedAt = items.contains(where: { $0.processEndedAt != nil })
                ? nil : ConversationProcessPresentation.startedAt(for: items)
            processState = projectedProcessState(for: items)
            if processState == .running, let last = items.last {
                if last.type == "executionPlan", let plan = processPlan {
                    processCurrentStepTitle = plan.steps.first(where: { $0.status == "inProgress" })?.text
                        ?? plan.steps.first(where: { $0.status == "pending" })?.text
                } else {
                    processCurrentStepTitle = L10n(NativeExecutionTimelineProjection.title(for: last))
                }
            }
            showsHeader = false
            contextTimestamp = ""
            messageDate = nil
            actions = []
            isPendingInteraction = false
            showsCollaborationSentStatus = false
            isCollaboration = false
            collaborationRoute = nil
        }
        var row = AppKitChatTimelineRow(
            id: entry.id,
            contentRevision: appKitContentRevision(entry, expandedTurnIds: expandedTurnIds),
            nativeText: text,
            rawStatusText: rawStatusText,
            copyText: copyText,
            nativeStyle: style,
            title: title,
            metadata: metadata,
            isCollaboration: isCollaboration,
            collaborationRoute: collaborationRoute,
            expandableTurnId: expandableTurnId,
            isExpanded: isExpanded,
            processCount: processCount,
            processDuration: processDuration,
            processStartedAt: processStartedAt,
            processState: processState,
            processSteps: processSteps,
            processPlan: processPlan,
            processCurrentStepTitle: processCurrentStepTitle,
            showsHeader: showsHeader,
            contextTimestamp: contextTimestamp,
            messageDate: messageDate,
            actions: actions,
            isPendingInteraction: isPendingInteraction,
            showsCollaborationSentStatus: showsCollaborationSentStatus,
            messageStatus: messageStatus,
            images: images
        )
        row.forkItemID = forkItemID(for: entry)
        row.forkUnavailableReason = forkUnavailableReason(for: entry)
        return row
    }

    func forkItemID(for entry: ChatDisplayEntry) -> String? {
        if case .message(let item) = entry.kind,
           item.type == "agentMessage",
           item.presentationRole == "final_answer",
           ["complete", "completed", "interrupted", "cancelled", "failed"].contains(item.turnStatus),
           allowsFork {
            return item.id
        }
        return nil
    }

    func forkUnavailableReason(for entry: ChatDisplayEntry) -> String? {
        guard !allowsFork, forkUnavailableReason != nil else { return nil }
        if case .message(let item) = entry.kind,
           item.type == "agentMessage",
           item.presentationRole == "final_answer",
           ["complete", "completed", "interrupted", "cancelled", "failed"].contains(item.turnStatus) {
            return forkUnavailableReason
        }
        return nil
    }

    private func nativeTimelineMetadata(for item: CodexThreadItem) -> String {
        nativeTimelineTimestampText(createdAt: item.createdAt)
    }

    private func nativeTimelineText(for item: CodexThreadItem) -> String {
        ChatTimelineRowRouting.displayText(for: item)
    }

    private func nativeTimelineSupplementalText(for item: CodexThreadItem) -> String {
        var sections: [String] = []
        if item.type == "userInput" {
            switch item.status {
            case "submitted": sections.append("已提交，等待会话更新")
            case "dispatching": sections.append("正在提交，等待确认")
            case "unknown": sections.append("提交结果待同步，请勿重复提交")
            case "expired": sections.append("此问题已失效")
            case "cancelled": sections.append("已取消请求")
            default: break
            }
        }
        if item.type == "choice",
           item.status == "selected",
           let selected = item.options?.first(where: { $0.selected == true }) {
            sections.append("Selected: \(selected.label)")
        }
        if let fileChanges = item.fileChanges, !fileChanges.isEmpty {
            let paths = fileChanges.map { change in
                let marker = switch change.kind {
                case "add": "+"
                case "delete": "−"
                default: "•"
                }
                return "\(marker) `\(change.path)`"
            }
            sections.append((["**Changed Files**"] + paths).joined(separator: "\n"))
        }
        return sections.joined(separator: "\n\n")
    }

    private func nativeTimelineActions(for item: CodexThreadItem) -> [AppKitChatTimelineRow.Action] {
        if item.presentationRole == "collaboration_confirmation"
            || item.type == "collaborationConfirmation",
           (item.collaborationConfirmationStatus ?? item.status ?? "pending").lowercased() == "pending",
           let confirmationID = item.collaborationConfirmationId {
            return [
                .init(
                    id: "\(item.id):confirm",
                    label: L10n("确认发送"),
                    isDestructive: false,
                    kind: .collaborationConfirmation(id: confirmationID, approve: true)
                ),
                .init(
                    id: "\(item.id):cancel",
                    label: L10n("取消"),
                    isDestructive: true,
                    kind: .collaborationConfirmation(id: confirmationID, approve: false)
                )
            ]
        }

        if item.type == "userInput", item.status == "pending",
           item.userInput?.schemaVersion == 1 {
            return [.init(id: "\(item.id):answer", label: "回答", isDestructive: false,
                kind: .userInput(itemID: item.id))]
        }

        if nativeTimelineAllowsChoiceActions(type: item.type, status: item.status) {
            let options = (item.options?.isEmpty == false ? item.options : nil)
                ?? (item.type == "approval" || item.type == "choice"
                    ? [
                        CodexApprovalOption(id: "approve", label: "Approve", role: "approve", index: 0, selected: false),
                        CodexApprovalOption(id: "deny", label: "Deny", role: "deny", index: 1, selected: false)
                    ]
                    : [])
            if !options.isEmpty {
                return options.map { option in
                    let kind: AppKitChatTimelineRow.Action.Kind = switch item.type {
                    case "approval": .codexApproval(option)
                    case "choice": .ptyChoice(option, choiceID: item.id)
                    default: .sendMessage(option.label)
                    }
                    return .init(
                        id: "\(item.id):\(option.id)",
                        label: option.label,
                        isDestructive: option.role?.localizedCaseInsensitiveContains("deny") == true,
                        kind: kind
                    )
                }
            }
        }

        guard !(item.fileChanges ?? []).isEmpty else { return [] }
        return [
            .init(
                id: "\(item.id):review",
                label: L10n("Review"),
                isDestructive: false,
                kind: .reviewChanges(turnID: item.turnId)
            ),
            .init(
                id: "\(item.id):undo",
                label: L10n("Undo"),
                isDestructive: true,
                kind: .undoChanges(turnID: item.turnId)
            )
        ]
    }

    func appKitContentRevision(
        _ entry: ChatDisplayEntry,
        expandedTurnIds: Set<String>
    ) -> Int {
        var hasher = Hasher()
        hasher.combine(entry.id)
        hasher.combine(forkItemID(for: entry))
        hasher.combine(forkUnavailableReason(for: entry))
        switch entry.kind {
        case .message(let item):
            hasher.combine(itemSignature(item))
        case .process(let turnId, let items):
            hasher.combine(turnId)
            hasher.combine(expandedTurnIds.contains(turnId))
            hasher.combine(items.count)
            hasher.combine(items.first?.processStartedAt)
            hasher.combine(items.first?.processEndedAt)
            if let last = items.last {
                hasher.combine(last.turnStatus)
                hasher.combine(last.status)
                hasher.combine(last.id)
                hasher.combine(last.title)
                // A collapsed plan keeps the same row and title while its
                // progress changes. Invalidate that one row so the compact
                // current-step summary does not remain on the old revision.
                hasher.combine(last.executionPlan?.revision)
            }
            if expandedTurnIds.contains(turnId) {
                items.forEach { hasher.combine(itemSignature($0)) }
            }
        }
        return hasher.finalize()
    }

    private func itemSignature(_ item: CodexThreadItem) -> String {
        let text = item.text.trimmingCharacters(in: .whitespacesAndNewlines)
        let presentationText = item.presentationText?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let imageSignature = (item.images ?? []).map(\.managedPath).joined(separator: ",")
        let collaborationSignature = [
            item.collaborationProcessingStatus ?? "",
            item.collaborationSenderName ?? "",
            item.collaborationRecipientName ?? "",
            item.collaborationInitiatorSessionId ?? "",
            item.collaborationRecipientSessionId ?? "",
            item.collaborationRecipientSessionTitle ?? "",
            item.collaborationTaskTitle ?? "",
            item.collaborationSourceCorptieTaskId ?? "",
            item.collaborationTargetCorptieTaskId ?? "",
            item.collaborationRelation ?? "",
            item.collaborationRouteStatus ?? "",
            item.collaborationRoutingVersion.map(String.init) ?? ""
        ].joined(separator: ":") + ":" + imageSignature
        return [
            item.id,
            item.type,
            item.status ?? "",
            item.userMessageStatus ?? "",
            item.queuePosition.map(String.init) ?? "",
            item.turnStatus,
            item.executionPlan.map { "plan:\($0.revision)" } ?? "",
            item.toolExecution.map { "tool:\($0.hashValue)" } ?? "",
            item.changeSet.map { "changes:\($0.hashValue)" } ?? "",
            item.presentationRole ?? "",
            collaborationSignature,
            "\(text.count)",
            String(text.suffix(96)),
            "\(presentationText.count)",
            String(presentationText.suffix(96)),
            fileChangesSignature(item)
        ].joined(separator: ":")
    }
}
