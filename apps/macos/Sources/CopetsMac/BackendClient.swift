import Foundation

@MainActor
final class BackendClient: ObservableObject {
    static let shared = BackendClient()

    @Published private(set) var sessions: [TaskSession] = []
    @Published private(set) var archivedSessions: [TaskSession] = []
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
    @Published private(set) var feishuBots: [FeishuBot] = []
    @Published private(set) var feishuProfiles: [FeishuProfile] = []
    @Published private(set) var isUpdatingFeishu = false
    @Published private(set) var codexModels: [CodexModel] = []
    @Published private(set) var codexDefaultModel: String?
    @Published private(set) var codexDefaultReasoningLevel: String?
    @Published private(set) var loadedModelProvider: String?
    @Published private(set) var isLoadingCodexModels = false
    @Published private(set) var isSwitchingModel = false
    @Published private(set) var isSwitchingReasoning = false
    @Published private(set) var connectionTransitionSessionIds = Set<String>()
    @Published private(set) var undoneCodexTurnIds = Set<String>()
    @Published private(set) var isLoadingArchivedSessions = false
    @Published private(set) var selectedSessionUsage: SessionUsageResponse?

    private let baseURL = CorptieAppEnvironment.backendBaseURL
    var defaultWorkspacePath: String {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("corptie", isDirectory: true).path
    }
    private var pollingTask: Task<Void, Never>?
    private var eventStreamTask: Task<Void, Never>?
    private var detailStreamTask: Task<Void, Never>?
    private var pendingUserMessagesByThread: [String: [CodexThreadItem]] = [:]
    private var handledChoiceIds = Set<String>()
    private var detailCacheBySessionId: [String: CodexThreadDetail] = [:]
    private var detailPrefetchTasks: [String: Task<Void, Never>] = [:]
    private var usageRefreshTask: Task<Void, Never>?

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
        usageRefreshTask?.cancel()
        usageRefreshTask = nil
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
                    var dataLines: [String] = []
                    for try await line in bytes.lines {
                        if Task.isCancelled {
                            return
                        }
                        if line.isEmpty {
                            await self.handleGlobalEvent(eventName, data: dataLines.joined(separator: "\n"))
                            eventName = ""
                            dataLines.removeAll(keepingCapacity: true)
                        } else if line.hasPrefix("event:") {
                            eventName = String(line.dropFirst(6)).trimmingCharacters(in: .whitespaces)
                        } else if line.hasPrefix("data:") {
                            dataLines.append(String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces))
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

    private func handleGlobalEvent(_ eventName: String, data: String) async {
        if eventName == "SessionUsageUpdated" {
            applyLiveUsageEvent(data)
            return
        }
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
        if eventName == "CodexThreadCompleted"
            || eventName == "CodexThreadFailed"
            || eventName == "CodexThreadError" {
            await refreshSelectedUsage()
        }
        if eventName == "CodexThreadChoiceOptionsUpdated"
            || eventName == "CodexThreadApprovalRequested"
            || eventName == "CodexThreadApprovalResponded" {
            await refreshSelectedDetailFromPolling()
        }
    }

    private func applyLiveUsageEvent(_ data: String) {
        guard let payload = data.data(using: .utf8),
              let event = try? JSONDecoder().decode(SessionUsageEventEnvelope.self, from: payload),
              selectedSession?.id == event.payload.sessionId else {
            return
        }
        let currentAccount = selectedSessionUsage?.account ?? CodexAccountUsage(
            available: nil,
            provider: "codex",
            model: nil,
            rateLimits: nil,
            rateLimitsByLimitId: nil
        )
        selectedSessionUsage = SessionUsageResponse(account: currentAccount, context: event.payload.context)
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

    func loadFeishuBots() async {
        do {
            let (data, response) = try await URLSession.shared.data(from: baseURL.appending(path: "feishu/bots"))
            guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
                throw URLError(.badServerResponse)
            }
            feishuBots = try JSONDecoder().decode(FeishuBotsResponse.self, from: data).bots
            lastError = nil
        } catch {
            lastError = error.localizedDescription
        }
    }

    func loadFeishuProfiles() async {
        do {
            let (data, response) = try await URLSession.shared.data(from: baseURL.appending(path: "feishu/profiles"))
            guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
                throw URLError(.badServerResponse)
            }
            feishuProfiles = try JSONDecoder().decode(FeishuProfilesResponse.self, from: data).profiles
            if lastError?.contains("Feishu") == true {
                lastError = nil
            }
        } catch {
            lastError = error.localizedDescription
        }
    }

