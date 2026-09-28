import Foundation

struct PendingDataRootMigrationRecovery: Codable, Equatable {
    let operationId: String?
    let targetDataRoot: String
    let recordedAt: Date
}

private struct DataRootMigrationErrorEnvelope: Decodable {
    let error: String
    let code: String
    let operation: DataRootMigrationOperation?
}

/// Settings and Data Root migration have one lifecycle and one published state owner.
@MainActor
final class BackendSettingsController: ObservableObject {
    @Published private(set) var settings: BackendSettings?
    @Published private(set) var isUpdatingSettings = false
    @Published private(set) var dataRootMigration: DataRootMigrationOperation?
    @Published private(set) var dataRootMigrationPresentationPhase: String?
    @Published private(set) var isTestingChoiceParser = false
    private var dataRootMigrationHandoffTasks: [String: Task<Void, Error>] = [:]
    private var completedDataRootMigrationHandoffs: Set<String> = []
    private var hasSyncedNewSessionDefaults = false

    private let baseURL: URL
    private let settingsAPI: BackendSettingsAPI
    private let backendIsOnline: () -> Bool
    private let currentError: () -> String?
    private let reportError: (String?) -> Void
    private let onBackendReconnected: () -> Void
    private let errorMessage: (Data) -> String?

    private var isOnline: Bool { backendIsOnline() }
    private var lastError: String? {
        get { currentError() }
        set { reportError(newValue) }
    }

    init(baseURL: URL, backendIsOnline: @escaping () -> Bool,
         currentError: @escaping () -> String?, reportError: @escaping (String?) -> Void,
         onBackendReconnected: @escaping () -> Void, errorMessage: @escaping (Data) -> String?) {
        self.baseURL = baseURL
        self.settingsAPI = BackendSettingsAPI(baseURL: baseURL, urlSession: .shared)
        self.backendIsOnline = backendIsOnline
        self.currentError = currentError
        self.reportError = reportError
        self.onBackendReconnected = onBackendReconnected
        self.errorMessage = errorMessage
    }

    func loadSettings() async {
        do {
            settings = try await settingsAPI.read()
            dataRootMigration = settings?.dataRootMigration
            dataRootMigrationPresentationPhase = settings?.dataRootMigration?.phase
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
            let (data, httpResponse) = try await settingsAPI.patch([
                "newSessionDefaults": newSessionDefaults
            ])
            guard (200..<300).contains(httpResponse.statusCode) else {
                throw URLError(.badServerResponse)
            }
            settings = try JSONDecoder().decode(BackendSettings.self, from: data)
            hasSyncedNewSessionDefaults = true
        } catch {
            hasSyncedNewSessionDefaults = false
        }
    }


    func updateDataRoot(_ dataRoot: String) async {
        await updateSettings(dataRoot: dataRoot, choiceParser: settings?.choiceParser, codexBackend: settings?.codexBackend, agentProxy: settings?.agentProxy, gateway: settings?.gateway)
    }

    @discardableResult
    func updateSettings(dataRoot: String, choiceParser: ChoiceParserSettings?, codexBackend: CodexBackendSettings? = nil, codeDiff: CodeDiffSettings? = nil, agentProxy: AgentProxySettings? = nil, gateway: GatewaySettings? = nil) async -> Bool {
        let trimmed = dataRoot.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            lastError = L10n("Data root is required.")
            return false
        }

        isUpdatingSettings = true
        defer { isUpdatingSettings = false }

        let migrationRequested = !DataRootMigrationPresentation.pathsEqual(settings?.dataRoot, trimmed)
        if migrationRequested {
            dataRootMigrationPresentationPhase = "preflight"
            persistPendingDataRootMigration(targetDataRoot: trimmed)
        }
        let migrationStatusTask: Task<Void, Never>? = migrationRequested
            ? Task { [weak self] in
                while !Task.isCancelled {
                    await self?.refreshDataRootMigrationStatus(expectedTarget: trimmed)
                    do {
                        try await Task.sleep(for: .milliseconds(250))
                    } catch {
                        return
                    }
                }
            }
            : nil
        defer { migrationStatusTask?.cancel() }

