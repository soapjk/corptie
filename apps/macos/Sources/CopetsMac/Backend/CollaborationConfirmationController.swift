import Foundation
import Combine

@MainActor
final class CollaborationConfirmationController: ObservableObject {
    @Published private(set) var pendingBySessionID: [String: PendingCollaborationConfirmation] = [:]
    private var localStatuses: [String: [String: String]] = [:]
    private var inFlight = Set<String>()

    private let baseURL: URL
    private let urlSession: URLSession
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
        reportError: @escaping (String) -> Void,
        urlSession: URLSession = .shared
    ) {
        self.baseURL = baseURL
        self.urlSession = urlSession
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
        localStatuses[sessionID] = nil
    }

    // Retain a local HTTP acknowledgement until the authoritative timeline
    // catches up. A delayed pending snapshot must not resurrect its buttons.
    func reconcile(_ detail: CodexThreadDetail, for sessionID: String) -> CodexThreadDetail {
        guard let statuses = localStatuses[sessionID], !statuses.isEmpty else { return detail }
        let reconciled = SessionTimelineLocalOverlay.detailReplacingItems(detail) { item in
            guard let id = item.collaborationConfirmationId, let status = statuses[id] else { return item }
            let authoritative = item.collaborationConfirmationStatus ?? item.status ?? "pending"
            if ["confirmed", "rejected", "failed"].contains(authoritative) {
                localStatuses[sessionID]?[id] = nil
                return item
            }
            return Self.replacingStatus(item, with: status)
        }
        if localStatuses[sessionID]?.isEmpty == true { localStatuses[sessionID] = nil }
        return reconciled
    }

    nonisolated static func replacingStatus(_ item: CodexThreadItem, with status: String) -> CodexThreadItem {
        var resolvedItem = item
        resolvedItem.collaborationConfirmationStatus = status
        return resolvedItem
    }

    private func publishStatus(_ status: String?, confirmationID: String, sessionID: String) {
        localStatuses[sessionID, default: [:]][confirmationID] = status
        if localStatuses[sessionID]?.isEmpty == true { localStatuses[sessionID] = nil }
        guard let detail = cachedDetail(sessionID) else { return }
        let updated = SessionTimelineLocalOverlay.detailReplacingItems(detail) { item in
            guard item.collaborationConfirmationId == confirmationID else { return item }
            // On failure restore only our transient state, never a terminal event.
            if status == nil, !["submitting", "rejecting"].contains(item.collaborationConfirmationStatus ?? "") { return item }
            return Self.replacingStatus(item, with: status ?? "pending")
        }
        storeDetail(updated, sessionID, SessionTimelineRepository.shared.timelineRevision(for: sessionID))
    }

    func respondToCollaborationConfirmation(confirmationId: String, approve: Bool, in session: TaskSession? = nil) {
        let sourceSessionID = session?.id
            ?? pendingBySessionID.first(where: {
                $0.value.confirmationId == confirmationId
            })?.key
        let sourceSession = session ?? sourceSessionID.flatMap { sourceSessionID in
            activeSessions().first(where: { $0.id == sourceSessionID })
        }
        guard inFlight.insert(confirmationId).inserted else { return }
        if let sourceSessionID {
            publishStatus(approve ? "submitting" : "rejecting", confirmationID: confirmationId, sessionID: sourceSessionID)
        }
        Task {
            commands.isSendingMessage = true
            defer { commands.isSendingMessage = false; inFlight.remove(confirmationId) }
            do {
                commands.sendStatusMessage = approve
                    ? L10n("正在确认协作请求…")
                    : L10n("Cancelling collaboration request…")
                let resolutionStatus = try await Self.requestCollaborationConfirmationResolution(
                    at: baseURL,
                    confirmationId: confirmationId,
                    approve: approve,
                    urlSession: urlSession
                )
                if let sourceSessionID {
                    publishStatus(resolutionStatus, confirmationID: confirmationId, sessionID: sourceSessionID)
                }
                // HTTP confirms the resolution, while the timeline stream may lag behind.
                if let sourceSession {
                    await loadMessages(sourceSession)
                }
                commands.sendStatusMessage = approve ? L10n("已发送") : L10n("Collaboration request cancelled")
            } catch {
                if let sourceSessionID { publishStatus(nil, confirmationID: confirmationId, sessionID: sourceSessionID) }
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
