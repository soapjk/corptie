import Foundation
import Combine

@MainActor
final class CollaborationConfirmationController: ObservableObject {
    @Published private(set) var pendingBySessionID: [String: PendingCollaborationConfirmation] = [:]

    private let baseURL: URL
    private let commands: SessionCommandController
    private let activeSessions: () -> [TaskSession]
    private let cachedDetail: (String) -> CodexThreadDetail?
    private let storeDetail: (CodexThreadDetail, String, Int?) -> Void
    private let loadMessages: (TaskSession) async -> Void
    private let reportError: (String) -> Void

    init(
        baseURL: URL,
        commands: SessionCommandController,
        activeSessions: @escaping () -> [TaskSession],
        cachedDetail: @escaping (String) -> CodexThreadDetail?,
        storeDetail: @escaping (CodexThreadDetail, String, Int?) -> Void,
        loadMessages: @escaping (TaskSession) async -> Void,
        reportError: @escaping (String) -> Void
    ) {
        self.baseURL = baseURL
        self.commands = commands
        self.activeSessions = activeSessions
        self.cachedDetail = cachedDetail
        self.storeDetail = storeDetail
        self.loadMessages = loadMessages
        self.reportError = reportError
    }

    func pendingConfirmation(for sessionID: String) -> PendingCollaborationConfirmation? {
        pendingBySessionID[sessionID]
    }

    func updatePendingConfirmation(from detail: CodexThreadDetail, for sessionID: String) {
        let pending = Self.pendingCollaborationConfirmation(in: detail)
        if pendingBySessionID[sessionID] != pending {
            pendingBySessionID[sessionID] = pending
        }
    }

    func removePendingConfirmation(for sessionID: String) {
        pendingBySessionID[sessionID] = nil
    }

    func respondToCollaborationConfirmation(confirmationId: String, approve: Bool, in session: TaskSession? = nil) {
        let sourceSessionID = session?.id
            ?? pendingBySessionID.first(where: {
                $0.value.confirmationId == confirmationId
            })?.key
        let sourceSession = session ?? sourceSessionID.flatMap { sourceSessionID in
            activeSessions().first(where: { $0.id == sourceSessionID })
        }
        Task {
            commands.isSendingMessage = true
            defer { commands.isSendingMessage = false }
            do {
                commands.sendStatusMessage = approve
                    ? L10n("正在确认协作请求…")
                    : L10n("Cancelling collaboration request…")
                let resolutionStatus = try await Self.requestCollaborationConfirmationResolution(
                    at: baseURL,
                    confirmationId: confirmationId,
                    approve: approve
                )
                if let sourceSessionID {
                    if let detail = cachedDetail(sourceSessionID) {
                        let resolvedDetail = SessionTimelineLocalOverlay.detailReplacingItems(detail) { item in
                            guard item.collaborationConfirmationId == confirmationId else { return item }
                            var resolvedItem = item
                            resolvedItem.collaborationConfirmationStatus = resolutionStatus
                            return resolvedItem
                        }
                        storeDetail(
                            resolvedDetail,
                            sourceSessionID,
                            SessionTimelineRepository.shared.timelineRevision(for: sourceSessionID)
                        )
                    } else {
                        pendingBySessionID[sourceSessionID] = nil
                    }
                }
                // HTTP confirms the resolution, while the timeline stream may lag behind.
                if let sourceSession {
                    await loadMessages(sourceSession)
                }
                commands.sendStatusMessage = approve ? L10n("协作请求已确认，不代表消息已送达") : L10n("Collaboration request cancelled")
            } catch {
                reportError(error.localizedDescription)
                commands.sendStatusMessage = L10nFormat("Confirmation failed: %@", error.localizedDescription)
            }
        }
    }

    nonisolated static func pendingCollaborationConfirmation(
        in detail: CodexThreadDetail
    ) -> PendingCollaborationConfirmation? {
        guard let item = detail.items.last(where: {
            $0.type == "collaborationConfirmation"
                && ($0.collaborationConfirmationStatus ?? $0.status ?? "pending").lowercased() == "pending"
        }), let confirmationID = item.collaborationConfirmationId else { return nil }
        return PendingCollaborationConfirmation(
            confirmationId: confirmationID,
            initiatorAgentId: item.collaborationSenderAgentId,
            initiatorName: item.collaborationSenderName,
            recipientAgentId: item.collaborationRecipientAgentId,
            recipientName: item.collaborationRecipientName ?? "Agent",
            sourceWorkId: item.collaborationSourceWorkId,
            sourceWorkName: item.collaborationSourceWorkName,
            targetWorkId: item.collaborationTargetWorkId,
            targetWorkName: item.collaborationTargetWorkName,
            initiatorSessionId: item.collaborationInitiatorSessionId,
            initiatorSessionTitle: item.collaborationInitiatorSessionTitle,
            initiatorSessionKind: item.collaborationInitiatorSessionKind,
            initiatorCorptieTaskId: item.collaborationSourceCorptieTaskId,
            recipientSessionId: item.collaborationRecipientSessionId,
            recipientSessionTitle: item.collaborationRecipientSessionTitle,
            recipientSessionKind: item.collaborationRecipientSessionKind,
            recipientCorptieTaskId: item.collaborationTargetCorptieTaskId,
            routeStatus: item.collaborationRouteStatus,
            routingVersion: item.collaborationRoutingVersion,
            taskTitle: item.collaborationTaskTitle ?? "Cross-session collaboration",
            summary: item.presentationText ?? item.text,
            acceptanceCriteria: item.collaborationAcceptanceCriteria ?? []
        )
    }

    @discardableResult
    nonisolated static func requestCollaborationConfirmationResolution(
        at baseURL: URL,
        confirmationId: String,
        approve: Bool,
        urlSession: URLSession = .shared
    ) async throws -> String {
        let action = approve ? "confirm" : "reject"
        var request = URLRequest(
            url: baseURL.appending(path: "collaboration/confirmations/\(confirmationId)/\(action)")
        )
        request.httpMethod = "POST"
        let (data, response) = try await urlSession.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse,
              (200..<300).contains(httpResponse.statusCode) else {
            let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            throw BackendError.message(
                payload?["error"] as? String ?? "Could not resolve collaboration confirmation."
            )
        }
        let payload = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        let resolution = (payload?["request"] ?? payload?["confirmation"]) as? [String: Any]
        guard let status = resolution?["status"] as? String,
              status == (approve ? "confirmed" : "rejected") else {
            throw BackendError.message("协作确认结果无效，请刷新后重试。")
        }
        return status
    }
}
