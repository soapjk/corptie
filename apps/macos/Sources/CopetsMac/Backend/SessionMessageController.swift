import Foundation

/// Message submission owns its in-flight command state and acknowledges local echo only after persistence.
@MainActor
final class SessionMessageController {
    private static let iso8601Formatter = ISO8601DateFormatter()
    private let baseURL: URL
    private let commands: SessionCommandController
    private let timelineLocalOverlay: SessionTimelineLocalOverlay
    private let currentSession: () -> TaskSession?
    private let currentDetail: () -> CodexThreadDetail?
    private let activeSessions: () -> [TaskSession]
    private let cachedDetail: (String) -> CodexThreadDetail?
    private let storeDetail: (CodexThreadDetail, String) -> Void
    private let publishReplacement: (SessionReplacement) -> Void
    private let selectSession: (TaskSession) -> Void
    private let loadWorkspaceRecoveryStatus: (TaskSession) async -> Void
    private let currentError: () -> String?
    private let reportError: (String?) -> Void

    private var selectedSession: TaskSession? { currentSession() }
    private var selectedDetail: CodexThreadDetail? { currentDetail() }
    private var sessions: [TaskSession] { activeSessions() }
    private var isSendingMessage: Bool {
        get { commands.isSendingMessage }
        set { commands.isSendingMessage = newValue }
    }
    private var sendStatusMessage: String? {
        get { commands.sendStatusMessage }
        set { commands.sendStatusMessage = newValue }
    }
    private var lastError: String? {
        get { currentError() }
        set { reportError(newValue) }
    }

    init(baseURL: URL, commands: SessionCommandController,
         timelineLocalOverlay: SessionTimelineLocalOverlay,
         currentSession: @escaping () -> TaskSession?,
         currentDetail: @escaping () -> CodexThreadDetail?,
         activeSessions: @escaping () -> [TaskSession],
         cachedDetail: @escaping (String) -> CodexThreadDetail?,
         storeDetail: @escaping (CodexThreadDetail, String) -> Void,
         publishReplacement: @escaping (SessionReplacement) -> Void,
         selectSession: @escaping (TaskSession) -> Void,
         loadWorkspaceRecoveryStatus: @escaping (TaskSession) async -> Void,
         currentError: @escaping () -> String?,
         reportError: @escaping (String?) -> Void) {
        self.baseURL = baseURL
        self.commands = commands
        self.timelineLocalOverlay = timelineLocalOverlay
        self.currentSession = currentSession
        self.currentDetail = currentDetail
        self.activeSessions = activeSessions
        self.cachedDetail = cachedDetail
        self.storeDetail = storeDetail
        self.publishReplacement = publishReplacement
        self.selectSession = selectSession
        self.loadWorkspaceRecoveryStatus = loadWorkspaceRecoveryStatus
        self.currentError = currentError
        self.reportError = reportError
    }

    @discardableResult
    func sendText(
        _ text: String,
        images: [ChatImageReference],
        mentions: [ConversationMention] = [],
        to session: TaskSession,
        reloadDetail: Bool,
        isChoiceSelection: Bool,
        onSuccess: @escaping () -> Void,
        onFailure: @escaping () -> Void = {}
    ) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || !images.isEmpty else {
            return false
        }
        let latencyTrace = SessionMessageLatencyTrace(sessionId: session.id)
        let messageID = "message:\(UUID().uuidString)"
        let deliveryID = "delivery:\(UUID().uuidString)"
        latencyTrace.log(stage: "send_clicked")
        let isClearCommand = trimmed.lowercased() == "/clear"
        let resolvesCollaborationConfirmation = selectedDetail?.items.contains(where: {
            $0.type == "collaborationConfirmation" && $0.collaborationConfirmationStatus == "pending"
        }) == true && Self.isCollaborationConfirmationReply(trimmed)
        let presentsAcknowledgedUserMessage = reloadDetail
            && !isClearCommand
            && !resolvesCollaborationConfirmation

        // Capture viewport intent before the composer shrinks or the server
        // acknowledgement changes the row set. A later user scroll wins.
        if presentsAcknowledgedUserMessage {
            NotificationCenter.default.post(name: .sessionTimelineSubmissionAccepted, object: session.id)
        }

