import AppKit
import Combine
import Foundation

struct SessionRestartActivity: Equatable {
    let text: String
    let isActive: Bool
}

@MainActor
final class BackendClient: ObservableObject {
    static let shared = BackendClient()

    private(set) var sessions: [TaskSession] = []
    let sessionListStore = SessionListStore()
    let sessionsDidChange = CurrentValueSubject<[TaskSession], Never>([])
    @Published private(set) var archivedSessions: [TaskSession] = []
    @Published private(set) var selectedSession: TaskSession?
    @Published private(set) var selectedDetail: CodexThreadDetail?
    @Published private(set) var viewingHistoricalThreadId: String?
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
    @Published private(set) var restartingSessionIds = Set<String>()
    @Published private(set) var restartActivityBySessionId: [String: SessionRestartActivity] = [:]
    @Published private(set) var undoneCodexTurnIds = Set<String>()
    @Published private(set) var isLoadingArchivedSessions = false
    @Published private(set) var selectedSessionUsage: SessionUsageResponse?
    @Published private(set) var selectedProjectWorktreeStatus: ProjectWorktreeStatusResponse?
    @Published private(set) var projectWorktreeLoadError: String?
    @Published private(set) var isLoadingProjectWorktrees = false
    @Published private(set) var projectWorktreeActionIds = Set<String>()
    @Published private(set) var isCleaningMergedProjectWorktrees = false
    @Published private(set) var gitHubPushPreparation: GitHubPushPreparation?
    @Published private(set) var gitHubPushError: String?
    @Published private(set) var isPreparingGitHubPush = false
    @Published private(set) var isGeneratingGitHubCommitMessage = false
    @Published private(set) var gitHubPushingSessionId: String?
    @Published private(set) var workspaceRecoveryStatus: WorkspaceRecoveryStatus?
    @Published private(set) var isRecoveringWorkspace = false
    @Published private(set) var worktreeCommitReviewPrompt: WorktreeCommitReviewPrompt?
    @Published private(set) var isGeneratingWorktreeCommitMessage = false
    let sessionReplacements = PassthroughSubject<SessionReplacement, Never>()

    private let baseURL = CorptieAppEnvironment.backendBaseURL
    var defaultWorkspacePath: String {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("corptie", isDirectory: true).path
    }
    private var pollingTask: Task<Void, Never>?
    private let sessionPayloadProcessor = SessionPayloadProcessor()
    private var eventStreamTask: Task<Void, Never>?
    private var sessionCollectionStreamTask: Task<Void, Never>?
    private var sessionCollectionRevision: UInt64?
    private var isSessionCollectionStreamConnected = false
    private var detailStreamTask: Task<Void, Never>?
    private var detailStreamWatchdogTask: Task<Void, Never>?
    private var detailStreamGeneration = 0
    private(set) var detailStreamHealth: ChatDetailStreamHealth = .inactive
    private(set) var detailStreamLastDiagnostic = "inactive"
    private var detailStreamLastActivity: ContinuousClock.Instant?
    private(set) var detailTimelineRevision: Int?
    private var detailStreamCanonicalDetail: CodexThreadDetail?
    private var performanceFixtureStreamTask: Task<Void, Never>?
    private var pendingUserMessagesByThread: [String: [CodexThreadItem]] = [:]
    private var handledChoiceIds = Set<String>()
    private var detailCacheBySessionId: [String: CodexThreadDetail] = [:]
    private var detailPrefetchTasks: [String: Task<Void, Never>] = [:]
    private var usageRefreshTask: Task<Void, Never>?
    private var projectStatusRefreshTask: Task<Void, Never>?
    private var projectStatusRequestSequence = 0
    private var restartActivityClearTasks: [String: Task<Void, Never>] = [:]

    var isPushingGitHub: Bool {
        gitHubPushingSessionId != nil
    }

    var isSelectedSessionPushingGitHub: Bool {
        gitHubPushingSessionId == selectedSession?.id
    }
    private var hasSyncedNewSessionDefaults = false
    private var isReorderingSessions = false
    private var sessionReorderRevision = 0
    private var pendingProtectedWorktreeAction: (
        worktree: ProjectWorktreeStatus,
        action: String,
        body: [String: Any]
    )?

