import Foundation

@MainActor
final class BackendClient: ObservableObject {
    static let shared = BackendClient()

    @Published private(set) var sessions: [TaskSession] = []
    @Published private(set) var selectedSession: TaskSession?
    @Published private(set) var selectedDetail: CodexThreadDetail?
    @Published private(set) var isLoadingDetail = false
    @Published private(set) var isSendingMessage = false
    @Published private(set) var sendStatusMessage: String?
    @Published private(set) var isOnline = false
    @Published private(set) var lastError: String?
    @Published private(set) var isCreatingTask = false
    @Published private(set) var settings: BackendSettings?
    @Published private(set) var isUpdatingSettings = false
    @Published private(set) var isTestingChoiceParser = false
    @Published private(set) var codexModels: [CodexModel] = []
    @Published private(set) var codexDefaultModel: String?
    @Published private(set) var codexDefaultReasoningLevel: String?
    @Published private(set) var loadedModelProvider: String?
    @Published private(set) var isLoadingCodexModels = false
    @Published private(set) var isSwitchingModel = false
    @Published private(set) var isSwitchingReasoning = false
    @Published private(set) var connectionTransitionSessionIds = Set<String>()
    @Published var isShowingArchivedSessions = false

    private let baseURL = CorptieAppEnvironment.backendBaseURL
    var defaultWorkspacePath: String {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("corptie", isDirectory: true).path
    }
    private var pollingTask: Task<Void, Never>?
    private var eventStreamTask: Task<Void, Never>?
    private var detailStreamTask: Task<Void, Never>?
    private var pendingUserMessagesByThread: [String: [CodexThreadItem]] = [:]
    private var handledChoiceIds = Set<String>()

    func start() {
        pollingTask?.cancel()
        eventStreamTask?.cancel()
        Task {
            await loadSettings()
            await loadModels(for: "codex-pty")
        }
        startEventStream()
        pollingTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                await self?.refreshSelectedDetailFromPolling()
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    func stop() {
        pollingTask?.cancel()
        pollingTask = nil
        eventStreamTask?.cancel()
        eventStreamTask = nil
        detailStreamTask?.cancel()
        detailStreamTask = nil
    }

    private func startEventStream() {
        eventStreamTask = Task { [weak self] in
            guard let self else {
                return
            }
            while !Task.isCancelled {
                var request = URLRequest(url: self.baseURL.appending(path: "events"))
                request.setValue("text/event-stream", forHTTPHeaderField: "accept")
                do {
                    let (bytes, response) = try await URLSession.shared.bytes(for: request)
                    guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
                        throw URLError(.badServerResponse)
                    }

                    var eventName = ""
                    for try await line in bytes.lines {
                        if Task.isCancelled {
                            return
                        }
                        if line.isEmpty {
                            await self.handleGlobalEvent(eventName)
                            eventName = ""
                        } else if line.hasPrefix("event:") {
                            eventName = String(line.dropFirst(6)).trimmingCharacters(in: .whitespaces)
                        }
                    }
                } catch {
                    if Task.isCancelled {
                        return
                    }
                    try? await Task.sleep(for: .seconds(2))
                }
            }
        }
    }

    private func handleGlobalEvent(_ eventName: String) async {
        let refreshEvents: Set<String> = [
            "CodexThreadCreated",
            "CodexTurnStarted",
            "CodexThreadProgressChanged",
            "CodexThreadCompleted",
            "CodexThreadFailed",
            "CodexThreadError",
            "CodexThreadChoiceOptionsUpdated",
            "CodexThreadApprovalRequested",
            "CodexThreadApprovalResponded",
            "SessionArchived",
            "SessionUnarchived",
            "SessionDeleted",
            "SessionRenamed",
            "SessionAvatarUpdated",
            "PtySessionStarted",
            "PtySessionInputSent",
            "PtySessionTerminated",
            "PtySessionInterrupted",
            "TaskCompleted",
            "TaskBlocked",
            "TaskProgressChanged"
        ]
        guard refreshEvents.contains(eventName) else {
            return
        }
        await refresh()
        if eventName == "CodexThreadChoiceOptionsUpdated"
            || eventName == "CodexThreadApprovalRequested"
            || eventName == "CodexThreadApprovalResponded" {
            await refreshSelectedDetailFromPolling()
        }
    }

