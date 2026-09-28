import AppKit
import CorptieClientCore
import CorptieConversation
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

typealias ChatDisplayEntry = ConversationEntry<CodexThreadItem>

struct DetailDisplayCache: Sendable {
    let sessionId: String
    let displayItems: [CodexThreadItem]
    let displayEntries: [ChatDisplayEntry]
    let totalDisplayEntryCount: Int
    let visibleMessageLimit: Int
    let signature: String
    let sourceSignature: String
    /// Non-nil only when the requested semantic viewport anchor was present
    /// in this bounded projection window.
    let restorationAnchorRowID: String?

    init(
        sessionId: String,
        displayItems: [CodexThreadItem],
        displayEntries: [ChatDisplayEntry],
        totalDisplayEntryCount: Int,
        visibleMessageLimit: Int,
        signature: String,
        sourceSignature: String,
        restorationAnchorRowID: String? = nil
    ) {
        self.sessionId = sessionId
        self.displayItems = displayItems
        self.displayEntries = displayEntries
        self.totalDisplayEntryCount = totalDisplayEntryCount
        self.visibleMessageLimit = visibleMessageLimit
        self.signature = signature
        self.sourceSignature = sourceSignature
        self.restorationAnchorRowID = restorationAnchorRowID
    }
}

func chatDisplayEntryTurnId(_ entry: ChatDisplayEntry) -> String {
    switch entry.kind {
    case .message(let item): item.turnId
    case .process(let turnId, let items): items.first?.turnId ?? turnId
    }
}

func makeDetailDisplayCache(
    for detail: CodexThreadDetail,
    sessionId: String,
    visibleMessageLimit: Int,
    restorationAnchorRowID: String? = nil
) -> DetailDisplayCache {
    let preparedDisplay = makeVisibleDetailDisplay(
        for: detail,
        visibleMessageLimit: visibleMessageLimit,
        restorationAnchorRowID: restorationAnchorRowID
    )
    return DetailDisplayCache(
        sessionId: sessionId,
        displayItems: preparedDisplay.displayItems,
        displayEntries: preparedDisplay.visibleEntries,
        totalDisplayEntryCount: preparedDisplay.totalCount,
        visibleMessageLimit: visibleMessageLimit,
        signature: preparedDisplay.signature,
        sourceSignature: preparedDisplay.sourceSignature,
        restorationAnchorRowID: preparedDisplay.resolvedRestorationAnchorRowID
    )
}

private func makeVisibleDetailDisplay(
    for detail: CodexThreadDetail,
    visibleMessageLimit: Int,
    restorationAnchorRowID: String?
) -> (displayItems: [CodexThreadItem], visibleEntries: [ChatDisplayEntry], totalCount: Int, signature: String, sourceSignature: String, resolvedRestorationAnchorRowID: String?) {
    let displayItems = detail.items
        .filter { !isLowSignalDetailProcessItem($0) }
    let displayEntries = PerfStopwatch.measure("timeline.makeChatDisplayEntries") {
        makeChatDisplayEntries(from: displayItems)
    }
    let anchoredWindow = restorationAnchorRowID.flatMap { anchorRowID in
        restorationDetailEntries(
            from: displayEntries,
            anchorRowID: anchorRowID,
            historyLimit: visibleMessageLimit
        )
    }
    let visibleEntries = anchoredWindow
        ?? visibleDetailEntries(from: displayEntries, limit: visibleMessageLimit)
    return (
        displayItems: displayItems,
        visibleEntries: visibleEntries,
        totalCount: displayEntries.reduce(0) { $0 + $1.displayWeight },
        signature: detailDisplaySignature(for: visibleEntries, visibleMessageLimit: visibleMessageLimit),
        sourceSignature: makeDetailSourceSignature(
            for: detail,
            visibleMessageLimit: visibleMessageLimit,
            restorationAnchorRowID: restorationAnchorRowID
        ),
        resolvedRestorationAnchorRowID: anchoredWindow == nil ? nil : restorationAnchorRowID
    )
}

