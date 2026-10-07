import Foundation
import CorptieClientCore

/// Owns the three-stage GitHub push interaction independently of session commands.
@MainActor
final class GitHubPushController: ObservableObject {
    @Published var preparation: GitHubPushPreparation?
    @Published private(set) var error: String?
    @Published private(set) var isPreparing = false
    @Published private(set) var isGeneratingCommitMessage = false
    @Published private(set) var pushingSessionID: String?

    private let baseURL: URL
    private let selectedSession: () -> TaskSession?
    private let reportError: (String) -> Void
    private let reportStatus: (String) -> Void
    private let refreshStatus: (TaskSession) async -> Void
    private let errorMessage: (Data) -> String?

    init(
        baseURL: URL,
        selectedSession: @escaping () -> TaskSession?,
        reportError: @escaping (String) -> Void,
        reportStatus: @escaping (String) -> Void,
        refreshStatus: @escaping (TaskSession) async -> Void,
        errorMessage: @escaping (Data) -> String?
    ) {
        self.baseURL = baseURL
        self.selectedSession = selectedSession
        self.reportError = reportError
        self.reportStatus = reportStatus
        self.refreshStatus = refreshStatus
        self.errorMessage = errorMessage
    }

    func prepare() {
        guard let session = selectedSession(), !isPreparing, pushingSessionID == nil else { return }
        Task {
            isPreparing = true
            error = nil
            defer { isPreparing = false }
            do {
                let data = try await post("sessions/\(session.id)/github-push/prepare", body: Data("{}".utf8),
                                          fallback: L10n("Could not prepare GitHub push."))
                guard selectedSession()?.id == session.id else { return }
                preparation = try JSONDecoder().decode(GitHubPushPreparation.self, from: data)
            } catch {
                self.error = error.localizedDescription
                reportError(error.localizedDescription)
            }
        }
    }

    func cancel() {
        guard pushingSessionID == nil else { return }
        clearPreparation()
    }

    func clearPreparation() {
        preparation = nil
        error = nil
    }

    func generateCommitMessage() async -> String? {
        guard let session = selectedSession(), let preparation, preparation.dirty,
              !isGeneratingCommitMessage, pushingSessionID == nil else { return nil }
        isGeneratingCommitMessage = true
        error = nil
        defer { isGeneratingCommitMessage = false }
        do {
            let body = try JSONSerialization.data(withJSONObject: ["confirmationToken": preparation.confirmationToken])
            let data = try await post("sessions/\(session.id)/github-push/commit-message", body: body,
                                      fallback: L10n("Could not generate commit message."))
            let result = try JSONDecoder().decode(GitHubCommitMessageSuggestion.self, from: data)
            guard selectedSession()?.id == session.id,
                  self.preparation?.confirmationToken == preparation.confirmationToken else { return nil }
            return result.commitMessage
        } catch {
            if self.preparation?.confirmationToken == preparation.confirmationToken {
                self.error = error.localizedDescription
            }
            return nil
        }
    }

    func confirm(commitMessage: String?, privateFilesDecision: String?, neverRemindPrivateFiles: Bool) {
        guard let session = selectedSession(), let preparation,
              pushingSessionID == nil, !isGeneratingCommitMessage else { return }
        // The modal closes immediately; the push remains visible in the header.
        pushingSessionID = session.id
        self.preparation = nil
        error = nil
        reportStatus(L10n("Pushing to GitHub…"))
        Task {
            defer {
                if pushingSessionID == session.id { pushingSessionID = nil }
            }
            do {
                var body: [String: Any] = ["confirmationToken": preparation.confirmationToken]
                if let commitMessage { body["commitMessage"] = commitMessage }
                if let privateFilesDecision {
                    body["privateFilesDecision"] = privateFilesDecision
                    body["neverRemindPrivateFiles"] = neverRemindPrivateFiles
                }
                let data = try await post("sessions/\(session.id)/github-push/confirm",
                                          body: JSONSerialization.data(withJSONObject: body),
                                          fallback: L10n("GitHub push failed."))
                let result = try JSONDecoder().decode(GitHubPushResult.self, from: data)
                guard result.pushed else { throw BackendError.message(L10n("GitHub did not confirm that the branch was pushed.")) }
                self.preparation = nil
                reportStatus(result.committed
                    ? L10n("Changes committed and pushed to GitHub")
                    : L10n("Branch pushed to GitHub"))
                OperationNotificationManager.shared.complete(.init(category: .gitPush, outcome: .succeeded, name: "Git push", sessionID: session.id))
                if selectedSession()?.id == session.id { await refreshStatus(session) }
            } catch {
                OperationNotificationManager.shared.complete(.init(category: .gitPush, outcome: OperationNotificationOutcome.errorOutcome(error), name: "Git push", sessionID: session.id))
                self.error = error.localizedDescription
                reportError(error.localizedDescription)
                reportStatus(L10nFormat("GitHub push failed: %@", error.localizedDescription))
            }
        }
    }

    private func post(_ path: String, body: Data, fallback: String) async throws -> Data {
        var request = URLRequest(url: baseURL.appending(path: path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = body
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let response = response as? HTTPURLResponse,
              (200..<300).contains(response.statusCode) else {
            throw BackendError.message(errorMessage(data) ?? fallback)
        }
        return data
    }
}