    func loadSettings() async {
        do {
            let (data, response) = try await URLSession.shared.data(from: baseURL.appending(path: "settings"))
            guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
                throw URLError(.badServerResponse)
            }
            settings = try JSONDecoder().decode(BackendSettings.self, from: data)
        } catch {
            lastError = error.localizedDescription
        }
    }

    func updateDataDirectory(_ dataDir: String) async {
        await updateSettings(dataDir: dataDir, choiceParser: settings?.choiceParser, codexBackend: settings?.codexBackend, agentProxy: settings?.agentProxy)
    }

    @discardableResult
    func updateSettings(dataDir: String, choiceParser: ChoiceParserSettings?, codexBackend: CodexBackendSettings? = nil, agentProxy: AgentProxySettings? = nil) async -> Bool {
        let trimmed = dataDir.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            lastError = "Data directory is required."
            return false
        }

        isUpdatingSettings = true
        defer { isUpdatingSettings = false }

        do {
            var request = URLRequest(url: baseURL.appending(path: "settings"))
            request.httpMethod = "PATCH"
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            var body: [String: Any] = ["dataDir": trimmed]
            if let choiceParser {
                body["choiceParser"] = [
                    "provider": choiceParser.provider,
                    "openaiBaseURL": choiceParser.openaiBaseURL,
                    "openaiApiKey": choiceParser.openaiApiKey,
                    "openaiModel": choiceParser.openaiModel,
                    "localCommand": choiceParser.localCommand,
                    "localArgs": choiceParser.localArgs,
                    "localModel": choiceParser.localModel,
                    "timeoutMs": choiceParser.timeoutMs
                ]
            }
            if let codexBackend {
                body["codexBackend"] = [
                    "mode": codexBackend.mode
                ]
            }
            if let agentProxy {
                body["agentProxy"] = agentProxyBody(agentProxy)
            }
            request.httpBody = try JSONSerialization.data(withJSONObject: body)

            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse else {
                throw URLError(.badServerResponse)
            }
            if !(200..<300).contains(httpResponse.statusCode) {
                let text = String(data: data, encoding: .utf8) ?? "Bad server response"
                throw BackendError.message(text)
            }
            settings = try JSONDecoder().decode(BackendSettings.self, from: data)
            lastError = nil
            await refresh()
            return true
        } catch {
            lastError = error.localizedDescription
            return false
        }
    }

    func testChoiceParser(_ choiceParser: ChoiceParserSettings, agentProxy: AgentProxySettings? = nil) async -> Result<String, Error> {
        isTestingChoiceParser = true
        defer { isTestingChoiceParser = false }

        do {
            var request = URLRequest(url: baseURL.appending(path: "settings/choice-parser/test"))
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            var body: [String: Any] = [
                "choiceParser": [
                    "provider": choiceParser.provider,
                    "openaiBaseURL": choiceParser.openaiBaseURL,
                    "openaiApiKey": choiceParser.openaiApiKey,
                    "openaiModel": choiceParser.openaiModel,
                    "localCommand": choiceParser.localCommand,
                    "localArgs": choiceParser.localArgs,
                    "localModel": choiceParser.localModel,
                    "timeoutMs": choiceParser.timeoutMs
                ]
            ]
            if let agentProxy {
                body["agentProxy"] = agentProxyBody(agentProxy)
            }
            request.httpBody = try JSONSerialization.data(withJSONObject: body)

            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse else {
                throw URLError(.badServerResponse)
            }
            let decoded = try JSONDecoder().decode(ChoiceParserTestResponse.self, from: data)
            if !(200..<300).contains(httpResponse.statusCode) || !decoded.ok {
                throw BackendError.message(decoded.error ?? "Choice parser test failed.")
            }
            lastError = nil
            return .success(choiceParserTestMessage(durationMs: decoded.durationMs))
        } catch {
            lastError = error.localizedDescription
            return .failure(error)
        }
    }

    func loadModelsForSelectedSession() async {
        let provider = selectedSession?.external?.provider ?? "codex-pty"
        await loadModels(for: provider)
    }

    func loadModels(for provider: String) async {
        if isLoadingCodexModels {
            return
        }
        isLoadingCodexModels = true
        defer { isLoadingCodexModels = false }

        do {
            let path = provider == "claude-sdk" ? "claude/models" : "codex/models"
            let (data, response) = try await URLSession.shared.data(from: baseURL.appending(path: path))
            guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
                throw URLError(.badServerResponse)
            }
            let decoded = try JSONDecoder().decode(CodexModelsResponse.self, from: data)
            loadedModelProvider = provider
            codexDefaultModel = decoded.currentModel
            codexDefaultReasoningLevel = decoded.currentReasoningLevel
            codexModels = decoded.models
            lastError = nil
        } catch {
            lastError = error.localizedDescription
        }
    }

    func lookupCodexSession(_ sessionId: String) async throws -> CodexSessionLookupResponse {
        let trimmedSessionId = sessionId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedSessionId.isEmpty else {
            throw BackendError.message("Session ID is required.")
        }

        let url = baseURL
            .appending(path: "codex")
            .appending(path: "sessions")
            .appending(path: trimmedSessionId)
        let (data, response) = try await URLSession.shared.data(from: url)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
        let decoded = try? JSONDecoder().decode(CodexSessionLookupResponse.self, from: data)
        guard (200..<300).contains(httpResponse.statusCode) else {
            throw BackendError.message(decoded?.error ?? String(data: data, encoding: .utf8) ?? "Codex session not found.")
        }
        if let decoded {
            return decoded
        }
        throw URLError(.cannotParseResponse)
    }

    func refresh() async {
        do {
            var components = URLComponents(url: baseURL.appending(path: "sessions"), resolvingAgainstBaseURL: false)!
            if isShowingArchivedSessions {
                components.queryItems = [URLQueryItem(name: "archived", value: "true")]
            }
            let url = components.url!
            let (data, response) = try await URLSession.shared.data(from: url)
            guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
                throw URLError(.badServerResponse)
            }

            let decoded = try JSONDecoder().decode(SessionsResponse.self, from: data)
            sessions = decoded.sessions
            syncSelectedSessionFromSessions()
            syncSelectedDetailMetadataFromSessions()
            isOnline = true
            lastError = nil
        } catch {
            isOnline = false
            lastError = error.localizedDescription
        }
    }

    func createPtyTask(title: String, command: String, arguments: [String], initialInput: String, cwd: String, onSuccess: @escaping () -> Void = {}) {
        let trimmedCommand = command.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedCwd = cwd.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedCommand.isEmpty else {
            lastError = "Command is required."
            return
        }

        Task {
            isCreatingTask = true
            defer { isCreatingTask = false }

            do {
                var request = URLRequest(url: baseURL.appending(path: "pty/sessions"))
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                request.httpBody = try JSONSerialization.data(withJSONObject: [
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
                    let message = decoded?.error ?? String(data: data, encoding: .utf8) ?? "Bad server response"
                    throw BackendError.message(message)
                }

                onSuccess()
                sendStatusMessage = "Started PTY agent"
                await refresh()
            } catch {
                lastError = error.localizedDescription
                sendStatusMessage = "Create failed: \(error.localizedDescription)"
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
        onSuccess: @escaping () -> Void = {}
    ) {
        let trimmedPrompt = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedCwd = cwd.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedExistingSessionId = existingSessionId.trimmingCharacters(in: .whitespacesAndNewlines)

        Task {
            isCreatingTask = true
            defer { isCreatingTask = false }

            do {
                let usesAppServer = settings?.codexBackend?.mode != "pty" && trimmedExistingSessionId.isEmpty
                var request = URLRequest(url: baseURL.appending(path: usesAppServer ? "codex/threads" : "codex/pty-sessions"))
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                var body: [String: Any] = [
                    "title": title.trimmingCharacters(in: .whitespacesAndNewlines),
                    "prompt": trimmedPrompt.isEmpty ? "Reply exactly: Ready" : trimmedPrompt,
                    "cwd": trimmedCwd.isEmpty ? defaultWorkspacePath : trimmedCwd,
                    "sandbox": sandbox,
                    "approvalPolicy": approvalPolicy
                ]
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
                    let message = decoded?.error ?? String(data: data, encoding: .utf8) ?? "Bad server response"
                    throw BackendError.message(message)
                }

                onSuccess()
                sendStatusMessage = usesAppServer ? "Started Codex App Server session" : "Started Codex CLI"
                await refresh()
            } catch {
                lastError = error.localizedDescription
                sendStatusMessage = "Create failed: \(error.localizedDescription)"
            }
        }
    }

    func createClaudeTask(
        title: String,
        prompt: String,
        cwd: String,
        onSuccess: @escaping () -> Void = {}
    ) {
        let trimmedCwd = cwd.trimmingCharacters(in: .whitespacesAndNewlines)

        Task {
            isCreatingTask = true
            defer { isCreatingTask = false }

            do {
                var request = URLRequest(url: baseURL.appending(path: "claude/sessions"))
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                request.httpBody = try JSONSerialization.data(withJSONObject: [
                    "title": title.trimmingCharacters(in: .whitespacesAndNewlines),
                    "prompt": prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Reply exactly: Ready" : prompt.trimmingCharacters(in: .whitespacesAndNewlines),
                    "cwd": trimmedCwd.isEmpty ? defaultWorkspacePath : trimmedCwd
                ])

                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse else {
                    throw URLError(.badServerResponse)
                }
                let decoded = try? JSONDecoder().decode(CreatePtySessionResponse.self, from: data)
                guard (200..<300).contains(httpResponse.statusCode) else {
                    let message = decoded?.error ?? String(data: data, encoding: .utf8) ?? "Bad server response"
                    throw BackendError.message(message)
                }

                onSuccess()
                sendStatusMessage = "Started Claude Code"
                await refresh()
            } catch {
                lastError = error.localizedDescription
                sendStatusMessage = "Create failed: \(error.localizedDescription)"
            }
        }
    }

    func respondToCodexApproval(option: CodexApprovalOption) {
        guard let session = selectedSession else {
            sendStatusMessage = "No Codex approval is active."
            return
        }
        respondToCodexApproval(option: option, to: session)
    }

    func respondToCodexApproval(option: CodexApprovalOption, to session: TaskSession) {
        guard let provider = session.external?.provider,
              let threadId = session.external?.threadId else {
            sendStatusMessage = "No Codex approval is active."
            return
        }

        clearSuggestedOptions(for: session)
        Task {
            isSendingMessage = true
            sendStatusMessage = "Selecting Codex option..."
            defer { isSendingMessage = false }

            do {
                let path = isPtyProvider(provider)
                    ? "pty/sessions/\(threadId)/codex-approval"
                    : "codex/threads/\(threadId)/approval"
                var request = URLRequest(url: baseURL.appending(path: path))
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                request.httpBody = try JSONSerialization.data(withJSONObject: [
                    "optionId": option.id,
                    "optionIndex": option.index ?? 0,
                    "approved": option.role?.localizedCaseInsensitiveContains("deny") != true
                ])

                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse else {
                    throw URLError(.badServerResponse)
                }
                guard (200..<300).contains(httpResponse.statusCode) else {
                    throw BackendError.message(Self.errorMessage(from: data) ?? "Bad server response")
                }

                sendStatusMessage = "Selected \(option.label)"
                if selectedSession?.id == session.id {
                    await loadDetail(for: session)
                }
                await refresh()
            } catch {
                lastError = error.localizedDescription
                sendStatusMessage = "Approval failed: \(error.localizedDescription)"
            }
        }
    }

    func respondToCodexApproval(approved: Bool) {
        let fallback = CodexApprovalOption(
            id: approved ? "approve" : "deny",
            label: approved ? "Approve" : "Deny",
            role: approved ? "approve" : "deny",
            index: approved ? 0 : 1,
            selected: approved
        )
        respondToCodexApproval(option: fallback)
    }

    func respondToPtyChoice(option: CodexApprovalOption, choiceId: String? = nil) {
        guard let session = selectedSession,
              isPtyProvider(session.external?.provider),
              let threadId = session.external?.threadId else {
            sendStatusMessage = "No terminal choice is active."
            return
        }

        Task {
            isSendingMessage = true
            sendStatusMessage = "Selecting option..."
            defer { isSendingMessage = false }

            do {
                var request = URLRequest(url: baseURL.appending(path: "pty/sessions/\(threadId)/choice"))
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                var body: [String: Any] = [
                    "optionId": option.id,
                    "optionIndex": option.index ?? 0
                ]
                if let choiceId, !choiceId.isEmpty {
                    body["choiceId"] = choiceId
                }
                request.httpBody = try JSONSerialization.data(withJSONObject: body)

                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse else {
                    throw URLError(.badServerResponse)
                }
                guard (200..<300).contains(httpResponse.statusCode) else {
                    throw BackendError.message(Self.errorMessage(from: data) ?? "Bad server response")
                }

                if let choiceId, !choiceId.isEmpty {
                    markChoiceHandled(choiceId: choiceId, selectedOptionId: option.id)
                }
                sendStatusMessage = "Selected \(option.label)"
                await loadDetail(for: session)
                await refresh()
            } catch {
                lastError = error.localizedDescription
                sendStatusMessage = "Choice failed: \(error.localizedDescription)"
            }
        }
    }

    func createCodexTask(prompt: String, cwd: String, onSuccess: @escaping () -> Void = {}) {
        let trimmedPrompt = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedCwd = cwd.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedPrompt.isEmpty else {
            lastError = "Task prompt is required."
            return
        }

        Task {
            isCreatingTask = true
            defer { isCreatingTask = false }

            do {
                var request = URLRequest(url: baseURL.appending(path: "codex/threads"))
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                request.httpBody = try JSONSerialization.data(withJSONObject: [
                    "prompt": trimmedPrompt,
                    "cwd": trimmedCwd.isEmpty ? defaultWorkspacePath : trimmedCwd
                ])

                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse else {
                    throw URLError(.badServerResponse)
                }
                let decoded = try? JSONDecoder().decode(CreateCodexThreadResponse.self, from: data)
                guard (200..<300).contains(httpResponse.statusCode) else {
                    let message = decoded?.error ?? String(data: data, encoding: .utf8) ?? "Bad server response"
                    throw BackendError.message(message)
                }

                onSuccess()
                sendStatusMessage = decoded?.warning ?? "Started Codex"
                await refresh()
            } catch {
                lastError = error.localizedDescription
                sendStatusMessage = "Create failed: \(error.localizedDescription)"
            }
        }
    }

    func select(session: TaskSession) {
        selectedSession = session
        selectedDetail = nil
        startDetailStream(for: session)
        Task {
            await loadDetail(for: session)
        }
    }

    func closeDetail() {
        detailStreamTask?.cancel()
        detailStreamTask = nil
        selectedSession = nil
        selectedDetail = nil
        isLoadingDetail = false
    }

    func loadSelectedDetail() {
        guard let selectedSession else {
            return
        }

        Task {
            await loadDetail(for: selectedSession)
        }
    }

    func sendMessage(_ text: String, onSuccess: @escaping () -> Void = {}) {
        if selectedDetail?.canSend == false {
            sendStatusMessage = selectedDetail?.sendUnavailableReason ?? "This thread is read-only in Corptie."
            return
        }

        guard let selectedSession, selectedSession.external?.threadId != nil else {
            lastError = "This task does not expose a Codex thread id."
            sendStatusMessage = lastError
            return
        }

        sendText(text, to: selectedSession, reloadDetail: true, isChoiceSelection: false, onSuccess: onSuccess)
    }

    func sendMessage(_ text: String, to session: TaskSession, isChoiceSelection: Bool = false, onSuccess: @escaping () -> Void = {}) {
        sendText(text, to: session, reloadDetail: selectedSession?.id == session.id, isChoiceSelection: isChoiceSelection, onSuccess: onSuccess)
    }

    private func sendText(_ text: String, to session: TaskSession, reloadDetail: Bool, isChoiceSelection: Bool, onSuccess: @escaping () -> Void) {
        guard let threadId = session.external?.threadId else {
            lastError = "This task does not expose a Codex thread id."
            sendStatusMessage = lastError
            return
        }

        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return
        }
        clearSuggestedOptions(for: session)
        if reloadDetail {
            appendOptimisticUserMessage(trimmed, to: session)
        }

        Task {
            isSendingMessage = true
            sendStatusMessage = isPtyProvider(session.external?.provider) ? "Sending to terminal agent..." : "Sending to Codex..."
            defer { isSendingMessage = false }

            do {
                let path = isPtyProvider(session.external?.provider)
                    ? "pty/sessions/\(threadId)/input"
                    : "codex/threads/\(threadId)/messages"
                var request = URLRequest(url: baseURL.appending(path: path))
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                request.httpBody = try JSONSerialization.data(withJSONObject: [
                    "text": trimmed,
                    "isChoiceSelection": isChoiceSelection
                ])

                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse else {
                    throw URLError(.badServerResponse)
                }
                let decoded = try? JSONDecoder().decode(SendMessageResponse.self, from: data)
                guard (200..<300).contains(httpResponse.statusCode) else {
                    let message = decoded?.error ?? String(data: data, encoding: .utf8) ?? "Bad server response"
                    let hint = decoded?.hint.map { "\n\($0)" } ?? ""
                    throw BackendError.message("\(message)\(hint)")
                }

                onSuccess()
                if isPtyProvider(session.external?.provider) {
                    sendStatusMessage = session.external?.provider == "codex-pty" ? "Sent to Codex CLI" : "Sent to PTY agent"
                } else if decoded?.visibleInCodexDesktop == false {
                    sendStatusMessage = decoded?.warning ?? "Sent to background Codex; Desktop may not refresh."
                } else {
                    sendStatusMessage = "Sent to Codex"
                }
                if reloadDetail {
                    await loadDetail(for: session)
                }
                await refresh()
            } catch {
                lastError = error.localizedDescription
                sendStatusMessage = "Send failed: \(error.localizedDescription)"
            }
        }
    }

    private func clearSuggestedOptions(for session: TaskSession) {
        sessions = sessions.map { existing in
            guard existing.id == session.id else {
                return existing
            }
            return TaskSession(
                id: existing.id,
                title: existing.title,
                agent: existing.agent,
                status: existing.status == .complete || existing.status == .blocked ? .running : existing.status,
                progress: existing.status == .complete || existing.status == .blocked ? 0.5 : existing.progress,
                summary: existing.summary,
                suggestedOptions: nil,
                suggestedPrompt: nil,
                activityStatus: existing.activityStatus,
                updatedAt: existing.updatedAt,
                accent: existing.accent,
                archived: existing.archived,
                pinned: existing.pinned,
                sortOrder: existing.sortOrder,
                avatarPath: existing.avatarPath,
                capabilities: existing.capabilities,
                external: existing.external
            )
        }
    }

    private func appendOptimisticUserMessage(_ text: String, to session: TaskSession) {
        let threadId = session.external?.threadId ?? session.id
        guard selectedSession?.id == session.id || selectedDetail?.id == threadId else {
            return
        }
        let now = ISO8601DateFormatter().string(from: Date())
        let optimisticTurnId = "optimistic-turn:\(session.id):\(UUID().uuidString)"
        let item = CodexThreadItem(
            id: "optimistic:\(session.id):\(UUID().uuidString)",
            turnId: optimisticTurnId,
            turnStatus: "running",
            type: "userMessage",
            title: "User",
            text: text,
            options: nil,
            status: "sent",
            createdAt: now
        )
        pendingUserMessagesByThread[threadId, default: []].append(item)

        guard let detail = selectedDetail, detail.id == threadId else {
            selectedDetail = optimisticDetail(for: session, threadId: threadId, now: now)
            return
        }
        selectedDetail = CodexThreadDetail(
            id: detail.id,
            title: detail.title,
            status: detail.status,
            source: detail.source,
            connectionStatus: detail.connectionStatus,
            currentModel: detail.currentModel,
            currentReasoningLevel: detail.currentReasoningLevel,
            activityStatus: detail.activityStatus,
            cwd: detail.cwd,
            createdAt: detail.createdAt,
            updatedAt: now,
            canSend: detail.canSend,
            sendUnavailableReason: detail.sendUnavailableReason,
            capabilities: detail.capabilities,
            turnCount: detail.turnCount,
            items: mergedItems(serverItems: detail.items, pendingItems: pendingUserMessagesByThread[threadId] ?? [])
        )
    }

    private func optimisticDetail(for session: TaskSession, threadId: String, now: String) -> CodexThreadDetail {
        CodexThreadDetail(
            id: threadId,
            title: session.title,
            status: session.status,
            source: session.external?.source,
            connectionStatus: session.external?.connectionStatus,
            currentModel: session.external?.currentModel,
            currentReasoningLevel: session.external?.currentReasoningLevel,
            activityStatus: session.activityStatus,
            cwd: session.external?.cwd,
            createdAt: session.updatedAt,
            updatedAt: now,
            canSend: true,
            sendUnavailableReason: nil,
            capabilities: session.capabilities,
            turnCount: 0,
            items: pendingUserMessagesByThread[threadId] ?? []
        )
    }

    func cancel(session: TaskSession) {
        Task {
            do {
                let path = isPtyProvider(session.external?.provider)
                    ? "pty/sessions/\(session.external?.threadId ?? session.id)/terminate"
                    : "tasks/\(session.id)/cancel"
                var request = URLRequest(url: baseURL.appending(path: path))
                request.httpMethod = "POST"
                _ = try await URLSession.shared.data(for: request)
                await refresh()
            } catch {
                lastError = error.localizedDescription
            }
        }
    }

    func interrupt(session: TaskSession) {
        if session.external?.provider == "codex-app-server" {
            cancel(session: session)
            return
        }

        guard let threadId = session.external?.threadId, isPtyProvider(session.external?.provider) else {
            cancel(session: session)
            return
        }

        Task {
            do {
                var request = URLRequest(url: baseURL.appending(path: "pty/sessions/\(threadId)/interrupt"))
                request.httpMethod = "POST"
                _ = try await URLSession.shared.data(for: request)
                sendStatusMessage = session.external?.provider == "codex-pty" ? "Interrupted Codex CLI" : "Interrupted PTY agent"
                await refresh()
                if selectedSession?.id == session.id {
                    await loadDetail(for: session)
                }
            } catch {
                lastError = error.localizedDescription
                sendStatusMessage = "Interrupt failed: \(error.localizedDescription)"
            }
        }
    }

    func togglePtyConnection(for session: TaskSession) {
        guard session.external?.provider == "codex-pty",
              let threadId = session.external?.threadId else {
            return
        }

        Task {
            connectionTransitionSessionIds.insert(session.id)
            defer {
                connectionTransitionSessionIds.remove(session.id)
            }
            do {
                let action = session.isConnected ? "disconnect" : "reconnect"
                var request = URLRequest(url: baseURL.appending(path: "pty/sessions/\(threadId)/\(action)"))
                request.httpMethod = "POST"
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse else {
                    throw URLError(.badServerResponse)
                }
                if !(200..<300).contains(httpResponse.statusCode) {
                    let text = String(data: data, encoding: .utf8) ?? "Bad server response"
                    throw BackendError.message(text)
                }
                sendStatusMessage = session.isConnected ? "PTY disconnected" : "PTY reconnected"
                await refresh()
                if selectedSession?.id == session.id {
                    await loadDetail(for: session, showLoading: false)
                }
            } catch {
                lastError = error.localizedDescription
                sendStatusMessage = session.isConnected
                    ? "Disconnect failed: \(error.localizedDescription)"
                    : "Reconnect failed: \(error.localizedDescription)"
            }
        }
    }

    func reconnect(session: TaskSession) {
        guard let threadId = session.external?.threadId else {
            return
        }

        Task {
            connectionTransitionSessionIds.insert(session.id)
            defer {
                connectionTransitionSessionIds.remove(session.id)
            }
            do {
                sendStatusMessage = "Reconnecting..."
                var request = URLRequest(url: baseURL.appending(path: "pty/sessions/\(threadId)/reconnect"))
                request.httpMethod = "POST"
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse else {
                    throw URLError(.badServerResponse)
                }
                if !(200..<300).contains(httpResponse.statusCode) {
                    let text = String(data: data, encoding: .utf8) ?? "Bad server response"
                    throw BackendError.message(text)
                }
                sendStatusMessage = "Reconnected"
                await refresh()
                if selectedSession?.id == session.id {
                    await loadDetail(for: session, showLoading: false)
                }
            } catch {
                lastError = error.localizedDescription
                sendStatusMessage = "Reconnect failed: \(error.localizedDescription)"
            }
        }
    }

    func setArchived(_ archived: Bool, session: TaskSession) {
        Task {
            do {
                var request = URLRequest(url: baseURL.appending(path: "sessions/\(session.id)/archive"))
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                request.httpBody = try JSONSerialization.data(withJSONObject: ["archived": archived])
                _ = try await URLSession.shared.data(for: request)
                if selectedSession?.id == session.id {
                    closeDetail()
                }
                await refresh()
            } catch {
                lastError = error.localizedDescription
            }
        }
    }

    func setPinned(_ pinned: Bool, session: TaskSession) {
        Task {
            do {
                var request = URLRequest(url: baseURL.appending(path: "sessions/\(session.id)/pin"))
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                request.httpBody = try JSONSerialization.data(withJSONObject: ["pinned": pinned])
                let (_, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse, (200..<300).contains(httpResponse.statusCode) else {
                    throw URLError(.badServerResponse)
                }
                await refresh()
            } catch {
                lastError = error.localizedDescription
            }
        }
    }

    func moveSession(draggedSessionId: String, before targetSessionId: String?) {
        guard draggedSessionId != targetSessionId,
              let fromIndex = sessions.firstIndex(where: { $0.id == draggedSessionId }) else {
            return
        }

        let movedSession = sessions.remove(at: fromIndex)
        guard let targetSessionId,
              let targetIndex = sessions.firstIndex(where: { $0.id == targetSessionId }) else {
            if fromIndex == sessions.count {
                sessions.insert(movedSession, at: fromIndex)
                return
            }
            sessions.append(movedSession)
            return
        }
        let insertionIndex = fromIndex < targetIndex ? targetIndex : targetIndex
        if insertionIndex == fromIndex {
            sessions.insert(movedSession, at: fromIndex)
            return
        }
        sessions.insert(movedSession, at: max(0, min(insertionIndex, sessions.count)))
    }

    func persistSessionOrder() {
        let orderedIds = sessions.map(\.id)
        Task {
            do {
                var request = URLRequest(url: baseURL.appending(path: "sessions/reorder"))
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                request.httpBody = try JSONSerialization.data(withJSONObject: ["sessionIds": orderedIds])
                let (_, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse, (200..<300).contains(httpResponse.statusCode) else {
                    throw URLError(.badServerResponse)
                }
                await refresh()
            } catch {
                lastError = error.localizedDescription
            }
        }
    }

    func rename(session: TaskSession, title: String, onSuccess: @escaping () -> Void = {}) {
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedTitle.isEmpty else {
            lastError = "Title is required."
            return
        }

        Task {
            do {
                var request = URLRequest(url: baseURL.appending(path: "sessions/\(session.id)"))
                request.httpMethod = "PATCH"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                request.httpBody = try JSONSerialization.data(withJSONObject: ["title": trimmedTitle])
                let (_, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse, (200..<300).contains(httpResponse.statusCode) else {
                    throw URLError(.badServerResponse)
                }
                onSuccess()
                await refresh()
                if selectedSession?.id == session.id {
                    selectedSession = sessions.first(where: { $0.id == session.id }) ?? selectedSession
                }
            } catch {
                lastError = error.localizedDescription
            }
        }
    }

    func updateAvatar(session: TaskSession, avatarPath: String?) {
        Task {
            do {
                var request = URLRequest(url: baseURL.appending(path: "sessions/\(session.id)"))
                request.httpMethod = "PATCH"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                let payload: [String: Any] = ["avatarPath": avatarPath ?? NSNull()]
                request.httpBody = try JSONSerialization.data(withJSONObject: payload)
                let (_, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse, (200..<300).contains(httpResponse.statusCode) else {
                    throw URLError(.badServerResponse)
                }
                await refresh()
                if selectedSession?.id == session.id {
                    selectedSession = sessions.first(where: { $0.id == session.id }) ?? selectedSession
                }
            } catch {
                lastError = error.localizedDescription
            }
        }
    }

    func delete(session: TaskSession) {
        Task {
            do {
                var request = URLRequest(url: baseURL.appending(path: "sessions/\(session.id)"))
                request.httpMethod = "DELETE"
                _ = try await URLSession.shared.data(for: request)
                if selectedSession?.id == session.id {
                    closeDetail()
                }
                await refresh()
            } catch {
                lastError = error.localizedDescription
            }
        }
    }

    func interruptSelectedSession() {
        guard let selectedSession else {
            return
        }

        guard let threadId = selectedSession.external?.threadId, isPtyProvider(selectedSession.external?.provider) else {
            cancel(session: selectedSession)
            return
        }

        Task {
            do {
                var request = URLRequest(url: baseURL.appending(path: "pty/sessions/\(threadId)/interrupt"))
                request.httpMethod = "POST"
                _ = try await URLSession.shared.data(for: request)
                sendStatusMessage = selectedSession.external?.provider == "codex-pty" ? "Interrupted Codex CLI" : "Interrupted PTY agent"
                await loadDetail(for: selectedSession)
                await refresh()
            } catch {
                lastError = error.localizedDescription
                sendStatusMessage = "Interrupt failed: \(error.localizedDescription)"
            }
        }
    }

    func switchSelectedCodexModel(to model: CodexModel) {
        guard let selectedSession,
              selectedSession.capabilities?.canSwitchModel == true else {
            sendStatusMessage = "Model switching is not available for this session."
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
                let provider = selectedSession.external?.provider == "claude-sdk" ? "Claude" : "Codex"
                sendStatusMessage = "Switching \(provider) model to \(model.name)"
                await loadDetail(for: selectedSession)
                await refresh()
            } catch {
                lastError = error.localizedDescription
                sendStatusMessage = "Model switch failed: \(error.localizedDescription)"
            }
        }
    }

    func switchSelectedCodexReasoning(to reasoningLevel: String) {
        let trimmedReasoningLevel = reasoningLevel.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedReasoningLevel.isEmpty else {
            return
        }
        guard let selectedSession else {
            sendStatusMessage = "Reasoning switching is not available for this session."
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
                sendStatusMessage = "Switching Codex reasoning to \(reasoningLabel(trimmedReasoningLevel))"
                await loadDetail(for: selectedSession)
                await refresh()
            } catch {
                lastError = error.localizedDescription
                sendStatusMessage = "Reasoning switch failed: \(error.localizedDescription)"
            }
        }
    }

    func reconnectSelectedSession() {
        guard let selectedSession else {
            return
        }
        reconnect(session: selectedSession)
    }

    private func refreshSelectedDetailFromPolling() async {
        guard let selectedSession else {
            return
        }
        await loadDetail(for: selectedSession, showLoading: false)
    }

    func fetchDetail(for session: TaskSession) async -> CodexThreadDetail? {
        guard let threadId = session.external?.threadId else {
            return nil
        }

        do {
            let path = isPtyProvider(session.external?.provider)
                ? "pty/sessions/\(threadId)"
                : "codex/threads/\(threadId)"
            let url = baseURL.appending(path: path)
            let (data, response) = try await URLSession.shared.data(from: url)
            guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
                throw URLError(.badServerResponse)
            }

            let decoded = try JSONDecoder().decode(CodexThreadDetailResponse.self, from: data)
            lastError = nil
            return decoded.thread
        } catch {
            lastError = error.localizedDescription
            return nil
        }
    }

    private func startDetailStream(for session: TaskSession) {
        detailStreamTask?.cancel()
        guard let threadId = session.external?.threadId,
              isPtyProvider(session.external?.provider) else {
            detailStreamTask = nil
            return
        }

        detailStreamTask = Task { [weak self] in
            guard let self else {
                return
            }
            var request = URLRequest(url: self.baseURL.appending(path: "pty/sessions/\(threadId)/events"))
            request.setValue("text/event-stream", forHTTPHeaderField: "accept")

            do {
                let (bytes, response) = try await URLSession.shared.bytes(for: request)
                guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
                    throw URLError(.badServerResponse)
                }

                var eventName = ""
                var dataLines: [String] = []
                for try await line in bytes.lines {
                    if Task.isCancelled {
                        return
                    }
                    if line.isEmpty {
                        await self.handleDetailStreamEvent(
                            eventName: eventName,
                            data: dataLines.joined(separator: "\n"),
                            expectedThreadId: threadId
                        )
                        eventName = ""
                        dataLines.removeAll(keepingCapacity: true)
                    } else if line.hasPrefix("event:") {
                        eventName = String(line.dropFirst(6)).trimmingCharacters(in: .whitespaces)
                    } else if line.hasPrefix("data:") {
                        dataLines.append(String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces))
                    }
                }
            } catch {
                if !Task.isCancelled {
                    lastError = error.localizedDescription
                }
            }
        }
    }

    private func handleDetailStreamEvent(eventName: String, data: String, expectedThreadId: String) async {
        guard eventName.isEmpty || eventName == "detail",
              !data.isEmpty,
              selectedSession?.external?.threadId == expectedThreadId,
              let payload = data.data(using: .utf8) else {
            return
        }
        do {
            let decoded = try JSONDecoder().decode(CodexThreadDetailResponse.self, from: payload)
            let mergedDetail = applyingHandledChoices(to: stableDetailReplacingEmptyItems(detailByMergingPendingMessages(decoded.thread)))
            selectedDetail = mergedDetail
            syncSessionSummary(from: mergedDetail)
            lastError = nil
        } catch {
            lastError = error.localizedDescription
        }
    }

    private func loadDetail(for session: TaskSession, showLoading: Bool = true) async {
        guard let threadId = session.external?.threadId else {
            lastError = "No Codex detail is available for this task."
            return
        }

        if showLoading {
            isLoadingDetail = true
        }
        defer {
            if showLoading {
                isLoadingDetail = false
            }
        }

        do {
            let path = isPtyProvider(session.external?.provider)
                ? "pty/sessions/\(threadId)"
                : "codex/threads/\(threadId)"
            let url = baseURL.appending(path: path)
            let (data, response) = try await URLSession.shared.data(from: url)
            guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
                throw URLError(.badServerResponse)
            }

            let decoded = try JSONDecoder().decode(CodexThreadDetailResponse.self, from: data)
            let mergedDetail = applyingHandledChoices(to: stableDetailReplacingEmptyItems(detailByMergingPendingMessages(decoded.thread)))
            selectedDetail = mergedDetail
            syncSessionSummary(from: mergedDetail)
            lastError = nil
        } catch {
            lastError = error.localizedDescription
        }
    }

    private func syncSessionSummary(from detail: CodexThreadDetail) {
        let latestSummary = detail.items.reversed().first { item in
            item.type != "userMessage"
                && item.type != "system"
                && !item.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }?.text.trimmingCharacters(in: .whitespacesAndNewlines)

        sessions = sessions.map { session in
            guard session.external?.threadId == detail.id else {
                return session
            }

            return TaskSession(
                id: session.id,
                title: session.title,
                agent: session.agent,
                status: detail.status,
                progress: session.progress,
                summary: latestSummary?.isEmpty == false ? latestSummary! : session.summary,
                suggestedOptions: detail.items.reversed().first { item in
                    guard item.status != "selected" else {
                        return false
                    }
                    guard let options = item.options else {
                        return false
                    }
                    return !options.isEmpty
                }?.options ?? session.suggestedOptions,
                suggestedPrompt: detail.items.reversed().first { item in
                    guard item.status != "selected" else {
                        return false
                    }
                    guard let options = item.options else {
                        return false
                    }
                    return !options.isEmpty && !item.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                }?.text ?? session.suggestedPrompt,
                activityStatus: detail.activityStatus ?? session.activityStatus,
                updatedAt: detail.updatedAt,
                accent: session.accent,
                archived: session.archived,
                pinned: session.pinned,
                sortOrder: session.sortOrder,
                avatarPath: session.avatarPath,
                capabilities: detail.capabilities ?? session.capabilities,
                external: ExternalSession(
                    provider: session.external?.provider ?? detail.source ?? "",
                    threadId: session.external?.threadId,
                    sessionId: session.external?.sessionId,
                    agentSessionId: session.external?.agentSessionId,
                    connectionStatus: detail.connectionStatus ?? session.external?.connectionStatus,
                    currentModel: detail.currentModel ?? session.external?.currentModel,
                    currentReasoningLevel: detail.currentReasoningLevel ?? session.external?.currentReasoningLevel,
                    cwd: detail.cwd ?? session.external?.cwd,
                    source: session.external?.source ?? detail.source
                )
            )
        }
    }

    private func syncSelectedSessionFromSessions() {
        guard let current = selectedSession,
              let refreshed = sessions.first(where: { $0.id == current.id }) else {
            return
        }
        selectedSession = refreshed
    }

    private func markChoiceHandled(choiceId: String, selectedOptionId: String) {
        handledChoiceIds.insert(choiceId)
        guard let detail = selectedDetail else {
            return
        }
        selectedDetail = detailReplacingItems(detail) { item in
            guard item.id == choiceId, item.type == "choice" else {
                return item
            }
            return CodexThreadItem(
                id: item.id,
                turnId: item.turnId,
                turnStatus: item.turnStatus,
                type: item.type,
                title: item.title,
                text: item.text,
                options: item.options?.map { option in
                    CodexApprovalOption(
                        id: option.id,
                        label: option.label,
                        role: option.role,
                        index: option.index,
                        selected: option.id == selectedOptionId
                    )
                },
                status: "selected",
                createdAt: item.createdAt
            )
        }
        if let selectedDetail {
            syncSessionSummary(from: selectedDetail)
        }
    }

    private func applyingHandledChoices(to detail: CodexThreadDetail) -> CodexThreadDetail {
        guard detail.items.contains(where: { handledChoiceIds.contains($0.id) && $0.status != "selected" }) else {
            return detail
        }
        return detailReplacingItems(detail) { item in
            guard handledChoiceIds.contains(item.id), item.type == "choice", item.status != "selected" else {
                return item
            }
            return CodexThreadItem(
                id: item.id,
                turnId: item.turnId,
                turnStatus: item.turnStatus,
                type: item.type,
                title: item.title,
                text: item.text,
                options: item.options,
                status: "selected",
                createdAt: item.createdAt
            )
        }
    }

    private func detailReplacingItems(_ detail: CodexThreadDetail, transform: (CodexThreadItem) -> CodexThreadItem) -> CodexThreadDetail {
        CodexThreadDetail(
            id: detail.id,
            title: detail.title,
            status: detail.status,
            source: detail.source,
            connectionStatus: detail.connectionStatus,
            currentModel: detail.currentModel,
            currentReasoningLevel: detail.currentReasoningLevel,
            activityStatus: detail.activityStatus,
            cwd: detail.cwd,
            createdAt: detail.createdAt,
            updatedAt: detail.updatedAt,
            canSend: detail.canSend,
            sendUnavailableReason: detail.sendUnavailableReason,
            capabilities: detail.capabilities,
            turnCount: detail.turnCount,
            items: detail.items.map(transform)
        )
    }

    private func syncSelectedDetailMetadataFromSessions() {
        guard let detail = selectedDetail,
              let session = sessions.first(where: { $0.external?.threadId == detail.id }) else {
            return
        }

        selectedDetail = CodexThreadDetail(
            id: detail.id,
            title: detail.title,
            status: session.status,
            source: session.external?.source ?? detail.source,
            connectionStatus: session.external?.connectionStatus ?? detail.connectionStatus,
            currentModel: session.external?.currentModel ?? detail.currentModel,
            currentReasoningLevel: session.external?.currentReasoningLevel ?? detail.currentReasoningLevel,
            activityStatus: session.activityStatus,
            cwd: session.external?.cwd ?? detail.cwd,
            createdAt: detail.createdAt,
            updatedAt: session.updatedAt,
            canSend: detail.canSend,
            sendUnavailableReason: detail.sendUnavailableReason,
            capabilities: session.capabilities ?? detail.capabilities,
            turnCount: detail.turnCount,
            items: detail.items
        )
    }

    private func detailByMergingPendingMessages(_ detail: CodexThreadDetail) -> CodexThreadDetail {
        let pending = pendingUserMessagesByThread[detail.id] ?? []
        let merged = mergedItems(serverItems: detail.items, pendingItems: pending)
        pendingUserMessagesByThread[detail.id] = remainingPendingItems(afterMerging: detail.items, pendingItems: pending)

        guard merged != detail.items else {
            return detail
        }

        return CodexThreadDetail(
            id: detail.id,
            title: detail.title,
            status: detail.status,
            source: detail.source,
            connectionStatus: detail.connectionStatus,
            currentModel: detail.currentModel,
            currentReasoningLevel: detail.currentReasoningLevel,
            activityStatus: detail.activityStatus,
            cwd: detail.cwd,
            createdAt: detail.createdAt,
            updatedAt: detail.updatedAt,
            canSend: detail.canSend,
            sendUnavailableReason: detail.sendUnavailableReason,
            capabilities: detail.capabilities,
            turnCount: detail.turnCount,
            items: merged
        )
    }

    private func stableDetailReplacingEmptyItems(_ detail: CodexThreadDetail) -> CodexThreadDetail {
        guard detail.items.isEmpty,
              let previous = selectedDetail,
              previous.id == detail.id,
              !previous.items.isEmpty else {
            return detail
        }

        return CodexThreadDetail(
            id: detail.id,
            title: detail.title,
            status: detail.status,
            source: detail.source,
            connectionStatus: detail.connectionStatus,
            currentModel: detail.currentModel,
            currentReasoningLevel: detail.currentReasoningLevel,
            activityStatus: detail.activityStatus,
            cwd: detail.cwd,
            createdAt: detail.createdAt,
            updatedAt: detail.updatedAt,
            canSend: detail.canSend,
            sendUnavailableReason: detail.sendUnavailableReason,
            capabilities: detail.capabilities,
            turnCount: max(detail.turnCount, previous.turnCount),
            items: previous.items
        )
    }

    private func mergedItems(serverItems: [CodexThreadItem], pendingItems: [CodexThreadItem]) -> [CodexThreadItem] {
        var items = serverItems
        var matchedServerIndexes = Set<Int>()
        for pendingItem in pendingItems {
            if let index = firstMatchingServerUserIndex(for: pendingItem, in: items, excluding: matchedServerIndexes) {
                matchedServerIndexes.insert(index)
            } else {
                items.append(pendingItem)
            }
        }
        return items
    }

    private func remainingPendingItems(afterMerging serverItems: [CodexThreadItem], pendingItems: [CodexThreadItem]) -> [CodexThreadItem] {
        var matchedServerIndexes = Set<Int>()
        return pendingItems.filter { pendingItem in
            if let index = firstMatchingServerUserIndex(for: pendingItem, in: serverItems, excluding: matchedServerIndexes) {
                matchedServerIndexes.insert(index)
                return false
            }
            return true
        }
    }

    private func firstMatchingServerUserIndex(for pendingItem: CodexThreadItem, in serverItems: [CodexThreadItem], excluding matchedIndexes: Set<Int>) -> Int? {
        let pendingText = normalizedMessageText(pendingItem.text)
        guard !pendingText.isEmpty else {
            return nil
        }
        return serverItems.indices.first { index in
            !matchedIndexes.contains(index)
                && serverItems[index].type == "userMessage"
                && normalizedMessageText(serverItems[index].text) == pendingText
        }
    }

    private static func errorMessage(from data: Data) -> String? {
        if let decoded = try? JSONDecoder().decode(BackendErrorResponse.self, from: data) {
            return decoded.error
        }
        return String(data: data, encoding: .utf8)
    }
}

