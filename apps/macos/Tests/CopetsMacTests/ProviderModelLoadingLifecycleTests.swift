import Foundation
import Testing

struct ProviderModelLoadingLifecycleTests {
    @Test
    func startupDoesNotWaitForProviderModelDiscovery() throws {
        let clientSource = try backendClientSource()

        let start = try #require(clientSource.range(of: "    func start() {"))
        let stop = try #require(clientSource.range(
            of: "    func stop() {",
            range: start.upperBound..<clientSource.endIndex
        ))
        let startupBody = clientSource[start.lowerBound..<stop.lowerBound]
        #expect(startupBody.contains("await loadProviders()"))
        #expect(!startupBody.contains("loadModels(for:"))

        let router = try source(named: "Backend/BackendEventRouter.swift")
        let storeReady = try #require(router.range(of: "if eventName == \"BackendStoreReady\""))
        let replayRequired = try #require(router.range(
            of: "if eventName == \"EventReplayRequired\"",
            range: storeReady.upperBound..<router.endIndex
        ))
        let storeReadyBody = router[storeReady.lowerBound..<replayRequired.lowerBound]
        #expect(storeReadyBody.contains("await ports.loadProviders()"))
        #expect(clientSource.contains("loadProviders: { [weak self] in"))
        #expect(!storeReadyBody.contains("loadModels(for:"))
    }

    @Test
    func modelDiscoveryRemainsAvailableOnDemand() throws {
        let backendClient = try source(named: "Backend/BackendClientSettingsAndCreation.swift")
        #expect(backendClient.contains("func loadModelsForSelectedSession(forceRefresh: Bool = false) async"))
        #expect(backendClient.contains("await loadModels(for: provider, forceRefresh: forceRefresh)"))

        let floatingRootView = try source(named: "Floating/NewSession/NewAgentSessionSheet.swift")
        #expect(floatingRootView.contains("private func loadModelsForCurrentAgent()"))
        #expect(floatingRootView.contains("await backendClient.loadModels(for: provider)"))

        let appSource = try source(named: "Settings/SettingsView.swift")
        #expect(appSource.contains("await backendClient.loadModels(for: \"codex-pty\")"))
    }

    private func backendClientSource() throws -> String {
        try source(named: "BackendClient.swift")
    }

    private func source(named name: String) throws -> String {
        let testFile = URL(fileURLWithPath: #filePath)
        let packageRoot = testFile
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        return try String(
            contentsOf: packageRoot.appendingPathComponent("Sources/CopetsMac/\(name)"),
            encoding: .utf8
        )
    }
}
