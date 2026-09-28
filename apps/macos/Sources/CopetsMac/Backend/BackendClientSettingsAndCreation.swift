import Foundation

extension BackendClient {
    func loadSettings() async { await settingsController.loadSettings() }

    func syncNewSessionDefaultsFromPreferences(force: Bool = false) async {
        await settingsController.syncNewSessionDefaultsFromPreferences(force: force)
    }

    func updateDataRoot(_ dataRoot: String) async {
        await settingsController.updateDataRoot(dataRoot)
    }

    @discardableResult
    func updateSettings(
        dataRoot: String, choiceParser: ChoiceParserSettings?,
        codexBackend: CodexBackendSettings? = nil, codeDiff: CodeDiffSettings? = nil,
        agentProxy: AgentProxySettings? = nil, gateway: GatewaySettings? = nil
    ) async -> Bool {
        await settingsController.updateSettings(
            dataRoot: dataRoot, choiceParser: choiceParser, codexBackend: codexBackend,
            codeDiff: codeDiff, agentProxy: agentProxy, gateway: gateway
        )
    }

    func recoverPendingDataRootMigrationIfNeeded() async {
        await settingsController.recoverPendingDataRootMigrationIfNeeded()
    }

    func testChoiceParser(
        _ choiceParser: ChoiceParserSettings, agentProxy: AgentProxySettings? = nil
    ) async -> Result<String, Error> {
        await settingsController.testChoiceParser(choiceParser, agentProxy: agentProxy)
    }

    func loadModelsForSelectedSession(forceRefresh: Bool = false) async {
        let provider = selectedSession?.external?.provider ?? "codex-pty"
        await loadModels(for: provider, forceRefresh: forceRefresh)
    }

    func loadProviders() async {
        await modelCatalog.loadProviders()
    }

    func providerDisplayName(for providerIdentity: String?) -> String? {
        modelCatalog.providerDisplayName(for: providerIdentity)
    }

    func loadModels(for provider: String, forceRefresh: Bool = false) async {
        await modelCatalog.loadModels(for: provider, forceRefresh: forceRefresh)
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

    /// A successful command response is merged into the canonical AppStateStore
    /// synchronously so the list has read-your-write behavior. The revisioned
    /// snapshot/SSE stream then reconciles the returned projection.
    func acceptCreatedSession(_ session: TaskSession, selectImmediately: Bool = true) {
        let accepted = appState.acceptCreatedSession(session)
        if selectImmediately { select(session: accepted) }
    }

    func previewSessionFork(_ selection: SessionForkSelection) async throws -> SessionForkPreview {
        try await sessionForkAPI.previewSessionFork(selection)
    }

    func createSessionFork(_ selection: SessionForkSelection, requestID: String, sourceBindingID: String,
                           title: String, description: String, acceptanceCriteria: String) async throws -> SessionForkResponse {
        try await sessionForkAPI.createSessionFork(
            selection, requestID: requestID, sourceBindingID: sourceBindingID,
            title: title, description: description, acceptanceCriteria: acceptanceCriteria
        )
    }
}