        do {
            let body = BackendSettingsAPI.updateBody(
                dataRoot: trimmed, expectedSourceDataRoot: migrationRequested ? settings?.dataRoot : nil,
                choiceParser: choiceParser, codexBackend: codexBackend, codeDiff: codeDiff,
                agentProxy: agentProxy, gateway: gateway
            )
            // Migration liveness comes from its progress endpoint, not a short request timeout.
            let (data, httpResponse) = try await settingsAPI.patch(body, timeoutInterval: 60 * 60)
            if !(200..<300).contains(httpResponse.statusCode) {
                if migrationRequested {
                    clearPendingDataRootMigration()
                }
                if let failure = try? JSONDecoder().decode(DataRootMigrationErrorEnvelope.self, from: data) {
                    if let operation = failure.operation {
                        dataRootMigration = operation
                        dataRootMigrationPresentationPhase = operation.phase
                    }
                    throw BackendError.message("\(failure.code): \(failure.error)")
                }
                throw BackendError.message(errorMessage(data) ?? "Bad server response")
            }
            let updatedSettings = try JSONDecoder().decode(BackendSettings.self, from: data)
            settings = updatedSettings
            dataRootMigration = updatedSettings.dataRootMigration
            dataRootMigrationPresentationPhase = updatedSettings.dataRootMigration?.phase
            if let operation = updatedSettings.dataRootMigration, operation.restartRequired {
                try await completeDataRootMigrationHandoff(operation)
            }
            lastError = nil
            return true
        } catch {
            if migrationRequested,
               let current = settings,
               DataRootMigrationPresentation.pathsEqual(current.dataRoot, trimmed),
               dataRootMigration?.phase == "completed" {
                lastError = nil
                return true
            }
            if migrationRequested,
               let operation = dataRootMigration,
               DataRootMigrationPresentation.pathsEqual(operation.targetDataRoot, trimmed),
               operation.restartRequired || dataRootMigrationHandoffTasks[operation.operationId] != nil {
                do {
                    try await completeDataRootMigrationHandoff(operation)
                    lastError = nil
                    return true
                } catch {
                    lastError = error.localizedDescription
                    return false
                }
            }
            lastError = error.localizedDescription
            return false
        }
    }

    private func refreshDataRootMigrationStatus(expectedTarget: String) async {
        do {
            guard let operation = try await settingsAPI.currentMigration(),
                  DataRootMigrationPresentation.pathsEqual(operation.targetDataRoot, expectedTarget) else { return }
            dataRootMigration = operation
            dataRootMigrationPresentationPhase = operation.phase
            if operation.restartRequired {
                try await completeDataRootMigrationHandoff(operation)
            }
        } catch {
            // A disconnect is expected after the selector is committed and the
            // host replaces the Backend. The reconnect loop owns that phase.
            if !(error is CancellationError) {
                lastError = error.localizedDescription
            }
        }
    }

    private func completeDataRootMigrationHandoff(_ operation: DataRootMigrationOperation) async throws {
        if completedDataRootMigrationHandoffs.contains(operation.operationId) {
            return
        }
        if let existing = dataRootMigrationHandoffTasks[operation.operationId] {
            try await existing.value
            return
        }

        persistPendingDataRootMigration(operation)
        let task = Task { @MainActor [weak self] in
            guard let self else { throw CancellationError() }
            try await CorptieBackendSupervisor.restartBackendForDataRootMigration()
            self.dataRootMigrationPresentationPhase = "reconnecting"
            try await self.reconnectAfterDataRootMigration(
                operationId: operation.operationId,
                targetDataRoot: operation.targetDataRoot
            )
        }
        dataRootMigrationHandoffTasks[operation.operationId] = task
        defer { dataRootMigrationHandoffTasks.removeValue(forKey: operation.operationId) }
        try await task.value
        completedDataRootMigrationHandoffs.insert(operation.operationId)
    }

    private func reconnectAfterDataRootMigration(operationId: String, targetDataRoot: String) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(45))
        while ContinuousClock.now < deadline {
            do {
                let (data, response) = try await URLSession.shared.data(from: baseURL.appending(path: "settings"))
                if let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 {
                    let current = try JSONDecoder().decode(BackendSettings.self, from: data)
                    if current.dataRoot == targetDataRoot,
                       current.dataRootMigration?.operationId == operationId,
                       current.dataRootMigration?.phase == "completed" {
                        settings = current
                        dataRootMigration = current.dataRootMigration
                        dataRootMigrationPresentationPhase = current.dataRootMigration?.phase
                        clearPendingDataRootMigration()
                        AppStateSyncController.shared.start()
                        onBackendReconnected()
                        return
                    }
                }
            } catch {
                // The verified old Backend is expected to disconnect while the
                // host replaces it. Keep this transition inside migration UI.
            }
            try await Task.sleep(for: .milliseconds(350))
        }
        throw BackendError.message(L10n("The Backend did not reconnect from the new Data Root in time."))
    }

    private static let pendingDataRootMigrationKey = "dataRootMigration.pendingRecovery"

    private func persistPendingDataRootMigration(_ operation: DataRootMigrationOperation) {
        persistPendingDataRootMigration(
            targetDataRoot: operation.targetDataRoot,
            operationId: operation.operationId
        )
    }

    private func persistPendingDataRootMigration(targetDataRoot: String, operationId: String? = nil) {
        let value = PendingDataRootMigrationRecovery(
            operationId: operationId,
            targetDataRoot: targetDataRoot,
            recordedAt: Date()
        )
        if let data = try? JSONEncoder().encode(value) {
            CorptieAppEnvironment.userDefaults.set(data, forKey: Self.pendingDataRootMigrationKey)
            CorptieAppEnvironment.userDefaults.synchronize()
        }
    }

    private func clearPendingDataRootMigration() {
        CorptieAppEnvironment.userDefaults.removeObject(forKey: Self.pendingDataRootMigrationKey)
        CorptieAppEnvironment.userDefaults.synchronize()
    }

    func recoverPendingDataRootMigrationIfNeeded() async {
        guard let data = CorptieAppEnvironment.userDefaults.data(forKey: Self.pendingDataRootMigrationKey),
              let pending = try? JSONDecoder().decode(PendingDataRootMigrationRecovery.self, from: data) else {
            return
        }
        do {
            if (try? await fetchSettingsForDataRootRecovery()) == nil {
                try await CorptieBackendSupervisor.ensureBackendRunningForPendingDataRootMigration()
            }
            let deadline = ContinuousClock.now.advanced(by: .seconds(60 * 60))
            while ContinuousClock.now < deadline {
                let current = try await fetchSettingsForDataRootRecovery()
                settings = current
                dataRootMigration = current.dataRootMigration
                dataRootMigrationPresentationPhase = current.dataRootMigration?.phase

                if DataRootMigrationPresentation.pathsEqual(current.dataRoot, pending.targetDataRoot),
                   current.dataRootMigration?.phase == "completed" {
                    clearPendingDataRootMigration()
                    return
                }
                guard let operation = current.dataRootMigration,
                      DataRootMigrationPresentation.pathsEqual(operation.targetDataRoot, pending.targetDataRoot),
                      pending.operationId == nil || pending.operationId == operation.operationId else {
                    clearPendingDataRootMigration()
                    return
                }
                if operation.phase == "failed" {
                    clearPendingDataRootMigration()
                    return
                }
                if operation.restartRequired {
                    try await completeDataRootMigrationHandoff(operation)
                    return
                }
                try await Task.sleep(for: .milliseconds(350))
            }
            throw BackendError.message(L10n("The Backend did not reconnect from the new Data Root in time."))
        } catch {
            // Keep the durable recovery marker. A later App launch or manual
            // retry resumes the same operation instead of starting a second one.
            lastError = L10nFormat("Data Root recovery is pending: %@", error.localizedDescription)
        }
    }

    private func fetchSettingsForDataRootRecovery() async throws -> BackendSettings {
        let (data, response) = try await URLSession.shared.data(from: baseURL.appending(path: "settings"))
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        return try JSONDecoder().decode(BackendSettings.self, from: data)
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
                body["agentProxy"] = BackendSettingsAPI.agentProxyBody(agentProxy)
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
}

private func nonEmptyPreference(_ value: String?) -> String? {
    guard let value else { return nil }
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
}

@MainActor
private func choiceParserTestMessage(durationMs: Int?) -> String {
    guard let durationMs else { return L10n("Test passed") }
    if durationMs < 1000 { return L10nFormat("Test passed in %lld ms", durationMs) }
    return L10nFormat("Test passed in %.1f s", Double(durationMs) / 1000)
}
