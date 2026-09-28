import Foundation

/// Creates Provider Sessions while keeping command progress local to creation surfaces.
@MainActor
final class SessionCreationController: ObservableObject {
    @Published private(set) var isCreatingTask = false
    private let baseURL: URL
    private let currentSettings: () -> BackendSettings?
    private let workspacePath: () -> String
    private let providerDisplayName: (String) -> String?
    private let onCreatedSession: (TaskSession, Bool) -> Void
    private let currentError: () -> String?
    private let reportError: (String?) -> Void
    private let currentStatus: () -> String?
    private let reportStatus: (String?) -> Void

    private var settings: BackendSettings? { currentSettings() }
    private var defaultWorkspacePath: String { workspacePath() }
    private var lastError: String? {
        get { currentError() }
        set { reportError(newValue) }
    }
    private var sendStatusMessage: String? {
        get { currentStatus() }
        set { reportStatus(newValue) }
    }

    init(baseURL: URL, currentSettings: @escaping () -> BackendSettings?,
         workspacePath: @escaping () -> String,
         providerDisplayName: @escaping (String) -> String?,
         onCreatedSession: @escaping (TaskSession, Bool) -> Void,
         currentError: @escaping () -> String?, reportError: @escaping (String?) -> Void,
         currentStatus: @escaping () -> String?, reportStatus: @escaping (String?) -> Void) {
        self.baseURL = baseURL
        self.currentSettings = currentSettings
        self.workspacePath = workspacePath
        self.providerDisplayName = providerDisplayName
        self.onCreatedSession = onCreatedSession
        self.currentError = currentError
        self.reportError = reportError
        self.currentStatus = currentStatus
        self.reportStatus = reportStatus
    }

    func createPtyTask(title: String, command: String, arguments: [String], initialInput: String, cwd: String, onNameConflict: @escaping (String) -> Void = { _ in }, onSuccess: @escaping () -> Void = {}) {
        let trimmedCommand = command.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedCwd = cwd.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedCommand.isEmpty else {
            lastError = L10n("Command is required.")
            return
        }
        guard !isCreatingTask else { return }
        isCreatingTask = true

        Task {
            defer { isCreatingTask = false }

            do {
                var request = URLRequest(url: baseURL.appending(path: "sessions"))
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                request.httpBody = try JSONSerialization.data(withJSONObject: [
                    "providerId": "pty",
                    "title": title.trimmingCharacters(in: .whitespacesAndNewlines),
                    "command": trimmedCommand,
                    "args": arguments,
                    "initialInput": initialInput,
                    "cwd": trimmedCwd.isEmpty ? defaultWorkspacePath : trimmedCwd
                ])

                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse else {
                    throw URLError(.badServerResponse)
                }
                let decoded = try? JSONDecoder().decode(CreatePtySessionResponse.self, from: data)
                guard (200..<300).contains(httpResponse.statusCode) else {
                    if httpResponse.statusCode == 409, let suggestedTitle = decoded?.suggestedTitle {
                        onNameConflict(suggestedTitle)
                        return
                    }
                    let message = httpResponse.statusCode == 409
                        ? L10n("A session with this name already exists.")
                        : decoded?.error ?? String(data: data, encoding: .utf8) ?? "Bad server response"
                    throw BackendError.message(message)
                }
                guard let session = decoded?.session else {
                    throw URLError(.cannotParseResponse)
                }

                onCreatedSession(session, false)
                onSuccess()
                sendStatusMessage = L10n("Started PTY agent")
            } catch {
                lastError = error.localizedDescription
                sendStatusMessage = L10nFormat("Create failed: %@", error.localizedDescription)
            }
        }
    }

