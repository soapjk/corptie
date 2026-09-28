import Foundation

@MainActor
final class SessionChoiceController {
    private let baseURL: URL
    private let commands: SessionCommandController
    private let selectedSession: () -> TaskSession?
    private let activeSessions: () -> [TaskSession]
    private let cachedDetail: (String) -> CodexThreadDetail?
    private let fetchDetail: (TaskSession) async -> Void
    private let sendText: (String, TaskSession, Bool) -> Void
    private let markChoiceHandled: (String, String) -> Void
    private let reportError: (String) -> Void
    private let errorMessage: (Data) -> String?

    init(
        baseURL: URL,
        commands: SessionCommandController,
        selectedSession: @escaping () -> TaskSession?,
        activeSessions: @escaping () -> [TaskSession],
        cachedDetail: @escaping (String) -> CodexThreadDetail?,
        fetchDetail: @escaping (TaskSession) async -> Void,
        sendText: @escaping (String, TaskSession, Bool) -> Void,
        markChoiceHandled: @escaping (String, String) -> Void,
        reportError: @escaping (String) -> Void,
        errorMessage: @escaping (Data) -> String?
    ) {
        self.baseURL = baseURL
        self.commands = commands
        self.selectedSession = selectedSession
        self.activeSessions = activeSessions
        self.cachedDetail = cachedDetail
        self.fetchDetail = fetchDetail
        self.sendText = sendText
        self.markChoiceHandled = markChoiceHandled
        self.reportError = reportError
        self.errorMessage = errorMessage
    }

    func respondToCodexApproval(option: CodexApprovalOption) {
        guard let session = selectedSession() else {
            commands.sendStatusMessage = L10n("No Codex approval is active.")
            return
        }
        respondToCodexApproval(option: option, to: session)
    }

    func respondToCodexApproval(option: CodexApprovalOption, to session: TaskSession) {
        Task {
            commands.isSendingMessage = true
            commands.sendStatusMessage = L10n("Selecting Codex option...")
            defer { commands.isSendingMessage = false }
            do {
                var request = URLRequest(url: baseURL.appending(path: "sessions/\(session.id)/actions/approve"))
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                request.httpBody = try JSONSerialization.data(withJSONObject: [
                    "optionId": option.id,
                    "optionIndex": option.index ?? 0,
                    "itemType": "approval",
                    "approved": option.role?.localizedCaseInsensitiveContains("deny") != true
                ])
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse else {
                    throw URLError(.badServerResponse)
                }
                guard (200..<300).contains(httpResponse.statusCode) else {
                    throw BackendError.message(errorMessage(data) ?? "Bad server response")
                }
                commands.sendStatusMessage = L10nFormat("Selected %@", option.label)
            } catch {
                reportError(error.localizedDescription)
                commands.sendStatusMessage = L10nFormat("Approval failed: %@", error.localizedDescription)
            }
        }
    }

    func respondToUserInput(sessionID: String, itemID: String,
                            answers: [String: [String]], action: String = "submit") async throws {
        var request = URLRequest(url: baseURL.appending(path: "sessions/\(sessionID)/actions/user-input"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "itemId": itemID, "answers": answers, "action": action
        ])
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse,
              (200..<300).contains(httpResponse.statusCode) else {
            throw BackendError.message(errorMessage(data) ?? "Unable to submit answers.")
        }
        if let session = activeSessions().first(where: { $0.id == sessionID }) {
            await fetchDetail(session)
        }
    }

    func respondToPtyChoice(option: CodexApprovalOption, choiceId: String? = nil, in targetSession: TaskSession? = nil) {
        guard let session = targetSession ?? selectedSession() else {
            commands.sendStatusMessage = L10n("No terminal choice is active.")
            return
        }
        Task { await submitChoice(option: option, choiceId: choiceId, in: session) }
    }

    func respondToSuggestedOption(_ option: CodexApprovalOption, in session: TaskSession) {
        Task {
            let detail = cachedDetail(session.id)
            if let choiceId = SuggestedOptionRouting.pendingChoiceId(
                for: option.id, items: detail?.items ?? []
            ) {
                await submitChoice(option: option, choiceId: choiceId, in: session)
            } else {
                sendText(option.label, session, selectedSession()?.id == session.id)
            }
        }
    }

    private func submitChoice(option: CodexApprovalOption, choiceId: String?, in session: TaskSession) async {
        commands.isSendingMessage = true
        commands.sendStatusMessage = L10n("Selecting option...")
        defer { commands.isSendingMessage = false }
        do {
            var request = URLRequest(url: baseURL.appending(path: "sessions/\(session.id)/actions/approve"))
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            var body: [String: Any] = [
                "optionId": option.id,
                "optionIndex": option.index ?? 0,
                "itemType": "choice",
                "approved": true
            ]
            if let choiceId, !choiceId.isEmpty { body["choiceId"] = choiceId }
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse else {
                throw URLError(.badServerResponse)
            }
            guard (200..<300).contains(httpResponse.statusCode) else {
                throw BackendError.message(errorMessage(data) ?? "Bad server response")
            }
            if let choiceId, !choiceId.isEmpty {
                markChoiceHandled(choiceId, option.id)
            }
            commands.sendStatusMessage = L10nFormat("Selected %@", option.label)
        } catch {
            reportError(error.localizedDescription)
            commands.sendStatusMessage = L10nFormat("Choice failed: %@", error.localizedDescription)
        }
    }
}