private func isPtyProvider(_ provider: String?) -> Bool {
    provider == "pty" || provider == "codex-pty" || provider == "claude-sdk"
}

private func normalizedMessageText(_ text: String) -> String {
    text.trimmingCharacters(in: .whitespacesAndNewlines)
        .components(separatedBy: .whitespacesAndNewlines)
        .filter { !$0.isEmpty }
        .joined(separator: " ")
}

private func agentProxyBody(_ settings: AgentProxySettings) -> [String: Any] {
    [
        "codex": agentProxyProfileBody(settings.codex),
        "choiceParser": agentProxyProfileBody(settings.choiceParser),
        "pty": agentProxyProfileBody(settings.pty)
    ]
}

private func agentProxyProfileBody(_ profile: AgentProxyProfile) -> [String: Any] {
    [
        "enabled": profile.enabled,
        "httpProxy": profile.httpProxy,
        "httpsProxy": profile.httpsProxy,
        "allProxy": profile.allProxy,
        "noProxy": profile.noProxy
    ]
}

private func choiceParserTestMessage(durationMs: Int?) -> String {
    guard let durationMs else {
        return "Test passed"
    }
    if durationMs < 1000 {
        return "Test passed in \(durationMs) ms"
    }
    let seconds = Double(durationMs) / 1000
    return String(format: "Test passed in %.1f s", seconds)
}

private func reasoningLabel(_ value: String) -> String {
    switch value.lowercased() {
    case "low": "Low"
    case "medium": "Medium"
    case "high": "High"
    case "xhigh": "Extra High"
    default: value
    }
}

enum BackendError: LocalizedError {
    case message(String)

    var errorDescription: String? {
        switch self {
        case .message(let message):
            message
        }
    }
}
