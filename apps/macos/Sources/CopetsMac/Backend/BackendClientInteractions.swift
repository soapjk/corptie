import CorptieConversation
import Foundation

extension BackendClient {
    func sendMessage(
        _ text: String,
        images: [ChatImageReference] = [],
        onSuccess: @escaping () -> Void = {},
        onFailure: @escaping () -> Void = {}
    ) -> Bool {
        if !selectedCanSendNow {
            sendStatusMessage = selectedNotReadyReason?.message
                ?? selectedDetail?.sendUnavailableReason
                ?? "This Session is not ready to accept messages."
            if let session = selectedSession {
                sessionCommandController.setSendFailure(sendStatusMessage, sessionID: session.id)
            }
            return false
        }

        guard let selectedSession, selectedSession.external?.threadId != nil else {
            lastError = L10n("This task does not expose a Codex thread id.")
            sendStatusMessage = lastError
            return false
        }

        return sendText(
            text,
            images: images,
            to: selectedSession,
            reloadDetail: true,
            isChoiceSelection: false,
            onSuccess: onSuccess,
            onFailure: onFailure
        )
    }

    func importChatImage(
        at fileURL: URL,
        to session: TaskSession,
        preserveOriginal: Bool
    ) async throws -> ChatImageReference {
        var request = URLRequest(url: baseURL.appending(path: "sessions/\(session.id)/images"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "sourcePath": fileURL.path,
            "preserveOriginal": preserveOriginal
        ])
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw BackendError.message(Self.errorMessage(from: data) ?? L10n("Could not attach image."))
        }
        if let direct = try? JSONDecoder().decode(ChatImageReference.self, from: data) {
            return direct
        }
        return try JSONDecoder().decode(ChatImageImportResponse.self, from: data).image
    }

    func presentChatImageError(_ error: Error) {
        lastError = error.localizedDescription
    }

    func removeUnsentChatImage(_ image: ChatImageReference, from session: TaskSession) async {
        var request = URLRequest(url: baseURL.appending(path: "sessions/\(session.id)/images"))
        request.httpMethod = "DELETE"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["managedPath": image.managedPath])
        _ = try? await URLSession.shared.data(for: request)
    }

    func chatImageURL(sessionID: String, managedPath: String) -> URL? {
        var components = URLComponents(
            url: baseURL.appending(path: "sessions/\(sessionID)/images"),
            resolvingAgainstBaseURL: false
        )
        components?.queryItems = [URLQueryItem(name: "path", value: managedPath)]
        return components?.url
    }

    func respondToCollaborationConfirmation(confirmationId: String, approve: Bool, in session: TaskSession? = nil) {
        collaborationConfirmationController.respondToCollaborationConfirmation(
            confirmationId: confirmationId, approve: approve, in: session
        )
    }

    @discardableResult
    nonisolated static func requestCollaborationConfirmationResolution(
        at baseURL: URL,
        confirmationId: String,
        approve: Bool,
        urlSession: URLSession = .shared
    ) async throws -> String {
        try await CollaborationConfirmationController.requestCollaborationConfirmationResolution(
            at: baseURL, confirmationId: confirmationId, approve: approve, urlSession: urlSession
        )
    }
    @discardableResult
    func sendMessage(
        _ text: String,
        to session: TaskSession,
        images: [ChatImageReference] = [],
        mentions: [ConversationMention] = [],
        isChoiceSelection: Bool = false,
        onSuccess: @escaping () -> Void = {},
        onFailure: @escaping () -> Void = {}
    ) -> Bool {
        sendText(
            text,
            images: images,
            mentions: mentions,
            to: session,
            reloadDetail: selectedSession?.id == session.id,
            isChoiceSelection: isChoiceSelection,
            onSuccess: onSuccess,
            onFailure: onFailure
        )
    }

    func reviewTurnChanges(sessionId: String, turnId: String) async -> Result<String, Error> {
        await performTurnChangesAction("review", sessionId: sessionId, turnId: turnId)
    }

    func undoTurnChanges(sessionId: String, turnId: String) async -> Result<String, Error> {
        await performTurnChangesAction("undo", sessionId: sessionId, turnId: turnId)
    }

    private func performTurnChangesAction(_ action: String, sessionId: String, turnId: String) async -> Result<String, Error> {
        do {
            var request = URLRequest(url: baseURL.appending(path: "sessions/\(sessionId)/turns/\(turnId)/changes/\(action)"))
            request.httpMethod = "POST"
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse else {
                throw URLError(.badServerResponse)
            }
            guard (200..<300).contains(httpResponse.statusCode) else {
                let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
                throw BackendError.message(payload?["error"] as? String ?? "The code diff action failed.")
            }
            let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            return .success(payload?["tool"] as? String ?? action)
        } catch {
            return .failure(error)
        }
    }

    @discardableResult
    func sendText(
        _ text: String, images: [ChatImageReference],
        mentions: [ConversationMention] = [], to session: TaskSession,
        reloadDetail: Bool, isChoiceSelection: Bool,
        onSuccess: @escaping () -> Void, onFailure: @escaping () -> Void = {}
    ) -> Bool {
        messageController.sendText(
            text, images: images, mentions: mentions, to: session,
            reloadDetail: reloadDetail, isChoiceSelection: isChoiceSelection,
            onSuccess: onSuccess, onFailure: onFailure
        )
    }

    func publishSessionReplacement(_ replacement: SessionReplacement) {
        appState.acceptSessionReplacement(
            previousSessionID: replacement.previousSessionId,
            session: replacement.session
        )
        sessionReplacements.send(replacement)
    }
}