func makeDetailSourceSignature(
    for detail: CodexThreadDetail,
    visibleMessageLimit: Int,
    restorationAnchorRowID: String? = nil
) -> String {
    // The final assistant message is often followed by multiple execution
    // items in the same turn. Signing only the last two raw items can therefore
    // miss the final text/status mutation and leave the rendered reply stale.
    // Bound the work to the current tail turn: this covers the whole active
    // response without hashing historical messages on every stream update.
    let tailTurnID = detail.items.last?.turnId
    let items: [CodexThreadItem] = tailTurnID.map { turnID in
        Array(detail.items.reversed().prefix { $0.turnId == turnID }.reversed())
    } ?? []
    let itemSignatures = items.map(detailSourceItemSignature).joined(separator: "|")
    return "\(visibleMessageLimit)|\(restorationAnchorRowID ?? "latest")|\(detail.items.count)|\(detail.updatedAt)|\(itemSignatures)"
}

private func detailSourceItemSignature(_ item: CodexThreadItem) -> String {
    let presentationText = item.presentationText ?? ""
    var signatureParts: [String] = [
            item.id,
            item.type,
            item.status ?? "",
            item.userMessageStatus ?? "",
            item.queuePosition.map(String.init) ?? "",
            item.turnStatus,
            item.presentationRole ?? "",
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
            item.collaborationRoutingVersion.map(String.init) ?? "",
            item.automationId ?? "",
            item.automationName ?? "",
            item.automationTriggerType ?? "",
            item.automationEventType ?? "",
            item.automationEventSource ?? "",
            item.automationRunId ?? ""
    ]
    signatureParts.append(item.automationEventOccurredAt ?? "")
    signatureParts.append(item.automationScheduleType ?? "")
    signatureParts.append(item.automationRunAt ?? "")
    signatureParts.append(item.automationNextRunAt ?? "")
    signatureParts.append(item.automationIntervalSeconds.map { String($0) } ?? "")
    signatureParts.append(item.automationConditionCheckIntervalSeconds.map { String($0) } ?? "")
    signatureParts.append(item.automationProcessPollIntervalSeconds.map { String($0) } ?? "")
    signatureParts.append(item.automationExpiresAt ?? "")
    signatureParts.append(contentsOf: [
            item.systemEventKind ?? "",
            item.systemEventReason ?? "",
            String(item.text.count),
            String(item.text.suffix(96)),
            String(presentationText.count),
            String(presentationText.suffix(96)),
            fileChangesSignature(item)
    ])
    return signatureParts.joined(separator: ":")
}

/// Builds a bounded semantic window around a saved row identity. Keeping a
/// small look-ahead makes the restored first frame useful while avoiding the
/// cost of materializing every row between a deep-history anchor and latest.
func restorationDetailEntries(
    from displayEntries: [ChatDisplayEntry],
    anchorRowID: String,
    historyLimit: Int,
    lookAhead: Int = 12
) -> [ChatDisplayEntry]? {
    guard let anchorIndex = displayEntries.firstIndex(where: { $0.id == anchorRowID }) else {
        return nil
    }
    let lowerBound = max(displayEntries.startIndex, anchorIndex - max(0, historyLimit - 1))
    let upperBound = min(displayEntries.index(before: displayEntries.endIndex), anchorIndex + max(0, lookAhead))
    return Array(displayEntries[lowerBound...upperBound])
}

func visibleDetailEntries(from displayEntries: [ChatDisplayEntry], limit: Int) -> [ChatDisplayEntry] {
    guard displayEntries.reduce(0, { $0 + $1.displayWeight }) > limit else {
        return displayEntries
    }
    var remainingWeight = limit
    var startIndex = displayEntries.endIndex
    while startIndex > displayEntries.startIndex {
        let candidateIndex = displayEntries.index(before: startIndex)
        let candidateWeight = displayEntries[candidateIndex].displayWeight
        remainingWeight -= candidateWeight
        startIndex = candidateIndex
        if remainingWeight <= 0 {
            break
        }
    }
    return Array(displayEntries[startIndex...])
}

func makeChatDisplayEntries(from items: [CodexThreadItem]) -> [ChatDisplayEntry] {
    ConversationTimeline.makeEntries(from: items)
}

func stableChronologicalChatItems(_ items: [CodexThreadItem]) -> [CodexThreadItem] {
    ConversationTimeline.orderedItems(items)
}

func makeChatDisplayEntriesForTurn(
    _ items: [CodexThreadItem], displayTurnId: String? = nil
) -> [ChatDisplayEntry] {
    ConversationTimeline.entriesForTurn(items, displayTurnId: displayTurnId)
}