    @discardableResult
    func addFeishuBot(appId: String, appSecret: String) async -> Bool {
        let trimmedAppId = appId.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedSecret = appSecret.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedAppId.isEmpty, !trimmedSecret.isEmpty else {
            lastError = L10n("Feishu App ID and App Secret are required.")
            return false
        }
        return await performFeishuMutation(method: "POST", path: "feishu/bots", body: [
            "appId": trimmedAppId,
            "appSecret": trimmedSecret,
            "brand": "feishu"
        ])
    }

    @discardableResult
    func addFeishuBot(profile: String) async -> Bool {
        let trimmedProfile = profile.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedProfile.isEmpty else {
            lastError = L10n("lark-cli Profile is required.")
            return false
        }
        return await performFeishuMutation(method: "POST", path: "feishu/bots", body: [
            "profile": trimmedProfile
        ])
    }

    @discardableResult
    func setFeishuBotEnabled(_ bot: FeishuBot, enabled: Bool) async -> Bool {
        await performFeishuMutation(method: "PATCH", path: "feishu/bots/\(bot.id)", body: ["enabled": enabled])
    }

    @discardableResult
    func deleteFeishuBot(_ bot: FeishuBot) async -> Bool {
        await performFeishuMutation(method: "DELETE", path: "feishu/bots/\(bot.id)")
    }

    @discardableResult
    func releaseFeishuSession(for bot: FeishuBot) async -> Bool {
        await performFeishuMutation(method: "DELETE", path: "feishu/bots/\(bot.id)/assignment")
    }

    @discardableResult
    func revokeFeishuBinding(_ binding: FeishuBinding) async -> Bool {
        await performFeishuMutation(method: "DELETE", path: "feishu/bindings/\(binding.id)")
    }

