import Foundation

/// Model, reasoning, and permission commands commit authoritative Session projections.
@MainActor
final class SessionConfigurationController {
    private let baseURL: URL
    private let commands: SessionCommandController
    private let appState: AppStateStore
    private let modelCatalog: ProviderCatalogStore
    private let currentSession: () -> TaskSession?
    private let currentModel: () -> String?
    private let currentError: () -> String?
    private let reportError: (String?) -> Void
    private let errorMessage: (Data) -> String?

    private var selectedSession: TaskSession? { currentSession() }
    private var selectedCurrentModel: String? { currentModel() }
    private var isSwitchingModel: Bool {
        get { commands.isSwitchingModel }
        set { commands.isSwitchingModel = newValue }
    }
    private var isSwitchingReasoning: Bool {
        get { commands.isSwitchingReasoning }
        set { commands.isSwitchingReasoning = newValue }
    }
    private var sendStatusMessage: String? {
        get { commands.sendStatusMessage }
        set { commands.sendStatusMessage = newValue }
    }
    private var lastError: String? {
        get { currentError() }
        set { reportError(newValue) }
    }

    init(baseURL: URL, commands: SessionCommandController, appState: AppStateStore,
         modelCatalog: ProviderCatalogStore, currentSession: @escaping () -> TaskSession?,
         currentModel: @escaping () -> String?, currentError: @escaping () -> String?,
         reportError: @escaping (String?) -> Void, errorMessage: @escaping (Data) -> String?) {
        self.baseURL = baseURL
        self.commands = commands
        self.appState = appState
        self.modelCatalog = modelCatalog
        self.currentSession = currentSession
        self.currentModel = currentModel
        self.currentError = currentError
        self.reportError = reportError
        self.errorMessage = errorMessage
    }

    func switchSelectedCodexModel(to model: CodexModel) {
        guard let selectedSession,
              selectedSession.canSwitchModelNow else {
            sendStatusMessage = L10n("Model switching is not available for this session.")
            return
        }

        Task {
            isSwitchingModel = true
            defer { isSwitchingModel = false }

            do {
                var request = URLRequest(url: baseURL.appending(path: "sessions/\(selectedSession.id)/model"))
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                request.httpBody = try JSONSerialization.data(withJSONObject: ["model": model.id])
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse else {
                    throw URLError(.badServerResponse)
                }
                if !(200..<300).contains(httpResponse.statusCode) {
                    let text = String(data: data, encoding: .utf8) ?? "Bad server response"
                    throw BackendError.message(text)
                }
                let command = try JSONDecoder().decode(SessionConfigurationCommandResponse.self, from: data)
                guard appState.acceptSessionConfiguration(
                    command.session,
                    requestedSessionID: selectedSession.id
                ) else {
                    throw BackendError.message(L10n("The model response did not match the current session."))
                }
                sendStatusMessage = L10nFormat("Switching model to %@", model.name)
            } catch {
                lastError = error.localizedDescription
                sendStatusMessage = L10nFormat("Model switch failed: %@", error.localizedDescription)
            }
        }
    }

    func switchSelectedCodexReasoning(to reasoningLevel: String) {
        let trimmedReasoningLevel = reasoningLevel.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedReasoningLevel.isEmpty else {
            return
        }
        guard let selectedSession,
              selectedSession.canSwitchReasoningNow else {
            sendStatusMessage = L10n("Reasoning switching is not available for this session.")
            return
        }
        if let currentModelID = selectedCurrentModel,
           let currentModel = modelCatalog.codexModels.first(where: { $0.id == currentModelID }),
           let supportedLevels = currentModel.reasoningLevels,
           !supportedLevels.contains(where: {
               $0.caseInsensitiveCompare(trimmedReasoningLevel) == .orderedSame
           }) {
            sendStatusMessage = L10n("This reasoning strength is not supported by the current model.")
            return
        }

        Task {
            isSwitchingReasoning = true
            defer { isSwitchingReasoning = false }

            do {
                var request = URLRequest(url: baseURL.appending(path: "sessions/\(selectedSession.id)/reasoning"))
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                request.httpBody = try JSONSerialization.data(withJSONObject: ["reasoningLevel": trimmedReasoningLevel])
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse else {
                    throw URLError(.badServerResponse)
                }
                if !(200..<300).contains(httpResponse.statusCode) {
                    let text = String(data: data, encoding: .utf8) ?? "Bad server response"
                    throw BackendError.message(text)
                }
                let command = try JSONDecoder().decode(SessionConfigurationCommandResponse.self, from: data)
                guard appState.acceptSessionConfiguration(
                    command.session,
                    requestedSessionID: selectedSession.id
                ) else {
                    throw BackendError.message(L10n("The reasoning response did not match the current session."))
                }
                sendStatusMessage = L10nFormat("Switching Codex reasoning to %@", reasoningLabel(trimmedReasoningLevel))
            } catch {
                lastError = error.localizedDescription
                sendStatusMessage = L10nFormat("Reasoning switch failed: %@", error.localizedDescription)
            }
        }
    }

    func updateSessionPermissions(
        session: TaskSession,
        sandbox: String,
        approvalPolicy: String
    ) async -> Bool {
        do {
            var request = URLRequest(url: baseURL.appending(path: "sessions/\(session.id)/permissions"))
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = try JSONSerialization.data(withJSONObject: [
                "sandbox": sandbox,
                "approvalPolicy": approvalPolicy
            ])
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse else {
                throw URLError(.badServerResponse)
            }
            guard (200..<300).contains(httpResponse.statusCode) else {
                let message = errorMessage(data)
                    ?? String(data: data, encoding: .utf8)
                    ?? "Bad server response"
                throw BackendError.message(message)
            }
            sendStatusMessage = L10n("Session permissions updated.")
            return true
        } catch {
            lastError = error.localizedDescription
            sendStatusMessage = L10nFormat("Permission update failed: %@", error.localizedDescription)
            return false
        }
    }
}

@MainActor
private func reasoningLabel(_ value: String) -> String {
    switch value.lowercased() {
    case "low": L10n("Low")
    case "medium": L10n("Medium")
    case "high": L10n("High")
    case "xhigh": L10n("Extra High")
    default: value
    }
}