/// Projects the state of the whole execution card from the turn lifecycle.
/// An individual command can fail and still be followed by a successful
/// recovery, so its item-level `status` must not determine the turn outcome.
func projectedProcessState(for items: [CodexThreadItem]) -> AppKitChatTimelineRow.ProcessState {
    ConversationProcessPresentation.state(for: items)
}

/// Formats the elapsed time for the complete execution lifecycle. Prefer the
/// turn bounds projected onto the process group; fall back to execution item
/// timestamps only for older cached entries. A single timestamp is not a
/// duration and must never be presented as a fabricated "<1s" result.
func executionProcessDurationText(for items: [CodexThreadItem], now: Date = Date()) -> String? {
    ConversationProcessPresentation.durationText(for: items, now: now)
}

struct NativeCollaborationCardPresentation: Equatable {
    let title: String
    let metadata: String
    let bodyMarkdown: String
    let messageText: String
    let route: NativeCollaborationRoutePresentation
}

struct NativeSpecialEventCardPresentation: Equatable {
    let title: String
    let metadata: String
    let bodyMarkdown: String
    let messageText: String
}

@MainActor
func nativeCollaborationCardPresentation(
    for item: CodexThreadItem,
    currentSessionTitle: String?
) -> NativeCollaborationCardPresentation? {
    let isConfirmation = item.presentationRole == "collaboration_confirmation"
        || item.type == "collaborationConfirmation"
    let isMessage = item.type == "userMessage" && item.presentationRole == "collaboration"
    guard isConfirmation || isMessage else { return nil }

    func nonEmpty(_ source: String?) -> String? {
        guard let value = source?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
            return nil
        }
        return value
    }
    func markdownEscaped(_ source: String) -> String {
        source
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "*", with: "\\*")
            .replacingOccurrences(of: "_", with: "\\_")
            .replacingOccurrences(of: "`", with: "\\`")
            .replacingOccurrences(of: "[", with: "\\[")
    }
    func readableName(_ source: String?, id: String?, fallback: String) -> String {
        guard let value = nonEmpty(source) else { return fallback }
        let normalizedID = nonEmpty(id)
        let lowercased = value.lowercased()
        guard value != normalizedID,
              !lowercased.hasPrefix("session:"),
              !lowercased.hasPrefix("work:"),
              !lowercased.hasPrefix("task:") else { return fallback }
        return value
    }

    if isMessage {
        guard (nonEmpty(item.collaborationTaskId) != nil || nonEmpty(item.collaborationChannelId) != nil),
              nonEmpty(item.collaborationInitiatorSessionId) != nil,
              nonEmpty(item.collaborationRecipientSessionId) != nil,
              nonEmpty(item.collaborationSourceWorkId) != nil,
              nonEmpty(item.collaborationTargetWorkId) != nil,
              nonEmpty(item.presentationText) != nil else {
            return nil
        }
    }

    let kind: String = switch item.collaborationMessageKind?.lowercased() {
    case "change_request": L10n("修改请求")
    case "needs_information": L10n("澄清请求")
    case "update_ready": L10n("结果")
    case "verification_result": L10n("验收结果")
    case "question": L10n("请求")
    default: L10n("协作消息")
    }
    let statusSource = (item.collaborationConfirmationStatus
        ?? item.collaborationProcessingStatus
        ?? item.status
        ?? "queued").lowercased()
    let status: String = switch statusSource {
    case "sent", "delivered": L10n("已发送")
    case "confirmed": isConfirmation
        ? (item.collaborationAuthorizationKind == "session_channel" ? L10n("已授权") : L10n("已确认"))
        : L10n("已处理")
    case "completed", "complete": L10n("已处理")
    case "running", "processing": L10n("处理中")
    case "failed": L10n("处理失败")
    case "rejected", "cancelled", "canceled": L10n("已取消")
    default: isConfirmation ? L10n("等待确认") : L10n("等待处理")
    }
    let hasTargetSession = nonEmpty(item.collaborationRecipientSessionId) != nil
    let sourceSession = readableName(
        item.collaborationInitiatorSessionTitle ?? currentSessionTitle,
        id: item.collaborationInitiatorSessionId,
        fallback: L10n("当前会话")
    )
    let targetSession = readableName(
        item.collaborationRecipientSessionTitle,
        id: item.collaborationRecipientSessionId,
        fallback: L10n("目标会话")
    )
    let sourceWork = readableName(
        item.collaborationSourceWorkName,
        id: item.collaborationSourceWorkId,
        fallback: L10n("来源 Work")
    )
    let targetWork = readableName(
        item.collaborationTargetWorkName,
        id: item.collaborationTargetWorkId,
        fallback: L10n("目标 Work")
    )
    let message = nonEmpty(item.presentationText)
        ?? nonEmpty(item.text)
        ?? L10n("协作消息正文不可用")
    let targetCorptieTask = readableName(
        item.collaborationTaskTitle,
        id: item.collaborationTargetCorptieTaskId,
        fallback: L10n("未命名协作任务")
    )
    var lines = ["**\(L10n("消息"))**", message]
    if let criteria = item.collaborationAcceptanceCriteria, !criteria.isEmpty {
        lines.append("")
        lines.append("**\(L10n("验收标准"))**")
        lines.append(contentsOf: criteria.map { "- \(markdownEscaped($0))" })
    }
    if let route = nonEmpty(item.collaborationRouteStatus) {
        lines.append("")
        lines.append("**\(L10n("路由状态"))**  \(markdownEscaped(route)) · v\(item.collaborationRoutingVersion ?? 0)")
    }
    if let relation = nonEmpty(item.collaborationRelation) {
        lines.append("**\(L10n("CorptieTask 关系"))**  \(markdownEscaped(relation))")
    }
    let timestamp = item.createdAt
        .flatMap(ISO8601DateFormatter.corptieThreadItemDate(from:))
        .map { $0.formatted(.dateTime.month(.twoDigits).day(.twoDigits).hour().minute()) }
    return NativeCollaborationCardPresentation(
        title: "\(L10n("跨会话协作")) · \(kind)",
        metadata: [status, timestamp].compactMap { $0 }.joined(separator: " · "),
        bodyMarkdown: lines.joined(separator: "\n"),
        messageText: message,
        route: NativeCollaborationRoutePresentation(
            destinationKind: hasTargetSession ? .existingSession : .newCorptieTask,
            routeLabel: hasTargetSession ? L10n("发送到现有会话") : L10n("将创建新的 CorptieTask"),
            sourceLabel: L10n("来源"),
            sourceSession: "Session · \(sourceSession)",
            sourceWork: "Work · \(sourceWork)",
            targetLabel: L10n("目标"),
            targetName: hasTargetSession
                ? "Session · \(targetSession)"
                : "CorptieTask · \(targetCorptieTask)",
            targetWork: "Work · \(targetWork)"
        )
    )
}