    func createFeishuPairingCode(for bot: FeishuBot) async -> Result<FeishuPairingCodeResponse, Error> {
        isUpdatingFeishu = true
        defer { isUpdatingFeishu = false }
        do {
            var request = URLRequest(url: baseURL.appending(path: "feishu/bots/\(bot.id)/pairing-code"))
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = try JSONSerialization.data(withJSONObject: [:])
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode) else {
                throw BackendError.message(Self.errorMessage(from: data) ?? "Could not create pairing code.")
            }
            let pairing = try JSONDecoder().decode(FeishuPairingCodeResponse.self, from: data)
            lastError = nil
            return .success(pairing)
        } catch {
            lastError = error.localizedDescription
            return .failure(error)
        }
    }

    private func performFeishuMutation(method: String, path: String, body: [String: Any]? = nil) async -> Bool {
        isUpdatingFeishu = true
        defer { isUpdatingFeishu = false }
        do {
            var request = URLRequest(url: baseURL.appending(path: path))
            request.httpMethod = method
            if let body {
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                request.httpBody = try JSONSerialization.data(withJSONObject: body)
            }
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode) else {
                throw BackendError.message(Self.errorMessage(from: data) ?? "Feishu gateway request failed.")
            }
            lastError = nil
            await loadFeishuBots()
            return true
        } catch {
            lastError = error.localizedDescription
            return false
        }
    }

    func updateDataDirectory(_ dataDir: String) async {
        await updateSettings(dataDir: dataDir, logDir: settings?.logDir, choiceParser: settings?.choiceParser, codexBackend: settings?.codexBackend, agentProxy: settings?.agentProxy, gateway: settings?.gateway)
    }

    @discardableResult
    func updateSettings(dataDir: String, logDir: String? = nil, choiceParser: ChoiceParserSettings?, codexBackend: CodexBackendSettings? = nil, codeDiff: CodeDiffSettings? = nil, agentProxy: AgentProxySettings? = nil, gateway: GatewaySettings? = nil) async -> Bool {
        let trimmed = dataDir.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            lastError = L10n("Data directory is required.")
            return false
        }

        isUpdatingSettings = true
        defer { isUpdatingSettings = false }

        do {
            var request = URLRequest(url: baseURL.appending(path: "settings"))
            request.httpMethod = "PATCH"
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            var body: [String: Any] = ["dataDir": trimmed]
            if let logDir {
                let trimmedLogDir = logDir.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmedLogDir.isEmpty {
                    body["logDir"] = trimmedLogDir
                }
            }
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
            if let codeDiff {
                body["codeDiff"] = ["tool": codeDiff.tool]
            }
            if let agentProxy {
                body["agentProxy"] = agentProxyBody(agentProxy)
            }
            if let gateway {
                body["gateway"] = ["trustedWorkspaces": gateway.trustedWorkspaces]
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

    func loadModelsForSelectedSession(forceRefresh: Bool = false) async {
        let provider = selectedSession?.external?.provider ?? "codex-pty"
        await loadModels(for: provider, forceRefresh: forceRefresh)
    }

    func loadModels(for provider: String, forceRefresh: Bool = false) async {
        if isLoadingCodexModels {
            return
        }
        isLoadingCodexModels = true
        defer { isLoadingCodexModels = false }

        do {
            let path = provider == "claude-sdk" ? "claude/models" : "codex/models"
            var components = URLComponents(url: baseURL.appending(path: path), resolvingAgainstBaseURL: false)!
            if forceRefresh {
                components.queryItems = [URLQueryItem(name: "refresh", value: "true")]
            }
            let (data, response) = try await URLSession.shared.data(from: components.url!)
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
            let latestSessions = try await fetchSessionsForShutdown()
            if sessions != latestSessions {
                sessions = latestSessions
                syncSelectedSessionFromSessions()
                syncSelectedDetailMetadataFromSessions()
            }
            if !isOnline {
                isOnline = true
            }
            if lastError != nil {
                lastError = nil
            }
        } catch {
            if isOnline {
                isOnline = false
            }
            let message = error.localizedDescription
            if lastError != message {
                lastError = message
            }
        }
    }

    func fetchSessionsForShutdown() async throws -> [TaskSession] {
        let (data, response) = try await URLSession.shared.data(from: baseURL.appending(path: "sessions"))
        guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        return try JSONDecoder().decode(SessionsResponse.self, from: data).sessions
    }

    func refreshArchivedSessions() async {
        isLoadingArchivedSessions = true
        defer { isLoadingArchivedSessions = false }

        do {
            var components = URLComponents(url: baseURL.appending(path: "sessions"), resolvingAgainstBaseURL: false)!
            components.queryItems = [URLQueryItem(name: "archived", value: "true")]
            let (data, response) = try await URLSession.shared.data(from: components.url!)
            guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
                throw URLError(.badServerResponse)
            }

            let decoded = try JSONDecoder().decode(SessionsResponse.self, from: data)
            if archivedSessions != decoded.sessions {
                archivedSessions = decoded.sessions
            }
            if lastError != nil {
                lastError = nil
            }
        } catch {
            let message = error.localizedDescription
            if lastError != message {
                lastError = message
            }
        }
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
                sendStatusMessage = L10n("Started PTY agent")
                await refresh()
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
        onNameConflict: @escaping (String) -> Void = { _ in },
        onSuccess: @escaping () -> Void = {}
    ) {
        let trimmedPrompt = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedCwd = cwd.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedExistingSessionId = existingSessionId.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedModel = model.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !isCreatingTask else { return }
        isCreatingTask = true

        Task {
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
                if !trimmedModel.isEmpty {
                    body["model"] = trimmedModel
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

                onSuccess()
                sendStatusMessage = usesAppServer ? L10n("Started Codex App Server session") : L10n("Started Codex CLI")
                await refresh()
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
                var request = URLRequest(url: baseURL.appending(path: "claude/sessions"))
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                var body: [String: Any] = [
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

                onSuccess()
                sendStatusMessage = L10n("Started Claude Code")
                await refresh()
            } catch {
                lastError = error.localizedDescription
                sendStatusMessage = L10nFormat("Create failed: %@", error.localizedDescription)
            }
        }
    }

    func respondToCodexApproval(option: CodexApprovalOption) {
        guard let session = selectedSession else {
            sendStatusMessage = L10n("No Codex approval is active.")
            return
        }
        respondToCodexApproval(option: option, to: session)
    }

    func respondToCodexApproval(option: CodexApprovalOption, to session: TaskSession) {
        guard let provider = session.external?.provider,
              let threadId = session.external?.threadId else {
            sendStatusMessage = L10n("No Codex approval is active.")
            return
        }

        clearSuggestedOptions(for: session)
        Task {
            isSendingMessage = true
            sendStatusMessage = L10n("Selecting Codex option...")
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

                sendStatusMessage = L10nFormat("Selected %@", option.label)
                if selectedSession?.id == session.id {
                    await loadDetail(for: session)
                }
                await refresh()
            } catch {
                lastError = error.localizedDescription
                sendStatusMessage = L10nFormat("Approval failed: %@", error.localizedDescription)
            }
        }
    }

    func respondToCodexApproval(approved: Bool) {
        let fallback = CodexApprovalOption(
            id: approved ? "approve" : "deny",
            label: approved ? L10n("Approve") : L10n("Deny"),
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
            sendStatusMessage = L10n("No terminal choice is active.")
            return
        }

        Task {
            isSendingMessage = true
            sendStatusMessage = L10n("Selecting option...")
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
                sendStatusMessage = L10nFormat("Selected %@", option.label)
                await loadDetail(for: session)
                await refresh()
            } catch {
                lastError = error.localizedDescription
                sendStatusMessage = L10nFormat("Choice failed: %@", error.localizedDescription)
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
                await refresh()
            } catch {
                lastError = error.localizedDescription
                sendStatusMessage = L10nFormat("Create failed: %@", error.localizedDescription)
            }
        }
    }

    func select(session: TaskSession) {
        selectedSession = session
        selectedSessionUsage = nil
        usageRefreshTask?.cancel()
        usageRefreshTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.loadUsage(for: session)
                try? await Task.sleep(for: .seconds(30))
            }
        }
        Task {
            await Task.yield()
            guard selectedSession?.id == session.id else {
                return
            }
            selectedDetail = detailCacheBySessionId[session.id]
            startDetailStream(for: session)
            await loadDetail(for: session, showLoading: selectedDetail == nil)
        }
    }

    func closeDetail() {
        usageRefreshTask?.cancel()
        usageRefreshTask = nil
        detailStreamTask?.cancel()
        detailStreamTask = nil
        selectedSession = nil
        selectedDetail = nil
        selectedSessionUsage = nil
        isLoadingDetail = false
    }

    private func loadUsage(for session: TaskSession) async {
        guard selectedSession?.id == session.id else { return }
        do {
            let url = baseURL.appending(path: "sessions/\(session.id)/usage")
            let (data, response) = try await URLSession.shared.data(from: url)
            guard let httpResponse = response as? HTTPURLResponse,
                  httpResponse.statusCode == 200 else { return }
            let usage = try JSONDecoder().decode(SessionUsageResponse.self, from: data)
            guard selectedSession?.id == session.id else { return }
            selectedSessionUsage = usage
        } catch {
            // Usage is supplementary; chat remains usable if Codex cannot report it.
        }
    }

    func refreshSelectedUsage() async {
        guard let selectedSession else { return }
        await loadUsage(for: selectedSession)
    }

    func cachedDetail(for sessionId: String) -> CodexThreadDetail? {
        detailCacheBySessionId[sessionId]
    }

    func prefetchDetail(for session: TaskSession) {
        guard detailCacheBySessionId[session.id] == nil,
              detailPrefetchTasks[session.id] == nil else {
            return
        }

        detailPrefetchTasks[session.id] = Task { [weak self] in
            guard let self else {
                return
            }
            defer {
                self.detailPrefetchTasks[session.id] = nil
            }
            _ = await self.fetchDetail(for: session)
        }
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
            lastError = L10n("This task does not expose a Codex thread id.")
            sendStatusMessage = lastError
            return
        }

        sendText(text, to: selectedSession, reloadDetail: true, isChoiceSelection: false, onSuccess: onSuccess)
    }

    func respondToCollaborationConfirmation(confirmationId: String, approve: Bool) {
        guard let selectedSession else { return }
        Task {
            isSendingMessage = true
            defer { isSendingMessage = false }
            do {
                let action = approve ? "confirm" : "reject"
                var request = URLRequest(url: baseURL.appending(path: "collaboration/confirmations/\(confirmationId)/\(action)"))
                request.httpMethod = "POST"
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse,
                      (200..<300).contains(httpResponse.statusCode) else {
                    let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
                    throw BackendError.message(payload?["error"] as? String ?? "Could not resolve collaboration confirmation.")
                }
                sendStatusMessage = approve ? L10n("Collaboration request sent") : L10n("Collaboration request cancelled")
                await loadDetail(for: selectedSession, showLoading: false)
                await refresh()
            } catch {
                lastError = error.localizedDescription
                sendStatusMessage = L10nFormat("Confirmation failed: %@", error.localizedDescription)
            }
        }
    }

    func sendMessage(_ text: String, to session: TaskSession, isChoiceSelection: Bool = false, onSuccess: @escaping () -> Void = {}) {
        sendText(text, to: session, reloadDetail: selectedSession?.id == session.id, isChoiceSelection: isChoiceSelection, onSuccess: onSuccess)
    }

    func reviewCodexChanges(threadId: String, turnId: String) async -> Result<String, Error> {
        await performCodexDiffAction("review", threadId: threadId, turnId: turnId)
    }

    func undoCodexChanges(threadId: String, turnId: String) async -> Result<String, Error> {
        let result = await performCodexDiffAction("undo", threadId: threadId, turnId: turnId)
        if case .success = result {
            undoneCodexTurnIds.insert(turnId)
            await refreshSelectedDetailFromPolling()
        }
        return result
    }

    private func performCodexDiffAction(_ action: String, threadId: String, turnId: String) async -> Result<String, Error> {
        do {
            var request = URLRequest(url: baseURL.appending(path: "codex/threads/\(threadId)/turns/\(turnId)/diff/\(action)"))
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

    private func sendText(_ text: String, to session: TaskSession, reloadDetail: Bool, isChoiceSelection: Bool, onSuccess: @escaping () -> Void) {
        guard let threadId = session.external?.threadId else {
            lastError = L10n("This task does not expose a Codex thread id.")
            sendStatusMessage = lastError
            return
        }

        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return
        }
        clearSuggestedOptions(for: session)
        let isClearCommand = trimmed.lowercased() == "/clear"
        let resolvesCollaborationConfirmation = selectedDetail?.items.contains(where: {
            $0.type == "collaborationConfirmation" && $0.collaborationConfirmationStatus == "pending"
        }) == true && Self.isCollaborationConfirmationReply(trimmed)
        if reloadDetail && !isClearCommand && !resolvesCollaborationConfirmation {
            appendOptimisticUserMessage(trimmed, to: session)
        }

        Task {
            isSendingMessage = true
            sendStatusMessage = isPtyProvider(session.external?.provider) ? L10n("Sending to terminal agent...") : L10n("Sending to Codex...")
            defer { isSendingMessage = false }

            do {
                let path = isPtyProvider(session.external?.provider)
                    ? "pty/sessions/\(threadId)/input"
                    : "sessions/\(session.id)/messages"
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
                if decoded?.cleared == true {
                    sendStatusMessage = L10n("Conversation cleared")
                    await refresh()
                    if let replacement = decoded?.session,
                       replacement.id != session.id {
                        select(session: sessions.first(where: { $0.id == replacement.id }) ?? replacement)
                    } else if reloadDetail {
                        await loadDetail(for: session)
                    }
                    return
                } else if decoded?.mode == "collaboration-confirmation" {
                    sendStatusMessage = L10n("Collaboration confirmation resolved")
                } else if isPtyProvider(session.external?.provider) {
                    sendStatusMessage = session.external?.provider == "codex-pty" ? L10n("Sent to Codex CLI") : L10n("Sent to PTY agent")
                } else if decoded?.queued == true {
                    let position = decoded?.queuePosition.map { " #\($0)" } ?? ""
                    sendStatusMessage = L10nFormat("Queued%@", position)
                } else if decoded?.visibleInCodexDesktop == false {
                    sendStatusMessage = decoded?.warning ?? "Sent to background Codex; Desktop may not refresh."
                } else {
                    sendStatusMessage = L10n("Sent to Codex")
                }
                if reloadDetail {
                    await loadDetail(for: session)
                }
                await refresh()
            } catch {
                lastError = error.localizedDescription
                sendStatusMessage = L10nFormat("Send failed: %@", error.localizedDescription)
            }
        }
    }

    private static func isCollaborationConfirmationReply(_ text: String) -> Bool {
        let normalized = text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return ["确认", "确认发送", "发送", "同意", "yes", "y", "confirm", "approve",
                "取消", "拒绝", "不发送", "否", "no", "n", "reject", "cancel"].contains(normalized)
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
                sendStatusMessage = session.external?.provider == "codex-pty" ? L10n("Interrupted Codex CLI") : L10n("Interrupted PTY agent")
                await refresh()
                if selectedSession?.id == session.id {
                    await loadDetail(for: session)
                }
            } catch {
                lastError = error.localizedDescription
                sendStatusMessage = L10nFormat("Interrupt failed: %@", error.localizedDescription)
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
                sendStatusMessage = session.isConnected ? L10n("PTY disconnected") : L10n("PTY reconnected")
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
                sendStatusMessage = L10n("Reconnecting...")
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
                sendStatusMessage = L10n("Reconnected")
                await refresh()
                if selectedSession?.id == session.id {
                    await loadDetail(for: session, showLoading: false)
                }
            } catch {
                lastError = error.localizedDescription
                sendStatusMessage = L10nFormat("Reconnect failed: %@", error.localizedDescription)
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
                let (_, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse, (200..<300).contains(httpResponse.statusCode) else {
                    throw URLError(.badServerResponse)
                }
                if selectedSession?.id == session.id {
                    closeDetail()
                }
                await refresh()
                await refreshArchivedSessions()
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
            lastError = L10n("Title is required.")
            return
        }

        Task {
            do {
                var request = URLRequest(url: baseURL.appending(path: "sessions/\(session.id)"))
                request.httpMethod = "PATCH"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                request.httpBody = try JSONSerialization.data(withJSONObject: ["title": trimmedTitle])
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse else {
                    throw URLError(.badServerResponse)
                }
                guard (200..<300).contains(httpResponse.statusCode) else {
                    if httpResponse.statusCode == 409 {
                        throw BackendError.message(L10n("A session with this name already exists."))
                    }
                    throw BackendError.message(Self.errorMessage(from: data) ?? L10n("Could not rename session."))
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
                let (_, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse, (200..<300).contains(httpResponse.statusCode) else {
                    throw URLError(.badServerResponse)
                }
                if selectedSession?.id == session.id {
                    closeDetail()
                }
                await refresh()
                await refreshArchivedSessions()
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
                sendStatusMessage = selectedSession.external?.provider == "codex-pty" ? L10n("Interrupted Codex CLI") : L10n("Interrupted PTY agent")
                await loadDetail(for: selectedSession)
                await refresh()
            } catch {
                lastError = error.localizedDescription
                sendStatusMessage = L10nFormat("Interrupt failed: %@", error.localizedDescription)
            }
        }
    }

    func switchSelectedCodexModel(to model: CodexModel) {
        guard let selectedSession,
              selectedSession.capabilities?.canSwitchModel == true else {
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
                let provider = selectedSession.external?.provider == "claude-sdk" ? "Claude" : "Codex"
                sendStatusMessage = L10nFormat("Switching %@ model to %@", provider, model.name)
                await loadDetail(for: selectedSession)
                await refresh()
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
        guard let selectedSession else {
            sendStatusMessage = L10n("Reasoning switching is not available for this session.")
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
                sendStatusMessage = L10nFormat("Switching Codex reasoning to %@", reasoningLabel(trimmedReasoningLevel))
                await loadDetail(for: selectedSession)
                await refresh()
            } catch {
                lastError = error.localizedDescription
                sendStatusMessage = L10nFormat("Reasoning switch failed: %@", error.localizedDescription)
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
                : "sessions/\(session.id)/snapshot"
            let url = baseURL.appending(path: path)
            let (data, response) = try await URLSession.shared.data(from: url)
            guard let httpResponse = response as? HTTPURLResponse else {
                throw URLError(.badServerResponse)
            }
            guard httpResponse.statusCode == 200 else {
                throw BackendError.message(Self.errorMessage(from: data) ?? "Could not load session details.")
            }

            let detail = try decodeDetail(data, for: session, threadId: threadId)
            let mergedDetail = applyingHandledChoices(to: stableDetailReplacingEmptyItems(detailByMergingPendingMessages(detail)))
            detailCacheBySessionId[session.id] = mergedDetail
            lastError = nil
            return mergedDetail
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
            if let selectedSession {
                detailCacheBySessionId[selectedSession.id] = mergedDetail
            }
            syncSessionSummary(from: mergedDetail)
            lastError = nil
        } catch {
            lastError = error.localizedDescription
        }
    }

    private func loadDetail(for session: TaskSession, showLoading: Bool = true) async {
        guard let threadId = session.external?.threadId else {
            lastError = L10n("No Codex detail is available for this task.")
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
                : "sessions/\(session.id)/snapshot"
            let url = baseURL.appending(path: path)
            let (data, response) = try await URLSession.shared.data(from: url)
            guard let httpResponse = response as? HTTPURLResponse else {
                throw URLError(.badServerResponse)
            }
            guard httpResponse.statusCode == 200 else {
                throw BackendError.message(Self.errorMessage(from: data) ?? "Could not load session details.")
            }

            let detail = try decodeDetail(data, for: session, threadId: threadId)
            let mergedDetail = applyingHandledChoices(to: stableDetailReplacingEmptyItems(detailByMergingPendingMessages(detail)))
            selectedDetail = mergedDetail
            detailCacheBySessionId[session.id] = mergedDetail
            syncSessionSummary(from: mergedDetail)
            lastError = nil
        } catch {
            lastError = error.localizedDescription
        }
    }

    private func decodeDetail(_ data: Data, for session: TaskSession, threadId: String) throws -> CodexThreadDetail {
        if isPtyProvider(session.external?.provider) {
            return try JSONDecoder().decode(CodexThreadDetailResponse.self, from: data).thread
        }

        let snapshot = try JSONDecoder().decode(UnifiedSessionSnapshotResponse.self, from: data).session
        // The unified endpoint identifies the envelope by Corptie Session ID.
        // Internally this client keys optimistic messages and detail merging by
        // the provider thread ID, so retain that stable identity here.
        return CodexThreadDetail(
            id: threadId,
            title: snapshot.title,
            status: snapshot.status,
            source: snapshot.source,
            connectionStatus: snapshot.connectionStatus,
            currentModel: snapshot.currentModel,
            currentReasoningLevel: snapshot.currentReasoningLevel,
            activityStatus: snapshot.activityStatus,
            cwd: snapshot.cwd,
            createdAt: snapshot.createdAt,
            updatedAt: snapshot.updatedAt,
            canSend: snapshot.canSend,
            sendUnavailableReason: snapshot.sendUnavailableReason,
            capabilities: snapshot.capabilities,
            turnCount: snapshot.turnCount,
            items: snapshot.items
        )
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
                createdAt: item.createdAt,
                fileChanges: item.fileChanges,
                turnDiff: item.turnDiff
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
                createdAt: item.createdAt,
                fileChanges: item.fileChanges,
                turnDiff: item.turnDiff
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

@MainActor
private func choiceParserTestMessage(durationMs: Int?) -> String {
    guard let durationMs else {
        return L10n("Test passed")
    }
    if durationMs < 1000 {
        return L10nFormat("Test passed in %lld ms", durationMs)
    }
    let seconds = Double(durationMs) / 1000
    return L10nFormat("Test passed in %.1f s", seconds)
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

enum BackendError: LocalizedError {
    case message(String)

    var errorDescription: String? {
        switch self {
        case .message(let message):
            message
        }
    }
}
