import Foundation

/// Read-only timeline transport. Reuses the existing delta processor; revision
/// checks, merge state and observable publication remain with their owners.
@MainActor
struct SessionTimelineReadAPI {
    let baseURL: URL
    let urlSession: URLSession
    let timelineDeltaProcessor: SessionTimelineDeltaProcessor
    let errorMessage: (Data) -> String?

    static func requestEarlierHistoryPage(
        at url: URL,
        urlSession: URLSession = .shared,
        timeoutInterval: TimeInterval = 15,
        errorMessage: (Data) -> String?
    ) async throws -> SessionHistoryResponse {
        var request = URLRequest(url: url)
        request.timeoutInterval = timeoutInterval
        let (data, response) = try await urlSession.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse,
              httpResponse.statusCode == 200 else {
            throw BackendError.message(
                errorMessage(data) ?? L10n("Could not load earlier messages.")
            )
        }
        let page = try await Task.detached(priority: .userInitiated) {
            try JSONDecoder().decode(SessionHistoryResponse.self, from: data)
        }.value
        if page.cursorStatus == "invalid" {
            throw BackendError.message(L10n("The history cursor is no longer valid. Please retry."))
        }
        return page
    }

    func fetchTimelineChanges(
        for session: TaskSession,
        after revision: Int
    ) async -> SessionTimelineChangeEnvelope? {
        do {
            var components = URLComponents(
                url: baseURL.appending(path: "sessions/\(session.id)/timeline/changes"),
                resolvingAgainstBaseURL: false
            )!
            components.queryItems = [
                URLQueryItem(name: "after", value: String(revision)),
                URLQueryItem(name: "limit", value: "200")
            ]
            let (data, response) = try await urlSession.data(from: components.url!)
            guard let http = response as? HTTPURLResponse,
                  http.statusCode == 200 || http.statusCode == 410 else {
                return nil
            }
            return try await timelineDeltaProcessor.decode(data)
        } catch {
            return nil
        }
    }

    func fetchStoredDetail(
        for session: TaskSession
    ) async -> Result<(detail: CodexThreadDetail, timelineRevision: Int), Error> {
        let threadId = session.external?.threadId ?? session.id
        do {
            let url = baseURL.appending(path: "sessions/\(session.id)/stored-snapshot")
            let (data, response) = try await urlSession.data(from: url)
            guard let http = response as? HTTPURLResponse else {
                throw BackendError.message(L10n("The history server returned an invalid response."))
            }
            guard http.statusCode == 200 else {
                let serverMessage = errorMessage(data)
                    ?? HTTPURLResponse.localizedString(forStatusCode: http.statusCode)
                throw BackendError.message(serverMessage)
            }
            async let header = Task.detached(priority: .utility) {
                try JSONDecoder().decode(StoredSessionTimelineSnapshotHeader.self, from: data)
            }.value
            async let detail = BackendResponseDecoder.detail(
                from: data, threadId: threadId,
                authoritativeCwd: session.external?.cwd,
                workspacePath: session.external?.workspace?.path
            )
            let result = try await (detail, header.timelineRevision)
            return .success(result)
        } catch {
            return .failure(error)
        }
    }
}