@MainActor
func nativeAutomationCardPresentation(for item: CodexThreadItem) -> NativeSpecialEventCardPresentation? {
    guard item.type == "automationEvent", item.presentationRole == "automation",
          let name = nonEmptyPresentationValue(item.automationName),
          let eventType = nonEmptyPresentationValue(item.automationEventType),
          ScheduledSessionEventMapping.timelineCardEventNames.contains(eventType) else { return nil }
    let message = nonEmptyPresentationValue(item.presentationText) ?? nonEmptyPresentationValue(item.text) ?? ""
    var lines = ["**\(L10n("事件类型"))**  \(automationEventLabel(eventType))"]
    if let eventTime = AutomationTimelinePresentation.eventTime(for: item) {
        lines.append("**\(AutomationTimelinePresentation.eventTimeLabel(for: eventType))**  \(eventTime)")
    }
    if let plan = AutomationTimelinePresentation.executionPlan(for: item) {
        lines.append("**\(L10n("执行计划"))**  \(plan)")
    }
    if let expiresAt = AutomationTimelinePresentation.localizedDate(item.automationExpiresAt) {
        lines.append("**\(L10n("过期时间"))**  \(expiresAt)")
    }
    if !message.isEmpty {
        lines.append(contentsOf: ["", "**\(L10n("触发消息"))**", automationMarkdownEscaped(message)])
    }
    return NativeSpecialEventCardPresentation(
        title: name,
        metadata: automationEventLabel(eventType),
        bodyMarkdown: lines.joined(separator: "\n"),
        messageText: message
    )
}

private func automationMarkdownEscaped(_ source: String) -> String {
    source
        .replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "*", with: "\\*")
        .replacingOccurrences(of: "_", with: "\\_")
        .replacingOccurrences(of: "`", with: "\\`")
        .replacingOccurrences(of: "[", with: "\\[")
}