    func start() {
        pollingTask?.cancel()
        eventStreamTask?.cancel()
        sessionCollectionStreamTask?.cancel()
        isSessionCollectionStreamConnected = false
        detailStreamTask?.cancel()
        detailStreamWatchdogTask?.cancel()
        detailStreamGeneration &+= 1
        detailStreamHealth = .inactive
        detailStreamLastActivity = nil
        resetDetailTimelineState()
        performanceFixtureStreamTask?.cancel()
        let chatFeatures = ChatTimelineFeatureFlags.current
        ChatPerformanceTrace.event("chat.renderer.selected", value: chatFeatures.rendererIndex)
        if chatFeatures.fixtureMode == .standard {
            installPerformanceFixture(replaysStreamingUpdates: chatFeatures.replaysStreamingUpdates)
            return
        }
        Task {
            await loadSettings()
            await loadModels(for: "codex-pty")
        }
        startEventStream()
        startSessionCollectionStream()
        if let selectedSession, viewingHistoricalThreadId == nil {
            startDetailStream(for: selectedSession)
        }
        pollingTask = Task { [weak self] in
            while !Task.isCancelled {
                if self?.isSessionCollectionStreamConnected != true {
                    await self?.refresh()
                }
                await self?.syncNewSessionDefaultsFromPreferences()
                await self?.refreshSelectedDetailFromPolling()
                guard SessionListPerformanceFlags.current.pollingEnabled else {
                    return
                }
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    func stop() {
        pollingTask?.cancel()
        pollingTask = nil
        eventStreamTask?.cancel()
        eventStreamTask = nil
        sessionCollectionStreamTask?.cancel()
        sessionCollectionStreamTask = nil
        sessionCollectionRevision = nil
        isSessionCollectionStreamConnected = false
        detailStreamTask?.cancel()
        detailStreamTask = nil
        detailStreamWatchdogTask?.cancel()
        detailStreamWatchdogTask = nil
        detailStreamGeneration &+= 1
        detailStreamHealth = .inactive
        detailStreamLastActivity = nil
        resetDetailTimelineState()
        performanceFixtureStreamTask?.cancel()
        performanceFixtureStreamTask = nil
        usageRefreshTask?.cancel()
        usageRefreshTask = nil
        projectStatusRefreshTask?.cancel()
        projectStatusRefreshTask = nil
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

    private func startSessionCollectionStream() {
        sessionCollectionStreamTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                var request = URLRequest(url: self.baseURL.appending(path: "session-collection/events"))
                request.setValue("text/event-stream", forHTTPHeaderField: "accept")
                request.setValue("identity", forHTTPHeaderField: "accept-encoding")
                if let revision = self.sessionCollectionRevision {
                    request.setValue(String(revision), forHTTPHeaderField: "last-event-id")
                }
                do {
                    let (bytes, response) = try await URLSession.shared.bytes(for: request)
                    guard let httpResponse = response as? HTTPURLResponse,
                          httpResponse.statusCode == 200 else {
                        throw URLError(.badServerResponse)
                    }
                    self.isSessionCollectionStreamConnected = true
                    var eventName = ""
                    var dataLines: [String] = []
                    for try await line in bytes.lines {
                        guard !Task.isCancelled else { return }
                        if line.isEmpty {
                            await self.handleSessionCollectionFrame(
                                eventName,
                                data: dataLines.joined(separator: "\n")
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
                    guard !Task.isCancelled else { return }
                    self.isSessionCollectionStreamConnected = false
                    try? await Task.sleep(for: .seconds(2))
                }
            }
        }
    }

    private func handleSessionCollectionFrame(_ eventName: String, data: String) async {
        guard let payload = data.data(using: .utf8), !payload.isEmpty else { return }
        do {
            if eventName == "session-collection-snapshot" {
                let envelope = try await Task.detached(priority: .userInitiated) {
                    try JSONDecoder().decode(SessionCollectionSnapshotEnvelope.self, from: payload)
                }.value
                let nextSessions = envelope.sessions
                let patch = await sessionPayloadProcessor.processSnapshot(
                    sessions: nextSessions,
                    current: sessions
                )
                applySessionSnapshot(nextSessions, patch: patch)
                sessionCollectionRevision = envelope.revision
                return
            }
            guard eventName == "session-collection-patch" else { return }
            let envelope = try await Task.detached(priority: .userInitiated) {
                try JSONDecoder().decode(SessionCollectionPatchEnvelope.self, from: payload)
            }.value
            guard sessionCollectionRevision == envelope.baseRevision else {
                sessionCollectionRevision = nil
                sessionCollectionStreamTask?.cancel()
                startSessionCollectionStream()
                return
            }
            guard let next = Self.applyingSessionCollectionPatch(envelope, to: sessions) else {
                sessionCollectionRevision = nil
                sessionCollectionStreamTask?.cancel()
                startSessionCollectionStream()
                return
            }
            let collectionPatch = await sessionPayloadProcessor.processSnapshot(
                sessions: next,
                current: sessions
            )
            applySessionSnapshot(next, patch: collectionPatch)
            sessionCollectionRevision = envelope.revision
        } catch {
            sessionCollectionRevision = nil
        }
    }

    nonisolated static func applyingSessionCollectionPatch(
        _ patch: SessionCollectionPatchEnvelope,
        to current: [TaskSession]
    ) -> [TaskSession]? {
        var byID = Dictionary(uniqueKeysWithValues: current.map { ($0.id, $0) })
        patch.removedIds.forEach { byID[$0] = nil }
        patch.inserted.forEach { byID[$0.session.id] = $0.session }
        patch.updated.forEach { byID[$0.sessionId] = $0.session }
        if let orderedIDs = patch.orderedIds {
            guard Set(orderedIDs) == Set(byID.keys) else { return nil }
            return orderedIDs.compactMap { byID[$0] }
        }
        let currentIDs = current.map(\.id).filter { byID[$0] != nil }
        let newInsertions = patch.inserted.sorted { $0.index < $1.index }
        var ids = currentIDs
        for insertion in newInsertions where !ids.contains(insertion.session.id) {
            ids.insert(insertion.session.id, at: min(max(0, insertion.index), ids.count))
        }
        guard Set(ids) == Set(byID.keys) else { return nil }
        return ids.compactMap { byID[$0] }
    }

    private func handleGlobalEvent(_ eventName: String, data: String) async {
        if eventName == "SessionWorkspaceSwitched" {
            if let payload = data.data(using: .utf8),
               let event = try? JSONDecoder().decode(SessionWorkspaceSwitchedEventEnvelope.self, from: payload),
               restartActivityBySessionId[event.payload.session.id] != nil {
                completeRestartActivity(for: event.payload.session.id)
                await refresh()
            }
            return
        }
        if eventName == "SessionWorkspaceSwitchFailed" {
            if let payload = data.data(using: .utf8),
               let event = try? JSONDecoder().decode(SessionTransitionEventEnvelope.self, from: payload),
               let sessionId = event.payload.sessionId,
               restartActivityBySessionId[sessionId] != nil {
                failRestartActivity(for: sessionId)
            }
            return
        }
        if eventName == "SessionUsageUpdated" {
            applyLiveUsageEvent(data)
            return
        }
        if eventName == "WorkspaceInventoryChanged" {
            applyWorkspaceInventoryEvent(data)
            await refresh()
            return
        }
        if eventName == "SessionCleared" {
            if let payload = data.data(using: .utf8),
               let event = try? JSONDecoder().decode(SessionClearedEventEnvelope.self, from: payload) {
                let wasSelected = selectedSession?.id == event.payload.previousSessionId
                publishSessionReplacement(event.payload)
                await refresh()
                if wasSelected {
                    select(session: sessions.first(where: { $0.id == event.payload.session.id }) ?? event.payload.session)
                }
                return
            }
            await refresh()
            return
        }
        let refreshEvents: Set<String> = [
            "SessionStarted",
            "CodexThreadCreated",
            "CodexTurnStarted",
            "CodexThreadProgressChanged",
            "CodexThreadCompleted",
            "CodexThreadFailed",
            "CodexThreadError",
            "CodexThreadChoiceOptionsUpdated",
            "CodexThreadApprovalRequested",
            "CodexThreadApprovalResponded",
            "CollaborationConfirmationRequested",
            "CollaborationConfirmationResolved",
            "SessionWorkspaceSwitched",
            "SessionWorkspaceSwitchFailed",
            "WorkspaceContinuationQueued",
            "WorkspaceContinuationStarted",
            "WorkspaceContinuationCompleted",
            "WorkspaceContinuationFailed",
            "WorkspaceContinuationDeferred",
            "SessionArchived",
            "SessionUnarchived",
            "SessionDeleted",
            "SessionRenamed",
            "SessionAvatarUpdated",
            "PtySessionStarted",
            "ClaudeSessionStarted",
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
        if !isSessionCollectionStreamConnected {
            await refresh()
        }
        if eventName == "CodexThreadCompleted"
            || eventName == "CodexThreadFailed"
            || eventName == "CodexThreadError" {
            await refreshSelectedUsage()
        }
        if eventName == "CodexThreadChoiceOptionsUpdated"
            || eventName == "CodexThreadApprovalRequested"
            || eventName == "CodexThreadApprovalResponded"
            || eventName == "CollaborationConfirmationRequested"
            || eventName == "CollaborationConfirmationResolved" {
            await refreshSelectedDetailFromPolling()
        }
    }

    private func applyWorkspaceInventoryEvent(_ data: String) {
        guard let payload = data.data(using: .utf8),
              let event = try? JSONDecoder().decode(WorkspaceInventoryEventEnvelope.self, from: payload),
              !event.payload.newlyDiscoveredWorkspaces.isEmpty else {
            return
        }
        sendStatusMessage = L10n(
            "A new Git worktree was detected. Ask the Agent to list workspaces or switch to it."
        )
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

    func syncNewSessionDefaultsFromPreferences(force: Bool = false) async {
        guard isOnline, force || !hasSyncedNewSessionDefaults else { return }

        let defaults = CorptieAppEnvironment.userDefaults
        let sandbox = defaults.string(forKey: "newTask.defaultSandboxMode") ?? "workspace-write"
        let approvalPolicy = defaults.string(forKey: "newTask.defaultApprovalPolicy") ?? "on-request"
        let codexModel = nonEmptyPreference(defaults.string(forKey: "newTask.defaultCodexModel"))
        let codexReasoningLevel = nonEmptyPreference(defaults.string(forKey: "newTask.defaultCodexReasoningLevel"))
        let claudeModel = nonEmptyPreference(defaults.string(forKey: "newTask.defaultClaudeModel"))
        if !force,
           settings?.newSessionDefaults?.sandbox == sandbox,
           settings?.newSessionDefaults?.approvalPolicy == approvalPolicy,
           codexModel == nil || settings?.newSessionDefaults?.codexModel == codexModel,
           codexReasoningLevel == nil || settings?.newSessionDefaults?.codexReasoningLevel == codexReasoningLevel,
           claudeModel == nil || settings?.newSessionDefaults?.claudeModel == claudeModel {
            hasSyncedNewSessionDefaults = true
            return
        }

        do {
            var newSessionDefaults: [String: Any] = [
                "sandbox": sandbox,
                "approvalPolicy": approvalPolicy
            ]
            if let codexModel {
                newSessionDefaults["codexModel"] = codexModel
            }
            if let codexReasoningLevel {
                newSessionDefaults["codexReasoningLevel"] = codexReasoningLevel
            }
            if let claudeModel {
                newSessionDefaults["claudeModel"] = claudeModel
            }
            var request = URLRequest(url: baseURL.appending(path: "settings"))
            request.httpMethod = "PATCH"
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = try JSONSerialization.data(withJSONObject: [
                "newSessionDefaults": newSessionDefaults
            ])
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode) else {
                throw URLError(.badServerResponse)
            }
            settings = try JSONDecoder().decode(BackendSettings.self, from: data)
            hasSyncedNewSessionDefaults = true
        } catch {
            hasSyncedNewSessionDefaults = false
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
            var components = URLComponents(url: baseURL.appending(path: "providers/\(provider)/models"), resolvingAgainstBaseURL: false)!
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
            let (data, response) = try await URLSession.shared.data(from: baseURL.appending(path: "sessions"))
            guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
                throw URLError(.badServerResponse)
            }
            let result = try await sessionPayloadProcessor.processSnapshot(data: data, current: sessions)
            applySessionSnapshot(result.sessions, patch: result.patch)
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
        return try await BackendResponseDecoder.sessions(from: data)
    }

    private func applySessionSnapshot(
        _ nextSessions: [TaskSession],
        patch: SessionCollectionPatch? = nil,
        allowDuringReorder: Bool = false
    ) {
        if isReorderingSessions && !allowDuringReorder {
            let nextByID = Dictionary(uniqueKeysWithValues: nextSessions.map { ($0.id, $0) })
            // Keep the locally manipulated order and membership stable, while
            // still applying live status/summary/capability changes to every
            // row that exists on both sides. The authoritative structural
            // snapshot is fetched as soon as reorder persistence settles.
            let contentOnlySnapshot = sessions.map { nextByID[$0.id] ?? $0 }
            applySessionSnapshot(contentOnlySnapshot, allowDuringReorder: true)
            return
        }
        let resolvedPatch = patch ?? SessionCollectionDiffer.patch(
            from: sessions,
            to: nextSessions,
            revision: 0
        )
        guard sessions != nextSessions else { return }
        sessions = nextSessions
        sessionListStore.apply(resolvedPatch, authoritativeSessions: nextSessions)
        sessionsDidChange.send(nextSessions)
        syncSelectedSessionFromSessions()
        syncSelectedDetailMetadataFromSessions()
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
            let explicitlyArchivedSessions = decoded.sessions.filter { $0.archived == true }
            if archivedSessions != explicitlyArchivedSessions {
                archivedSessions = explicitlyArchivedSessions
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
        clearSuggestedOptions(for: session)
        Task {
            isSendingMessage = true
            sendStatusMessage = L10n("Selecting Codex option...")
            defer { isSendingMessage = false }

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

    func respondToPtyChoice(option: CodexApprovalOption, choiceId: String? = nil, in targetSession: TaskSession? = nil) {
        guard let session = targetSession ?? selectedSession else {
            sendStatusMessage = L10n("No terminal choice is active.")
            return
        }

        Task {
            await submitChoice(option: option, choiceId: choiceId, in: session)
        }
    }

    func respondToSuggestedOption(_ option: CodexApprovalOption, in session: TaskSession) {
        Task {
            let detail = await fetchDetail(for: session)
            if let choiceId = SuggestedOptionRouting.pendingChoiceId(
                for: option.id,
                items: detail?.items ?? []
            ) {
                await submitChoice(option: option, choiceId: choiceId, in: session)
            } else {
                sendText(
                    option.label,
                    to: session,
                    reloadDetail: selectedSession?.id == session.id,
                    isChoiceSelection: true,
                    onSuccess: {}
                )
            }
        }
    }

    private func submitChoice(option: CodexApprovalOption, choiceId: String?, in session: TaskSession) async {
        isSendingMessage = true
        sendStatusMessage = L10n("Selecting option...")
        defer { isSendingMessage = false }

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
            if selectedSession?.id == session.id {
                await loadDetail(for: session)
            } else if let detail = await fetchDetail(for: session) {
                syncSessionSummary(from: detail)
            }
            await refresh()
        } catch {
            lastError = error.localizedDescription
            sendStatusMessage = L10nFormat("Choice failed: %@", error.localizedDescription)
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
                await refresh()
            } catch {
                lastError = error.localizedDescription
                sendStatusMessage = L10nFormat("Create failed: %@", error.localizedDescription)
            }
        }
    }

    func select(session: TaskSession) {
        viewingHistoricalThreadId = nil
        selectedSession = session
        resetDetailTimelineState()
        selectedSessionUsage = nil
        usageRefreshTask?.cancel()
        usageRefreshTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.loadUsage(for: session)
                try? await Task.sleep(for: .seconds(30))
                if Task.isCancelled { return }
            }
        }
        selectedProjectWorktreeStatus = nil
        projectWorktreeLoadError = nil
        projectStatusRequestSequence &+= 1
        workspaceRecoveryStatus = nil
        projectStatusRefreshTask?.cancel()
        if projectId(for: session) != nil {
            projectStatusRefreshTask = Task { [weak self] in
                while !Task.isCancelled {
                    await self?.loadProjectWorktreeStatus(for: session)
                    try? await Task.sleep(for: .seconds(5))
                    if Task.isCancelled { return }
                }
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
        projectStatusRefreshTask?.cancel()
        projectStatusRefreshTask = nil
        detailStreamTask?.cancel()
        detailStreamTask = nil
        detailStreamWatchdogTask?.cancel()
        detailStreamWatchdogTask = nil
        detailStreamGeneration &+= 1
        detailStreamHealth = .inactive
        detailStreamLastActivity = nil
        resetDetailTimelineState()
        selectedSession = nil
        selectedDetail = nil
        viewingHistoricalThreadId = nil
        selectedSessionUsage = nil
        selectedProjectWorktreeStatus = nil
        projectWorktreeLoadError = nil
        projectStatusRequestSequence &+= 1
        workspaceRecoveryStatus = nil
        gitHubPushPreparation = nil
        gitHubPushError = nil
        worktreeCommitReviewPrompt = nil
        isLoadingDetail = false
    }

    func refreshSelectedProjectWorktrees() async {
        guard let selectedSession else { return }
        await loadProjectWorktreeStatus(for: selectedSession)
    }

    func prepareGitHubPush() {
        guard let session = selectedSession, !isPreparingGitHubPush, !isPushingGitHub else { return }
        Task {
            isPreparingGitHubPush = true
            gitHubPushError = nil
            defer { isPreparingGitHubPush = false }
            do {
                var request = URLRequest(
                    url: baseURL.appending(path: "sessions/\(session.id)/github-push/prepare")
                )
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                request.httpBody = Data("{}".utf8)
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse,
                      (200..<300).contains(httpResponse.statusCode) else {
                    throw BackendError.message(Self.errorMessage(from: data) ?? L10n("Could not prepare GitHub push."))
                }
                guard selectedSession?.id == session.id else { return }
                gitHubPushPreparation = try JSONDecoder().decode(GitHubPushPreparation.self, from: data)
            } catch {
                gitHubPushError = error.localizedDescription
                lastError = error.localizedDescription
            }
        }
    }

    func cancelGitHubPush() {
        guard !isPushingGitHub else { return }
        gitHubPushPreparation = nil
        gitHubPushError = nil
    }

    func generateGitHubCommitMessage() async -> String? {
        guard let session = selectedSession,
              let preparation = gitHubPushPreparation,
              preparation.dirty,
              !isGeneratingGitHubCommitMessage,
              !isPushingGitHub else { return nil }
        isGeneratingGitHubCommitMessage = true
        gitHubPushError = nil
        defer { isGeneratingGitHubCommitMessage = false }
        do {
            var request = URLRequest(
                url: baseURL.appending(path: "sessions/\(session.id)/github-push/commit-message")
            )
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = try JSONSerialization.data(withJSONObject: [
                "confirmationToken": preparation.confirmationToken
            ])
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode) else {
                throw BackendError.message(
                    Self.errorMessage(from: data) ?? L10n("Could not generate commit message.")
                )
            }
            let result = try JSONDecoder().decode(GitHubCommitMessageSuggestion.self, from: data)
            guard selectedSession?.id == session.id,
                  gitHubPushPreparation?.confirmationToken == preparation.confirmationToken else {
                return nil
            }
            return result.commitMessage
        } catch {
            if gitHubPushPreparation?.confirmationToken == preparation.confirmationToken {
                gitHubPushError = error.localizedDescription
            }
            return nil
        }
    }

    func confirmGitHubPush(
        commitMessage: String? = nil,
        privateFilesDecision: String? = nil,
        neverRemindPrivateFiles: Bool = false
    ) {
        guard let session = selectedSession,
              let preparation = gitHubPushPreparation,
              !isPushingGitHub,
              !isGeneratingGitHubCommitMessage else { return }

        // Confirmation ends the modal interaction. The potentially slow commit and
        // network push continue independently and are represented in the header.
        gitHubPushingSessionId = session.id
        gitHubPushPreparation = nil
        gitHubPushError = nil
        sendStatusMessage = L10n("Pushing to GitHub…")

        Task {
            defer {
                if gitHubPushingSessionId == session.id {
                    gitHubPushingSessionId = nil
                }
            }
            do {
                var request = URLRequest(
                    url: baseURL.appending(path: "sessions/\(session.id)/github-push/confirm")
                )
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                var body: [String: Any] = ["confirmationToken": preparation.confirmationToken]
                if let commitMessage {
                    body["commitMessage"] = commitMessage
                }
                if let privateFilesDecision {
                    body["privateFilesDecision"] = privateFilesDecision
                    body["neverRemindPrivateFiles"] = neverRemindPrivateFiles
                }
                request.httpBody = try JSONSerialization.data(withJSONObject: body)
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse,
                      (200..<300).contains(httpResponse.statusCode) else {
                    throw BackendError.message(Self.errorMessage(from: data) ?? L10n("GitHub push failed."))
                }
                let result = try JSONDecoder().decode(GitHubPushResult.self, from: data)
                gitHubPushPreparation = nil
                sendStatusMessage = result.committed
                    ? L10n("Changes committed and pushed to GitHub")
                    : L10n("Branch pushed to GitHub")
                SessionCompletionSoundManager.playGitHubPushSuccess()
                await refresh()
                if selectedSession?.id == session.id {
                    await loadProjectWorktreeStatus(for: session)
                }
            } catch {
                gitHubPushError = error.localizedDescription
                lastError = error.localizedDescription
                sendStatusMessage = L10nFormat("GitHub push failed: %@", error.localizedDescription)
            }
        }
    }

    private func loadProjectWorktreeStatus(for session: TaskSession) async {
        guard selectedSession?.id == session.id else { return }
        projectStatusRequestSequence &+= 1
        let requestSequence = projectStatusRequestSequence
        if selectedProjectWorktreeStatus == nil {
            projectWorktreeLoadError = nil
        }
        do {
            let url: URL
            if let projectId = projectId(for: session) {
                let base = baseURL.appending(path: "projects/\(projectId)/workspaces")
                if let activeWorkspaceId = session.external?.workspace?.id,
                   !activeWorkspaceId.isEmpty,
                   var components = URLComponents(url: base, resolvingAgainstBaseURL: false) {
                    components.queryItems = [
                        URLQueryItem(name: "activeWorkspaceId", value: activeWorkspaceId)
                    ]
                    url = components.url ?? base
                } else {
                    url = base
                }
            } else {
                url = baseURL.appending(path: "sessions/\(session.id)/project-worktrees")
            }
            let (data, response) = try await URLSession.shared.data(from: url)
            guard let httpResponse = response as? HTTPURLResponse,
                  httpResponse.statusCode == 200 else {
                if selectedSession?.id == session.id,
                   requestSequence == projectStatusRequestSequence {
                    projectWorktreeLoadError = Self.errorMessage(from: data)
                        ?? L10n("Could not load project worktrees")
                }
                await loadWorkspaceRecoveryStatus(for: session)
                return
            }
            let status = try JSONDecoder().decode(ProjectWorktreeStatusResponse.self, from: data)
            guard selectedSession?.id == session.id,
                  requestSequence == projectStatusRequestSequence else { return }
            selectedProjectWorktreeStatus = status
            projectWorktreeLoadError = nil
            workspaceRecoveryStatus = nil
        } catch {
            if selectedSession?.id == session.id,
               requestSequence == projectStatusRequestSequence {
                projectWorktreeLoadError = error.localizedDescription
            }
            await loadWorkspaceRecoveryStatus(for: session)
        }
    }

    private func loadWorkspaceRecoveryStatus(for session: TaskSession) async {
        guard selectedSession?.id == session.id else { return }
        do {
            let url = baseURL.appending(path: "sessions/\(session.id)/workspace/recovery")
            let (data, response) = try await URLSession.shared.data(from: url)
            guard let httpResponse = response as? HTTPURLResponse,
                  httpResponse.statusCode == 200 else { return }
            let status = try JSONDecoder().decode(WorkspaceRecoveryStatus.self, from: data)
            guard selectedSession?.id == session.id else { return }
            workspaceRecoveryStatus = status.orphaned ? status : nil
        } catch {
            // Recovery is supplementary and must not hide the existing session history.
        }
    }

    func recoverSelectedWorkspace(action: String, targetWorktreeId: String? = nil) {
        guard let session = selectedSession, !isRecoveringWorkspace else { return }
        Task {
            isRecoveringWorkspace = true
            lastError = nil
            defer { isRecoveringWorkspace = false }
            do {
                var body: [String: Any] = ["action": action]
                if let targetWorktreeId { body["targetWorktreeId"] = targetWorktreeId }
                var request = URLRequest(
                    url: baseURL.appending(path: "sessions/\(session.id)/workspace/recovery")
                )
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                request.httpBody = try JSONSerialization.data(withJSONObject: body)
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse,
                      (200..<300).contains(httpResponse.statusCode) else {
                    throw BackendError.message(Self.errorMessage(from: data) ?? L10n("Workspace recovery failed."))
                }
                workspaceRecoveryStatus = nil
                sendStatusMessage = action == "rebuild"
                    ? L10n("Original Worktree rebuilt")
                    : L10n("Session switched to an available Worktree")
                await refresh()
                if let refreshed = sessions.first(where: { $0.id == session.id }) {
                    selectedSession = refreshed
                    await loadProjectWorktreeStatus(for: refreshed)
                    await loadDetail(for: refreshed, showLoading: false)
                }
            } catch {
                lastError = error.localizedDescription
                await loadWorkspaceRecoveryStatus(for: session)
            }
        }
    }

    func initializeProjectToolset(update: Bool = false) {
        guard let session = selectedSession,
              let projectId = projectId(for: session) else { return }
        let action = update ? "update" : "initialize"
        Task {
            isLoadingProjectWorktrees = true
            defer { isLoadingProjectWorktrees = false }
            do {
                var request = URLRequest(
                    url: baseURL.appending(path: "projects/\(projectId)/development-service/actions/\(action)")
                )
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                request.httpBody = Data("{}".utf8)
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse,
                      (200..<300).contains(httpResponse.statusCode) else {
                    throw BackendError.message(Self.errorMessage(from: data) ?? L10n("Could not initialize project tools."))
                }
                sendStatusMessage = update
                    ? L10n("Project tools update started")
                    : L10n("Project tools initialization started")
                try? await Task.sleep(for: .seconds(1))
                await loadProjectWorktreeStatus(for: session)
            } catch {
                lastError = error.localizedDescription
            }
        }
    }

    func runProjectServiceAction(_ action: String) {
        guard let session = selectedSession,
              let projectId = projectId(for: session) else { return }
        let actionId = "service:\(action)"
        Task {
            projectWorktreeActionIds.insert(actionId)
            defer { projectWorktreeActionIds.remove(actionId) }
            do {
                var request = URLRequest(
                    url: baseURL.appending(path: "projects/\(projectId)/development-service/actions/\(action)")
                )
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                request.httpBody = Data("{}".utf8)
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse,
                      (200..<300).contains(httpResponse.statusCode) else {
                    throw BackendError.message(Self.errorMessage(from: data) ?? L10n("Project service action failed."))
                }
                await loadProjectWorktreeStatus(for: session)
            } catch {
                lastError = error.localizedDescription
            }
        }
    }

    func selectProjectServiceProfile(_ profileId: String) {
        guard let session = selectedSession,
              let projectId = projectId(for: session) else { return }
        let actionId = "service:profile"
        Task {
            projectWorktreeActionIds.insert(actionId)
            defer { projectWorktreeActionIds.remove(actionId) }
            do {
                var request = URLRequest(
                    url: baseURL.appending(path: "projects/\(projectId)/development-service/actions/profile")
                )
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                request.httpBody = try JSONSerialization.data(withJSONObject: ["profileId": profileId])
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse,
                      (200..<300).contains(httpResponse.statusCode) else {
                    throw BackendError.message(
                        Self.errorMessage(from: data) ?? L10n("Could not update the service profile.")
                    )
                }
                await loadProjectWorktreeStatus(for: session)
            } catch {
                lastError = error.localizedDescription
            }
        }
    }

    func mergeProjectWorktree(_ worktree: ProjectWorktreeStatus, restartService: Bool) {
        performProtectedProjectWorktreeAction(
            worktree,
            action: "merge",
            body: ["restartService": restartService]
        )
    }

    func restartProjectService(from worktree: ProjectWorktreeStatus) {
        performProjectWorktreeAction(
            worktree,
            action: "restart",
            body: [:]
        )
    }

    func commitProjectWorktreeChanges(_ worktree: ProjectWorktreeStatus) {
        performProtectedProjectWorktreeAction(worktree, action: "commit", body: [:])
    }

    private func performProtectedProjectWorktreeAction(
        _ worktree: ProjectWorktreeStatus,
        action: String,
        body: [String: Any]
    ) {
        let actionMayCommit = action == "commit"
            || action == "merge"
            || action == "complete"
            || (action == "operate" && body["mergeIntoMain"] as? Bool == true)
        guard worktree.dirty == true, actionMayCommit else {
            performProjectWorktreeAction(worktree, action: action, body: body)
            return
        }
        guard let session = selectedSession else { return }
        Task {
            lastError = nil
            projectWorktreeActionIds.insert(worktree.worktreeId)
            defer { projectWorktreeActionIds.remove(worktree.worktreeId) }
            do {
                var request = URLRequest(url: baseURL.appending(
                    path: "sessions/\(session.id)/project-worktrees/\(worktree.worktreeId)/commit-prepare"
                ))
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                request.httpBody = Data("{}".utf8)
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse,
                      (200..<300).contains(httpResponse.statusCode) else {
                    throw BackendError.message(Self.errorMessage(from: data) ?? L10n("Could not inspect commit contents."))
                }
                let protection = try JSONDecoder().decode(GitCommitProtectionStatus.self, from: data)
                pendingProtectedWorktreeAction = (worktree, action, body)
                worktreeCommitReviewPrompt = WorktreeCommitReviewPrompt(
                    worktree: worktree,
                    protection: protection,
                    operation: Self.commitReviewOperation(for: action)
                )
            } catch {
                lastError = error.localizedDescription
            }
        }
    }

    func confirmProtectedWorktreeCommit(
        commitMessage: String,
        decision: String,
        neverRemindPrivateFiles: Bool
    ) {
        guard worktreeCommitReviewPrompt != nil,
              let pending = pendingProtectedWorktreeAction else { return }
        worktreeCommitReviewPrompt = nil
        pendingProtectedWorktreeAction = nil
        var body = pending.body
        body["commitMessage"] = commitMessage
        body["privateFilesDecision"] = decision
        body["neverRemindPrivateFiles"] = neverRemindPrivateFiles
        performProjectWorktreeAction(
            pending.worktree,
            action: pending.action,
            body: body
        )
    }

    func cancelProtectedWorktreeCommit() {
        worktreeCommitReviewPrompt = nil
        pendingProtectedWorktreeAction = nil
    }

    func generateWorktreeCommitMessage() async -> String? {
        guard let session = selectedSession,
              let prompt = worktreeCommitReviewPrompt,
              !isGeneratingWorktreeCommitMessage else { return nil }
        isGeneratingWorktreeCommitMessage = true
        lastError = nil
        defer { isGeneratingWorktreeCommitMessage = false }
        do {
            var request = URLRequest(url: baseURL.appending(
                path: "sessions/\(session.id)/project-worktrees/\(prompt.worktree.worktreeId)/commit-message"
            ))
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = Data("{}".utf8)
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode) else {
                throw BackendError.message(
                    Self.errorMessage(from: data) ?? L10n("Could not generate commit message.")
                )
            }
            let result = try JSONDecoder().decode(GitHubCommitMessageSuggestion.self, from: data)
            guard worktreeCommitReviewPrompt?.id == prompt.id else { return nil }
            return result.commitMessage
        } catch {
            lastError = error.localizedDescription
            return nil
        }
    }

    private static func commitReviewOperation(for action: String) -> WorktreeCommitReviewOperation {
        switch action {
        case "commit": .commit
        case "merge": .merge
        case "complete": .complete
        default: .operate
        }
    }

    func operateProjectWorktree(
        _ worktree: ProjectWorktreeStatus,
        mergeIntoMain: Bool,
        synchronizeWithMain: Bool,
        deleteWorktree: Bool,
        deleteSessions: Bool,
        restartService: Bool,
        forceDeleteUnmerged: Bool = false,
        confirmedBranchName: String? = nil
    ) {
        var body: [String: Any] = [
            "mergeIntoMain": mergeIntoMain,
            "synchronizeWithMain": synchronizeWithMain,
            "deleteWorktree": deleteWorktree,
            "deleteSessions": deleteSessions,
            "restartService": restartService
        ]
        if forceDeleteUnmerged, let confirmedBranchName {
            body["forceDeleteUnmerged"] = true
            body["acknowledgeIrrecoverable"] = true
            body["confirmedBranchName"] = confirmedBranchName
        }
        performProtectedProjectWorktreeAction(
            worktree,
            action: "operate",
            body: body
        )
    }

    func synchronizeProjectWorktree(_ worktree: ProjectWorktreeStatus) {
        let needsMerge = worktree.dirty == true || worktree.mergedIntoMain != true
        operateProjectWorktree(
            worktree,
            mergeIntoMain: needsMerge,
            synchronizeWithMain: true,
            deleteWorktree: false,
            deleteSessions: false,
            restartService: false
        )
    }

    func completeProjectWorktree(_ worktree: ProjectWorktreeStatus, restartService: Bool = true) {
        performProtectedProjectWorktreeAction(
            worktree,
            action: "complete",
            body: [
                "restartService": restartService,
                "deleteSessions": true,
                "deleteBranch": true
            ]
        )
    }

    func cleanupMergedProjectWorktrees(_ worktrees: [ProjectWorktreeStatus]) {
        guard !worktrees.isEmpty,
              let session = selectedSession,
              let projectId = projectId(for: session),
              !isCleaningMergedProjectWorktrees else { return }
        let worktreeIds = Set(worktrees.map(\.worktreeId))
        Task {
            lastError = nil
            isCleaningMergedProjectWorktrees = true
            projectWorktreeActionIds.formUnion(worktreeIds)
            defer {
                projectWorktreeActionIds.subtract(worktreeIds)
                isCleaningMergedProjectWorktrees = false
            }

            var removedCount = 0
            var failures: [String] = []
            for worktree in worktrees {
                do {
                    var request = URLRequest(url: baseURL.appending(
                        path: "projects/\(projectId)/workspaces/\(worktree.worktreeId)/actions/delete"
                    ))
                    request.httpMethod = "POST"
                    request.setValue("application/json", forHTTPHeaderField: "content-type")
                    request.httpBody = try JSONSerialization.data(withJSONObject: ["deleteBranch": true])
                    let (data, response) = try await URLSession.shared.data(for: request)
                    guard let httpResponse = response as? HTTPURLResponse,
                          (200..<300).contains(httpResponse.statusCode) else {
                        throw BackendError.message(
                            Self.errorMessage(from: data) ?? L10n("Worktree action failed.")
                        )
                    }
                    removedCount += 1
                } catch {
                    let name = worktree.branchName ?? worktree.path
                    failures.append("\(name): \(error.localizedDescription)")
                }
            }

            if failures.isEmpty {
                sendStatusMessage = L10nFormat("Removed %d merged Worktrees", removedCount)
            } else {
                lastError = L10nFormat(
                    "Removed %d Worktrees; %d could not be removed:\n%@",
                    removedCount,
                    failures.count,
                    failures.joined(separator: "\n")
                )
            }
            await refresh()
            if selectedSession?.id == session.id {
                await loadProjectWorktreeStatus(for: session)
            }
        }
    }

    private func performProjectWorktreeAction(
        _ worktree: ProjectWorktreeStatus,
        action: String,
        body: [String: Any]
    ) {
        guard let session = selectedSession else { return }
        Task {
            lastError = nil
            projectWorktreeActionIds.insert(worktree.worktreeId)
            defer { projectWorktreeActionIds.remove(worktree.worktreeId) }
            do {
                let path: String
                if action == "restart", let projectId = projectId(for: session) {
                    path = "projects/\(projectId)/workspaces/\(worktree.worktreeId)/actions/restart"
                } else {
                    path = "sessions/\(session.id)/project-worktrees/\(worktree.worktreeId)/\(action)"
                }
                var request = URLRequest(url: baseURL.appending(
                    path: path
                ))
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                request.httpBody = try JSONSerialization.data(withJSONObject: body)
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse,
                      (200..<300).contains(httpResponse.statusCode) else {
                    throw BackendError.message(Self.errorMessage(from: data) ?? L10n("Worktree action failed."))
                }
                let result = try? JSONDecoder().decode(ProjectWorktreeActionResponse.self, from: data)
                if action == "commit" {
                    sendStatusMessage = L10n("Worktree changes committed")
                }
                if result?.deletedSessionIds?.contains(session.id) == true {
                    closeDetail()
                }
                await refresh()
                if selectedSession?.id == session.id {
                    await loadProjectWorktreeStatus(for: session)
                }
            } catch {
                lastError = error.localizedDescription
            }
        }
    }

    private func projectId(for session: TaskSession) -> String? {
        let projectId = session.external?.workspace?.repositoryId?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return projectId?.isEmpty == false ? projectId : nil
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

    func respondToCollaborationConfirmation(confirmationId: String, approve: Bool, in session: TaskSession? = nil) {
        guard let targetSession = session ?? selectedSession else { return }
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
                if selectedSession?.id == targetSession.id {
                    await loadDetail(for: targetSession, showLoading: false)
                }
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

    func reviewTurnChanges(sessionId: String, turnId: String) async -> Result<String, Error> {
        await performTurnChangesAction("review", sessionId: sessionId, turnId: turnId)
    }

    func undoTurnChanges(sessionId: String, turnId: String) async -> Result<String, Error> {
        let result = await performTurnChangesAction("undo", sessionId: sessionId, turnId: turnId)
        if case .success = result {
            undoneCodexTurnIds.insert(turnId)
            await refreshSelectedDetailFromPolling()
        }
        return result
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

    private func sendText(_ text: String, to session: TaskSession, reloadDetail: Bool, isChoiceSelection: Bool, onSuccess: @escaping () -> Void) {
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
            sendStatusMessage = L10n("Sending...")
            defer { isSendingMessage = false }

            do {
                var request = URLRequest(url: baseURL.appending(path: "sessions/\(session.id)/messages"))
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
                    if let replacement = decoded?.session,
                       replacement.id != session.id {
                        publishSessionReplacement(SessionReplacement(
                            previousSessionId: session.id,
                            session: replacement
                        ))
                    }
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

    private func publishSessionReplacement(_ replacement: SessionReplacement) {
        var nextSessions = sessions
        if let index = nextSessions.firstIndex(where: { $0.id == replacement.previousSessionId }) {
            nextSessions[index] = replacement.session
        } else if !nextSessions.contains(where: { $0.id == replacement.session.id }) {
            nextSessions.append(replacement.session)
        }
        applySessionSnapshot(nextSessions, allowDuringReorder: true)
        sessionReplacements.send(replacement)
    }

    private static func isCollaborationConfirmationReply(_ text: String) -> Bool {
        let normalized = text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return ["确认", "确认发送", "发送", "同意", "yes", "y", "confirm", "approve",
                "取消", "拒绝", "不发送", "否", "no", "n", "reject", "cancel"].contains(normalized)
    }

    private func clearSuggestedOptions(for session: TaskSession) {
        let nextSessions = sessions.map { existing in
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
                external: existing.external,
                pendingCollaborationConfirmation: existing.pendingCollaborationConfirmation
            )
        }
        applySessionSnapshot(nextSessions, allowDuringReorder: true)
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

    func interrupt(session: TaskSession) {
        Task {
            do {
                var request = URLRequest(url: baseURL.appending(path: "sessions/\(session.id)/interrupt"))
                request.httpMethod = "POST"
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse,
                      (200..<300).contains(httpResponse.statusCode) else {
                    throw BackendError.message(Self.errorMessage(from: data) ?? "Interrupt failed")
                }
                sendStatusMessage = L10n("Interrupted")
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
        guard session.usesManualConnection else {
            return
        }

        Task {
            connectionTransitionSessionIds.insert(session.id)
            defer {
                connectionTransitionSessionIds.remove(session.id)
            }
            do {
                let action = session.isConnected ? "disconnect" : "reconnect"
                var request = URLRequest(url: baseURL.appending(path: "sessions/\(session.id)/actions/\(action)"))
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
        Task {
            connectionTransitionSessionIds.insert(session.id)
            defer {
                connectionTransitionSessionIds.remove(session.id)
            }
            do {
                sendStatusMessage = L10n("Reconnecting...")
                var request = URLRequest(url: baseURL.appending(path: "sessions/\(session.id)/actions/resume"))
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

    func restart(session: TaskSession) {
        guard session.actions?.restart?.available == true,
              !restartingSessionIds.contains(session.id) else {
            return
        }

        Task {
            restartingSessionIds.insert(session.id)
            beginRestartActivity(for: session.id)
            defer {
                restartingSessionIds.remove(session.id)
            }
            do {
                sendStatusMessage = L10n("Restarting session…")
                var request = URLRequest(url: baseURL.appending(path: "sessions/\(session.id)/restart"))
                request.httpMethod = "POST"
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse else {
                    throw URLError(.badServerResponse)
                }
                guard (200..<300).contains(httpResponse.statusCode) else {
                    throw BackendError.message(
                        Self.errorMessage(from: data) ?? L10n("Could not restart session.")
                    )
                }
                sendStatusMessage = httpResponse.statusCode == 202
                    ? L10n("Session will restart after the current run finishes")
                    : L10n("Session restarted")
                if httpResponse.statusCode != 202 {
                    completeRestartActivity(for: session.id)
                }
                await refresh()
                if selectedSession?.id == session.id,
                   let refreshed = sessions.first(where: { $0.id == session.id }) {
                    select(session: refreshed)
                }
            } catch {
                failRestartActivity(for: session.id)
                lastError = error.localizedDescription
                sendStatusMessage = L10nFormat("Restart failed: %@", error.localizedDescription)
            }
        }
    }

    private func beginRestartActivity(for sessionId: String) {
        restartActivityClearTasks.removeValue(forKey: sessionId)?.cancel()
        restartActivityBySessionId[sessionId] = SessionRestartActivity(
            text: L10n("Restarting session…"),
            isActive: true
        )
    }

    private func completeRestartActivity(for sessionId: String) {
        restartActivityClearTasks.removeValue(forKey: sessionId)?.cancel()
        restartActivityBySessionId[sessionId] = SessionRestartActivity(
            text: L10n("Session restarted"),
            isActive: false
        )
        scheduleRestartActivityClear(for: sessionId, after: .seconds(2))
    }

    private func failRestartActivity(for sessionId: String) {
        restartActivityClearTasks.removeValue(forKey: sessionId)?.cancel()
        restartActivityBySessionId[sessionId] = SessionRestartActivity(
            text: L10n("Restart failed"),
            isActive: false
        )
        scheduleRestartActivityClear(for: sessionId, after: .seconds(4))
    }

    private func scheduleRestartActivityClear(for sessionId: String, after delay: Duration) {
        restartActivityClearTasks[sessionId] = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled else { return }
            self?.restartActivityBySessionId.removeValue(forKey: sessionId)
            self?.restartActivityClearTasks.removeValue(forKey: sessionId)
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

        var nextSessions = sessions
        let movedSession = nextSessions.remove(at: fromIndex)
        guard let targetSessionId,
              let targetIndex = nextSessions.firstIndex(where: {
                  $0.id == targetSessionId && ($0.pinned == true) == (movedSession.pinned == true)
              }) else {
            let lastMatchingIndex = nextSessions.lastIndex {
                ($0.pinned == true) == (movedSession.pinned == true)
            }
            let insertionIndex = lastMatchingIndex.map { $0 + 1 } ?? min(fromIndex, nextSessions.count)
            nextSessions.insert(movedSession, at: insertionIndex)
            applySessionSnapshot(nextSessions, allowDuringReorder: true)
            return
        }
        let insertionIndex = targetIndex
        if insertionIndex == fromIndex {
            nextSessions.insert(movedSession, at: fromIndex)
            applySessionSnapshot(nextSessions, allowDuringReorder: true)
            return
        }
        nextSessions.insert(movedSession, at: max(0, min(insertionIndex, nextSessions.count)))
        applySessionSnapshot(nextSessions, allowDuringReorder: true)
    }

    func beginSessionReorder() {
        sessionReorderRevision += 1
        isReorderingSessions = true
    }

    func persistSessionOrder() {
        let orderedIds = sessions.map(\.id)
        let revision = sessionReorderRevision
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
                if revision == sessionReorderRevision {
                    isReorderingSessions = false
                    await refresh()
                }
            } catch {
                if revision == sessionReorderRevision {
                    isReorderingSessions = false
                    lastError = error.localizedDescription
                    await refresh()
                }
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
                let planURL = baseURL.appending(path: "sessions/\(session.id)/deletion-plan")
                let (planData, planResponse) = try await URLSession.shared.data(from: planURL)
                guard let planHTTPResponse = planResponse as? HTTPURLResponse else {
                    throw URLError(.badServerResponse)
                }
                guard (200..<300).contains(planHTTPResponse.statusCode) else {
                    throw BackendError.message(Self.errorMessage(from: planData) ?? L10n("Could not inspect the session worktree."))
                }
                let plan = try JSONDecoder().decode(SessionDeletionPlan.self, from: planData)
                var mergeWorktree = false
                if plan.workspaceUnavailable == true {
                    guard confirmOrphanedSessionDeletion(plan: plan) else { return }
                } else if plan.requiresWorktreeMerge {
                    guard let decision = confirmWorktreeDeletion(plan: plan) else { return }
                    mergeWorktree = decision
                }

                var deleteURL = baseURL.appending(path: "sessions/\(session.id)")
                if mergeWorktree {
                    deleteURL.append(queryItems: [URLQueryItem(name: "mergeWorktree", value: "true")])
                }
                var request = URLRequest(url: deleteURL)
                request.httpMethod = "DELETE"
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse, (200..<300).contains(httpResponse.statusCode) else {
                    throw BackendError.message(Self.errorMessage(from: data) ?? L10n("Could not delete the session."))
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

    private func confirmWorktreeDeletion(plan: SessionDeletionPlan) -> Bool? {
        let branch = plan.sourceBranch ?? L10n("detached HEAD")
        let path = plan.sourcePath ?? L10n("Unknown path")
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = L10n("This session is bound to a Git worktree")
        alert.informativeText = L10nFormat(
            "Worktree “%@” at %@ can be merged locally into main before the session is deleted. If it has uncommitted changes, this session will generate the commit message. No remote push will be performed.",
            branch,
            path
        )
        alert.addButton(withTitle: L10n("Merge into main and Delete"))
        alert.addButton(withTitle: L10n("Delete Only"))
        alert.addButton(withTitle: L10n("Cancel"))
        alert.buttons[1].hasDestructiveAction = true
        switch alert.runModal() {
        case .alertFirstButtonReturn: return true
        case .alertSecondButtonReturn: return false
        default: return nil
        }
    }

    private func confirmOrphanedSessionDeletion(plan: SessionDeletionPlan) -> Bool {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = L10n("This session's workspace is missing")
        alert.informativeText = L10nFormat(
            "The workspace at %@ is unavailable. Corptie can delete only the session and its local conversation record; no Worktree files or Git branches will be changed.",
            plan.sourcePath ?? L10n("Unknown path")
        )
        alert.addButton(withTitle: L10n("Delete Session Only"))
        alert.addButton(withTitle: L10n("Cancel"))
        return alert.runModal() == .alertFirstButtonReturn
    }

    func interruptSelectedSession() {
        guard let selectedSession else {
            return
        }
        interrupt(session: selectedSession)
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
                sendStatusMessage = L10nFormat("Switching model to %@", model.name)
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
                let message = Self.errorMessage(from: data)
                    ?? String(data: data, encoding: .utf8)
                    ?? "Bad server response"
                throw BackendError.message(message)
            }
            sendStatusMessage = L10n("Session permissions updated.")
            await refresh()
            if selectedSession?.id == session.id {
                await loadDetail(for: session)
            }
            return true
        } catch {
            lastError = error.localizedDescription
            sendStatusMessage = L10nFormat("Permission update failed: %@", error.localizedDescription)
            return false
        }
    }

    func reconnectSelectedSession() {
        guard let selectedSession else {
            return
        }
        reconnect(session: selectedSession)
    }

    private func refreshSelectedDetailFromPolling() async {
        guard let selectedSession,
              ChatDetailRefreshPolicy.shouldPoll(
                  sessionId: selectedSession.id,
                  isViewingHistory: viewingHistoricalThreadId != nil,
                  sseHealthEnabled: ChatTimelineFeatureFlags.current.sseHealthEnabled,
                  streamHealth: detailStreamHealth
              ) else {
            return
        }
        ChatPerformanceRecorder.shared.increment(.detailPollRequests)
        await loadDetail(for: selectedSession, showLoading: false)
    }

    func workspaceHistory(for session: TaskSession) async -> [SessionWorkspaceHistory] {
        do {
            let url = baseURL.appending(path: "sessions/\(session.id)/workspaces")
            let (data, response) = try await URLSession.shared.data(from: url)
            guard let httpResponse = response as? HTTPURLResponse,
                  httpResponse.statusCode == 200 else {
                throw BackendError.message(Self.errorMessage(from: data) ?? "Could not load workspace history.")
            }
            return try JSONDecoder().decode(SessionWorkspaceHistoryResponse.self, from: data).history
        } catch {
            lastError = error.localizedDescription
            return []
        }
    }

    func openHistoricalThread(_ history: SessionWorkspaceHistory, for session: TaskSession) async -> Bool {
        guard history.readOnly else {
            select(session: session)
            return true
        }
        do {
            let url = baseURL.appending(path: "sessions/\(session.id)/bindings/\(history.bindingId)/snapshot")
            let (data, response) = try await URLSession.shared.data(from: url)
            guard let httpResponse = response as? HTTPURLResponse,
                  httpResponse.statusCode == 200 else {
                throw BackendError.message(Self.errorMessage(from: data) ?? "Could not load historical thread.")
            }
            let detail = try await BackendResponseDecoder.detail(
                from: data,
                threadId: history.providerThreadId,
                authoritativeCwd: history.boundCwd,
                workspacePath: history.boundCwd
            )
            selectedSession = session
            selectedDetail = detail
            viewingHistoricalThreadId = history.providerThreadId
            detailStreamTask?.cancel()
            detailStreamTask = nil
            detailStreamWatchdogTask?.cancel()
            detailStreamWatchdogTask = nil
            detailStreamGeneration &+= 1
            detailStreamHealth = .inactive
            detailStreamLastActivity = nil
            resetDetailTimelineState()
            return true
        } catch {
            lastError = error.localizedDescription
            return false
        }
    }

    func returnToActiveThread() {
        guard let selectedSession else { return }
        select(session: selectedSession)
    }

    func fetchDetail(for session: TaskSession) async -> CodexThreadDetail? {
        let threadId = session.external?.threadId ?? session.id

        do {
            let url = baseURL.appending(path: "sessions/\(session.id)/snapshot")
            let (data, response) = try await URLSession.shared.data(from: url)
            guard let httpResponse = response as? HTTPURLResponse else {
                throw URLError(.badServerResponse)
            }
            guard httpResponse.statusCode == 200 else {
                throw BackendError.message(Self.errorMessage(from: data) ?? "Could not load session details.")
            }

            let detail = try await decodeDetail(data, for: session, threadId: threadId)
            let mergedDetail = applyingHandledChoices(to: stableDetailReplacingEmptyItems(detailByMergingPendingMessages(detail)))
            detailCacheBySessionId[session.id] = mergedDetail
            if lastError != nil {
                lastError = nil
            }
            return mergedDetail
        } catch {
            lastError = error.localizedDescription
            return nil
        }
    }

    private func startDetailStream(for session: TaskSession) {
        detailStreamTask?.cancel()
        detailStreamWatchdogTask?.cancel()
        detailStreamGeneration &+= 1
        let generation = detailStreamGeneration
        let threadId = session.external?.threadId ?? session.id
        detailStreamHealth = .connecting(sessionId: session.id)
        detailStreamLastDiagnostic = "generation=\(generation) connecting session=\(session.id)"
        detailStreamLastActivity = .now
        resetDetailTimelineState()

        detailStreamWatchdogTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                guard !Task.isCancelled, let self,
                      self.detailStreamGeneration == generation,
                      self.selectedSession?.id == session.id,
                      let lastActivity = self.detailStreamLastActivity else { return }
                guard ContinuousClock.now - lastActivity >= .seconds(35) else { continue }
                self.detailStreamHealth = .fallback(sessionId: session.id)
                self.startDetailStream(for: session)
                return
            }
        }

        detailStreamTask = Task { [weak self] in
            guard let self else {
                return
            }
            var failureCount = 0
            while !Task.isCancelled {
                guard self.detailStreamGeneration == generation,
                      self.selectedSession?.id == session.id else { return }
                var request = URLRequest(url: self.baseURL.appending(path: "sessions/\(session.id)/events"))
                request.setValue("text/event-stream", forHTTPHeaderField: "accept")
                request.setValue("identity", forHTTPHeaderField: "accept-encoding")
                if ChatTimelineFeatureFlags.current.deltaTimelineEnabled {
                    request.setValue("1", forHTTPHeaderField: "x-corptie-timeline-protocol")
                }
                request.cachePolicy = .reloadIgnoringLocalCacheData
                self.detailStreamLastDiagnostic = "generation=\(generation) requesting"

                do {
                    let (bytes, response) = try await URLSession.shared.bytes(for: request)
                    guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
                        throw URLError(.badServerResponse)
                    }
                    guard self.detailStreamGeneration == generation,
                          self.selectedSession?.id == session.id else { return }
                    self.detailStreamLastDiagnostic = "generation=\(generation) response=\(httpResponse.statusCode)"
                    failureCount = 0

                    var eventName = ""
                    var dataLines: [String] = []
                    for try await line in bytes.lines {
                        if Task.isCancelled { return }
                        guard self.detailStreamGeneration == generation,
                              self.selectedSession?.id == session.id else { return }
                        if !line.isEmpty {
                            self.detailStreamLastActivity = .now
                            self.detailStreamLastDiagnostic = "generation=\(generation) line=\(line.prefix(32))"
                        }
                        if line.isEmpty {
                            await self.handleDetailStreamEvent(
                                eventName: eventName,
                                data: dataLines.joined(separator: "\n"),
                                expectedSession: session,
                                expectedThreadId: threadId
                            )
                            eventName = ""
                            dataLines.removeAll(keepingCapacity: true)
                        } else if line.hasPrefix("event:") {
                            eventName = String(line.dropFirst(6)).trimmingCharacters(in: .whitespaces)
                        } else if line.hasPrefix("data:") {
                            dataLines.append(String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces))
                            // The canonical session endpoint emits snapshot payloads as one JSON line.
                            // Foundation's AsyncLineSequence can hold the trailing empty delimiter
                            // until the next heartbeat, so publish the complete frame immediately.
                            if Self.isSingleLineTimelineEvent(eventName), dataLines.count == 1 {
                                await self.handleDetailStreamEvent(
                                    eventName: eventName,
                                    data: dataLines[0],
                                    expectedSession: session,
                                    expectedThreadId: threadId
                                )
                                eventName = ""
                                dataLines.removeAll(keepingCapacity: true)
                            }
                        }
                    }
                    throw URLError(.networkConnectionLost)
                } catch {
                    if Task.isCancelled || self.detailStreamGeneration != generation { return }
                    self.detailStreamLastDiagnostic = "generation=\(generation) error=\(error.localizedDescription)"
                    self.detailStreamHealth = .fallback(sessionId: session.id)
                    failureCount += 1
                    let delay = ChatDetailRefreshPolicy.reconnectDelaySeconds(afterFailure: failureCount)
                    try? await Task.sleep(for: .seconds(delay))
                    if Task.isCancelled { return }
                    self.detailStreamHealth = .connecting(sessionId: session.id)
                }
            }
        }
    }

    private func handleDetailStreamEvent(eventName: String, data: String, expectedSession: TaskSession, expectedThreadId: String) async {
        guard !data.isEmpty,
              selectedSession?.id == expectedSession.id,
              let payload = data.data(using: .utf8) else {
            return
        }
        if eventName == "snapshot" {
            await handleDetailStreamSnapshot(
                payload,
                expectedSession: expectedSession,
                expectedThreadId: expectedThreadId
            )
            return
        }
        guard let kind = ChatTimelineDeltaKind(rawValue: eventName) else { return }
        await handleDetailStreamDelta(kind, payload: payload, expectedSession: expectedSession)
    }

    private func handleDetailStreamSnapshot(
        _ payload: Data,
        expectedSession: TaskSession,
        expectedThreadId: String
    ) async {
        ChatPerformanceRecorder.shared.increment(.sseSnapshots)
        ChatPerformanceRecorder.shared.increment(.sseSnapshotBytes, by: Int64(payload.count))
        do {
            async let header = ChatTimelineDeltaDecoder.snapshotHeader(from: payload)
            let canonicalDetail = try await ChatPerformanceTrace.measure("timeline.snapshot.decode") {
                try await BackendResponseDecoder.detail(
                    from: payload,
                    threadId: expectedThreadId,
                    authoritativeCwd: expectedSession.external?.cwd,
                    workspacePath: expectedSession.external?.workspace?.path
                )
            }
            let decodedHeader = try await header
            guard selectedSession?.id == expectedSession.id else { return }
            detailStreamCanonicalDetail = canonicalDetail
            detailTimelineRevision = decodedHeader.protocolVersion == 1 ? decodedHeader.revision : nil
            let mergedDetail = presentationDetail(from: canonicalDetail)
            markDetailStreamHealthy(for: expectedSession)
            publishSelectedDetailIfSafe(mergedDetail)
            if let selectedSession {
                detailCacheBySessionId[selectedSession.id] = mergedDetail
            }
            syncSessionSummary(from: mergedDetail)
            if lastError != nil {
                lastError = nil
            }
        } catch {
            lastError = error.localizedDescription
        }
    }

    private func handleDetailStreamDelta(
        _ kind: ChatTimelineDeltaKind,
        payload: Data,
        expectedSession: TaskSession
    ) async {
        ChatPerformanceRecorder.shared.increment(.sseDeltas)
        ChatPerformanceRecorder.shared.increment(.sseDeltaBytes, by: Int64(payload.count))
        do {
            let envelope = try await ChatPerformanceTrace.measure("timeline.delta.decode") {
                try await ChatTimelineDeltaDecoder.delta(from: payload)
            }
            guard selectedSession?.id == expectedSession.id else { return }
            let preferredCwd = BackendResponseDecoder.preferredWorkspacePath(
                authoritativePath: expectedSession.external?.cwd,
                providerPath: envelope.metadata.cwd,
                workspacePath: expectedSession.external?.workspace?.path
            )
            switch ChatTimelineDeltaMerger.merge(
                kind: kind,
                envelope: envelope,
                currentDetail: detailStreamCanonicalDetail,
                currentRevision: detailTimelineRevision,
                preferredCwd: preferredCwd
            ) {
            case .applied(let canonicalDetail, let revision):
                detailStreamCanonicalDetail = canonicalDetail
                detailTimelineRevision = revision
                let mergedDetail = presentationDetail(from: canonicalDetail)
                markDetailStreamHealthy(for: expectedSession)
                publishSelectedDetailIfSafe(mergedDetail)
                detailCacheBySessionId[expectedSession.id] = mergedDetail
                syncSessionSummary(from: mergedDetail)
                lastError = nil
            case .duplicate:
                markDetailStreamHealthy(for: expectedSession)
            case .requiresSnapshot:
                scheduleDetailStreamSnapshotRecovery(for: expectedSession)
            }
        } catch {
            scheduleDetailStreamSnapshotRecovery(for: expectedSession, error: error)
        }
    }

    private func presentationDetail(from canonicalDetail: CodexThreadDetail) -> CodexThreadDetail {
        applyingHandledChoices(
            to: stableDetailReplacingEmptyItems(detailByMergingPendingMessages(canonicalDetail))
        )
    }

    private func markDetailStreamHealthy(for session: TaskSession) {
        detailStreamLastActivity = .now
        detailStreamHealth = .healthy(sessionId: session.id)
        let revisionDescription = detailTimelineRevision.map(String.init) ?? "legacy"
        detailStreamLastDiagnostic = "generation=\(detailStreamGeneration) healthy session=\(session.id) revision=\(revisionDescription)"
    }

    private func scheduleDetailStreamSnapshotRecovery(for session: TaskSession, error: Error? = nil) {
        guard selectedSession?.id == session.id else { return }
        ChatPerformanceRecorder.shared.increment(.sseSnapshotRecoveries)
        detailStreamHealth = .fallback(sessionId: session.id)
        let errorDescription = error.map { " error=\($0.localizedDescription)" } ?? ""
        detailStreamLastDiagnostic = "generation=\(detailStreamGeneration) snapshot-recovery session=\(session.id)\(errorDescription)"
        resetDetailTimelineState()
        detailStreamGeneration &+= 1
        let recoveryGeneration = detailStreamGeneration
        detailStreamTask?.cancel()
        detailStreamWatchdogTask?.cancel()
        Task { [weak self] in
            await Task.yield()
            guard let self,
                  self.detailStreamGeneration == recoveryGeneration,
                  self.selectedSession?.id == session.id else { return }
            self.startDetailStream(for: session)
        }
    }

    private func resetDetailTimelineState() {
        detailTimelineRevision = nil
        detailStreamCanonicalDetail = nil
    }

    private static func isSingleLineTimelineEvent(_ eventName: String) -> Bool {
        eventName == "snapshot" || ChatTimelineDeltaKind(rawValue: eventName) != nil
    }

    private func loadDetail(for session: TaskSession, showLoading: Bool = true) async {
        let threadId = session.external?.threadId ?? session.id

        if showLoading {
            isLoadingDetail = true
        }
        defer {
            if showLoading {
                isLoadingDetail = false
            }
        }

        do {
            let url = baseURL.appending(path: "sessions/\(session.id)/snapshot")
            let (data, response) = try await URLSession.shared.data(from: url)
            guard let httpResponse = response as? HTTPURLResponse else {
                throw URLError(.badServerResponse)
            }
            guard httpResponse.statusCode == 200 else {
                throw BackendError.message(Self.errorMessage(from: data) ?? "Could not load session details.")
            }

            let detail = try await decodeDetail(data, for: session, threadId: threadId)
            let mergedDetail = applyingHandledChoices(to: stableDetailReplacingEmptyItems(detailByMergingPendingMessages(detail)))
            publishSelectedDetailIfSafe(mergedDetail)
            detailCacheBySessionId[session.id] = mergedDetail
            syncSessionSummary(from: mergedDetail)
            if lastError != nil {
                lastError = nil
            }
        } catch {
            lastError = error.localizedDescription
        }
    }

    private func decodeDetail(_ data: Data, for session: TaskSession, threadId: String) async throws -> CodexThreadDetail {
        try await BackendResponseDecoder.detail(
            from: data,
            threadId: threadId,
            authoritativeCwd: session.external?.cwd,
            workspacePath: session.external?.workspace?.path
        )
    }

    private func syncSessionSummary(from detail: CodexThreadDetail) {
        let latestSummary = detail.items.reversed().first { item in
            item.type != "userMessage"
                && item.type != "system"
                && !item.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }?.text.trimmingCharacters(in: .whitespacesAndNewlines)

        let nextSessions = sessions.map { session in
            guard session.external?.threadId == detail.id else {
                return session
            }

            let pendingChoice = detail.items.reversed().first { item in
                item.status != "selected" && !(item.options ?? []).isEmpty
            }
            let pendingPrompt = pendingChoice?.text.trimmingCharacters(in: .whitespacesAndNewlines)

            return TaskSession(
                id: session.id,
                title: session.title,
                agent: session.agent,
                status: detail.status,
                progress: session.progress,
                summary: latestSummary?.isEmpty == false ? latestSummary! : session.summary,
                suggestedOptions: pendingChoice?.options ?? session.suggestedOptions,
                suggestedPrompt: pendingPrompt?.isEmpty == false ? pendingPrompt : session.suggestedPrompt,
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
                    cwd: session.external?.cwd ?? detail.cwd,
                    sandbox: session.external?.sandbox,
                    approvalPolicy: session.external?.approvalPolicy,
                    source: session.external?.source ?? detail.source,
                    logicalSessionId: session.external?.logicalSessionId,
                    workspace: session.external?.workspace,
                    routingVersion: session.external?.routingVersion
                ),
                pendingCollaborationConfirmation: session.pendingCollaborationConfirmation
            )
        }
        applySessionSnapshot(nextSessions)
    }

    private func syncSelectedSessionFromSessions() {
        guard let current = selectedSession,
              let refreshed = sessions.first(where: { $0.id == current.id }) else {
            return
        }
        let routeChanged = current.external?.threadId != refreshed.external?.threadId
            || current.external?.routingVersion != refreshed.external?.routingVersion
        selectedSession = refreshed
        if routeChanged {
            viewingHistoricalThreadId = nil
            selectedDetail = nil
            detailCacheBySessionId.removeValue(forKey: refreshed.id)
            Task { [weak self] in
                guard let self, self.selectedSession?.id == refreshed.id else { return }
                self.startDetailStream(for: refreshed)
                await self.loadDetail(for: refreshed, showLoading: false)
            }
        }
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

        let nextDetail = CodexThreadDetail(
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
        publishSelectedDetailIfSafe(nextDetail)
    }

    private func publishSelectedDetailIfSafe(_ detail: CodexThreadDetail) {
        if let selectedDetail,
           detailPublicationRevision(selectedDetail) == detailPublicationRevision(detail),
           selectedDetail == detail {
            return
        }
        guard NSEvent.pressedMouseButtons == 0 else { return }
        ChatPerformanceRecorder.shared.increment(.detailPublishes)
        ChatPerformanceTrace.event("ui.detail.publish", value: detail.items.count)
        selectedDetail = detail
    }

    private func detailPublicationRevision(_ detail: CodexThreadDetail) -> String {
        let tail = detail.items.last
        return [
            detail.id,
            detail.status.rawValue,
            detail.updatedAt,
            "\(detail.items.count)",
            tail?.id ?? "",
            tail?.turnStatus ?? "",
            tail?.status ?? "",
            "\(tail?.text.count ?? 0)",
            String(tail?.text.suffix(64) ?? "")
        ].joined(separator: ":")
    }

    private func installPerformanceFixture(replaysStreamingUpdates: Bool) {
        let fixture = ChatPerformanceTrace.measure("fixture.generate") {
            ChatPerformanceFixture.make()
        }
        applySessionSnapshot([fixture.session], allowDuringReorder: true)
        archivedSessions = []
        selectedSession = fixture.session
        selectedDetail = fixture.detail
        detailCacheBySessionId = [fixture.session.id: fixture.detail]
        isLoadingDetail = false
        isOnline = true
        lastError = nil
        ChatPerformanceRecorder.shared.logSnapshot(reason: "fixture-installed")
        guard replaysStreamingUpdates else { return }

        performanceFixtureStreamTask = Task { [weak self] in
            guard let self else { return }
            var detail = fixture.detail
            var lastPublishedAt = ContinuousClock.now
            let fixtureFlags = ChatTimelineFeatureFlags.current
            let finalStep = fixtureFlags.fixtureStreamSteps
            for step in 1...finalStep {
                if Task.isCancelled { return }
                try? await Task.sleep(for: .milliseconds(fixtureFlags.fixtureStreamIntervalMilliseconds))
                if Task.isCancelled { return }
                detail = ChatPerformanceFixture.appendingStreamStep(step, to: detail, finalStep: finalStep)
                ChatPerformanceRecorder.shared.increment(.fixtureStreamingUpdates)
                let flags = ChatTimelineFeatureFlags.current
                let batchInterval = Duration.milliseconds(flags.uiBatchIntervalMilliseconds)
                if !flags.uiBatchingEnabled
                    || ContinuousClock.now - lastPublishedAt >= batchInterval
                    || step == finalStep {
                    publishSelectedDetailIfSafe(detail)
                    lastPublishedAt = .now
                }
                if step.isMultiple(of: 20) {
                    ChatPerformanceRecorder.shared.logSnapshot(reason: "fixture-stream-step-\(step)")
                }
            }
        }
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

private func normalizedMessageText(_ text: String) -> String {
    text.trimmingCharacters(in: .whitespacesAndNewlines)
        .components(separatedBy: .whitespacesAndNewlines)
        .filter { !$0.isEmpty }
        .joined(separator: " ")
}

private func nonEmptyPreference(_ value: String?) -> String? {
    guard let value else {
        return nil
    }
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
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

enum SuggestedOptionRouting {
    static func pendingChoiceId(for optionId: String, items: [CodexThreadItem]) -> String? {
        items.reversed().first { item in
            item.type == "choice"
                && item.status != "selected"
                && (item.options ?? []).contains(where: { $0.id == optionId })
        }?.id
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

enum BackendError: LocalizedError {
    case message(String)

    var errorDescription: String? {
        switch self {
        case .message(let message):
            message
        }
    }
}