    func createCodexPtyTask(
        title: String,
        prompt: String,
        cwd: String,
        existingSessionId: String = "",
        sandbox: String = "workspace-write",
        approvalPolicy: String = "on-request",
        model: String = "",
        reasoningLevel: String = "",
        onNameConflict: @escaping (String) -> Void = { _ in },
        onSuccess: @escaping () -> Void = {}
    ) {
        let trimmedPrompt = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedCwd = cwd.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedExistingSessionId = existingSessionId.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedModel = model.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedReasoningLevel = reasoningLevel.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !isCreatingTask else { return }
        isCreatingTask = true

        Task {
            defer { isCreatingTask = false }

            do {
                let usesAppServer = settings?.codexBackend?.mode != "pty" && trimmedExistingSessionId.isEmpty
                var request = URLRequest(url: baseURL.appending(path: "sessions"))
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                var body: [String: Any] = [
                    "providerId": usesAppServer ? "codex-app-server" : "codex-pty",
                    "title": title.trimmingCharacters(in: .whitespacesAndNewlines),
                    "prompt": trimmedPrompt.isEmpty ? "Reply exactly: Ready" : trimmedPrompt,
                    "cwd": trimmedCwd.isEmpty ? defaultWorkspacePath : trimmedCwd,
                    "sandbox": sandbox,
                    "approvalPolicy": approvalPolicy
                ]
                if !trimmedModel.isEmpty {
                    body["model"] = trimmedModel
                }
                if !trimmedReasoningLevel.isEmpty {
                    body["reasoningLevel"] = trimmedReasoningLevel
                }
                if !usesAppServer {
                    body["prompt"] = trimmedPrompt
                    body["existingSessionId"] = trimmedExistingSessionId
                }
                request.httpBody = try JSONSerialization.data(withJSONObject: body)

                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse else {
                    throw URLError(.badServerResponse)
                }
                let decoded = try? JSONDecoder().decode(CreatePtySessionResponse.self, from: data)
                guard (200..<300).contains(httpResponse.statusCode) else {
                    if httpResponse.statusCode == 409, let suggestedTitle = decoded?.suggestedTitle {
                        onNameConflict(suggestedTitle)
                        return
                    }
                    let message = httpResponse.statusCode == 409
                        ? L10n("A session with this name already exists.")
                        : decoded?.error ?? String(data: data, encoding: .utf8) ?? "Bad server response"
                    throw BackendError.message(message)
                }
                guard let session = decoded?.session else {
                    throw URLError(.cannotParseResponse)
                }

                onCreatedSession(session, false)
                onSuccess()
                sendStatusMessage = usesAppServer ? L10n("Started Codex App Server session") : L10n("Started Codex CLI")
            } catch {
                lastError = error.localizedDescription
                sendStatusMessage = L10nFormat("Create failed: %@", error.localizedDescription)
            }
        }
    }

    func createClaudeTask(
        title: String,
        prompt: String,
        cwd: String,
        sandbox: String = "workspace-write",
        approvalPolicy: String = "on-request",
        model: String = "",
        onNameConflict: @escaping (String) -> Void = { _ in },
        onSuccess: @escaping () -> Void = {}
    ) {
        let trimmedCwd = cwd.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedModel = model.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !isCreatingTask else { return }
        isCreatingTask = true

        Task {
            defer { isCreatingTask = false }

            do {
                var request = URLRequest(url: baseURL.appending(path: "sessions"))
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                var body: [String: Any] = [
                    "providerId": "claude-sdk",
                    "title": title.trimmingCharacters(in: .whitespacesAndNewlines),
                    "prompt": prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Reply exactly: Ready" : prompt.trimmingCharacters(in: .whitespacesAndNewlines),
                    "cwd": trimmedCwd.isEmpty ? defaultWorkspacePath : trimmedCwd,
                    "sandbox": sandbox,
                    "approvalPolicy": approvalPolicy
                ]
                if !trimmedModel.isEmpty {
                    body["model"] = trimmedModel
                }
                request.httpBody = try JSONSerialization.data(withJSONObject: body)

                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse else {
                    throw URLError(.badServerResponse)
                }
                let decoded = try? JSONDecoder().decode(CreatePtySessionResponse.self, from: data)
                guard (200..<300).contains(httpResponse.statusCode) else {
                    if httpResponse.statusCode == 409, let suggestedTitle = decoded?.suggestedTitle {
                        onNameConflict(suggestedTitle)
                        return
                    }
                    let message = httpResponse.statusCode == 409
                        ? L10n("A session with this name already exists.")
                        : decoded?.error ?? String(data: data, encoding: .utf8) ?? "Bad server response"
                    throw BackendError.message(message)
                }
                guard let session = decoded?.session else {
                    throw URLError(.cannotParseResponse)
                }

                onCreatedSession(session, false)
                onSuccess()
                sendStatusMessage = L10n("Started Claude Code")
            } catch {
                lastError = error.localizedDescription
                sendStatusMessage = L10nFormat("Create failed: %@", error.localizedDescription)
            }
        }
    }