        Task {
            isSendingMessage = true
            commands.setSendFailure(nil, sessionID: session.id)
            sendStatusMessage = L10n("Sending...")
            defer { isSendingMessage = false }

            do {
                let requestStartedAtMs = SessionMessageLatencyTrace.nowMs
                var request = URLRequest(url: baseURL.appending(path: "sessions/\(session.id)/messages"))
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                request.setValue(latencyTrace.traceId, forHTTPHeaderField: "x-corptie-message-trace-id")
                request.setValue(String(latencyTrace.clickedAtMs), forHTTPHeaderField: "x-corptie-message-clicked-at-ms")
                request.setValue(String(requestStartedAtMs), forHTTPHeaderField: "x-corptie-message-request-started-at-ms")
                request.httpBody = try JSONSerialization.data(withJSONObject: [
                    "text": trimmed,
                    "mentions": mentions.map { mention in
                        [
                            "targetType": mention.targetType.rawValue,
                            "targetId": mention.targetId,
                            "displayName": mention.displayName
                        ]
                    },
                    "images": images.map { image in
                        [
                            "managedPath": image.managedPath,
                            "originalPath": image.originalPath ?? NSNull()
                        ] as [String: Any]
                    },
                    "isChoiceSelection": isChoiceSelection,
                    "messageId": messageID,
                    "deliveryId": deliveryID
                ])

                latencyTrace.log(stage: "request_sent", requestStartedAtMs: requestStartedAtMs)
                let (data, response) = try await URLSession.shared.data(for: request)
                latencyTrace.log(stage: "response_received", requestStartedAtMs: requestStartedAtMs)
                guard let httpResponse = response as? HTTPURLResponse else {
                    throw URLError(.badServerResponse)
                }
                let decoded = try? JSONDecoder().decode(SendMessageResponse.self, from: data)
                guard (200..<300).contains(httpResponse.statusCode) else {
                    let message = decoded?.error ?? String(data: data, encoding: .utf8) ?? "Bad server response"
                    let hint = decoded?.hint.map { "\n\($0)" } ?? ""
                    throw BackendError.message("\(message)\(hint)\nHTTP \(httpResponse.statusCode) · \(latencyTrace.traceId)")
                }

                // A Timeline row is product state, not a send animation. The
                // backend creates the MessageDelivery and its session_items
                // projection in one transaction before returning success, so
                // only a 2xx acknowledgement may make this local echo visible.
                if presentsAcknowledgedUserMessage && decoded?.mode != "session-command" {
                    appendAcknowledgedUserMessage(
                        trimmed,
                        images: images,
                        messageID: messageID,
                        deliveryID: deliveryID,
                        to: session
                    )
                }
                onSuccess()
                if decoded?.mode == "session-command" {
                    sendStatusMessage = decoded?.warning
                } else if decoded?.cleared == true {
                    sendStatusMessage = L10n("Conversation cleared")
                    if let replacement = decoded?.session,
                       replacement.id != session.id {
                        publishReplacement(SessionReplacement(
                            previousSessionId: session.id,
                            session: replacement
                        ))
                    }
                    if let replacement = decoded?.session,
                       replacement.id != session.id {
                        selectSession(sessions.first(where: { $0.id == replacement.id }) ?? replacement)
                    }
                    return
                } else if decoded?.mode == "collaboration-confirmation" {
                    sendStatusMessage = L10n("Collaboration confirmation resolved")
                } else if decoded?.queued == true {
                    let position = decoded?.queuePosition.map { " #\($0)" } ?? ""
                    sendStatusMessage = L10nFormat("Queued%@", position)
                } else if decoded?.visibleInCodexDesktop == false {
                    sendStatusMessage = decoded?.warning ?? "Sent to background Codex; Desktop may not refresh."
                } else {
                    sendStatusMessage = L10n("Sent to Codex")
                }
            } catch {
                lastError = error.localizedDescription
                sendStatusMessage = L10nFormat("Send failed: %@", error.localizedDescription)
                latencyTrace.log(stage: "send_failed")
                commands.setSendFailure(sendStatusMessage, sessionID: session.id)
                onFailure()
                if selectedSession?.id == session.id {
                    await loadWorkspaceRecoveryStatus(session)
                }
            }
        }
        return true
    }

    private static func isCollaborationConfirmationReply(_ text: String) -> Bool {
        let normalized = text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return ["确认", "确认发送", "发送", "同意", "yes", "y", "confirm", "approve",
                "取消", "拒绝", "不发送", "否", "no", "n", "reject", "cancel"].contains(normalized)
    }

    private func appendAcknowledgedUserMessage(
        _ text: String,
        images: [ChatImageReference] = [],
        messageID: String,
        deliveryID: String,
        to session: TaskSession
    ) {
        let threadId = session.external?.threadId ?? session.id
        guard selectedSession?.id == session.id || selectedDetail?.id == threadId else {
            return
        }
        let detail = timelineLocalOverlay.acknowledge(
            text, images: images, messageID: messageID, deliveryID: deliveryID,
            to: session, residentDetail: cachedDetail(session.id),
            now: Self.iso8601Formatter.string(from: Date())
        )
        storeDetail(detail, session.id)
    }
}
