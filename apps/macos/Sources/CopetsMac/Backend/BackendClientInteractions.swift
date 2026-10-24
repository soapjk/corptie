import CorptieConversation
import CorptieClientCore
import Foundation

extension BackendClient {
    static let quickMessageCache = ClientQuickMessageCache(defaults: CorptieAppEnvironment.userDefaults)

    func cancelQueuedMessage(sessionID: String, taskID: String) async throws {
        var request = URLRequest(url: baseURL.appending(path: "sessions/\(sessionID)/queued-messages/\(taskID)/cancel"))
        request.httpMethod = "POST"
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw BackendError.message(Self.errorMessage(from: data) ?? L10n("Could not cancel queued message."))
        }
    }
    func deleteUnreceivedMessage(sessionID: String, messageID: String) async throws {
        var request = URLRequest(url: baseURL.appendingPathComponent("sessions")
            .appendingPathComponent(sessionID).appendingPathComponent("messages").appendingPathComponent(messageID))
        request.httpMethod = "DELETE"
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw BackendError.message(Self.errorMessage(from: data) ?? "删除未完成，请刷新状态后重试。")
        }
    }

    func quickMessages(for sessionID: String) async throws -> ClientQuickMessageRecommendations {
        var request = URLRequest(url: baseURL.appending(path: "sessions/\(sessionID)/quick-messages"))
        request.timeoutInterval = 8
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            if let http = response as? HTTPURLResponse, [502, 503, 504].contains(http.statusCode) {
                throw URLError(.resourceUnavailable)
            }
            throw ClientConnectionError.invalidResponse
        }
        let result = try JSONDecoder().decode(ClientQuickMessageRecommendations.self, from: data)
        return try result.validated()
    }
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
        guard let http = response as? HTTPURLResponse else { throw ClientConnectionError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            let failure = try? JSONDecoder().decode(ChatImageImportFailureBody.self, from: data)
            throw ChatImageImportFailure(statusCode: http.statusCode, code: failure?.code)
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

private struct ChatImageImportFailureBody: Decodable {
    let code: String?
}

/// Do not echo server-supplied filesystem paths or collapse attachment failures into network errors.
private struct ChatImageImportFailure: LocalizedError {
    let statusCode: Int
    let code: String?
    private let message: String

    @MainActor init(statusCode: Int, code: String?) {
        self.statusCode = statusCode
        self.code = code
        message = Self.localizedMessage(statusCode: statusCode, code: code)
    }

    var errorDescription: String? { message }

    @MainActor private static func localizedMessage(statusCode: Int, code: String?) -> String {
        switch code {
        case "CHAT_IMAGE_ACCESS_DENIED":
            return L10n("图片导入失败：系统拒绝访问图片文件。请尝试复制图片内容后重新粘贴。")
        case "CHAT_IMAGE_SOURCE_MISSING", "CHAT_IMAGE_MISSING":
            return L10n("图片文件已不可用，请重新复制或选择图片。")
        case "CHAT_IMAGE_SIZE_INVALID":
            return L10n("图片超过附件大小限制，未添加。")
        case "CHAT_IMAGE_FORMAT_UNSUPPORTED":
            return L10n("图片格式不受支持，请使用 PNG、JPEG、GIF、WebP 或 HEIC 图片。")
        case "CHAT_IMAGE_PATH_INVALID", "CHAT_IMAGE_NOT_FILE":
            return L10n("无法读取这份图片，请重新复制图片内容后重试。")
        case "SESSION_NOT_FOUND":
            return L10n("当前会话已不可用，图片未添加。")
        default:
            return String(format: L10n("图片导入失败（HTTP %d），请稍后重试。"), statusCode)
        }
    }
}