    func createProviderTask(
        providerId: String,
        title: String,
        prompt: String,
        cwd: String,
        sandbox: String = "workspace-write",
        approvalPolicy: String = "on-request",
        model: String = "",
        reasoningLevel: String = "",
        onNameConflict: @escaping (String) -> Void = { _ in },
        onSuccess: @escaping () -> Void = {}
    ) {
        let trimmedProviderId = providerId.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedCwd = cwd.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedProviderId.isEmpty, !isCreatingTask else { return }
        isCreatingTask = true

        Task {
            defer { isCreatingTask = false }
            do {
                var request = URLRequest(url: baseURL.appending(path: "sessions"))
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                var body: [String: Any] = [
                    "providerId": trimmedProviderId,
                    "title": title.trimmingCharacters(in: .whitespacesAndNewlines),
                    "prompt": prompt.trimmingCharacters(in: .whitespacesAndNewlines),
                    "cwd": trimmedCwd.isEmpty ? defaultWorkspacePath : trimmedCwd,
                    "sandbox": sandbox,
                    "approvalPolicy": approvalPolicy
                ]
                if !model.isEmpty { body["model"] = model }
                if !reasoningLevel.isEmpty { body["reasoningLevel"] = reasoningLevel }
                request.httpBody = try JSONSerialization.data(withJSONObject: body)

                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse else {
                    throw URLError(.badServerResponse)
                }
                let decoded = try? JSONDecoder().decode(CreatePtySessionResponse.self, from: data)
                guard (200..<300).contains(httpResponse.statusCode) else {
                    if httpResponse.statusCode == 409, let suggestedTitle = decoded?.suggestedTitle {
                        onNameConflict(suggestedTitle)
                        return
                    }
                    throw BackendError.message(decoded?.error ?? String(data: data, encoding: .utf8) ?? "Bad server response")
                }
                guard let session = decoded?.session else {
                    throw URLError(.cannotParseResponse)
                }
                onCreatedSession(session, false)
                onSuccess()
                let providerName = providerDisplayName(trimmedProviderId) ?? trimmedProviderId
                sendStatusMessage = L10nFormat("Started %@", providerName)
            } catch {
                lastError = error.localizedDescription
                sendStatusMessage = L10nFormat("Create failed: %@", error.localizedDescription)
            }
        }
    }

    func createCodexTask(prompt: String, cwd: String, onNameConflict: @escaping (String) -> Void = { _ in }, onSuccess: @escaping () -> Void = {}) {
        let trimmedPrompt = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedCwd = cwd.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedPrompt.isEmpty else {
            lastError = L10n("Task prompt is required.")
            return
        }
        guard !isCreatingTask else { return }
        isCreatingTask = true

        Task {
            defer { isCreatingTask = false }

            do {
                var request = URLRequest(url: baseURL.appending(path: "sessions"))
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                request.httpBody = try JSONSerialization.data(withJSONObject: [
                    "providerId": "codex-app-server",
                    "prompt": trimmedPrompt,
                    "cwd": trimmedCwd.isEmpty ? defaultWorkspacePath : trimmedCwd
                ])

                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse else {
                    throw URLError(.badServerResponse)
                }
                let decoded = try? JSONDecoder().decode(CreateCodexThreadResponse.self, from: data)
                guard (200..<300).contains(httpResponse.statusCode) else {
                    if httpResponse.statusCode == 409, let suggestedTitle = decoded?.suggestedTitle {
                        onNameConflict(suggestedTitle)
                        return
                    }
                    let message = httpResponse.statusCode == 409
                        ? L10n("A session with this name already exists.")
                        : decoded?.error ?? String(data: data, encoding: .utf8) ?? "Bad server response"
                    throw BackendError.message(message)
                }

                onSuccess()
                sendStatusMessage = decoded?.warning ?? "Started Codex"
            } catch {
                lastError = error.localizedDescription
                sendStatusMessage = L10nFormat("Create failed: %@", error.localizedDescription)
            }
        }
    }
}
