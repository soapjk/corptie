import Foundation

@MainActor
struct BackendSettingsAPI {
    let baseURL: URL
    let urlSession: URLSession

    static func updateBody(
        dataRoot: String, expectedSourceDataRoot: String?,
        choiceParser: ChoiceParserSettings?, codexBackend: CodexBackendSettings?,
        codeDiff: CodeDiffSettings?, agentProxy: AgentProxySettings?, gateway: GatewaySettings?
    ) -> [String: Any] {
        var body: [String: Any] = ["dataRoot": dataRoot]
        if let activeDataRoot = expectedSourceDataRoot {
            body["expectedSourceDataRoot"] = activeDataRoot
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
        return body
    }

    static func agentProxyBody(_ settings: AgentProxySettings) -> [String: Any] {
        [
            "codex": agentProxyProfileBody(settings.codex),
            "choiceParser": agentProxyProfileBody(settings.choiceParser),
            "pty": agentProxyProfileBody(settings.pty)
        ]
    }

    private static func agentProxyProfileBody(_ profile: AgentProxyProfile) -> [String: Any] {
        [
            "enabled": profile.enabled,
            "httpProxy": profile.httpProxy,
            "httpsProxy": profile.httpsProxy,
            "allProxy": profile.allProxy,
            "noProxy": profile.noProxy
        ]
    }

    func read() async throws -> BackendSettings {
        let (data, response) = try await urlSession.data(from: baseURL.appending(path: "settings"))
        guard let response = response as? HTTPURLResponse, response.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        return try JSONDecoder().decode(BackendSettings.self, from: data)
    }

    // Return unsuccessful HTTP responses too: migration failures carry an
    // operation receipt that the existing controller must publish before error.
    func patch(_ body: [String: Any], timeoutInterval: TimeInterval? = nil) async throws -> (Data, HTTPURLResponse) {
        var request = URLRequest(url: baseURL.appending(path: "settings"))
        request.httpMethod = "PATCH"
        if let timeoutInterval { request.timeoutInterval = timeoutInterval }
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await urlSession.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        return (data, response)
    }

    func currentMigration() async throws -> DataRootMigrationOperation? {
        let (data, response) = try await urlSession.data(
            from: baseURL.appending(path: "data-root-migrations/current")
        )
        guard let response = response as? HTTPURLResponse, response.statusCode == 200 else { return nil }
        return try JSONDecoder().decode(MigrationStatus.self, from: data).operation
    }

    private struct MigrationStatus: Decodable {
        let operation: DataRootMigrationOperation?
    }
}