@MainActor
func nativeSystemEventCardPresentation(for item: CodexThreadItem) -> NativeSpecialEventCardPresentation? {
    guard item.presentationRole == "system_event",
          let reason = nonEmptyPresentationValue(item.systemEventReason) else { return nil }
    let source = nonEmptyPresentationValue(item.systemEventSource) ?? L10n("未知")
    let taskID = nonEmptyPresentationValue(item.collaborationTaskId)
    var lines = [
        "**\(L10n("事件类型"))**  \(item.systemEventKind ?? "system_event")",
        "**\(L10n("事件来源"))**  \(source)",
        "**Reason**  \(reason)"
    ]
    if let taskID { lines.append("**Task ID**  \(taskID)") }
    lines.append("\nThis event is not an executable collaboration request.")
    return NativeSpecialEventCardPresentation(
        title: "System Event · Invalid collaboration envelope",
        metadata: nativeEventTimestamp(item.createdAt),
        bodyMarkdown: lines.joined(separator: "\n"),
        messageText: item.presentationText ?? item.text
    )
}

private func nonEmptyPresentationValue(_ value: String?) -> String? {
    guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
    return value
}

private func nativeEventTimestamp(_ value: String?) -> String {
    value.flatMap(ISO8601DateFormatter.corptieThreadItemDate(from:))
        .map { $0.formatted(.dateTime.month(.twoDigits).day(.twoDigits).hour().minute()) } ?? ""
}

@MainActor
private func automationEventLabel(_ type: String) -> String {
    switch type {
    case "ScheduledSessionTaskCreated": L10n("已创建")
    case "ScheduledSessionTaskDue": L10n("已触发")
    case "ScheduledSessionRunQueued": L10n("已触发")
    default: L10n("计划任务事件")
    }
}

func nativeTimelineAllowsChoiceActions(type: String, status: String?) -> Bool {
    switch type {
    case "approval", "choice":
        // A historical or uncertain approval must never offer a second submission.
        return status == "pending"
    case "agentMessage":
        return status != "selected"
    default:
        return false
    }
}

func isLowSignalDetailProcessItem(_ item: CodexThreadItem) -> Bool {
    // A completion event can carry the only explanation for a failed turn.
    // Hide the empty success marker, never the failure diagnostic.
    if item.type == "taskComplete" {
        let failed = item.status == "failed" || item.turnStatus == "failed"
        return !failed && item.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
    if item.title.localizedCaseInsensitiveContains("turn completed")
        && item.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        return true
    }
    if item.type == "agentMessage" && item.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        return true
    }
    return false
}

private func detailDisplaySignature(for visibleEntries: [ChatDisplayEntry], visibleMessageLimit: Int) -> String {
    let entrySignatures = visibleEntries.map { entry in
        switch entry.kind {
        case .message(let item):
            return detailItemSignature(item)
        case .process(let turnId, let items):
            return turnId + ":" + items.map(detailItemSignature).joined(separator: ",")
        }
    }.joined(separator: "|")
    return "\(visibleMessageLimit)|\(entrySignatures)"
}

func detailItemSignature(_ item: CodexThreadItem) -> String {
    let text = item.text.trimmingCharacters(in: .whitespacesAndNewlines)
    let presentationText = item.presentationText?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let rawMetadata = item.rawMetadataJSON ?? ""
    let rawMetadataCount = String(rawMetadata.count)
    let rawMetadataSuffix = String(rawMetadata.suffix(96))
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
    ].joined(separator: ":")
    return [
        item.id,
        item.type,
        item.status ?? "",
        item.userMessageStatus ?? "",
        item.queuePosition.map(String.init) ?? "",
        item.processingError ?? "",
        item.turnStatus,
        item.processStartedAt ?? "",
        item.processEndedAt ?? "",
        item.presentationRole ?? "",
        imageSignature,
        collaborationSignature,
        "\(text.count)",
        String(text.suffix(96)),
        "\(presentationText.count)",
        String(presentationText.suffix(96)),
        rawMetadataCount,
        rawMetadataSuffix,
        fileChangesSignature(item)
    ].joined(separator: ":")
}

func timelineTailContentRevision(for items: [CodexThreadItem]) -> String {
    items.suffix(2).map(detailItemSignature).joined(separator: "|")
}

func fileChangesSignature(_ item: CodexThreadItem) -> String {
    (item.fileChanges ?? []).map { "\($0.kind):\($0.path)" }.joined(separator: ",")
}
